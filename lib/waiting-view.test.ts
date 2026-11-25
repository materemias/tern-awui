import { describe, expect, test } from "bun:test";
import { blockOf, groupRows, headlineText, matchesRow, newlyOnMe, parseView, rowId, snoozeTarget, waitingArgs, type WaitingRow } from "./waiting-view";

const wait = (id: string, ball = "on_machine", over: Record<string, unknown> = {}) => ({ id, label: `Label ${id}`, summary: `Summary ${id}`, ball, reason: null, created_at: "2026-11-03T14:10:00Z", ...over });
const session = (id: string, over: Record<string, unknown> = {}) => ({
  session_id: id,
  title: `Session ${id}`,
  live: true,
  pane: 42,
  ball: "on_machine",
  unseen: false,
  note: "fix, merge, release",
  suggested_note: null,
  line: "⏳ PR#1",
  next_step: null,
  recap: null,
  set_aside_at: "2026-11-03T14:10:00Z",
  waits: [wait("w1")],
  ...over,
});
const view = (sessions: unknown[], panes: unknown[] = []) => ({ ok: true, now: "x", counts: { on_me: 2 }, sessions, panes });
const rows = (sessions: unknown[], panes: unknown[] = []) => parseView(view(sessions, panes))!.rows;

describe("parseView", () => {
  test("reads sessions and panes into one kind of row", () => {
    const parsed = parseView(view([session("a")], [{ pane: 51, label: "bun test", note: null, ball: "on_me", status: "s", line: "l", waits: [wait("w9", "on_me")] }]))!;
    expect(parsed.onMe).toBe(2);
    expect(parsed.rows.map(rowId)).toEqual(["a", "pane:51"]);
    expect(parsed.rows[0]).toMatchObject({ session: "a", pane: 42, title: "Session a", note: "fix, merge, release", since: Date.parse("2026-11-03T14:10:00Z") });
    expect(parsed.rows[1]).toMatchObject({ session: null, pane: 51, title: "bun test", live: true, since: Date.parse("2026-11-03T14:10:00Z") });
  });

  test("only a live session has a pane", () => {
    expect(rows([session("a", { live: false })])[0].pane).toBeNull();
  });

  test("an answer that isn't a view is none; rows and waits it can't read are left out", () => {
    for (const bad of [null, "x", {}, { ok: false, sessions: [] }, { ok: true }]) expect(parseView(bad)).toBeNull();
    const kept = rows([session("a", { waits: [wait("w1"), { id: 3, ball: "on_me" }, wait("w2", "nobody")] }), { session_id: 7, ball: "on_me" }, session("b", { ball: "?" })]);
    expect(kept.map(rowId)).toEqual(["a"]);
    expect(kept[0].waits.map((w) => w.id)).toEqual(["w1"]);
  });

  test("reads what the cards show", () => {
    const pr = { repo: "o/r", number: 74, url: "https://github.com/o/r/pull/74", source: "wait", title: "fix(x): y", state: "open", review: "approved", checks: "failing", checked_at: "x" };
    const [row] = rows([
      session("a", {
        project: null,
        cwd: "/home/u/code/shiftmaqt/",
        ball: "on_me",
        outcome: "fulfilled",
        headline: "✅ 4h passed",
        threads: ["✅ 4h passed", "⏲ 24h check"],
        still_waiting: ["⏲ 24h check"],
        waiting_for: "Anna's reply",
        due_at: "2026-11-12T13:09:05+01:00",
        pinned: true,
        size: "L",
        agent_state: "idle",
        recap: "Did a thing.",
        recap_at: "2026-11-05T18:53:52+01:00",
        recap_stale: true,
        history: [{ kind: "fired", at: "2026-11-12T13:09:05+01:00", wait: "w1", text: "4h passed" }, { kind: null, at: "x", text: "" }],
        prs: [pr, { ...pr, number: 75, url: "javascript:alert(1)" }, { ...pr, source: "bogus" }],
        waits: [
          wait("w1", "on_me", { kind: "time", state: "review", overdue: false, outcome: "fulfilled", mark: "✅ ", due_at: "2026-11-12T13:09:05+01:00", has_prompt: true, repeat: null }),
          wait("w2", "on_timer", { kind: "time", state: "waiting", mark: "⏲ ", due_at: null }),
        ],
      }),
    ]);
    expect(row).toMatchObject({
      project: "shiftmaqt",
      outcome: "fulfilled",
      headline: "✅ 4h passed",
      threads: ["✅ 4h passed", "⏲ 24h check"],
      stillWaiting: ["⏲ 24h check"],
      waitingFor: "Anna's reply",
      due: Date.parse("2026-11-12T13:09:05+01:00"),
      pinned: true,
      size: "L",
      agentState: "idle",
      recapAt: Date.parse("2026-11-05T18:53:52+01:00"),
      recapStale: true,
      history: [{ at: Date.parse("2026-11-12T13:09:05+01:00"), text: "4h passed", fired: true }],
      prs: [{ repo: "o/r", number: 74, url: pr.url, source: "wait", title: "fix(x): y", state: "open", review: "approved", checks: "failing" }],
    });
    // A wait on a timer stays on its row, which another wait groups.
    expect(row.waits).toMatchObject([
      { id: "w1", kind: "time", state: "review", outcome: "fulfilled", mark: "✅", hasPrompt: true, snoozable: false, due: Date.parse("2026-11-12T13:09:05+01:00") },
      { id: "w2", ball: "on_timer", outcome: null, due: 0 },
    ]);
    // A session only the clock holds is listed, On a timer.
    expect(rows([session("b", { ball: "on_timer" })])).toMatchObject([{ session: "b", ball: "on_timer" }]);
  });
});

describe("snoozeTarget", () => {
  const row = (...waits: unknown[]) => rows([session("a", { waits })])[0];

  test("only what AgentView marks snoozable, the earliest due first", () => {
    const late = wait("w1", "on_me", { snoozable: true, due_at: "2026-11-20T10:00:00Z" });
    const soon = wait("w2", "on_me", { snoozable: true, due_at: "2026-11-13T10:00:00Z" });
    expect(snoozeTarget(row(late, soon))?.id).toBe("w2");
    expect(snoozeTarget(row(wait("w3", "on_me", { snoozable: true }), late))?.id).toBe("w1");
  });

  test("a wait still watched or on a timer has no Snooze 1d", () => {
    const watched = wait("m", "on_machine", { kind: "pr", due_at: "2026-11-13T10:00:00Z" });
    const timer = wait("t", "on_timer", { kind: "time", due_at: "2026-11-13T09:00:00Z" });
    expect(snoozeTarget(row(watched, timer))).toBeUndefined();
    expect(snoozeTarget(row(watched, timer, wait("r", "on_me", { snoozable: true })))?.id).toBe("r");
  });
});

describe("headlineText", () => {
  const card = (over: Record<string, unknown>) => rows([session("a", over)])[0];

  test("the headline loses the outcome mark the row leads with", () => {
    expect(headlineText(card({ outcome: "fulfilled", headline: "✅ 4h passed" }))).toBe("4h passed");
    expect(headlineText(card({ outcome: "attention", headline: "odd" }))).toBe("odd");
    expect(headlineText(card({ headline: "x" }))).toBeNull();
  });
});

describe("groupRows", () => {
  test("groups in their order, On me by outcome, sessions before panes, empty groups left out", () => {
    const list = rows(
      [
        session("later", { ball: "on_my_time" }),
        session("timer", { ball: "on_timer" }),
        session("done", { ball: "on_me", outcome: "fulfilled" }),
        session("plain", { ball: "on_me" }),
        session("late", { ball: "on_me", outcome: "overdue" }),
        session("look", { ball: "on_me", outcome: "attention" }),
        session("m1"),
        session("m2"),
      ],
      [{ pane: 5, label: "job", ball: "on_me", line: "", outcome: "attention", waits: [] }],
    );
    expect(groupRows(list).map((g) => [g.label, g.rows.map(rowId)])).toEqual([
      ["On me", ["look", "pane:5", "late", "done", "plain"]],
      ["Machine watching", ["m1", "m2"]],
      ["On a timer", ["timer"]],
      ["When I have time", ["later"]],
    ]);
  });

  test("every word must match the title, note, project, a thread, waiting for or the headline", () => {
    const row = rows([session("a", { title: "Fix desync", note: "check RM", project: "shiftmaqt", threads: ["⏳ PR#74 review"], waiting_for: "Anna", headline: "conflicts" })])[0];
    for (const q of ["", "desync", "rm shiftmaqt", "PR#74", "anna conflicts", "  FIX  "]) expect(matchesRow(row, q)).toBe(true);
    expect(matchesRow(row, "desync nope")).toBe(false);
    expect(groupRows([row], "nope")).toEqual([]);
  });
});

describe("newlyOnMe", () => {
  const onMe = (id: string, ...waits: string[]) => session(id, { ball: "on_me", waits: waits.map((w) => wait(w, "on_me")) });

  test("the first look is no news", () => {
    const { keys, fresh } = newlyOnMe(rows([onMe("a", "w1")]), null);
    expect(fresh).toEqual([]);
    expect(keys.size).toBe(1);
  });

  test("a session entering on_me is news once", () => {
    const { keys } = newlyOnMe(rows([session("a")]), null);
    const first = newlyOnMe(rows([onMe("a", "w1")]), keys);
    expect(first.fresh.map((f) => [rowId(f.row), f.text])).toEqual([["a", "Label w1"]]);
    expect(newlyOnMe(rows([onMe("a", "w1")]), first.keys).fresh).toEqual([]);
  });

  test("only the agent's own question counts as asking; anything new with it is what the notification says", () => {
    const asks = wait("w1", "on_me", { reason: "agent asks a question" });
    const pr = wait("w2", "on_me", { reason: "ran, take a look" });
    const alone = newlyOnMe(rows([session("a", { ball: "on_me", waits: [asks] })]), new Set()).fresh;
    expect(alone.map((f) => [f.text, f.asking])).toEqual([["agent asks a question", true]]);
    const both = newlyOnMe(rows([session("a", { ball: "on_me", waits: [asks, pr] })]), new Set()).fresh;
    expect(both.map((f) => [f.text, f.asking])).toEqual([["ran, take a look", false]]);
  });

  test("another wait firing on a session already on you is news, and says so", () => {
    const { keys } = newlyOnMe(rows([onMe("a", "w1")]), null);
    const { fresh } = newlyOnMe(rows([session("a", { ball: "on_me", waits: [wait("w1", "on_me"), wait("w2", "on_me", { reason: "ran, take a look" })] })]), keys);
    expect(fresh.map((f) => f.text)).toEqual(["ran, take a look"]);
  });

  test("a wait that left on_me and came back is news again", () => {
    const one = newlyOnMe(rows([onMe("a", "w1")]), null);
    const away = newlyOnMe(rows([session("a")]), one.keys);
    expect(newlyOnMe(rows([onMe("a", "w1")]), away.keys).fresh).toHaveLength(1);
  });

  test("panes count, and a session two waits entered at once notifies once", () => {
    const pane = { pane: 51, label: "bun test", ball: "on_me", line: "job failed", waits: [wait("w9", "on_me")] };
    const { fresh } = newlyOnMe(rows([onMe("a", "w1", "w2")], [pane]), new Set());
    expect(fresh.map((f) => rowId(f.row))).toEqual(["a", "pane:51"]);
  });

  test("an on_me row without a readable wait falls back to its line", () => {
    const { fresh } = newlyOnMe(rows([session("a", { ball: "on_me", waits: [] })]), new Set());
    expect(fresh.map((f) => f.text)).toEqual(["⏳ PR#1"]);
  });
});

describe("blockOf", () => {
  const row = rows([session("a")])[0];
  const agent = (sessionId: string) => ({ sessionId });

  const blocks = (...list: { block: string; agent: { sessionId: string } | null }[]) => list;

  test("the bridge's session wins over the view's pane", () => {
    expect(blockOf(blocks({ block: "42", agent: null }, { block: "7", agent: agent("a") }), row)?.block).toBe("7");
  });
  test("else the pane, if it is on the list", () => {
    expect(blockOf(blocks({ block: "42", agent: agent("b") }), row)?.block).toBe("42");
    expect(blockOf(blocks({ block: "9", agent: null }), row)).toBeNull();
  });
  test("a closed session has none", () => {
    expect(blockOf(blocks({ block: "42", agent: null }), { ...row, pane: null })).toBeNull();
  });
});

describe("waitingArgs", () => {
  const list: WaitingRow[] = rows(
    [session("a", { waits: [wait("w1"), wait("w2")] })],
    [{ pane: 51, label: "bun test", ball: "on_machine", line: "", waits: [wait("w9")] }],
  );

  test("each action's argv", () => {
    expect(waitingArgs("mark-seen", { session: "a", wait: "w2" }, list)).toEqual(["mark-seen", "--session", "a", "--wait", "w2"]);
    expect(waitingArgs("mark-seen", { session: "a" }, list)).toEqual(["mark-seen", "--session", "a"]);
    expect(waitingArgs("stop", { session: "a", wait: "w1" }, list)).toEqual(["stop", "--session", "a", "--wait", "w1"]);
    expect(waitingArgs("stop", { pane: 51, all: true }, list)).toEqual(["stop", "--pane", "51", "--all"]);
    expect(waitingArgs("snooze", { session: "a", wait: "w1" }, list)).toEqual(["snooze", "--session", "a", "--wait", "w1", "--for", "1d"]);
    expect(waitingArgs("seen", { session: "a" }, list)).toEqual(["seen", "--session", "a"]);
    expect(waitingArgs("note", { session: "a", text: "-- back on Friday" }, list)).toEqual(["note", "--session", "a", "--text=-- back on Friday"]);
    expect(waitingArgs("accept-suggested", { pane: 51 }, list)).toEqual(["note", "--pane", "51", "--accept-suggested"]);
    expect(waitingArgs("what", { session: "a", text: "--Anna's reply" }, list)).toEqual(["what", "--session", "a", "--text=--Anna's reply"]);
    // Empty clears the free-text wait.
    expect(waitingArgs("what", { pane: 51, text: "" }, list)).toEqual(["what", "--pane", "51", "--text="]);
  });

  test("ids must be on the current view", () => {
    for (const body of [{ session: "--help" }, { session: "gone" }, {}, { pane: 52 }, { pane: "51" }, { session: 1 }])
      expect(waitingArgs("stop", { ...body, all: true }, list)).toEqual({ status: 404, error: "not on the waiting list" });
    expect(waitingArgs("stop", { session: "a", wait: "w9" }, list)).toEqual({ status: 404, error: "no such wait" });
    expect(waitingArgs("stop", { session: "a", wait: 1 }, list)).toEqual({ status: 404, error: "no such wait" });
  });

  test("a session's id never reaches a pane's row", () => {
    expect(waitingArgs("stop", { session: "a", pane: 51, all: true }, list)).toEqual(["stop", "--session", "a", "--all"]);
  });

  test("what an action needs is checked", () => {
    expect(waitingArgs("snooze", { session: "a" }, list)).toEqual({ status: 400, error: "snooze needs a wait" });
    expect(waitingArgs("mark-seen", { pane: 51, wait: "w9" }, list)).toEqual(["mark-seen", "--pane", "51", "--wait", "w9"]);
    expect(waitingArgs("stop", { session: "a" }, list)).toEqual({ status: 400, error: "stop needs a wait or all" });
    expect(waitingArgs("stop", { session: "a", wait: "w1", all: true }, list)).toEqual({ status: 400, error: "stop takes a wait or all, not both" });
    expect(waitingArgs("seen", { pane: 51 }, list)).toEqual({ status: 400, error: "only sessions have a return card" });
    expect(waitingArgs("note", { session: "a" }, list)).toEqual({ status: 400, error: "bad note" });
    expect(waitingArgs("note", { session: "a", text: "x".repeat(10_001) }, list)).toEqual({ status: 400, error: "bad note" });
    expect(waitingArgs("what", { session: "a" }, list)).toEqual({ status: 400, error: "bad text" });
    expect(waitingArgs("what", { session: "--help", text: "x" }, list)).toEqual({ status: 404, error: "not on the waiting list" });
  });
});
