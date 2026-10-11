// tern-mobile: a phone-sized control surface for the Tern panes on this machine.
// Reads blocks from `tern ls --json`, omp transcripts from ~/.omp/agent/sessions and recaps
// from omp's ~/.omp/agent/history.db; writes input with `tern send`.
// omp sessions running the tern-mobile extension also connect to /bridge: they stream their
// prompt draft, model and busy state, and take drafts and model picks from the phone.
// Listens on loopback only; `tailscale serve` is the way in, and its identity header is the gate.

import { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import webpush, { type PushSubscription } from "web-push";

const HOME = process.env.HOME ?? "";
const PORT = Number(process.env.TERN_MOBILE_PORT ?? 4380);
const ALLOW = (process.env.TERN_MOBILE_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DEV = process.env.TERN_MOBILE_DEV === "1";
const SESSIONS_DIR = `${HOME}/.omp/agent/sessions`;
const HISTORY_DB = `${HOME}/.omp/agent/history.db`;
const BLOBS_DIR = `${HOME}/.omp/agent/blobs`;
const NOTES_DIR = `${HOME}/.local/state/tern/notes`;
const DOC_MAX_BYTES = 512 * 1024;
const PROJECTS_SCRIPT = process.env.TERN_MOBILE_PROJECTS ?? `${HOME}/.local/bin/agent-projects.py`;
const TOKEN_FILE = `${HOME}/.config/tern-mobile/bridge-token`;
const DIST = new URL("./dist/", import.meta.url).pathname;

/** The list is rebuilt on events (Tern, bridges, history.db); this is only the cache's backstop. */
const STATE_TTL_MS = 15_000;
/** Events arriving within this window share one rebuild. */
const STATE_BATCH_MS = 150;
/** Open streams recheck everything this often, in case an event was missed. */
const SAFETY_MS = 15_000;
const PING_MS = 12_000;
const TERN_EVENTS_RETRY_MS = 2000;
const ROLES_TTL_MS = 5 * 60_000;
const CHAT_TAIL_BYTES = 4 * 1024 * 1024;
const SCREEN_LINES = 160;
const BRIDGE_REPLY_MS = 2000;

if (!DEV && ALLOW.length === 0) {
  console.error("TERN_MOBILE_ALLOW must list the Tailscale logins allowed in (or set TERN_MOBILE_DEV=1)");
  process.exit(2);
}

if (!existsSync(TOKEN_FILE)) {
  mkdirSync(`${HOME}/.config/tern-mobile`, { recursive: true });
  writeFileSync(TOKEN_FILE, randomBytes(32).toString("base64url"), { mode: 0o600 });
}
const BRIDGE_TOKEN = Buffer.from(readFileSync(TOKEN_FILE, "utf8").trim());

// ---------- web push ----------

const VAPID_FILE = `${HOME}/.config/tern-mobile/vapid.json`;
const PUSH_FILE = `${HOME}/.config/tern-mobile/push.json`;
/** A finish is reported only if the session stays idle this long (no follow-up turn). */
const DONE_SETTLE_MS = 3000;

if (!existsSync(VAPID_FILE)) writeFileSync(VAPID_FILE, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
const VAPID: { publicKey: string; privateKey: string } = JSON.parse(readFileSync(VAPID_FILE, "utf8"));
// The subject reaches the browser's push service (FCM for Chrome); keep it free of personal data.
webpush.setVapidDetails(process.env.TERN_MOBILE_VAPID_SUBJECT ?? "https://tern-mobile.invalid", VAPID.publicKey, VAPID.privateKey);

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

// ---------- untyped JSON from tern and omp ----------

type Obj = Record<string, unknown>;
/** Narrows parsed JSON to an object; anything else reads as empty. */
function obj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
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

/** `status`: blocked while an ask dialog or tool approval waits on the user; `since` when it last changed. */
type BridgeState = {
  sessionId: string;
  text: string;
  model: string;
  thinking: string;
  status: string;
  since: number;
  /** Context-window use, as omp's status line estimates it. */
  context: Context | null;
  /** Prompts waiting in omp's queue, oldest first: steers, or follow-ups held until the turn ends. */
  queued: Queued[];
  /** Background jobs running for the session: subagents (`task`, `eval`) and backgrounded bash. */
  jobs: Job[];
  /** The session's current leaf entry: after a rewind it sits earlier than the file's last line. */
  leaf: string;
  /** The current model's thinking levels ("off" first) and serving tiers ("" = standard). */
  levels: string[];
  tiers: string[];
  tier: string;
};
type Context = { tokens: number; window: number; percent: number };
type Queued = { text: string; followUp: boolean };
type Job = { id: string; type: string; label: string; agent: string; since: number };
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

type Compaction = { enabled: boolean; thresholdTokens: number; thresholdPercent: number; reserveTokens: number | null };
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

/**
 * Where auto-compaction fires, as a percent of `window`; null when it is off. Mirrors omp's
 * resolveThresholdTokens (pi-agent-core compaction.ts): fixed tokens, else a percent, else the
 * window minus a reserve of max(15 %, reserveTokens ?? 16384). Per-model thresholds are not read.
 */
function compactAtPercent(window: number): number | null {
  const s = compactionSettings();
  if (!s.enabled || !(window > 0)) return null;
  let tokens: number;
  if (s.thresholdTokens > 0) tokens = Math.min(window - 1, Math.max(1, s.thresholdTokens));
  else if (s.thresholdPercent > 0) tokens = Math.floor(window * (Math.min(99, Math.max(1, s.thresholdPercent)) / 100));
  else {
    const proportional = Math.max(1, Math.floor(window * 0.15));
    let reserve = Math.max(Math.floor(window * 0.15), s.reserveTokens ?? 16384);
    if ((s.reserveTokens === null && reserve >= window - proportional) || reserve >= window) reserve = proportional;
    tokens = Math.max(0, Math.min(window - 1, window - reserve));
  }
  return tokens > 0 ? (tokens / window) * 100 : null;
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

/** `git -C cwd ARGS` output; null outside a repo or without git. */
function gitOut(cwd: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

const projectCache = new Map<string, string>();
function projectOf(cwd: string): string {
  const hit = projectCache.get(cwd);
  if (hit) return hit;
  const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  const name = (top && basename(top)) || (cwd === HOME ? "~" : basename(cwd) || cwd);
  projectCache.set(cwd, name);
  return name;
}

const BRANCH_TTL_MS = 10_000;
const branchCache = new Map<string, { at: number; value: string | null }>();
function branchOf(cwd: string): string | null {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.value;
  const current = gitOut(cwd, ["branch", "--show-current"]);
  const value = current === null ? null : current || gitOut(cwd, ["rev-parse", "--short", "HEAD"]);
  branchCache.set(cwd, { at: Date.now(), value });
  return value;
}

/** What the list shows of a transcript, scanned from where the previous scan stopped. */
type Facts = { offset: number; lastPrompt: string; lastTurn: number; lastActivity: number };
const factsCache = new Map<string, Facts>();
const NEWLINE = 0x0a;

async function sessionFacts(sessionId: string): Promise<Facts | null> {
  const path = transcriptPath(sessionId);
  if (!path) return null;
  const size = statSync(path).size;
  let facts = factsCache.get(path);
  const fresh = !facts || size < facts.offset;
  if (!facts || fresh) facts = { offset: Math.max(0, size - CHAT_TAIL_BYTES), lastPrompt: "", lastTurn: 0, lastActivity: 0 };
  if (size > facts.offset) {
    const bytes = new Uint8Array(await Bun.file(path).slice(facts.offset, size).arrayBuffer());
    const end = bytes.lastIndexOf(NEWLINE) + 1; // a line still being written waits for the next scan
    const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");
    if (fresh && facts.offset > 0) lines.shift(); // the tail starts mid-line
    for (const line of lines) {
      if (!line.startsWith('{"type":"message"')) continue;
      let row: Obj;
      try {
        row = obj(JSON.parse(line));
      } catch {
        continue;
      }
      const msg = obj(row.message);
      const ts = Date.parse(str(row.timestamp)) || num(msg.timestamp);
      facts.lastActivity = Math.max(facts.lastActivity, ts);
      if (msg.role !== "user") continue;
      // Any prompt starts a turn (an image-only one too); only text replaces the shown prompt.
      facts.lastTurn = ts;
      const text = textOf(msg.content).replace(/\s+/g, " ").trim();
      if (text) facts.lastPrompt = text.slice(0, 300);
    }
    facts.offset += end;
  }
  factsCache.set(path, facts);
  return facts;
}

const RECAP_CHARS = 600;
let historyDb: Database | null = null;
/** The newest recap omp wrote for each session, with its time (whole seconds). */
function readRecaps(ids: string[]): Map<string, { text: string; createdAt: number }> {
  const out = new Map<string, { text: string; createdAt: number }>();
  if (!ids.length) return out;
  try {
    historyDb ??= new Database(HISTORY_DB, { readonly: true });
    // Oldest first, so the newest recap of each session wins; `id` orders recaps within a second.
    const rows = historyDb
      .query(`SELECT session_id, recap, created_at FROM session_recaps WHERE session_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, id`)
      .all(...ids);
    for (const raw of rows) {
      const r = obj(raw);
      const text = str(r.recap).replace(/\s+/g, " ").trim();
      if (text) out.set(str(r.session_id), { text: text.slice(0, RECAP_CHARS), createdAt: num(r.created_at) });
    }
  } catch {
    // No history.db yet, or a schema this omp doesn't have: rows go without recaps.
    historyDb?.close();
    historyDb = null;
  }
  return out;
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
        // `created_at` holds whole seconds, so it may trail the turn by one.
        recapStale: !!recap && (recap.createdAt + 1) * 1000 < (facts?.lastTurn ?? 0),
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
        const doc = note ? `${NOTES_DIR}/${note}.md` : file.startsWith("/") ? file : null;
        const raw = str(b.title, basename(str(b.program, id))).trim();
        const icon = PUA.exec(raw)?.[0] ?? null;
        const clean = raw.replace(new RegExp(PUA.source, "gu"), "").trim();
        const m = /^([\p{Lu}\d_-]{2,14}):\s+(.*)$/u.exec(clean);
        const project = projectOf(cwd);
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
                context: bridge.state.context && { ...bridge.state.context, compactAt: compactAtPercent(bridge.state.context.window) },
                jobs: bridge.state.jobs,
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

type ToolCall = { name: string; intent: string; error?: boolean };
/** omp's todo list after a `todo` call: phases of tasks (pending, in_progress, completed, blocked…). */
type TodoPhase = { name: string; tasks: { content: string; status: string; blocker?: string }[] };
type AskQuestion = {
  question: string;
  options: { label: string; description: string }[];
  multi: boolean;
  recommended: number;
};
/**
 * An image the session saw, as a URL for <img>: omp keeps most bytes in ~/.omp/agent/blobs/<hash>
 * (served by /api/blob), and small ones inline in the transcript (sent as a data: URL).
 */
type Img = { src: string };
const INLINE_IMAGE_CHARS = 256 * 1024;
type ChatEntry =
  | { role: "user"; id: string; text: string; images: Img[]; ts: number }
  | { role: "assistant"; text: string; ts: number }
  | { role: "tools"; calls: ToolCall[]; images: Img[]; todo: TodoPhase[] | null; ts: number }
  | { role: "ask"; id: string; questions: AskQuestion[]; answer: string | null; ts: number }
  | { role: "turn"; ms: number; model: string; ts: number }
  | { role: "advisor"; notes: AdvisorNote[]; ts: number };
/** A note from omp's advisor model: `Key:`/`Evidence:`/`Impact:`/`Fix:` lines. */
type AdvisorNote = { advisor: string; severity: string; note: string };

const sessionPaths = new Map<string, string>();
function transcriptPath(sessionId: string): string | null {
  const hit = sessionPaths.get(sessionId);
  if (hit && existsSync(hit)) return hit;
  if (!/^[\w-]+$/.test(sessionId)) return null;
  for (const rel of new Bun.Glob(`*/*_${sessionId}.jsonl`).scanSync(SESSIONS_DIR)) {
    const full = `${SESSIONS_DIR}/${rel}`;
    sessionPaths.set(sessionId, full);
    return full;
  }
  return null;
}

// `title` is eval's intent; `code` (its first line) only when a call carries nothing better.
const INTENT_KEYS = ["i", "title", "command", "path", "pattern", "query", "url", "description", "code"];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map(obj)
    .filter((p) => p.type === "text")
    .map((p) => str(p.text))
    .join("\n");
}

const IMAGE_MIMES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true };

function imagesOf(content: unknown): Img[] {
  return arr(content)
    .map(obj)
    .filter((p) => p.type === "image" && IMAGE_MIMES[str(p.mimeType)])
    .map((p) => {
      const data = str(p.data);
      const mime = str(p.mimeType);
      const hash = /^blob:sha256:([0-9a-f]{64})$/.exec(data)?.[1];
      if (hash) return { src: `/api/blob/${hash}?type=${encodeURIComponent(mime)}` };
      const inline = data.length <= INLINE_IMAGE_CHARS && /^[A-Za-z0-9+/]+=*$/.test(data);
      return { src: inline ? `data:${mime};base64,${data}` : "" };
    })
    .filter((i) => i.src);
}

async function readChat(sessionId: string, limit: number): Promise<{ entries: ChatEntry[] } | null> {
  const path = transcriptPath(sessionId);
  if (!path) return null;
  const size = statSync(path).size;
  const start = Math.max(0, size - CHAT_TAIL_BYTES);
  const lines = (await Bun.file(path).slice(start, size).text()).split("\n");
  if (start > 0) lines.shift(); // partial line
  const entries: ChatEntry[] = [];
  const callsById = new Map<string, ToolCall>();
  const groupByCall = new Map<string, Extract<ChatEntry, { role: "tools" }>>();
  const asksById = new Map<string, Extract<ChatEntry, { role: "ask" }>>();
  // The file is a tree: a rewind leaves the abandoned path in place and continues from an
  // earlier entry. Only the active path shows, walked back from the leaf: the session's own
  // (its bridge knows it, even before anything is appended after a rewind), else the last line.
  const rows = lines.flatMap((line) => {
    try {
      return [obj(JSON.parse(line))];
    } catch {
      return [];
    }
  });
  const parentOf = new Map(rows.filter((r) => str(r.id)).map((r) => [str(r.id), str(r.parentId)]));
  // `-`: rewound past the first prompt, nothing is on the path. Older extensions send no leaf.
  const known = [...bridges.values()].find((b) => b.state.sessionId === sessionId)?.state.leaf ?? "";
  let id = known === "-" ? "" : parentOf.has(known) ? known : str(rows.findLast((r) => parentOf.has(str(r.id)))?.id);
  const active = new Set<string>();
  for (; parentOf.has(id) && !active.has(id); id = parentOf.get(id) ?? "") active.add(id);
  // A turn runs from a user prompt to the assistant message that stops without calling tools.
  let turnStart: number | null = null;
  for (const row of rows) {
    const advisor = row.type === "custom_message" && row.customType === "advisor";
    if ((!advisor && row.type !== "message") || !active.has(str(row.id))) continue;
    const msg = obj(row.message);
    const ts = Date.parse(str(row.timestamp)) || num(msg.timestamp);
    if (advisor) {
      const notes = arr(obj(row.details).notes)
        .map(obj)
        .map((n) => ({ advisor: str(n.advisor), severity: str(n.severity, "note"), note: str(n.note).trim() }))
        .filter((n) => n.note);
      if (notes.length) entries.push({ role: "advisor", notes, ts });
      continue;
    }
    if (msg.role === "user") {
      const text = textOf(msg.content).trim();
      const images = imagesOf(msg.content);
      if (text || images.length) entries.push({ role: "user", id: str(row.id), text, images, ts });
      turnStart = ts;
    } else if (msg.role === "assistant") {
      for (const part of arr(msg.content).map(obj)) {
        if (part.type === "text" && str(part.text).trim()) entries.push({ role: "assistant", text: str(part.text), ts });
        if (part.type !== "toolCall") continue;
        const args = obj(part.arguments);
        if (part.name === "ask" && Array.isArray(args.questions)) {
          const questions = arr(args.questions).map(obj).map((q) => ({
            question: str(q.question),
            multi: q.multi === true,
            recommended: num(q.recommended),
            options: arr(q.options).map((o) => ({ label: str(obj(o).label, str(o)), description: str(obj(o).description) })),
          }));
          const ask = { role: "ask" as const, id: str(part.id), questions, answer: null, ts };
          asksById.set(ask.id, ask);
          entries.push(ask);
          continue;
        }
        const key = INTENT_KEYS.find((k) => typeof args[k] === "string");
        const intent = key ? str(args[key]).trim().split("\n")[0] : "";
        const call: ToolCall = { name: str(part.name), intent: intent.slice(0, 160) };
        callsById.set(str(part.id), call);
        const last = entries[entries.length - 1];
        const group = last?.role === "tools" ? last : { role: "tools" as const, calls: [], images: [], todo: null, ts };
        if (group !== last) entries.push(group);
        group.calls.push(call);
        groupByCall.set(str(part.id), group);
      }
      if (turnStart !== null && msg.stopReason !== "toolUse") {
        entries.push({ role: "turn", ms: ts - turnStart, model: str(msg.model), ts });
        turnStart = null;
      }
    } else if (msg.role === "toolResult") {
      const ask = asksById.get(str(msg.toolCallId));
      if (ask) ask.answer = textOf(msg.content).trim() || "answered";
      const call = callsById.get(str(msg.toolCallId));
      if (call && msg.isError === true) call.error = true;
      const group = groupByCall.get(str(msg.toolCallId));
      group?.images.push(...imagesOf(msg.content));
      // The list as this call left it; a group keeps the newest.
      const phases = arr(obj(msg.details).phases).map(obj);
      if (group && msg.toolName === "todo" && phases.length)
        group.todo = phases.map((p) => ({
          name: str(p.name),
          tasks: arr(p.tasks)
            .map(obj)
            .map((t) => ({ content: str(t.content), status: str(t.status, "pending"), ...(t.blocker ? { blocker: str(t.blocker) } : {}) })),
        }));
    }
  }
  return { entries: entries.slice(-limit) };
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

const KEYS: Record<string, true> = {
  Enter: true, Escape: true, Tab: true, "shift+Tab": true, Up: true, Down: true, Left: true, Right: true,
  Backspace: true, space: true, "ctrl+c": true, "ctrl+d": true, "ctrl+l": true, "ctrl+p": true,
  PageUp: true, PageDown: true, "1": true, "2": true, "3": true, "4": true, "5": true, y: true, n: true,
};

async function sendKeys(block: string, keys: string[]): Promise<string | null> {
  const bad = keys.find((k) => !KEYS[k]);
  if (bad !== undefined) return `key not allowed: ${bad}`;
  return keys.length ? (await tern(["send", block, "keys", ...keys])).error : null;
}

async function sendText(block: string, text: string): Promise<string | null> {
  return (await tern(["send", block, text.includes("\n") ? "paste" : "text", text])).error;
}

type PromptImage = { data: string; mimeType: string };
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_PROMPT_IMAGES = 8;
/** Base64 characters across a prompt's images (~15 MB decoded). */
const MAX_IMAGE_CHARS = 20 * 1024 * 1024;

/** The pasted images of a submit body; a string when one doesn't qualify. */
function promptImages(raw: unknown): PromptImage[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PROMPT_IMAGES) return `at most ${MAX_PROMPT_IMAGES} images`;
  const images = raw.map((r) => ({ data: str(obj(r).data), mimeType: str(obj(r).mimeType) }));
  if (images.some((i) => !IMAGE_TYPES.has(i.mimeType) || !/^[A-Za-z0-9+/]+=*$/.test(i.data))) return "unsupported image";
  if (images.reduce((n, i) => n + i.data.length, 0) > MAX_IMAGE_CHARS) return "images too large";
  return images;
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

/**
 * Answers the pending ask dialog the way its keyboard works (pi-tui ask-dialog): each question
 * opens on its recommended row; Enter picks a single option and moves on, Space toggles a multi
 * option and Enter moves on; "Other…" follows the options and opens a prompt for typed text.
 * Dialogs with several questions end on a Review tab that Enter submits.
 */
async function answer(block: string, item: Item, body: Obj): Promise<string | null> {
  const chat = item.agent ? await readChat(item.agent.sessionId, 80) : null;
  const ask = chat?.entries.findLast((e) => e.role === "ask");
  if (ask?.role !== "ask" || ask.answer !== null || ask.id !== str(body.id)) return "this question is no longer open";
  const answers = arr(body.answers).map(obj);
  if (answers.length !== ask.questions.length) return "answer every question";
  const invalid = ask.questions.findIndex((q, i) => {
    const a = answers[i];
    if (str(a.other).trim()) return false;
    if (q.multi) return !Array.isArray(a.picks);
    return typeof a.option !== "number" || a.option < 0 || a.option >= q.options.length;
  });
  if (invalid >= 0) return `question ${invalid + 1} has no valid answer`;

  // Each step is keys, or text typed into a prompt that the previous keys opened.
  const steps: ({ keys: string[] } | { text: string })[] = [];
  ask.questions.forEach((q, i) => {
    const a = answers[i];
    const otherRow = q.options.length;
    // The desktop may have moved the cursor; Up clamps at the first row, so enough of them
    // put it on row 0 whatever its position, and navigation is absolute from there.
    const reset: string[] = Array(otherRow).fill("Up");
    let at = 0;
    const moveTo = (row: number) => {
      const keys: string[] = [...reset.splice(0)];
      for (; at < row; at++) keys.push("Down");
      for (; at > row; at--) keys.push("Up");
      return keys;
    };
    const other = str(a.other).trim();
    if (q.multi) {
      const picks = arr(a.picks).filter((n): n is number => typeof n === "number" && n >= 0 && n < otherRow);
      const keys = [...new Set(picks)].sort((x, y) => x - y).flatMap((p) => [...moveTo(p), "space"]);
      if (other) {
        steps.push({ keys: [...keys, ...moveTo(otherRow), "Enter"] }, { text: other }, { keys: ["Enter"] });
        // A lone multi question jumps to Review after a typed answer; Enter there submits.
        if (ask.questions.length === 1) steps.push({ keys: ["Enter"] });
      } else steps.push({ keys: [...keys, ...reset.splice(0), "Enter"] });
    } else if (other) {
      steps.push({ keys: [...moveTo(otherRow), "Enter"] }, { text: other }, { keys: ["Enter"] });
    } else {
      steps.push({ keys: [...moveTo(num(a.option)), "Enter"] });
    }
  });
  if (ask.questions.length > 1) steps.push({ keys: ["Enter"] });

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
    const file = Bun.file(`${BLOBS_DIR}/${blob[1]}`);
    if (!IMAGE_MIMES[type] || !(await file.exists())) return json({ error: "no such image" }, 404);
    // Content-addressed: the bytes behind a hash never change.
    return new Response(file, { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" } });
  }
  if (req.method === "GET" && path === "/api/projects") {
    // The same list `op` feeds to fzf: known Claude/omp project folders, active first.
    const r = Bun.spawnSync(["python3", PROJECTS_SCRIPT], { stderr: "ignore" });
    const projects = r.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter((p) => p.startsWith("/") && existsSync(p));
    return json({ projects });
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
    if (!cwd.startsWith("/") || !existsSync(cwd) || !statSync(cwd).isDirectory())
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
  const given = Buffer.from(req.headers.get("x-tern-mobile-bridge") ?? "");
  return given.length === BRIDGE_TOKEN.length && timingSafeEqual(given, BRIDGE_TOKEN);
}

/** Every bridge connection per pane; the newest is the pane's bridge. */
const paneSockets = new Map<string, Set<ServerWebSocket<{ pane: string | null }>>>();

/** A connection now speaks for `pane`: its state starts over until it reports. */
function registerBridge(pane: string, ws: ServerWebSocket<{ pane: string | null }>) {
  bridges.set(pane, {
    ws,
    state: { sessionId: "", text: "", model: "", thinking: "", status: "", since: Date.now(), context: null, queued: [], jobs: [], leaf: "", levels: [], tiers: [], tier: "" },
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
    if (url.pathname.startsWith("/api/")) return handleApi(req, url);
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (rel.includes("..")) return new Response("bad path", { status: 400 });
    const file = Bun.file(DIST + rel);
    return new Response((await file.exists()) ? file : Bun.file(DIST + "index.html"), {
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
      // Extensions from before `status` existed send only `idle`.
      const status = str(msg.status) || (msg.idle === false ? "working" : "idle");
      b.state = {
        sessionId: str(msg.sessionId),
        text: str(msg.text),
        model: str(msg.model),
        thinking: str(msg.thinking),
        levels: arr(msg.levels).map((l) => str(l)).filter(Boolean),
        tiers: arr(msg.tiers).map((t) => str(t)),
        tier: str(msg.tier),
        status,
        since: status === before.status ? before.since : Date.now(),
        context: (() => {
          const c = obj(msg.context);
          const window = num(c.window);
          return window > 0 ? { tokens: num(c.tokens), window, percent: num(c.percent) } : null;
        })(),
        // Extensions before follow-ups send plain strings (all steers).
        queued: arr(msg.queued)
          .map((q) => (typeof q === "string" ? { text: q, followUp: false } : { text: str(obj(q).text), followUp: obj(q).followUp === true }))
          .filter((q) => q.text),
        jobs: arr(msg.jobs)
          .map(obj)
          .map((j) => ({ id: str(j.id), type: str(j.type), label: str(j.label), agent: str(j.agent), since: num(j.since) }))
          .filter((j) => j.id),
        leaf: str(msg.leaf),
      };
      // A rewind moves the leaf without writing to the file: the open chat must re-read.
      if (before.leaf !== b.state.leaf) emit(pane, "leaf", null);
      if (JSON.stringify(before.queued) !== JSON.stringify(b.state.queued)) emit(pane, "queued", b.state.queued);
      if (
        before.model !== b.state.model ||
        before.thinking !== b.state.thinking ||
        before.tier !== b.state.tier ||
        before.status !== status ||
        before.context?.percent !== b.state.context?.percent ||
        before.sessionId !== b.state.sessionId ||
        JSON.stringify(before.jobs) !== JSON.stringify(b.state.jobs)
      )
        invalidateState();
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
