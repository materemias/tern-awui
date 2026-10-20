// tern-mobile: a phone-sized control surface for the Tern panes on this machine.
// Reads blocks from `tern ls --json`, omp transcripts from omp's sessions folder and recaps
// from its history.db (see lib/paths.ts for where omp keeps them); writes input with `tern send`.
// omp sessions running the tern-mobile extension also connect to /bridge: they stream their
// prompt draft, model and busy state, and take drafts and model picks from the phone.
// Listens on loopback only and has no authentication of its own: whoever reaches the port controls
// the panes. Protecting it is the job of what sits in front (loopback only, Tailscale Serve, another
// authenticating proxy). Built in: a Host check against DNS rebinding, a custom header on POSTs, the
// bridge token, and an optional Tailscale login allowlist (TERN_AWUI_ALLOW).

import { Database } from "bun:sqlite";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import type { Server, ServerWebSocket, Subprocess } from "bun";
import webpush, { type PushSubscription, type RequestOptions } from "web-push";
import { arr, num, obj, str, type Obj } from "./lib/json";
import { IMAGE_MIMES, TranscriptImages, readChatFile, recapStale, scanFacts, type ChatEntry, type Facts } from "./lib/transcript";
import { countSubagents, listSubagents, regularFile, subagentDir, subagentFile, validSubagentName, type Subagent, type SubagentFacts } from "./lib/subagents";
import { readBtwHistory } from "./lib/btw-history";
import { compactAtPercent, type Compaction } from "./lib/compaction";
import { branchOf, projectOf } from "./lib/git";
import { queryRecaps, querySessionRecaps, withRecaps } from "./lib/recaps";
import { answerSteps, KEYS, promptImages, type PromptImage } from "./lib/input";
import { emptyState, listChanged, parseBridgeState, PROTOCOL, STRETCH_BLOCK, type BridgeState, type Caps, type Context, type Job } from "./lib/bridge-state";
import { extensionCheck, offersCommand, sessionMismatch, type InstallStatus, type Mismatch } from "./lib/extension-check";
import { configDir, docIcon, installedExtension, ompDataDir, ternNotesDir } from "./lib/paths";
import { ensureToken, sameToken } from "./lib/auth";
import { recentProjects } from "./lib/projects";
import { vapidSubject } from "./lib/push";
import { writePrivateFile } from "./lib/private-file";

const DOC_MAX_BYTES = 512 * 1024;
/** This checkout. The phone shows it in the command that (re)installs the extension. */
const REPO = import.meta.dir;
/** The list is rebuilt on events (Tern, bridges, history.db); this is only the cache's backstop. */
const STATE_TTL_MS = 15_000;
/** Events arriving within this window share one rebuild. */
const STATE_BATCH_MS = 150;
/** Open streams recheck everything this often, in case an event was missed. */
const SAFETY_MS = 15_000;
const PING_MS = 12_000;
const TERN_EVENTS_RETRY_MS = 2000;
const ROLES_TTL_MS = 5 * 60_000;
const SCREEN_LINES = 160;
const BRIDGE_REPLY_MS = 2000;
/** A finish is reported only if the session stays idle this long (no follow-up turn). */
const DONE_SETTLE_MS = 3000;
/** `TERN_AWUI_PROJECTS` gets this long to print its folders. */
const PROJECTS_TIMEOUT_MS = 5000;
/** Longest prompt or draft the API takes (characters). */
const MAX_TEXT = 1_000_000;
/** Only this origin's scripts, styles and images (plus data:/blob:): agent markdown can't make the app fetch a URL that leaks data. */
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export type ServerOptions = {
  /** Configuration (TERN_AWUI_*, omp and Tern locations) and the environment of tern, omp and the projects command. */
  env?: Record<string, string | undefined>;
  home?: string;
  /** The built app; this checkout's dist/ by default. */
  dist?: string;
  /** Delivers one Web Push message; web-push's by default. */
  sendNotification?: (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;
};

export type ServerHandle = {
  port: number;
  /** Allowed Tailscale logins; empty: no login check. */
  allow: string[];
  /** Closes the listener, streams and bridges and stops following Tern. */
  stop(): Promise<void>;
};

export function startServer(options: ServerOptions = {}): ServerHandle {
  const env = options.env ?? process.env;
  const HOME = options.home ?? homedir();
  const CONFIG_DIR = configDir(env, HOME);

  const PORT = Number(env.TERN_AWUI_PORT ?? 4380);
  /** Optional: when set, every request (but the bridge) needs one of these in `Tailscale-User-Login`. */
  const ALLOW = (env.TERN_AWUI_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  /**
   * Host names this server answers to. Any other `Host` is refused: a web page that rebinds its own
   * name to 127.0.0.1 would otherwise count as same-origin and could set every header.
   */
  const HOSTS = new Set(
    ["localhost", "127.0.0.1", "[::1]", ...(env.TERN_AWUI_HOSTS ?? "").split(",")]
      .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean),
  );
  const OMP_DATA = ompDataDir(env, HOME, process.platform);
  const SESSIONS_DIR = join(OMP_DATA, "sessions");
  const HISTORY_DB = join(OMP_DATA, "history.db");
  const BLOBS_DIR = join(OMP_DATA, "blobs");
  const NOTES_DIR = ternNotesDir(env, HOME, process.platform);
  /** A command printing one folder per line; `.py` runs with python3. Unset: lib/projects.ts. */
  const PROJECTS_SCRIPT = env.TERN_AWUI_PROJECTS ?? "";
  const DIST = options.dist ?? fileURLToPath(new URL("./dist/", import.meta.url));

  /** Where omp loads the extension from, and the checkout's file it should be (or link to). */
  const INSTALLED_EXTENSION = installedExtension(env, HOME);
  const extension = extensionCheck(INSTALLED_EXTENSION, join(REPO, "omp-extension", "tern-mobile.ts"));

  const BRIDGE_TOKEN = ensureToken(join(CONFIG_DIR, "bridge-token"));
  /** Set by `stop`: background loops and late callbacks end. */
  let stopped = false;

  // ---------- web push ----------

  const VAPID_FILE = join(CONFIG_DIR, "vapid.json");
  const PUSH_FILE = join(CONFIG_DIR, "push.json");

  /**
   * The VAPID keys, made on first start. Keys that don't load (a file cut off by a crash) are
   * replaced, and the subscriptions made for them dropped: the push service refuses them under
   * new keys, and each phone that chose *on* subscribes again on its next check.
   */
  function loadVapid(): { publicKey: string; privateKey: string } {
    if (existsSync(VAPID_FILE)) {
      try {
        const v = obj(JSON.parse(readFileSync(VAPID_FILE, "utf8")));
        const publicKey = str(v.publicKey);
        const privateKey = str(v.privateKey);
        // P-256: a 65-byte uncompressed public point and a 32-byte private scalar.
        if (Buffer.from(publicKey, "base64url").length === 65 && Buffer.from(privateKey, "base64url").length === 32) return { publicKey, privateKey };
      } catch {}
      console.error(`${VAPID_FILE} is unreadable: new push keys, phones subscribe again`);
      writePrivateFile(PUSH_FILE, "[]");
    }
    const keys = webpush.generateVAPIDKeys();
    writePrivateFile(VAPID_FILE, JSON.stringify(keys));
    return keys;
  }
  const VAPID = loadVapid();
  const vapidDetails = { subject: vapidSubject(env, ALLOW), publicKey: VAPID.publicKey, privateKey: VAPID.privateKey };
  // Checks the subject and keys at startup; each send names this server's keys itself.
  webpush.setVapidDetails(vapidDetails.subject, vapidDetails.publicKey, vapidDetails.privateKey);
  const sendNotification = options.sendNotification ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));

  /** Saved subscriptions; an unreadable file (cut off by a crash) starts over with none. */
  const pushSubs = new Map<string, PushSubscription>();
  if (existsSync(PUSH_FILE))
    try {
      for (const s of arr(JSON.parse(readFileSync(PUSH_FILE, "utf8")))) pushSubs.set(str(obj(s).endpoint), s as PushSubscription);
    } catch {
      console.error(`${PUSH_FILE} is unreadable: phones subscribe again`);
    }
  function savePushSubs() {
    writePrivateFile(PUSH_FILE, JSON.stringify([...pushSubs.values()]));
  }

  /** Tells every subscribed phone that a session finished a turn or waits on the user. */
  async function pushStatus(pane: string, kind: "done" | "blocked", sessionId: string) {
    if (!pushSubs.size) return;
    const item = await findItem(pane);
    if (stopped) return;
    const title = item ? `${item.tag ? `${item.tag}: ` : ""}${item.title}` : "omp";
    const entries = sessionId ? ((await readChat(sessionId, 20))?.entries ?? []) : [];
    if (stopped) return;
    const ask = kind === "blocked" ? entries.findLast((e) => e.role === "ask") : undefined;
    const said = entries.findLast((e) => e.role === "assistant");
    const detail =
      ask?.role === "ask" ? ask.questions[0]?.question : said?.role === "assistant" ? said.text.replace(/[*`#_>]/g, "") : "";
    const body = `${kind === "blocked" ? "Needs you" : "Finished"}${detail ? ` · ${detail.trim().slice(0, 160)}` : ""}`;
    // `badge`: the app icon's count of unseen updates, set by the service worker while the app is closed.
    const payload = JSON.stringify({ title, body, block: pane, badge: unseen.size });
    await Promise.all(
      [...pushSubs.values()].map((sub) =>
        sendNotification(sub, payload, { TTL: 900, urgency: "high", vapidDetails }).catch((err: { statusCode?: number }) => {
          // A previous server must not rewrite subscriptions after its owner stopped it.
          if (stopped) return;
          // 404/410: the browser dropped the subscription.
          if (err.statusCode === 404 || err.statusCode === 410) {
            if (pushSubs.get(sub.endpoint) === sub) {
              pushSubs.delete(sub.endpoint);
              savePushSubs();
              console.log(`push: ${sub.endpoint.split("/")[2]} reported a subscription gone (${err.statusCode}); removed`);
            }
          } else console.error("push failed", err.statusCode ?? err);
        }),
      ),
    );
  }

  /**
   * Sessions with an update the phone hasn't opened yet: a finished turn or a wait on the user.
   * Opening the session clears it, and so does the agent working again (handled on the desktop).
   */
  const unseen = new Map<string, "done" | "blocked">();
  function markUnseen(pane: string, kind: "done" | "blocked") {
    // A phone showing this session right now has seen it.
    if (paneListeners.get(pane)?.size) return;
    unseen.set(pane, kind);
    invalidateState();
  }

  const doneTimers = new Map<string, Timer>();
  /** working → idle is a finished turn once it settles; → blocked notifies at once. */
  function onStatusChange(pane: string, from: string, to: string, sessionId: string) {
    clearTimeout(doneTimers.get(pane));
    doneTimers.delete(pane);
    if (to === "blocked") {
      markUnseen(pane, "blocked");
      void pushStatus(pane, "blocked", sessionId).catch((error) => console.error("push failed", error));
    } else if (to === "idle" && from === "working")
      doneTimers.set(
        pane,
        setTimeout(() => {
          doneTimers.delete(pane);
          if (bridges.get(pane)?.state.status !== "idle") return;
          markUnseen(pane, "done");
          void pushStatus(pane, "done", sessionId).catch((error) => console.error("push failed", error));
        }, DONE_SETTLE_MS),
      );
  }

  // ---------- tern CLI ----------

  /**
   * Runs tern; `error` is set when it failed. tern can print an error and still exit 0
   * (`tern send BLOCK keys Bogus`), so stderr counts too, minus its WARN noise.
   */
  async function tern(args: string[], timeoutMs = 10_000): Promise<{ out: string; error: string | null }> {
    const proc = Bun.spawn(["tern", ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const complaint = err
      .split("\n")
      .filter((l) => l.trim() && !/\bWARN\b/.test(l))
      .join("\n")
      .trim();
    return { out, error: code !== 0 || complaint ? complaint || `tern ${args[0]} exited ${code}` : null };
  }

  // ---------- omp bridge ----------

  type Bridge = {
    ws: ServerWebSocket<{ pane: string | null }>;
    state: BridgeState;
    /** Pending requests by seq; resolved with omp's reply (a snapshot, or a `reply` payload), null once this connection stops speaking for the pane. */
    waiting: Map<number, (reply: Obj | null) => void>;
    /** The assistant message omp is writing right now, while a phone watches; null between messages. */
    live: { text: string; done: boolean } | null;
    /** Whether this omp has `/restart`, asked once its extension turns out older (see `askRestart`). */
    restart: "unasked" | "asking" | boolean;
  };
  const bridges = new Map<string, Bridge>();
  /** The phones watching each pane: draft, live text and btw events go to them as they happen. */
  const paneListeners = new Map<string, Set<(event: string, data: unknown) => void>>();
  let bridgeSeq = 0;

  function emit(pane: string, event: string, data: unknown) {
    for (const fn of paneListeners.get(pane) ?? []) fn(event, data);
  }

  function notifyBridge(pane: string) {
    emit(pane, "draft", draftPayload(bridges.get(pane) ?? null));
  }

  /** Tells a pane's omp whether a phone is watching, so it streams its message text only then. */
  function tellWatched(pane: string) {
    const b = bridges.get(pane);
    if (b) b.ws.send(JSON.stringify({ t: "watch", on: (paneListeners.get(pane)?.size ?? 0) > 0 }));
  }

  function listenPane(pane: string, fn: (event: string, data: unknown) => void): () => void {
    const set = paneListeners.get(pane) ?? new Set();
    paneListeners.set(pane, set);
    set.add(fn);
    if (set.size === 1) tellWatched(pane);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        paneListeners.delete(pane);
        tellWatched(pane);
      }
    };
  }

  /** A command's outcome: null when omp took it, else why not. */
  function bridgeError(reply: Obj | null, missing = "omp did not answer"): string | null {
    return reply ? (reply.error ? str(reply.error) : null) : missing;
  }

  const MODELS_TTL_MS = 5 * 60_000;
  let modelsCache: { at: number; value: unknown[] } | null = null;

  /** Sends a command to an omp session; resolves with its reply, or null when it doesn't answer. */
  function bridgeRequest(b: Bridge, msg: Obj): Promise<Obj | null> {
    const seq = ++bridgeSeq;
    const { promise, resolve } = Promise.withResolvers<Obj | null>();
    const timer = setTimeout(() => {
      b.waiting.delete(seq);
      resolve(null);
    }, BRIDGE_REPLY_MS);
    b.waiting.set(seq, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    b.ws.send(JSON.stringify({ ...msg, seq }));
    return promise;
  }

  /**
   * Asks whether a session's omp has `/restart` (restarts omp in its pane, resuming the session, so
   * the installed extension loads): its own autocomplete, which every extension version answers
   * (an unknown request gets a snapshot, which offers nothing). Once per connection; the list
   * updates when the answer is yes.
   */
  function askRestart(b: Bridge) {
    if (b.restart !== "unasked" || b.state.caps?.complete === false) return;
    b.restart = "asking";
    void bridgeRequest(b, { t: "complete", text: "/restart" }).then((reply) => {
      b.restart = offersCommand(reply, "restart");
      if (b.restart) invalidateState();
    });
  }

  /**
   * A command's stdout, without blocking the server while it runs; null when it is missing or is
   * killed after `timeoutMs`. A killed command's children may still hold its output open, so its
   * output is not awaited then.
   */
  async function commandOutput(argv: string[], timeoutMs: number): Promise<string | null> {
    try {
      const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
      const out = new Response(proc.stdout).text();
      await proc.exited;
      return proc.signalCode ? null : await out;
    } catch {
      return null;
    }
  }

  /** `omp config get KEY` as parsed JSON; null when omp is missing or the key is unset. */
  async function ompConfig(key: string): Promise<unknown> {
    try {
      return JSON.parse((await commandOutput(["omp", "config", "get", key], 10_000)) ?? "");
    } catch {
      return null;
    }
  }

  /** Ctrl+P roles from omp's settings: `cycleOrder` names roles, `modelRoles` maps them to models. */
  type Role = { role: string; spec: string };
  type OmpSettings = { roles: Role[]; compaction: Compaction };
  let settingsCache: { at: number; value: Promise<OmpSettings> } | null = null;
  /** The omp settings the list needs, read at most every few minutes; a missing omp only costs the picker and the gauge's tick. */
  function ompSettings(): Promise<OmpSettings> {
    if (settingsCache && Date.now() - settingsCache.at < ROLES_TTL_MS) return settingsCache.value;
    const keys = ["modelRoles", "cycleOrder", "compaction.enabled", "compaction.thresholdTokens", "compaction.thresholdPercent", "compaction.reserveTokens"];
    const value = Promise.all(keys.map(ompConfig)).then(([roles, order, enabled, tokens, percent, reserve]) => ({
      roles: arr(order)
        .map((r) => ({ role: str(r), spec: str(obj(roles)[str(r)]) }))
        .filter((r) => r.role && r.spec),
      compaction: {
        enabled: enabled !== false,
        thresholdTokens: num(tokens),
        thresholdPercent: num(percent),
        reserveTokens: typeof reserve === "number" ? reserve : null,
      },
    }));
    settingsCache = { at: Date.now(), value };
    return value;
  }

  // ---------- state ----------

  /** The omp session in a pane, known through its bridge connection. */
  type Agent = {
    sessionId: string;
    lastPrompt: string;
    /** omp's recap of the session, written when it goes idle. */
    recap: string;
    /** Turns followed the recap, so it describes an earlier exchange. */
    recapStale: boolean;
    /** The newest transcript entry (ms). */
    lastActivity: number;
    /** Its subagents: those with a transcript, finished ones too, and running ones. */
    subagents: number;
  };

  type Item = {
    block: string;
    icon: string | null;
    tag: string | null;
    title: string;
    cwd: string;
    project: string;
    /** Checked-out git branch of the cwd (short sha when detached); null outside a repo. */
    branch: string | null;
    agent: Agent | null;
    /** Present while the session's omp is connected to /bridge. */
    live: {
      model: string;
      thinking: string;
      levels: string[];
      tiers: string[];
      tier: string;
      context: (Context & { compactAt: number | null }) | null;
      jobs: Job[];
      /** The extension's bridge protocol (0: older than versioning) and its feature caps (null: none sent). */
      protocol: number;
      caps: Caps | null;
      /** The extension's build id; "" when it reported none. */
      build: string;
      /** How the extension differs from this server's (lib/extension-check.ts); null when it matches. */
      mismatch: Mismatch | null;
      /** This omp has `/restart`, which reloads the extension in place (asked only when `older`). */
      restart: boolean;
    } | null;
    /** working / blocked / idle, from the session's bridge; null without one. */
    status: string | null;
    /** When `status` last changed (ms). */
    since: number;
    /** File blocks (Tern notes and opened files): the path shown read-only instead of a terminal. */
    doc: string | null;
    /** An update the phone hasn't opened: a finished turn or a wait on the user. */
    unseen: "done" | "blocked" | null;
  };

  type State = {
    projects: { name: string; items: Item[] }[];
    counts: Record<string, number>;
    roles: Role[];
    /** Unseen updates across sessions: the app icon's badge. */
    badge: number;
    at: number;
    /** dist/'s build id (build.ts); a page built from another one reloads. "" when unbuilt. */
    app: string;
    /** The extension as installed for omp; the phone shows a banner unless `ok`. */
    extension: {
      status: InstallStatus;
      /** `<omp dir>/extensions/tern-mobile.ts`. */
      path: string;
      /** Where a `foreign` link points. */
      target: string;
      /** This checkout, where `bun install.ts` fixes it. */
      repo: string;
      /** The fix is a PowerShell command. */
      windows: boolean;
    };
  };

  // Nerd-font icons live in the private use areas; the app ships the symbols font for them.
  const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/u;

  const factsCache = new Map<string, Facts>();
  const transcriptImages = new TranscriptImages();

  /** What the list shows of a session's transcript, scanned from where the previous scan stopped. */
  async function sessionFacts(sessionId: string): Promise<Facts | null> {
    const path = transcriptPath(sessionId);
    if (!path) return null;
    try {
      const facts = await scanFacts(path, factsCache.get(path));
      factsCache.set(path, facts);
      return facts;
    } catch {
      // One unreadable transcript must not hide the other panes.
      return null;
    }
  }

  let historyDb: Database | null = null;
  /** Reads omp's history.db; without it (none yet, or a schema this omp doesn't have) gives `fallback`. */
  function fromHistory<T>(read: (db: Database) => T, fallback: T): T {
    try {
      historyDb ??= new Database(HISTORY_DB, { readonly: true });
      return read(historyDb);
    } catch {
      historyDb?.close();
      historyDb = null;
      return fallback;
    }
  }
  /** The newest recap omp wrote for each session, with its time (whole seconds). */
  function readRecaps(ids: string[]): Map<string, { text: string; createdAt: number }> {
    // Without history.db rows go without recaps.
    return ids.length ? fromHistory((db) => queryRecaps(db, ids), new Map()) : new Map();
  }

  /** The omp session of every pane whose omp is connected to the bridge. */
  async function readAgents(): Promise<Map<string, Agent>> {
    const connected = [...bridges].filter(([, b]) => b.state.sessionId);
    const recaps = readRecaps(connected.map(([, b]) => b.state.sessionId));
    const byPane = new Map<string, Agent>();
    await Promise.all(
      connected.map(async ([pane, b]) => {
        const sessionId = b.state.sessionId;
        const facts = await sessionFacts(sessionId);
        const recap = recaps.get(sessionId);
        const transcript = transcriptPath(sessionId);
        byPane.set(pane, {
          sessionId,
          lastPrompt: facts?.lastPrompt ?? "",
          recap: recap?.text ?? "",
          recapStale: recapStale(recap, facts?.lastTurn ?? 0),
          lastActivity: facts?.lastActivity ?? 0,
          subagents: transcript ? countSubagents(subagentDir(transcript), b.state.jobs) : 0,
        });
      }),
    );
    return byPane;
  }

  async function buildState(): Promise<State> {
    const [ls, agents, settings] = await Promise.all([tern(["ls", "--json"]), readAgents(), ompSettings()]);
    let tree: Obj = {};
    try {
      tree = obj(JSON.parse(ls.out));
    } catch {}
    const groups = new Map<string, Item[]>();
    const counts: Record<string, number> = { working: 0, blocked: 0, idle: 0 };
    // What a session's extension should be: this server's protocol and the checkout's file.
    const current = { protocol: PROTOCOL, build: extension.build() };
    for (const s of arr(tree.sessions).map(obj))
      for (const t of arr(s.tabs).map(obj))
        for (const b of arr(t.blocks).map(obj)) {
          const id = String(b.id);
          const agent = agents.get(id) ?? null;
          const bridge = bridges.get(id);
          const cwd = str(b.cwd, HOME);
          const file = str(b.file);
          const note = /^note:([0-9a-f]+)$/.exec(file)?.[1];
          const doc = note ? join(NOTES_DIR, `${note}.md`) : file && isAbsolute(file) ? file : null;
          // Tern leaves file blocks untitled: name them after the file, with a file-type glyph.
          const raw = str(b.title).trim() || (note ? "Note" : doc ? basename(doc) : basename(str(b.program, id)));
          const icon = PUA.exec(raw)?.[0] ?? (doc ? docIcon(doc, !!note) : null);
          const clean = raw.replace(new RegExp(PUA.source, "gu"), "").trim();
          const m = /^([\p{Lu}\d_-]{2,14}):\s+(.*)$/u.exec(clean);
          const project = projectOf(cwd, HOME);
          const status = bridge?.state.status || null;
          // The bridge's clock starts at its connect; an idle session dates from its last entry.
          const since = status === "idle" && agent?.lastActivity ? agent.lastActivity : (bridge?.state.since ?? 0);
          if (status) counts[status] = (counts[status] ?? 0) + 1;
          // A bridge that hasn't reported yet (no status) has nothing to compare.
          const mismatch = bridge?.state.status ? sessionMismatch(bridge.state, current) : null;
          if (bridge && mismatch === "older") askRestart(bridge);
          const list = groups.get(project) ?? [];
          list.push({
            block: id,
            icon,
            tag: m ? m[1] : null,
            title: m ? m[2] : clean,
            cwd,
            project,
            branch: doc ? null : branchOf(cwd),
            agent,
            live: bridge
              ? {
                  model: bridge.state.model,
                  thinking: bridge.state.thinking,
                  levels: bridge.state.levels,
                  tiers: bridge.state.tiers,
                  tier: bridge.state.tier,
                  context: bridge.state.context && { ...bridge.state.context, compactAt: compactAtPercent(settings.compaction, bridge.state.context.window) },
                  jobs: bridge.state.jobs,
                  protocol: bridge.state.protocol,
                  caps: bridge.state.caps,
                  build: bridge.state.build,
                  mismatch,
                  restart: bridge.restart === true,
                }
              : null,
            status,
            since,
            doc,
            unseen: unseen.get(id) ?? null,
          });
          groups.set(project, list);
        }
    // A successful empty list means the last pane closed; a failed or malformed list proves nothing.
    const open = new Set([...groups.values()].flatMap((items) => items.map((i) => i.block)));
    if (!ls.error && Array.isArray(tree.sessions))
      for (const pane of unseen.keys()) if (!open.has(pane)) unseen.delete(pane);
    // Newest activity first, within projects and between them.
    const activity = (i: Item) => i.since;
    const projects = [...groups].map(([name, items]) => ({ name, items: items.sort((x, y) => activity(y) - activity(x)) }));
    projects.sort((x, y) => activity(y.items[0]) - activity(x.items[0]));
    // dist/'s build id: "" until `bun run build` has run.
    let app = "";
    try {
      app = readFileSync(join(DIST, "build-id"), "utf8").trim();
    } catch {}
    return {
      projects,
      counts,
      roles: settings.roles,
      badge: unseen.size,
      at: Date.now(),
      app,
      extension: { ...extension.install(), path: INSTALLED_EXTENSION, repo: REPO, windows: process.platform === "win32" },
    };
  }

  let stateCache: { at: number; value: Promise<State> } | null = null;
  function getState(): Promise<State> {
    if (!stateCache || Date.now() - stateCache.at > STATE_TTL_MS) stateCache = { at: Date.now(), value: buildState() };
    return stateCache.value;
  }

  /** Open streams, each rechecking the list (and its block) when called. */
  const stateWatchers = new Set<() => void>();
  let stateTimer: Timer | null = null;
  /** The list may have changed: drop the cache and have every open stream recheck, in one batch. */
  function invalidateState() {
    stateCache = null;
    // Sockets closing during `stop` report here too.
    if (stopped) return;
    stateTimer ??= setTimeout(() => {
      stateTimer = null;
      for (const fn of stateWatchers) fn();
    }, STATE_BATCH_MS);
  }
  const safety = setInterval(() => stateWatchers.size && invalidateState(), SAFETY_MS);

  /** The running `tern events`, killed by `stop`. */
  let ternEvents: Subprocess | null = null;
  /** Wakes the retry wait at `stop`. */
  let cancelRetry: (() => void) | undefined;

  /**
   * Rebuilds the list on Tern's own changes (panes opened, closed or moved, titles, cwds) instead of
   * polling `tern ls`. Pane output has no event; terminal screens stay polled while open.
   */
  async function followTernEvents() {
    while (!stopped) {
      try {
        const proc = Bun.spawn(["tern", "events"], { env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
        ternEvents = proc;
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout) {
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            let event = "";
            try {
              event = str(obj(JSON.parse(line)).event);
            } catch {}
            // Every CLI call (this server's own `tern ls` and `capture` too) logs a client pair.
            if (event && !event.startsWith("client_")) invalidateState();
          }
        }
        await proc.exited;
      } catch {}
      ternEvents = null;
      // The daemon restarting or tern updating; the safety recheck covers the gap.
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TERN_EVENTS_RETRY_MS);
        cancelRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      cancelRetry = undefined;
    }
  }
  const following = followTernEvents();

  // omp writes a recap to history.db when a session goes idle, after the status change.
  let historyWatcher: FSWatcher | null = null;
  try {
    historyWatcher = watch(dirname(HISTORY_DB), (_e, f) => f?.startsWith("history.db") && invalidateState());
    historyWatcher.on("error", () => {});
  } catch {}
  // `bun run build` swaps dist/ in with a rename: open pages learn the new id and reload.
  let distWatcher: FSWatcher | null = null;
  try {
    const distName = basename(resolve(DIST));
    distWatcher = watch(dirname(resolve(DIST)), (_e, f) => f === distName && invalidateState());
    distWatcher.on("error", () => {});
  } catch {}

  async function findItem(block: string): Promise<Item | undefined> {
    const s = await getState();
    for (const p of s.projects) for (const i of p.items) if (i.block === block) return i;
  }

  // ---------- transcript ----------

  const sessionPaths = new Map<string, string>();
  function transcriptPath(sessionId: string): string | null {
    const hit = sessionPaths.get(sessionId);
    if (hit && existsSync(hit)) return hit;
    if (!/^[\w-]+$/.test(sessionId)) return null;
    try {
      for (const rel of new Bun.Glob(`*/*_${sessionId}.jsonl`).scanSync(SESSIONS_DIR)) {
        const full = join(SESSIONS_DIR, rel);
        sessionPaths.set(sessionId, full);
        return full;
      }
    } catch {
      // omp can connect before it creates the sessions folder.
    }
    return null;
  }

  async function readChat(sessionId: string, limit: number): Promise<{ entries: ChatEntry[] } | null> {
    const path = transcriptPath(sessionId);
    if (!path) return null;
    // The session's own leaf: its bridge knows it even before anything is appended after a rewind.
    const leaf = [...bridges.values()].find((b) => b.state.sessionId === sessionId)?.state.leaf ?? "";
    const chat = await readChatFile(path, leaf, limit);
    const recaps = fromHistory((db) => querySessionRecaps(db, sessionId), []);
    return transcriptImages.attach({ entries: withRecaps(chat.entries, recaps) });
  }

  const subagentFacts = new Map<string, SubagentFacts>();
  /** A session's subagents; none while its omp isn't bridged (its transcript is unknown then). */
  async function readSubagents(item: Item): Promise<Subagent[]> {
    const transcript = item.agent ? transcriptPath(item.agent.sessionId) : null;
    return transcript ? listSubagents(subagentDir(transcript), item.live?.jobs ?? [], subagentFacts) : [];
  }

  /**
   * A block's screen. omp agents render as Tern surfaces, read as text with --surfaces (their
   * HTML runs to megabytes). Plain terminals come as Tern's colored HTML: one screen of
   * `<pre><span style=…>`, which the phone sanitizes before showing.
   */
  async function readScreen(block: string, agent: boolean): Promise<{ text: string; html: boolean }> {
    if (!agent) return { text: (await tern(["capture", block, "--html"], 15_000)).out, html: true };
    const { out } = await tern(["capture", block, "--surfaces"], 15_000);
    return { text: out.replace(/\s+$/, "").split("\n").slice(-SCREEN_LINES).join("\n"), html: false };
  }

  // ---------- input ----------

  async function sendKeys(block: string, keys: string[]): Promise<string | null> {
    const bad = keys.find((k) => KEYS[k] !== true);
    if (bad !== undefined) return `key not allowed: ${bad}`;
    return keys.length ? (await tern(["send", block, "keys", ...keys])).error : null;
  }

  async function sendText(block: string, text: string): Promise<string | null> {
    // `--` so text starting with `-` (`--help`, `-h`) is typed, not read as tern's own flags.
    return (await tern(["send", block, text.includes("\n") ? "paste" : "text", "--", text])).error;
  }

  /**
   * Submits a prompt: through the bridge's draft when connected, else typed into the pane.
   * Images need the bridge (a terminal can't take them); they go to omp as one user message.
   */
  async function submit(block: string, text: string, images: PromptImage[], followUp: boolean): Promise<string | null> {
    const b = bridges.get(block);
    if (images.length || followUp) {
      if (!b) return `${followUp ? "follow-ups" : "images"} need an omp session connected to tern-mobile (restart it)`;
      // `expected`: omp clears its editor only if it still holds the phone's draft, so desktop typing survives.
      return bridgeError(await bridgeRequest(b, { t: "send", text, images, followUp, expected: b.state.text }), "omp did not take the message");
    }
    if (!b) return (text && (await sendText(block, text))) || sendKeys(block, ["Enter"]);
    // Always set: the reported draft may be stale, and Enter must submit exactly the phone's text.
    const error = bridgeError(await bridgeRequest(b, { t: "set", text }), "omp did not take the draft");
    if (error) return error;
    return sendKeys(block, ["Enter"]);
  }

  /** Answers the pending ask dialog by typing its keys (see `answerSteps`). */
  async function answer(block: string, item: Item, body: Obj): Promise<string | null> {
    const chat = item.agent ? await readChat(item.agent.sessionId, 80) : null;
    const ask = chat?.entries.findLast((e) => e.role === "ask");
    const steps = answerSteps(ask?.role === "ask" ? ask : undefined, body);
    if (typeof steps === "string") return steps;
    for (const step of steps) {
      const err = "keys" in step ? await sendKeys(block, step.keys) : await sendText(block, step.text);
      if (err) return err;
      await Bun.sleep(150); // let omp open the prompt or the next tab before more input
    }
    return null;
  }

  // ---------- http ----------

  function json(data: unknown, status = 200): Response {
    return Response.json(data, { status, headers: { "cache-control": "no-store", "content-security-policy": CSP } });
  }

  function draftPayload(b: Bridge | null) {
    return b ? { live: true, text: b.state.text } : { live: false, text: "" };
  }

  /** Every open stream's `finish`, called by `stop`. */
  const openStreams = new Set<() => void>();
  /**
   * One phone screen's updates. Nothing here polls on a timer except terminal screens (Tern has
   * no output event): the list is rechecked when `invalidateState` batches an event, and the open
   * transcript or file when its folder reports a write to it. `view=subagents` follows a session's
   * subagent list; `sub` one subagent's chat, read-only.
   */
  function stream(req: Request, block: string | null, view: string, sub: string | null): Response {
    const enc = new TextEncoder();
    let stop = false;
    const cleanups: (() => void)[] = [];
    let finish = () => {};
    return new Response(
      new ReadableStream({
        start(ctrl) {
          // Block lookup may have awaited the CLI while the request or server was stopped.
          if (stopped || req.signal.aborted) {
            ctrl.close();
            return;
          }
          const send = (event: string, data: unknown) => {
            if (!stop) ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          finish = () => {
            if (stop) return;
            stop = true;
            for (const fn of cleanups) fn();
            try {
              ctrl.close();
            } catch {}
          };
          req.signal.addEventListener("abort", finish);
          openStreams.add(finish);
          cleanups.push(() => openStreams.delete(finish));

          // A subagent screen shows none of the session's own draft, live text or queue.
          if (block && sub === null && view !== "subagents") {
            // Drafts, live text and btw answers go out the moment omp reports them.
            let lastDraft = "";
            const onPane = (event: string, data: unknown) => {
              if (event === "leaf") return void check();
              if (event === "draft") {
                const payload = JSON.stringify(data);
                if (payload === lastDraft) return;
                lastDraft = payload;
              }
              send(event, data);
            };
            cleanups.push(listenPane(block, onPane));
            const b = bridges.get(block) ?? null;
            onPane("draft", draftPayload(b));
            if (b?.live) onPane("live", b.live);
            if (b?.state.queued.length) onPane("queued", b.state.queued);
            // Always, null included: a reconnecting phone must drop state from an omp that restarted without stretch.ts.
            onPane("stretch", b?.state.stretch ?? null);
            // Opening a session on the phone is seeing its update.
            if (unseen.delete(block)) invalidateState();
          }

          let lastState = "";
          let lastDetail = "";
          let timer: Timer | undefined;
          let followed: { path: string; watcher: FSWatcher } | null = null;
          cleanups.push(() => {
            clearTimeout(timer);
            followed?.watcher.close();
          });
          /**
           * Rechecks when `path` is written or replaced; its folder is watched, as editors save by
           * renaming. `folder`: `path` is a folder of transcripts, rechecked on any `.jsonl` write in it.
           */
          const follow = (path: string | null, folder = false) => {
            if (followed?.path === path) return;
            followed?.watcher.close();
            followed = null;
            // A check can resume after the phone left; cleanup already ran, so take nothing new.
            if (!path || stop) return;
            const name = basename(path);
            try {
              const watcher = folder
                ? watch(path, (_e, f) => f?.endsWith(".jsonl") && check())
                : watch(dirname(path), (_e, f) => f === name && check());
              watcher.on("error", () => {});
              followed = { path, watcher };
            } catch {
              // A missing folder (no subagent has started yet): the next check tries again.
            }
          };

          const step = async () => {
            const s = await getState();
            const key = JSON.stringify([s.projects, s.counts, s.roles, s.extension, s.badge, s.app]);
            if (key !== lastState) {
              lastState = key;
              send("state", s);
            }
            const item = block ? await findItem(block) : undefined;
            if (stop) return;
            clearTimeout(timer);
            if (sub !== null || view === "subagents") {
              // A session's subagents sit beside its transcript, known while its omp is bridged.
              const transcript = item?.agent ? transcriptPath(item.agent.sessionId) : null;
              if (sub === null) {
                follow(transcript && subagentDir(transcript), true);
                const list = item ? await readSubagents(item) : [];
                const etag = JSON.stringify(list);
                if (etag !== lastDetail) {
                  lastDetail = etag;
                  send("subagents", list);
                }
              } else {
                const path = transcript && subagentFile(transcript, sub);
                follow(path);
                const file = path && regularFile(path) ? path : null;
                const st = file ? statSync(file) : null;
                const etag = st ? `${file}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : "none";
                if (etag !== lastDetail) {
                  // No bridge speaks for a subagent: its file's last entry is its leaf.
                  const chat = file ? await transcriptImages.attach(await readChatFile(file, "", 80)) : { entries: [] };
                  lastDetail = etag;
                  send("chat", chat);
                }
              }
            } else if (item?.doc) {
              const path = item.doc;
              follow(path);
              const st = existsSync(path) ? statSync(path) : null;
              const etag = st ? `${path}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : "none";
              if (etag !== lastDetail) {
                const text = st && st.isFile() ? await Bun.file(path).slice(0, DOC_MAX_BYTES).text() : "";
                lastDetail = etag;
                send("doc", { text, markdown: /\.(md|markdown)$/i.test(path), missing: !st, clipped: (st?.size ?? 0) > DOC_MAX_BYTES });
              }
            } else if (item?.agent && view === "chat") {
              const path = transcriptPath(item.agent.sessionId);
              follow(path);
              const st = path ? statSync(path) : null;
              // The recap: omp writes it to history.db once the session sat idle, with the transcript unchanged.
              const etag = st ? `${path}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${bridges.get(block!)?.state.leaf ?? ""}:${item.agent.recap}` : "none";
              if (etag !== lastDetail) {
                const chat = await readChat(item.agent.sessionId, 80);
                lastDetail = etag;
                send("chat", chat);
              }
            } else {
              follow(null);
              if (!item) return;
              const screen = await readScreen(item.block, item.agent !== null || item.live !== null);
              if (screen.text !== lastDetail) {
                lastDetail = screen.text;
                send("screen", screen);
              }
              // Terminals echo typing; poll them fast so the phone keeps up.
              const terminal = !item.agent && !item.live;
              if (!stop) timer = setTimeout(check, terminal ? 450 : 1200);
            }
          };

          // One check at a time; a trigger during one runs another right after it.
          let running = false;
          let again = false;
          const check = async () => {
            if (stop) return;
            if (running) return void (again = true);
            running = true;
            try {
              do {
                again = false;
                await step();
              } while (again && !stop);
            } catch (err) {
              send("error", { message: String(err) });
            } finally {
              running = false;
            }
          };
          stateWatchers.add(check);
          cleanups.push(() => stateWatchers.delete(check));
          const ping = setInterval(() => !stop && ctrl.enqueue(enc.encode(": ping\n\n")), PING_MS);
          cleanups.push(() => clearInterval(ping));
          void check();
        },
        cancel() {
          finish();
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } },
    );
  }

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/state") return json(await getState());
    if (req.method === "GET" && path === "/api/stream") {
      const block = url.searchParams.get("block");
      const sub = url.searchParams.get("sub");
      // The name comes from the URL: only a plain name reaches the session's subagent folder.
      if (sub !== null && !(block && validSubagentName(sub))) return json({ error: "bad subagent" }, 400);
      if (block && !(await findItem(block))) return json({ error: "no such block" }, 404);
      return stream(req, block, url.searchParams.get("view") ?? "chat", sub);
    }
    const subagents = /^\/api\/blocks\/(\d+)\/subagents$/.exec(path);
    if (req.method === "GET" && subagents) {
      const item = await findItem(subagents[1]);
      return item ? json({ subagents: await readSubagents(item) }) : json({ error: "no such block" }, 404);
    }
    const btwHistory = /^\/api\/blocks\/(\d+)\/btw-history$/.exec(path);
    if (req.method === "GET" && btwHistory) {
      const item = await findItem(btwHistory[1]);
      if (!item) return json({ error: "no such block" }, 404);
      if (!item.agent || !bridges.has(btwHistory[1])) return json({ error: "no bridged omp session" }, 409);
      const transcript = transcriptPath(item.agent.sessionId);
      if (!transcript) return json({ error: "session transcript unavailable" }, 404);
      try {
        return json({ records: await readBtwHistory(transcript) });
      } catch {
        return json({ error: "could not read btw history" }, 500);
      }
    }
    const blob = /^\/api\/blob\/([0-9a-f]{64})$/.exec(path);
    if (req.method === "GET" && blob) {
      const type = url.searchParams.get("type") ?? "";
      if (IMAGE_MIMES[type] !== true) return json({ error: "no such image" }, 404);
      const cached = await transcriptImages.get(blob[1]);
      if (cached?.type === type)
        return new Response(cached.bytes, { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable", "content-security-policy": CSP } });
      const file = Bun.file(join(BLOBS_DIR, blob[1]));
      if (!(await file.exists())) return json({ error: "no such image" }, 404);
      // Content-addressed: the bytes behind a hash never change.
      return new Response(file, { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable", "content-security-policy": CSP } });
    }
    if (req.method === "GET" && path === "/api/projects") {
      // Folders for a new omp: the open blocks' and past omp sessions' cwds, or a configured command's list.
      let projects: string[];
      if (PROJECTS_SCRIPT) {
        const cmd = /\.py$/i.test(PROJECTS_SCRIPT) ? ["python3", PROJECTS_SCRIPT] : [PROJECTS_SCRIPT];
        // A missing, hanging or failed command lists nothing; the server keeps serving meanwhile.
        const out = (await commandOutput(cmd, PROJECTS_TIMEOUT_MS)) ?? "";
        projects = out
          .split("\n")
          .map((l) => l.trim())
          .filter((p) => {
            try {
              return isAbsolute(p) && statSync(p).isDirectory();
            } catch {
              return false;
            }
          });
      } else {
        const open = (await getState()).projects.flatMap((p) => p.items).filter((i) => !i.doc).map((i) => i.cwd);
        projects = await recentProjects(SESSIONS_DIR, open);
      }
      // `home` lets the phone show paths under it as ~, whatever the separators.
      return json({ projects, home: HOME });
    }
    if (req.method === "GET" && path === "/api/push/key") return json({ key: VAPID.publicKey });
    if (req.method !== "POST") return json({ error: "not found" }, 404);

    // Cross-site forms cannot set custom headers; this keeps the POSTs same-origin.
    if (req.headers.get("x-tern-mobile") !== "1") return json({ error: "missing header" }, 403);
    const m = /^\/api\/blocks\/(\d+)\/(keys|type|submit|draft|answer|model|models|thinking|tier|focus|abort|btw|close|complete|completion|rewind|stretch)$/.exec(path);
    // Commands with no arguments may omit the body; payload-bearing actions must send JSON.
    const bodyless = req.body === null && /^(models|focus|abort|close)$/.test(m?.[2] ?? "");
    const raw: unknown = bodyless ? {} : await req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "expected a JSON object" }, 400);
    const body = obj(raw);
    if (path === "/api/push/subscribe" || path === "/api/push/unsubscribe") {
      const endpoint = str(body.endpoint);
      if (!endpoint.startsWith("https://")) return json({ error: "bad subscription" }, 400);
      if (path.endsWith("/subscribe")) {
        const keys = obj(body.keys);
        if (!str(keys.p256dh) || !str(keys.auth)) return json({ error: "bad subscription" }, 400);
        pushSubs.set(endpoint, { endpoint, keys: { p256dh: str(keys.p256dh), auth: str(keys.auth) } });
      }
      // An unsubscribe is also how the service worker retires a subscription the browser replaced,
      // so it doesn't mean notifications were turned off.
      else if (pushSubs.delete(endpoint)) console.log(`push: a device on ${endpoint.split("/")[2]} removed a subscription`);
      savePushSubs();
      return json({ ok: true });
    }
    const done = (err: string | null) => (err ? json({ error: err }, 502) : json({ ok: true }));
    // Bun drops WebSocket frames over 16 MB, and a draft that big would loop the bridge's reconnects.
    if (typeof body.text === "string" && body.text.length > MAX_TEXT) return json({ error: "text too long" }, 400);

    if (m) {
      const [, block, action] = m;
      const item = await findItem(block);
      if (!item) return json({ error: "no such block" }, 404);
      const bridge = bridges.get(block);
      switch (action) {
        case "focus":
          return done((await tern(["focus", block])).error);
        case "abort":
          // Stops the running turn; without the bridge, Escape is omp's interrupt key.
          if (!bridge) return done(await sendKeys(block, ["Escape"]));
          return done(bridgeError(await bridgeRequest(bridge, { t: "abort" })));
        case "btw": {
          // A side question; the answer streams to this block's phones as `btw` events.
          const text = str(body.text).trim();
          if (!text) return json({ error: "empty question" }, 400);
          if (!bridge) return json({ error: "no bridge" }, 409);
          const id = crypto.randomUUID();
          const error = bridgeError(await bridgeRequest(bridge, { t: "btw", id, text }));
          return error ? done(error) : json({ id });
        }
        case "rewind": {
          // omp's Rewind on a prompt: the session goes back to before it and the prompt returns to
          // the editor. Only a command context can move the leaf, so the extension's command runs it.
          const entry = str(body.entry);
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry)) return json({ error: "bad entry" }, 400);
          if (!bridge) return json({ error: "rewind needs an omp session connected to tern-mobile (restart it)" }, 409);
          if (bridge.state.caps?.rewind === false) return json({ error: "this omp can't rewind from tern-mobile (update omp)" }, 409);
          if (bridge.state.status !== "idle") return json({ error: "stop the agent first" }, 409);
          return done(await submit(block, `/tern-mobile-rewind ${entry}`, [], false));
        }
        case "close": {
          // Closes the block in Tern itself, so on the desktop too; the phone confirms first.
          const err = (await tern(["close", block])).error;
          invalidateState();
          return done(err);
        }
        case "keys":
          return done(await sendKeys(block, arr(body.keys).map((k) => str(k))));
        case "type": {
          // Live typing into a terminal's own prompt: erase what changed, then type the rest.
          const back = Math.max(Math.trunc(num(body.back)), 0);
          if (!Number.isSafeInteger(back)) return json({ error: "bad backspace count" }, 400);
          for (let remaining = back; remaining > 0; remaining -= 500) {
            const error = await sendKeys(block, Array(Math.min(remaining, 500)).fill("Backspace"));
            if (error) return done(error);
          }
          const text = str(body.text);
          return done(text ? await sendText(block, text) : null);
        }
        case "submit": {
          const images = promptImages(body.images);
          if (typeof images === "string") return json({ error: images }, 400);
          return done(await submit(block, str(body.text), images, body.followUp === true));
        }
        case "stretch": {
          // Opens or closes a stretch of a reply in the pane too (omp's stretch.ts), so the desktop
          // shows what the phone opened and the next prompt's read note counts it.
          const reply = str(body.block);
          const key = str(body.key);
          if (!STRETCH_BLOCK.test(reply) || !key || key.length > 4000) return json({ error: "bad stretch" }, 400);
          if (!bridge?.state.stretch) return json({ error: "this omp doesn't run stretch.ts" }, 409);
          return done(bridgeError(await bridgeRequest(bridge, { t: "stretch", block: reply, key, open: body.open === true })));
        }
        case "answer":
          return done(await answer(block, item, body));
        case "draft":
          if (!bridge) return json({ error: "no bridge" }, 409);
          if (body.expectedSessionId !== undefined && typeof body.expectedSessionId !== "string")
            return json({ error: "bad expected session" }, 400);
          if (body.expectedSessionId !== undefined && body.expectedSessionId !== bridge.state.sessionId)
            return json({ error: "session changed" }, 409);
          if (body.expectedText !== undefined && typeof body.expectedText !== "string")
            return json({ error: "bad expected draft" }, 400);
          if (body.expectedText !== undefined && body.expectedText !== bridge.state.text)
            return json({ error: "draft changed" }, 409);
          // `expected`: omp sets the draft only if its editor still holds what the phone saw.
          return done(bridgeError(await bridgeRequest(bridge, {
            t: "set",
            text: str(body.text),
            ...(typeof body.expectedText === "string" && { expected: body.expectedText }),
          })));
        case "model": {
          // A Ctrl+P role (its model and thinking), or any model omp lists: `provider/id`.
          const spec = body.role !== undefined ? (await ompSettings()).roles.find((r) => r.role === str(body.role))?.spec : str(body.spec);
          if (!spec || !spec.includes("/")) return json({ error: "unknown model" }, 400);
          if (!bridge) return json({ error: "no bridge" }, 409);
          invalidateState();
          return done(bridgeError(await bridgeRequest(bridge, { t: "model", spec })));
        }
        case "models": {
          // The picker's full list; the same on every session, so one fetch serves a few minutes.
          if (!bridge) return json({ error: "no bridge" }, 409);
          if (bridge.state.caps?.models === false) return json({ error: "this omp can't list its models (update omp)" }, 409);
          if (!modelsCache || Date.now() - modelsCache.at > MODELS_TTL_MS) {
            const r = await bridgeRequest(bridge, { t: "models" });
            const error = bridgeError(r);
            if (error) return done(error);
            modelsCache = { at: Date.now(), value: arr(r?.models) };
          }
          return json({ models: modelsCache.value });
        }
        case "thinking":
          if (!bridge) return json({ error: "no bridge" }, 409);
          return done(bridgeError(await bridgeRequest(bridge, { t: "thinking", level: str(body.level) })));
        case "tier":
          if (!bridge) return json({ error: "no bridge" }, 409);
          if (bridge.state.caps?.tiers === false) return json({ error: "this omp has no service tiers (update omp)" }, 409);
          return done(bridgeError(await bridgeRequest(bridge, { t: "tier", tier: str(body.tier) })));
        case "complete": {
          // omp's own autocomplete (slash commands, /skill:…, @files) for the phone's text.
          if (!bridge) return json({ error: "no bridge" }, 409);
          const r = await bridgeRequest(bridge, { t: "complete", text: str(body.text) });
          const error = bridgeError(r);
          if (error) return done(error);
          return json({ prefix: str(r?.prefix), items: arr(r?.items).map(obj).map((i) => ({ value: str(i.value), label: str(i.label), description: str(i.description) })) });
        }
        case "completion": {
          // Applies a picked suggestion in omp, which also sets the desktop draft; returns the new text.
          if (!bridge) return json({ error: "no bridge" }, 409);
          const r = await bridgeRequest(bridge, { t: "apply", text: str(body.text), value: str(body.value), label: str(body.label), prefix: str(body.prefix) });
          if (r?.error) return done(bridgeError(r));
          if (!r || typeof r.text !== "string") return json({ error: "omp did not apply it" }, 502);
          return json({ text: r.text });
        }
      }
    }

    if (path === "/api/new") {
      const cwd = str(body.cwd);
      if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory())
        return json({ error: "cwd must be an existing directory" }, 400);
      const r = await tern(["new", "tab", "--cwd", cwd, "--json", "--", "omp"]);
      if (r.error) return json({ error: r.error }, 502);
      invalidateState();
      try {
        return json({ block: String(obj(JSON.parse(r.out)).block) });
      } catch {
        return json({ ok: true });
      }
    }
    return json({ error: "not found" }, 404);
  }

  function bridgeAuthorized(req: Request): boolean {
    return sameToken(req.headers.get("x-tern-mobile-bridge") ?? "", BRIDGE_TOKEN);
  }

  /** Whether a request's `Host` header (port aside) names this server; a missing or malformed one doesn't. */
  function knownHost(host: string | null): boolean {
    const name = /^(\[[\d:a-f.]+\]|[\w.-]+)(?::\d{1,5})?$/i.exec(host ?? "")?.[1];
    return !!name && HOSTS.has(name.toLowerCase().replace(/\.$/, ""));
  }

  /** Every bridge connection per pane; the newest is the pane's bridge. */
  const paneSockets = new Map<string, Set<ServerWebSocket<{ pane: string | null }>>>();

  /** A different session must not inherit the previous one's transient output or finish timer. */
  function resetPane(pane: string) {
    clearTimeout(doneTimers.get(pane));
    doneTimers.delete(pane);
    emit(pane, "live", { text: "", done: false });
    emit(pane, "queued", []);
    emit(pane, "stretch", null);
  }

  /** A connection stopped speaking for its pane: its pending requests fail now, not at their timeout. */
  function abandonRequests(b: Bridge) {
    for (const settle of b.waiting.values()) settle(null);
    b.waiting.clear();
  }

  /** A connection now speaks for `pane`: its state starts over until it reports. */
  function registerBridge(pane: string, ws: ServerWebSocket<{ pane: string | null }>) {
    const previous = bridges.get(pane);
    if (previous) {
      previous.ws.send(JSON.stringify({ t: "watch", on: false }));
      abandonRequests(previous);
      resetPane(pane);
    }
    bridges.set(pane, {
      ws,
      state: emptyState(Date.now()),
      waiting: new Map(),
      live: null,
      restart: "unasked",
    });
    invalidateState();
    // A fresh connection starts unwatched; tell it if a phone already looks at this pane.
    if (paneListeners.has(pane)) tellWatched(pane);
  }

  /**
   * Forgets a connection. When it was the pane's bridge, the pane's newest other connection takes
   * over: older extensions bridged an omp's subagents too, under the same pane, and one exiting
   * left the main session unbridged. `sync` makes the survivor report at once (every extension
   * version answers an unknown command with a snapshot).
   */
  function dropSocket(ws: ServerWebSocket<{ pane: string | null }>) {
    const pane = ws.data.pane;
    if (!pane) return;
    const set = paneSockets.get(pane);
    set?.delete(ws);
    if (!set?.size) paneSockets.delete(pane);
    if (bridges.get(pane)?.ws !== ws) return;
    abandonRequests(bridges.get(pane)!);
    resetPane(pane);
    bridges.delete(pane);
    const next = set?.size ? [...set].at(-1) : undefined;
    if (next) {
      registerBridge(pane, next);
      next.send(JSON.stringify({ t: "sync" }));
      return;
    }
    invalidateState();
    notifyBridge(pane);
  }

  /** Ends everything this server started; safe to call twice. */
  async function stop() {
    if (stopped) return;
    stopped = true;
    cancelRetry?.();
    clearInterval(safety);
    for (const timer of doneTimers.values()) clearTimeout(timer);
    ternEvents?.kill();
    historyWatcher?.close();
    distWatcher?.close();
    for (const finish of [...openStreams]) finish();
    await server?.stop(true);
    clearTimeout(stateTimer ?? undefined);
    historyDb?.close();
    await following;
  }

  let server: Server<{ pane: string | null }> | undefined;
  try {
    server = Bun.serve<{ pane: string | null }>({
      hostname: "127.0.0.1",
      port: PORT,
      idleTimeout: 0, // SSE streams stay open
      async fetch(req, server) {
        if (!knownHost(req.headers.get("host"))) return new Response("unknown host: add it to TERN_AWUI_HOSTS", { status: 403 });
        const url = new URL(req.url);
        // omp sessions on this machine; Tailscale Serve requests always carry a login header.
        if (url.pathname === "/bridge" && !req.headers.get("tailscale-user-login")) {
          if (!bridgeAuthorized(req)) return new Response("forbidden", { status: 403 });
          return server.upgrade(req, { data: { pane: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
        }
        const login = req.headers.get("tailscale-user-login");
        if (ALLOW.length && !(login && ALLOW.includes(login))) return new Response("forbidden", { status: 403 });
        if (url.pathname.startsWith("/api/")) return handleApi(req, url);
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (rel.includes("..")) return new Response("bad path", { status: 400 });
        const file = Bun.file(join(DIST, rel));
        const index = Bun.file(join(DIST, "index.html"));
        if (!(await index.exists())) return new Response("not built: run `bun run build`", { status: 404 });
        return new Response((await file.exists()) ? file : index, {
          // The 1 MB symbols font changes only with the Nerd Font package.
          headers: { "cache-control": rel === "symbols.woff2" ? "max-age=604800" : "no-cache", "content-security-policy": CSP },
        });
      },
      websocket: {
        message(ws, raw) {
          let msg: Obj;
          try {
            msg = obj(JSON.parse(String(raw)));
          } catch {
            return;
          }
          if (msg.t === "btw" && ws.data.pane) {
            if (bridges.get(ws.data.pane)?.ws !== ws) return;
            const payload = { id: str(msg.id), text: str(msg.text), done: msg.done === true, error: str(msg.error) };
            emit(ws.data.pane, "btw", payload);
            return;
          }
          if (msg.t === "live" && ws.data.pane) {
            const b = bridges.get(ws.data.pane);
            if (!b || b.ws !== ws) return;
            const payload = { text: str(msg.text), done: msg.done === true };
            b.live = payload.done ? null : payload;
            emit(ws.data.pane, "live", payload);
            return;
          }
          if (msg.t === "reply" && typeof msg.seq === "number") {
            const b = ws.data.pane ? bridges.get(ws.data.pane) : undefined;
            if (b?.ws !== ws) return;
            b?.waiting.get(msg.seq)?.(msg);
            b?.waiting.delete(msg.seq);
            return;
          }
          if (msg.t !== "state" || !/^\d+$/.test(str(msg.pane))) return;
          const pane = str(msg.pane);
          if (ws.data.pane !== pane) {
            if (ws.data.pane) dropSocket(ws);
            ws.data.pane = pane;
            const set = paneSockets.get(pane) ?? new Set();
            paneSockets.set(pane, set.add(ws));
            registerBridge(pane, ws);
          }
          const b = bridges.get(pane);
          if (!b || b.ws !== ws) return;
          const before = b.state;
          b.state = parseBridgeState(msg, before, Date.now());
          const status = b.state.status;
          const changedSession = Boolean(before.sessionId) && before.sessionId !== b.state.sessionId;
          if (changedSession) {
            b.live = null;
            resetPane(pane);
          }
          if ((changedSession || status === "working") && unseen.delete(pane)) invalidateState();
          // A rewind moves the leaf without writing to the file: the open chat must re-read.
          if (before.leaf !== b.state.leaf) emit(pane, "leaf", null);
          if (JSON.stringify(before.queued) !== JSON.stringify(b.state.queued)) emit(pane, "queued", b.state.queued);
          if (JSON.stringify(before.stretch) !== JSON.stringify(b.state.stretch)) emit(pane, "stretch", b.state.stretch);
          if (listChanged(before, b.state)) invalidateState();
          // `before.status` is empty on a fresh connection: a restarted omp is not a finished turn.
          if (!changedSession && before.status && before.status !== status) onStatusChange(pane, before.status, status, b.state.sessionId);
          notifyBridge(pane);
          if (typeof msg.seq === "number") {
            b.waiting.get(msg.seq)?.(msg);
            b.waiting.delete(msg.seq);
          }
        },
        close(ws) {
          dropSocket(ws);
        },
      },
    });
  } catch (err) {
    // The port is taken, say: nothing may keep running.
    void stop();
    throw err;
  }
  return { port: server.port!, allow: ALLOW, stop };
}

if (import.meta.main) {
  const { port, allow } = startServer();
  console.log(
    `tern-mobile on http://127.0.0.1:${port} ${allow.length ? `allow=${allow.join(",")}` : "(no login check: whoever reaches this port controls your terminals)"}`,
  );
}
