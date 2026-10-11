// tern-mobile: a phone-sized control surface for the Tern panes on this machine.
// Reads blocks from `tern ls --json`, omp transcripts from omp's sessions folder and recaps
// from its history.db (see lib/paths.ts for where omp keeps them); writes input with `tern send`.
// omp sessions running the tern-mobile extension also connect to /bridge: they stream their
// prompt draft, model and busy state, and take drafts and model picks from the phone.
// Listens on loopback only; `tailscale serve` is the way in. Its identity header and the
// pairing cookie (`bun server.ts pair` prints the link that sets it) are the gate.

import { Database } from "bun:sqlite";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import type { ServerWebSocket } from "bun";
import webpush, { type PushSubscription } from "web-push";
import { arr, num, obj, str, type Obj } from "./lib/json";
import { IMAGE_MIMES, readChatFile, recapStale, scanFacts, type ChatEntry, type Facts } from "./lib/transcript";
import { compactAtPercent, type Compaction } from "./lib/compaction";
import { branchOf, projectOf } from "./lib/git";
import { queryRecaps } from "./lib/recaps";
import { answerSteps, KEYS, promptImages, type PromptImage } from "./lib/input";
import { emptyState, listChanged, parseBridgeState, type BridgeState, type Caps, type Context, type Job } from "./lib/bridge-state";
import { configDir, ompDataDir, ternNotesDir } from "./lib/paths";
import { cookieValue, ensureToken, PAIR_COOKIE, sameToken } from "./lib/auth";
import { recentProjects } from "./lib/projects";
import { vapidSubject } from "./lib/push";

const HOME = homedir();
const CONFIG_DIR = configDir(process.env, HOME);
const ACCESS_TOKEN_FILE = join(CONFIG_DIR, "access-token");

// `bun server.ts pair`: the pairing link's path, for installers to put behind the tailnet URL.
if (process.argv[2] === "pair") {
  console.log(`/pair?code=${ensureToken(ACCESS_TOKEN_FILE)}`);
  process.exit(0);
}

const PORT = Number(process.env.TERN_MOBILE_PORT ?? 4380);
const ALLOW = (process.env.TERN_MOBILE_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DEV = process.env.TERN_MOBILE_DEV === "1";
const OMP_DATA = ompDataDir(process.env, HOME, process.platform);
const SESSIONS_DIR = join(OMP_DATA, "sessions");
const HISTORY_DB = join(OMP_DATA, "history.db");
const BLOBS_DIR = join(OMP_DATA, "blobs");
const NOTES_DIR = ternNotesDir(process.env, HOME, process.platform);
const DOC_MAX_BYTES = 512 * 1024;
/** A command printing one folder per line; `.py` runs with python3. Unset: lib/projects.ts. */
const PROJECTS_SCRIPT = process.env.TERN_MOBILE_PROJECTS ?? "";
const DIST = fileURLToPath(new URL("./dist/", import.meta.url));
/** Browsers cap cookie lifetimes at 400 days. */
const PAIR_MAX_AGE_S = 400 * 24 * 3600;

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

if (!DEV && ALLOW.length === 0) {
  console.error("TERN_MOBILE_ALLOW must list the Tailscale logins allowed in (or set TERN_MOBILE_DEV=1)");
  process.exit(2);
}

const BRIDGE_TOKEN = ensureToken(join(CONFIG_DIR, "bridge-token"));
const ACCESS_TOKEN = ensureToken(ACCESS_TOKEN_FILE);

// ---------- web push ----------

const VAPID_FILE = join(CONFIG_DIR, "vapid.json");
const PUSH_FILE = join(CONFIG_DIR, "push.json");
/** A finish is reported only if the session stays idle this long (no follow-up turn). */
const DONE_SETTLE_MS = 3000;

if (!existsSync(VAPID_FILE)) writeFileSync(VAPID_FILE, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
const VAPID: { publicKey: string; privateKey: string } = JSON.parse(readFileSync(VAPID_FILE, "utf8"));
webpush.setVapidDetails(vapidSubject(process.env, ALLOW), VAPID.publicKey, VAPID.privateKey);

const pushSubs = new Map<string, PushSubscription>(
  existsSync(PUSH_FILE) ? arr(JSON.parse(readFileSync(PUSH_FILE, "utf8"))).map((s) => [str(obj(s).endpoint), s as PushSubscription]) : [],
);
function savePushSubs() {
  writeFileSync(PUSH_FILE, JSON.stringify([...pushSubs.values()]), { mode: 0o600 });
}

/** Tells every subscribed phone that a session finished a turn or waits on the user. */
async function pushStatus(pane: string, kind: "done" | "blocked", sessionId: string) {
  if (!pushSubs.size) return;
  const item = await findItem(pane);
  const title = item ? `${item.tag ? `${item.tag}: ` : ""}${item.title}` : "omp";
  const entries = sessionId ? ((await readChat(sessionId, 20))?.entries ?? []) : [];
  const ask = kind === "blocked" ? entries.findLast((e) => e.role === "ask") : undefined;
  const said = entries.findLast((e) => e.role === "assistant");
  const detail =
    ask?.role === "ask" ? ask.questions[0]?.question : said?.role === "assistant" ? said.text.replace(/[*`#_>]/g, "") : "";
  const body = `${kind === "blocked" ? "Needs you" : "Finished"}${detail ? ` · ${detail.trim().slice(0, 160)}` : ""}`;
  // `badge`: the app icon's count of unseen updates, set by the service worker while the app is closed.
  const payload = JSON.stringify({ title, body, block: pane, badge: unseen.size });
  await Promise.all(
    [...pushSubs.values()].map((sub) =>
      webpush.sendNotification(sub, payload, { TTL: 900, urgency: "high" }).catch((err: { statusCode?: number }) => {
        // 404/410: the browser dropped the subscription.
        if (err.statusCode === 404 || err.statusCode === 410) {
          pushSubs.delete(sub.endpoint);
          savePushSubs();
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
  if (to === "working" && unseen.delete(pane)) invalidateState();
  if (to === "blocked") {
    markUnseen(pane, "blocked");
    void pushStatus(pane, "blocked", sessionId);
  } else if (to === "idle" && from === "working")
    doneTimers.set(
      pane,
      setTimeout(() => {
        doneTimers.delete(pane);
        if (bridges.get(pane)?.state.status !== "idle") return;
        markUnseen(pane, "done");
        void pushStatus(pane, "done", sessionId);
      }, DONE_SETTLE_MS),
    );
}

// ---------- tern CLI ----------

/**
 * Runs tern; `error` is set when it failed. tern can print an error and still exit 0
 * (`tern send BLOCK keys Bogus`), so stderr counts too, minus its WARN noise.
 */
async function tern(args: string[], timeoutMs = 10_000): Promise<{ out: string; error: string | null }> {
  const proc = Bun.spawn(["tern", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
  /** Pending requests by seq; resolved with omp's reply (a snapshot, or a `reply` payload). */
  waiting: Map<number, (reply: Obj) => void>;
  /** The assistant message omp is writing right now, while a phone watches; null between messages. */
  live: { text: string; done: boolean } | null;
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
function bridgeError(reply: Obj | null): string | null {
  return reply ? (reply.error ? str(reply.error) : null) : "omp did not answer";
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

/** `omp config get KEY` as parsed JSON; null when omp is missing or the key is unset. */
function ompConfig(key: string): unknown {
  try {
    const r = Bun.spawnSync(["omp", "config", "get", key], { stderr: "ignore" });
    return JSON.parse(r.stdout.toString());
  } catch {
    return null;
  }
}

/** Ctrl+P roles from omp's settings: `cycleOrder` names roles, `modelRoles` maps them to models. */
type Role = { role: string; spec: string };
let rolesCache: { at: number; value: Role[] } | null = null;
function modelRoles(): Role[] {
  if (rolesCache && Date.now() - rolesCache.at < ROLES_TTL_MS) return rolesCache.value;
  // A missing or moved omp only costs the model picker, never the block list.
  const map = obj(ompConfig("modelRoles"));
  const value = arr(ompConfig("cycleOrder"))
    .map((r) => ({ role: str(r), spec: str(map[str(r)]) }))
    .filter((r) => r.role && r.spec);
  rolesCache = { at: Date.now(), value };
  return value;
}

let compactionCache: { at: number; value: Compaction } | null = null;
function compactionSettings(): Compaction {
  if (compactionCache && Date.now() - compactionCache.at < ROLES_TTL_MS) return compactionCache.value;
  const reserve = ompConfig("compaction.reserveTokens");
  const value = {
    enabled: ompConfig("compaction.enabled") !== false,
    thresholdTokens: num(ompConfig("compaction.thresholdTokens")),
    thresholdPercent: num(ompConfig("compaction.thresholdPercent")),
    reserveTokens: typeof reserve === "number" ? reserve : null,
  };
  compactionCache = { at: Date.now(), value };
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
};

// Nerd-font icons live in the private use areas; the app ships the symbols font for them.
const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/u;

const factsCache = new Map<string, Facts>();

/** What the list shows of a session's transcript, scanned from where the previous scan stopped. */
async function sessionFacts(sessionId: string): Promise<Facts | null> {
  const path = transcriptPath(sessionId);
  if (!path) return null;
  const facts = await scanFacts(path, factsCache.get(path));
  factsCache.set(path, facts);
  return facts;
}

let historyDb: Database | null = null;
/** The newest recap omp wrote for each session, with its time (whole seconds). */
function readRecaps(ids: string[]): Map<string, { text: string; createdAt: number }> {
  if (!ids.length) return new Map();
  try {
    historyDb ??= new Database(HISTORY_DB, { readonly: true });
    return queryRecaps(historyDb, ids);
  } catch {
    // No history.db yet, or a schema this omp doesn't have: rows go without recaps.
    historyDb?.close();
    historyDb = null;
    return new Map();
  }
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
      byPane.set(pane, {
        sessionId,
        lastPrompt: facts?.lastPrompt ?? "",
        recap: recap?.text ?? "",
        recapStale: recapStale(recap, facts?.lastTurn ?? 0),
        lastActivity: facts?.lastActivity ?? 0,
      });
    }),
  );
  return byPane;
}

async function buildState(): Promise<State> {
  const [ls, agents] = await Promise.all([tern(["ls", "--json"]), readAgents()]);
  let tree: Obj = {};
  try {
    tree = obj(JSON.parse(ls.out));
  } catch {}
  const groups = new Map<string, Item[]>();
  const counts: Record<string, number> = { working: 0, blocked: 0, idle: 0 };
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
        const raw = str(b.title, basename(str(b.program, id))).trim();
        const icon = PUA.exec(raw)?.[0] ?? null;
        const clean = raw.replace(new RegExp(PUA.source, "gu"), "").trim();
        const m = /^([\p{Lu}\d_-]{2,14}):\s+(.*)$/u.exec(clean);
        const project = projectOf(cwd, HOME);
        const status = bridge?.state.status || null;
        // The bridge's clock starts at its connect; an idle session dates from its last entry.
        const since = status === "idle" && agent?.lastActivity ? agent.lastActivity : (bridge?.state.since ?? 0);
        if (status) counts[status] = (counts[status] ?? 0) + 1;
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
                context: bridge.state.context && { ...bridge.state.context, compactAt: compactAtPercent(compactionSettings(), bridge.state.context.window) },
                jobs: bridge.state.jobs,
                protocol: bridge.state.protocol,
                caps: bridge.state.caps,
              }
            : null,
          status,
          since,
          doc,
          unseen: unseen.get(id) ?? null,
        });
        groups.set(project, list);
      }
  // Closed panes can't be opened any more; their updates leave the badge. (An empty tree is a
  // failed `tern ls`, not every pane closed.)
  const open = new Set([...groups.values()].flatMap((items) => items.map((i) => i.block)));
  if (open.size) for (const pane of unseen.keys()) if (!open.has(pane)) unseen.delete(pane);
  // Newest activity first, within projects and between them.
  const activity = (i: Item) => i.since;
  const projects = [...groups].map(([name, items]) => ({ name, items: items.sort((x, y) => activity(y) - activity(x)) }));
  projects.sort((x, y) => activity(y.items[0]) - activity(x.items[0]));
  return { projects, counts, roles: modelRoles(), badge: unseen.size, at: Date.now() };
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
  stateTimer ??= setTimeout(() => {
    stateTimer = null;
    for (const fn of stateWatchers) fn();
  }, STATE_BATCH_MS);
}
setInterval(() => stateWatchers.size && invalidateState(), SAFETY_MS);

/**
 * Rebuilds the list on Tern's own changes (panes opened, closed or moved, titles, cwds) instead of
 * polling `tern ls`. Pane output has no event; terminal screens stay polled while open.
 */
async function followTernEvents() {
  for (;;) {
    try {
      const proc = Bun.spawn(["tern", "events"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
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
    // The daemon restarting or tern updating; the safety recheck covers the gap.
    await Bun.sleep(TERN_EVENTS_RETRY_MS);
  }
}
void followTernEvents();

// omp writes a recap to history.db when a session goes idle, after the status change.
try {
  watch(dirname(HISTORY_DB), (_e, f) => f?.startsWith("history.db") && invalidateState()).on("error", () => {});
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
  for (const rel of new Bun.Glob(`*/*_${sessionId}.jsonl`).scanSync(SESSIONS_DIR)) {
    const full = join(SESSIONS_DIR, rel);
    sessionPaths.set(sessionId, full);
    return full;
  }
  return null;
}

async function readChat(sessionId: string, limit: number): Promise<{ entries: ChatEntry[] } | null> {
  const path = transcriptPath(sessionId);
  if (!path) return null;
  // The session's own leaf: its bridge knows it even before anything is appended after a rewind.
  const leaf = [...bridges.values()].find((b) => b.state.sessionId === sessionId)?.state.leaf ?? "";
  return readChatFile(path, leaf, limit);
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
  return (await tern(["send", block, text.includes("\n") ? "paste" : "text", text])).error;
}

/**
 * Submits a prompt: through the bridge's draft when connected, else typed into the pane.
 * Images need the bridge (a terminal can't take them); they go to omp as one user message.
 */
async function submit(block: string, text: string, images: PromptImage[], followUp: boolean): Promise<string | null> {
  const b = bridges.get(block);
  if (images.length || followUp) {
    if (!b) return `${followUp ? "follow-ups" : "images"} need an omp session connected to tern-mobile (restart it)`;
    return (await bridgeRequest(b, { t: "send", text, images, followUp })) ? null : "omp did not take the message";
  }
  if (!b) return (text && (await sendText(block, text))) || sendKeys(block, ["Enter"]);
  if (b.state.text !== text && !(await bridgeRequest(b, { t: "set", text }))) return "omp did not take the draft";
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
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function draftPayload(b: Bridge | null) {
  return b ? { live: true, text: b.state.text } : { live: false, text: "" };
}

/**
 * One phone screen's updates. Nothing here polls on a timer except terminal screens (Tern has
 * no output event): the list is rechecked when `invalidateState` batches an event, and the open
 * transcript or file when its folder reports a write to it.
 */
function stream(req: Request, block: string | null, view: string): Response {
  const enc = new TextEncoder();
  let stop = false;
  const cleanups: (() => void)[] = [];
  let finish = () => {};
  return new Response(
    new ReadableStream({
      start(ctrl) {
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

        if (block) {
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
        /** Rechecks when `path` is written or replaced; its folder is watched, as editors save by renaming. */
        const follow = (path: string | null) => {
          if (followed?.path === path) return;
          followed?.watcher.close();
          followed = null;
          // A check can resume after the phone left; cleanup already ran, so take nothing new.
          if (!path || stop) return;
          const name = basename(path);
          try {
            const watcher = watch(dirname(path), (_e, f) => f === name && check());
            watcher.on("error", () => {});
            followed = { path, watcher };
          } catch {
            // A missing folder: the safety recheck tries again.
          }
        };

        const step = async () => {
          const s = await getState();
          const key = JSON.stringify([s.projects, s.counts, s.roles]);
          if (key !== lastState) {
            lastState = key;
            send("state", s);
          }
          const item = block ? await findItem(block) : undefined;
          if (stop) return;
          clearTimeout(timer);
          if (item?.doc) {
            const path = item.doc;
            follow(path);
            const st = existsSync(path) ? statSync(path) : null;
            const etag = st ? `${st.size}:${st.mtimeMs}` : "none";
            if (etag !== lastDetail) {
              lastDetail = etag;
              const text = st && st.isFile() ? await Bun.file(path).slice(0, DOC_MAX_BYTES).text() : "";
              send("doc", { text, markdown: /\.(md|markdown)$/i.test(path), missing: !st, clipped: (st?.size ?? 0) > DOC_MAX_BYTES });
            }
          } else if (item?.agent && view === "chat") {
            const path = transcriptPath(item.agent.sessionId);
            follow(path);
            const etag = path ? `${path}:${statSync(path).size}:${bridges.get(block!)?.state.leaf ?? ""}` : "none";
            if (etag !== lastDetail) {
              lastDetail = etag;
              send("chat", await readChat(item.agent.sessionId, 80));
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
    if (block && !(await findItem(block))) return json({ error: "no such block" }, 404);
    return stream(req, block, url.searchParams.get("view") ?? "chat");
  }
  const blob = /^\/api\/blob\/([0-9a-f]{64})$/.exec(path);
  if (req.method === "GET" && blob) {
    const type = url.searchParams.get("type") ?? "";
    const file = Bun.file(join(BLOBS_DIR, blob[1]));
    if (IMAGE_MIMES[type] !== true || !(await file.exists())) return json({ error: "no such image" }, 404);
    // Content-addressed: the bytes behind a hash never change.
    return new Response(file, { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" } });
  }
  if (req.method === "GET" && path === "/api/projects") {
    // Folders for a new omp: the open blocks' and past omp sessions' cwds, or a configured command's list.
    let projects: string[];
    if (PROJECTS_SCRIPT) {
      let out = "";
      try {
        const cmd = /\.py$/i.test(PROJECTS_SCRIPT) ? ["python3", PROJECTS_SCRIPT] : [PROJECTS_SCRIPT];
        out = Bun.spawnSync(cmd, { stderr: "ignore" }).stdout.toString();
      } catch {
        // A missing command lists nothing.
      }
      projects = out
        .split("\n")
        .map((l) => l.trim())
        .filter((p) => isAbsolute(p) && existsSync(p));
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
  if (path === "/api/push/subscribe" || path === "/api/push/unsubscribe") {
    const sub = obj(await req.json().catch(() => null));
    const endpoint = str(sub.endpoint);
    if (!endpoint.startsWith("https://")) return json({ error: "bad subscription" }, 400);
    if (path.endsWith("/subscribe")) {
      const keys = obj(sub.keys);
      if (!str(keys.p256dh) || !str(keys.auth)) return json({ error: "bad subscription" }, 400);
      pushSubs.set(endpoint, { endpoint, keys: { p256dh: str(keys.p256dh), auth: str(keys.auth) } });
    } else pushSubs.delete(endpoint);
    savePushSubs();
    return json({ ok: true });
  }
  const body = obj(await req.json().catch(() => null));
  const done = (err: string | null) => (err ? json({ error: err }, 502) : json({ ok: true }));

  const m = /^\/api\/blocks\/(\d+)\/(keys|type|submit|draft|answer|model|models|thinking|tier|focus|abort|btw|close|complete|completion|rewind)$/.exec(path);
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
        return done((await bridgeRequest(bridge, { t: "abort" })) ? null : "omp did not answer");
      case "btw": {
        // A side question; the answer streams to this block's phones as `btw` events.
        const text = str(body.text).trim();
        if (!text) return json({ error: "empty question" }, 400);
        if (!bridge) return json({ error: "no bridge" }, 409);
        const id = crypto.randomUUID();
        return (await bridgeRequest(bridge, { t: "btw", id, text })) ? json({ id }) : json({ error: "omp did not answer" }, 502);
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
        const back = Math.min(Math.max(Math.trunc(num(body.back)), 0), 500);
        const err = back ? (await tern(["send", block, "keys", ...Array(back).fill("Backspace")])).error : null;
        const text = str(body.text);
        return done(err ?? (text ? await sendText(block, text) : null));
      }
      case "submit": {
        const images = promptImages(body.images);
        if (typeof images === "string") return json({ error: images }, 400);
        return done(await submit(block, str(body.text), images, body.followUp === true));
      }
      case "answer":
        return done(await answer(block, item, body));
      case "draft":
        if (!bridge) return json({ error: "no bridge" }, 409);
        return done((await bridgeRequest(bridge, { t: "set", text: str(body.text) })) ? null : "omp did not answer");
      case "model": {
        // A Ctrl+P role (its model and thinking), or any model omp lists: `provider/id`.
        const spec = body.role !== undefined ? modelRoles().find((r) => r.role === str(body.role))?.spec : str(body.spec);
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
          if (!r) return json({ error: "omp did not answer" }, 502);
          modelsCache = { at: Date.now(), value: arr(r.models) };
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
        if (!r) return json({ error: "omp did not answer" }, 502);
        return json({ prefix: str(r.prefix), items: arr(r.items).map(obj).map((i) => ({ value: str(i.value), label: str(i.label), description: str(i.description) })) });
      }
      case "completion": {
        // Applies a picked suggestion in omp, which also sets the desktop draft; returns the new text.
        if (!bridge) return json({ error: "no bridge" }, 409);
        const r = await bridgeRequest(bridge, { t: "apply", text: str(body.text), value: str(body.value), label: str(body.label), prefix: str(body.prefix) });
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

/** `/pair?code=…`: the installer's link. The right code sets the cookie /api asks for. */
function pair(url: URL): Response {
  if (!sameToken(url.searchParams.get("code") ?? "", ACCESS_TOKEN))
    return new Response("<!doctype html><title>tern</title><p>Wrong pairing code. Open the pairing link the installer printed (<code>bun server.ts pair</code>).</p>", {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "cache-control": "no-store",
      "set-cookie": `${PAIR_COOKIE}=${ACCESS_TOKEN}; Path=/; Max-Age=${PAIR_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

/** Every bridge connection per pane; the newest is the pane's bridge. */
const paneSockets = new Map<string, Set<ServerWebSocket<{ pane: string | null }>>>();

/** A connection now speaks for `pane`: its state starts over until it reports. */
function registerBridge(pane: string, ws: ServerWebSocket<{ pane: string | null }>) {
  bridges.set(pane, {
    ws,
    state: emptyState(Date.now()),
    waiting: new Map(),
    live: null,
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
  bridges.delete(pane);
  const next = set?.size ? [...set].at(-1) : undefined;
  if (next) {
    registerBridge(pane, next);
    next.send(JSON.stringify({ t: "sync" }));
    return;
  }
  invalidateState();
  notifyBridge(pane);
  emit(pane, "live", { text: "", done: true });
  emit(pane, "queued", []);
}

Bun.serve<{ pane: string | null }>({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // SSE streams stay open
  async fetch(req, server) {
    const url = new URL(req.url);
    // omp sessions on this machine; Tailscale Serve requests always carry a login header.
    if (url.pathname === "/bridge" && !req.headers.get("tailscale-user-login")) {
      if (!bridgeAuthorized(req)) return new Response("forbidden", { status: 403 });
      return server.upgrade(req, { data: { pane: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const login = req.headers.get("tailscale-user-login");
    if (!DEV && !(login && ALLOW.includes(login))) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/pair") return pair(url);
    if (url.pathname.startsWith("/api/")) {
      if (!DEV && !sameToken(cookieValue(req.headers.get("cookie"), PAIR_COOKIE), ACCESS_TOKEN)) return json({ error: "not paired" }, 401);
      return handleApi(req, url);
    }
    // The app itself needs only the login: it shows how to pair when /api says "not paired".
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (rel.includes("..")) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(DIST, rel));
    const index = Bun.file(join(DIST, "index.html"));
    if (!(await index.exists())) return new Response("not built: run `bun run build`", { status: 404 });
    return new Response((await file.exists()) ? file : index, {
      // The 1 MB symbols font changes only with the Nerd Font package.
      headers: { "cache-control": rel === "symbols.woff2" ? "max-age=604800" : "no-cache" },
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
      // A rewind moves the leaf without writing to the file: the open chat must re-read.
      if (before.leaf !== b.state.leaf) emit(pane, "leaf", null);
      if (JSON.stringify(before.queued) !== JSON.stringify(b.state.queued)) emit(pane, "queued", b.state.queued);
      if (listChanged(before, b.state)) invalidateState();
      // `before.status` is empty on a fresh connection: a restarted omp is not a finished turn.
      if (before.status && before.status !== status) onStatusChange(pane, before.status, status, b.state.sessionId);
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

console.log(`tern-mobile on http://127.0.0.1:${PORT}${DEV ? " (dev: no auth)" : ` allow=${ALLOW.join(",")}`}`);
