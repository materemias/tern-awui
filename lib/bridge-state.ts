// The state snapshots an omp session's tern-mobile extension sends over /bridge.

import { arr, num, obj, str, type Obj } from "./json";

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
};
export type Context = { tokens: number; window: number; percent: number };
export type Queued = { text: string; followUp: boolean };
export type Job = { id: string; type: string; label: string; agent: string; since: number };

/** A connection that hasn't reported yet. */
export function emptyState(now: number): BridgeState {
  return { sessionId: "", text: "", model: "", thinking: "", status: "", since: now, context: null, queued: [], jobs: [], leaf: "", levels: [], tiers: [], tier: "" };
}

/** A `state` message as the pane's new state; `since` carries over while the status holds. */
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
    since: status === before.status ? before.since : now,
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
    before.sessionId !== after.sessionId ||
    JSON.stringify(before.jobs) !== JSON.stringify(after.jobs)
  );
}
