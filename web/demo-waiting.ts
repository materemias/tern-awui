// The demo's CodexBar AgentView: the sessions set aside (demo-fixtures.ts) and what the Waiting
// popup's taps do to them, standing in for `codexbar_waiting.py`. Requests are checked as the
// server checks them (waitingArgs); a row's group, threads and counts follow from its waits.
import type { Waiting, WaitingRow } from "./api";
import { waitingArgs, type Ball, type WaitingAction } from "../lib/waiting-view";
import { demoWaiting } from "./demo-fixtures";

const DAY_MS = 24 * 60 * 60_000;

/** The row's group, threads and counts from its waits; false when nothing keeps it on the list. */
function settle(row: WaitingRow): boolean {
  row.onYou = row.onYou.filter((o) => row.waits.some((w) => w.id === o.id));
  const came = row.waits.find((w) => w.outcome);
  if (!came) {
    row.outcome = null;
    row.headline = null;
  }
  const first = row.waits.find((w) => w.ball !== "on_me");
  const ball: Ball = row.waits.some((w) => w.ball === "on_me")
    ? "on_me"
    : first
      ? first.ball === "on_timer"
        ? "on_machine"
        : first.ball
      : row.waitingFor
        ? "on_someone"
        : "on_my_time";
  row.ball = ball;
  const thread = (w: WaitingRow["waits"][number]) => `${w.mark || "⏳"} ${w.summary}`;
  row.threads = row.waits.filter((w) => w.kind !== "later").map(thread);
  row.stillWaiting = came ? row.waits.filter((w) => w !== came && w.kind !== "later").map(thread) : [];
  row.stoppable = row.waits.filter((w) => w.state !== "done").length;
  row.due = Math.min(...row.waits.map((w) => w.due || Infinity));
  if (row.due === Infinity) row.due = 0;
  return row.waits.length > 0 || row.pinned || !!row.waitingFor;
}

export class DemoWaiting {
  private rows: WaitingRow[];

  constructor(now: number) {
    this.rows = demoWaiting(now).filter(settle);
  }

  /** The view as the server sends it: every check succeeded a minute ago. */
  view(now: number): Waiting {
    return { available: true, onMe: this.rows.filter((r) => r.ball === "on_me").length, rows: this.rows, health: { checkedAt: now - 60_000, failed: false } };
  }

  /** A session opened or closed in Tern: its row's Open or Resume follows. */
  setLive(session: string, pane: number | null) {
    for (const r of this.rows) {
      if (r.session !== session) continue;
      r.live = pane !== null;
      r.pane = pane;
      r.agentState = pane === null ? null : "idle";
    }
  }

  /** One of the popup's taps; the status and body the server would answer with. */
  act(action: WaitingAction, body: Record<string, unknown>, now: number): { status: number; body: Record<string, unknown> } {
    const args = waitingArgs(action, body, this.rows);
    if (!Array.isArray(args)) return { status: args.status, body: { error: args.error } };
    const row = this.rows.find((r) => (typeof body.session === "string" ? r.session === body.session : r.session === null && r.pane === body.pane))!;
    const wait = row.waits.find((w) => w.id === body.wait);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const note = (said: string) => row.history.push({ at: now, text: said, fired: false });
    switch (action) {
      case "mark-seen": {
        const seen = wait ? row.onYou.filter((o) => o.id === wait.id) : row.onYou;
        if (!seen.length) return { status: 409, body: { error: "nothing here is on you" } };
        const ids = new Set(seen.map((o) => o.id));
        row.waits = row.waits.filter((w) => !ids.has(w.id));
        note(`Seen: ${seen.map((o) => o.label).join(", ")}`);
        row.unseen = false;
        break;
      }
      case "stop": {
        const stopped = wait ? [wait] : row.waits;
        row.waits = row.waits.filter((w) => !stopped.includes(w));
        note(`Stopped: ${stopped.map((w) => w.label).join(", ")}`);
        break;
      }
      case "snooze":
        // Pushed a day: it rings again then, and until then sits on a timer.
        Object.assign(wait!, { due: now + DAY_MS, overdue: false, outcome: null, state: "waiting", ball: wait!.ball === "on_me" ? "on_timer" : wait!.ball, mark: "⏲" });
        note(`Snoozed 1d: ${wait!.label}`);
        break;
      case "seen":
        row.unseen = false;
        break;
      case "note":
        row.note = text || null;
        break;
      case "what":
        row.waitingFor = text || null;
        break;
      case "accept-suggested":
        if (!row.suggested) return { status: 409, body: { error: "omp suggests nothing here" } };
        row.note = row.suggested;
        row.suggested = null;
        break;
    }
    if (!settle(row)) this.rows = this.rows.filter((r) => r !== row);
    return { status: 200, body: { ok: true } };
  }
}
