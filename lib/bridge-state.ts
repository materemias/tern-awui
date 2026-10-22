// The state snapshots an omp session's tern-mobile extension sends over /bridge.

import { arr, num, obj, str, type Obj } from "./json";

/**
 * The bridge protocol this server speaks; omp-extension/tern-mobile.ts declares the same (a test
 * keeps them equal). 2: the extension reports its `build`. 3: it forwards ✦ presses (`deepen`).
 */
export const PROTOCOL = 3;

/** `status`: blocked while an ask dialog or tool approval waits on the user; `since` when it last changed. */
export type BridgeState = {
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
  /** The extension's bridge protocol; 0 for extensions from before versioning. */
  protocol: number;
  /** The extension's build id (see lib/extension-check.ts); "" when it sent none or couldn't read its file. */
  build: string;
  /** What this omp supports, from the extension's feature detection; null when it sent none. */
  caps: Caps | null;
  /** Open stretches of the session's replies, from omp's stretch.ts; null when it isn't loaded. */
  stretch: StretchState | null;
};
/**
 * `open`: stretch keys drawn open, per reply block (`<message timestamp>.<content index>`); `off`:
 * the session turned stretches off (`/stretch off`), so replies show every long form. `deepen`: a ✦
 * press can run in the pane; `answers`: its ✦ answers per block, `running`: presses still waiting.
 */
export type StretchState = {
  off: boolean;
  open: Record<string, string[]>;
  deepen: boolean;
  answers: Record<string, { key: string; text: string }[]>;
  running: Record<string, { key: string; seconds: number; partial: string }[]>;
};
export type Context = { tokens: number; window: number; percent: number };
type Queued = { text: string; followUp: boolean };
export type Job = { id: string; type: string; label: string; agent: string; since: number };
const CAPS = ["models", "tiers", "jobs", "queue", "rewind", "btw", "complete", "levels"] as const;
export type Caps = Record<(typeof CAPS)[number], boolean>;

/** A connection that hasn't reported yet. */
export function emptyState(now: number): BridgeState {
  return { sessionId: "", text: "", model: "", thinking: "", status: "", since: now, context: null, queued: [], jobs: [], leaf: "", levels: [], tiers: [], tier: "", protocol: 0, build: "", caps: null, stretch: null };
}

/** The reported caps; a cap the extension doesn't name (or names oddly) is unsupported. */
function parseCaps(value: unknown): Caps | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = obj(value);
  return Object.fromEntries(CAPS.map((k) => [k, c[k] === true])) as Caps;
}

/** A reply block id as stretch.ts names one. */
export const STRETCH_BLOCK = /^\d+\.\d+$/;

/** Per-block lists of a reported field: blocks with malformed ids, rows without a key, and empty blocks dropped. */
function perBlock<T extends { key: string }>(value: unknown, row: (o: Obj) => T): Record<string, T[]> {
  const blocks = Object.entries(obj(value))
    .filter(([block]) => STRETCH_BLOCK.test(block))
    .map(([block, rows]) => [block, arr(rows).map((r) => row(obj(r))).filter((r) => r.key)] as const)
    .filter(([, rows]) => rows.length);
  return Object.fromEntries(blocks);
}

/**
 * The reported stretch state; malformed blocks and keys are dropped. Older stretch.ts sends no ✦
 * fields. `deepen` also needs an extension that forwards presses (protocol 3): an older one passes
 * a newer stretch.ts's `deepen` through but drops the press.
 */
function parseStretch(value: unknown, protocol: number): StretchState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = obj(value);
  const open = Object.entries(obj(s.open))
    .filter(([block]) => STRETCH_BLOCK.test(block))
    .map(([block, keys]) => [block, arr(keys).map((k) => str(k)).filter(Boolean)] as const)
    .filter(([, keys]) => keys.length);
  return {
    off: s.off === true,
    open: Object.fromEntries(open),
    deepen: s.deepen === true && protocol >= 3,
    answers: perBlock(s.answers, (a) => ({ key: str(a.key), text: str(a.text) })),
    running: perBlock(s.running, (r) => ({ key: str(r.key), seconds: num(r.seconds), partial: str(r.partial) })),
  };
}

/** A `state` message as the pane's new state; `since` carries over within one session and status. */
export function parseBridgeState(msg: Obj, before: BridgeState, now: number): BridgeState {
  // Extensions from before `status` existed send only `idle`.
  const status = str(msg.status) || (msg.idle === false ? "working" : "idle");
  const c = obj(msg.context);
  const window = num(c.window);
  return {
    sessionId: str(msg.sessionId),
    text: str(msg.text),
    model: str(msg.model),
    thinking: str(msg.thinking),
    levels: arr(msg.levels).map((l) => str(l)).filter(Boolean),
    tiers: arr(msg.tiers).map((t) => str(t)),
    tier: str(msg.tier),
    status,
    since: status === before.status && str(msg.sessionId) === before.sessionId ? before.since : now,
    context: window > 0 ? { tokens: num(c.tokens), window, percent: num(c.percent) } : null,
    // Extensions before follow-ups send plain strings (all steers).
    queued: arr(msg.queued)
      .map((q) => (typeof q === "string" ? { text: q, followUp: false } : { text: str(obj(q).text), followUp: obj(q).followUp === true }))
      .filter((q) => q.text),
    jobs: arr(msg.jobs)
      .map(obj)
      .map((j) => ({ id: str(j.id), type: str(j.type), label: str(j.label), agent: str(j.agent), since: num(j.since) }))
      .filter((j) => j.id),
    leaf: str(msg.leaf),
    protocol: num(msg.protocol),
    build: str(msg.build),
    caps: parseCaps(msg.caps),
    stretch: parseStretch(msg.stretch, num(msg.protocol)),
  };
}

/** Whether the change shows in the list (a draft or queue change alone doesn't). */
export function listChanged(before: BridgeState, after: BridgeState): boolean {
  return (
    before.model !== after.model ||
    before.thinking !== after.thinking ||
    before.tier !== after.tier ||
    before.status !== after.status ||
    before.context?.percent !== after.context?.percent ||
    before.context?.tokens !== after.context?.tokens ||
    before.context?.window !== after.context?.window ||
    before.sessionId !== after.sessionId ||
    before.protocol !== after.protocol ||
    before.build !== after.build ||
    JSON.stringify(before.caps) !== JSON.stringify(after.caps) ||
    JSON.stringify(before.jobs) !== JSON.stringify(after.jobs)
  );
}
