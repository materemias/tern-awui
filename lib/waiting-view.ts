// CodexBar AgentView's waits as `codexbar_waiting.py` reports them: the parse at the CLI's edge and
// the little the app does with them. Which wait fired, what a row says and how a session is sorted
// are the CLI's; the view's fields are shown as they come. Shared by the server and the web app; no
// Node imports here.
import { arr, num, obj, str, type Obj } from "./json";
import { matchesWords } from "./search";

/** The groups the app shows, in their order. omp's own schedules (`on_timer`) are left out. */
const BALLS = ["on_me", "on_machine", "on_someone", "on_my_time"] as const;
/** Who holds the next step. */
export type Ball = (typeof BALLS)[number];
/** A wait can sit on a timer inside a row that is grouped by another of its waits. */
export type WaitBall = Ball | "on_timer";
const WAIT_BALLS: readonly WaitBall[] = [...BALLS, "on_timer"];

const OUTCOMES = ["fulfilled", "attention", "overdue"] as const;
/** What happened to a wait on the user: it came, it needs a look, or its time passed. */
export type Outcome = (typeof OUTCOMES)[number];
/** The mark each outcome leads with, as AgentView draws it. */
const OUTCOME_MARK: Record<Outcome, string> = { fulfilled: "✅", attention: "⚠️", overdue: "⏰" };

export type Wait = {
  id: string;
  /** "pr", "time", "command", "job", "something", "later", … */
  kind: string;
  /** The wait's own name: "Greptile review on the new head". */
  label: string;
  /** What it waits for, in a few words: "PR#16476 review on head", "until 17:00". */
  summary: string;
  /** "waiting", "pending" (a chain step not started), "acting" (the agent runs its prompt), "review", "fired", … */
  state: string;
  ball: WaitBall;
  /** Why it needs the user: "agent asks a question", "ran, take a look". */
  reason: string | null;
  overdue: boolean;
  outcome: Outcome | null;
  /** The CLI's mark for it ("✅", "⏳", "⏲"), without the trailing space. */
  mark: string;
  /** When it is due (ms); 0 without a time. */
  due: number;
  /** It runs a prompt when it fires. */
  hasPrompt: boolean;
  /** It repeats: Snooze 1d moves its next run whatever it does now. */
  repeats: boolean;
};

/** A PR the session waits on, created, or only mentioned (muted). */
export type Pr = {
  repo: string;
  number: number;
  url: string;
  source: "wait" | "created" | "mentioned";
  title: string | null;
  /** "open", "draft", "merged", "closed". */
  state: string | null;
  /** "approved", "changes_requested", "review_required". */
  review: string | null;
  /** "passing", "failing", "pending". */
  checks: string | null;
};

const VERDICTS = ["safe", "manual", "park"] as const;
/**
 * Whether closing the session (or pane) keeps its waits: `safe`, Tern reopens it when a wait fires;
 * `manual`, it comes back to the user, who resumes it; `park`, only parking keeps it.
 */
export type Close = { verdict: (typeof VERDICTS)[number]; reason: string; text: string };
/** The view's `health`: when a tick last checked the waits (ms, 0 never), and whether the last one failed. */
export type Health = { checkedAt: number; failed: boolean };

/** One line of what happened since the row was set aside; `fired`: a wait came. */
export type HistoryEvent = { at: number; text: string; fired: boolean };

/** A wait on the user and what came: `report`, for a "ran, take a look", is the agent's last words after its prompt. */
export type OnYou = { id: string; label: string; mark: string; text: string; report: string | null };

/** A session set aside, or a plain pane (a shell job) with waits of its own. */
export type WaitingRow = {
  /** The omp session; null for a plain pane. */
  session: string | null;
  /** The Tern pane running it; null while it runs in none. */
  pane: number | null;
  title: string;
  /** The folder's name; leads the row, as titles alone don't tell sessions apart. Empty for a pane. */
  project: string;
  live: boolean;
  /** "working", "blocked" or "idle" while its omp runs. */
  agentState: string | null;
  ball: Ball;
  /** What the wait that holds the row came to; null while nothing did. */
  outcome: Outcome | null;
  /** The outcome's line: "✅ PR#20 merged", "⚠️ conflicts with main". */
  headline: string | null;
  /** Each thread's current step, with its mark. */
  threads: string[];
  /** Threads still open beside the one that came. */
  stillWaiting: string[];
  /** The user's free-text "waiting for …". */
  waitingFor: string | null;
  /** When the row's earliest wait is due (ms); 0 without one. */
  due: number;
  /** Kept on the list without a wait ("When I have time"). */
  pinned: boolean;
  /** The user's guess of the work left: "S", "M", "L". */
  size: string | null;
  /** Something fired since the desktop's return card or a phone last showed it. */
  unseen: boolean;
  /** The user's own sentence. */
  note: string | null;
  /** The agent's sentence, kept apart until the user accepts it. */
  suggested: string | null;
  line: string;
  nextStep: string | null;
  recap: string | null;
  /** When the recap was written (ms); 0 without a time. */
  recapAt: number;
  /** The session moved on since: the recap tells an earlier state. */
  recapStale: boolean;
  /** When it was set aside (ms); 0 when the view has no time. */
  since: number;
  waits: Wait[];
  /** Oldest first, as the CLI keeps it. */
  history: HistoryEvent[];
  prs: Pr[];
  /** The CLI's close verdict; null with no open waits or from an older CLI. */
  close?: Close | null;
  /** The waits on the user, what Seen closes. */
  onYou: OnYou[];
  /** How many waits are open: what Stop all ends. */
  stoppable: number;
};

/** No `health` from an older CLI, which writes none. */
export type WaitingView = { onMe: number; rows: WaitingRow[]; health?: Health };
/** What the app gets: nothing without CodexBar AgentView, else the last good view and any failure to refresh it. */
export type Waiting = { available: false } | (WaitingView & { available: true; error?: string });

const pick = <T extends string>(list: readonly T[], value: unknown): T | null => list.find((v) => v === value) ?? null;

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const time = (value: unknown): number => Date.parse(str(value)) || 0;
const texts = (value: unknown): string[] => arr(value).flatMap((t) => (typeof t === "string" && t ? [t] : []));

function waits(value: unknown): Wait[] {
  return arr(value).flatMap((raw) => {
    const w = obj(raw);
    const ball = pick(WAIT_BALLS, w.ball);
    if (typeof w.id !== "string" || !w.id || !ball) return [];
    return [{
      id: w.id,
      kind: str(w.kind),
      label: str(w.label),
      summary: str(w.summary) || str(w.label),
      state: str(w.state),
      ball,
      reason: text(w.reason),
      overdue: w.overdue === true,
      outcome: pick(OUTCOMES, w.outcome),
      mark: str(w.mark).trim(),
      due: time(w.due_at),
      hasPrompt: w.has_prompt === true,
      repeats: w.repeat != null,
    }];
  });
}

function history(value: unknown): HistoryEvent[] {
  return arr(value).flatMap((raw) => {
    const h = obj(raw);
    const said = text(h.text);
    return said ? [{ at: time(h.at), text: said, fired: h.kind === "fired" }] : [];
  });
}

function prs(value: unknown): Pr[] {
  return arr(value).flatMap((raw) => {
    const p = obj(raw);
    const source = pick(["wait", "created", "mentioned"] as const, p.source);
    // Only https links (no `javascript:` and the like): the app puts it in an href.
    if (typeof p.repo !== "string" || typeof p.number !== "number" || !source || !str(p.url).startsWith("https://")) return [];
    return [{ repo: p.repo, number: p.number, url: str(p.url), source, title: text(p.title), state: text(p.state), review: text(p.review), checks: text(p.checks) }];
  });
}

function close(value: unknown): Close | null {
  const c = obj(value);
  const verdict = pick(VERDICTS, c.verdict);
  return verdict && typeof c.text === "string" && c.text ? { verdict, reason: str(c.reason), text: c.text } : null;
}

function onYou(value: unknown): OnYou[] {
  return arr(value).flatMap((raw) => {
    const o = obj(raw);
    return typeof o.id === "string" && o.id ? [{ id: o.id, label: str(o.label), mark: str(o.mark).trim(), text: str(o.text), report: text(o.report) }] : [];
  });
}

function health(value: unknown): Health | null {
  if (!value || typeof value !== "object") return null;
  const h = obj(value);
  // A partial error is a check that ran; any other error is a failed tick (an older CLI writes no kind).
  return { checkedAt: time(h.checked_at), failed: !!text(h.error) && h.error_kind !== "partial" };
}

/** The fields sessions and panes share. */
function common(t: Obj, ball: Ball) {
  return {
    close: close(t.close),
    ball,
    outcome: pick(OUTCOMES, t.outcome),
    headline: text(t.headline),
    threads: texts(t.threads),
    stillWaiting: texts(t.still_waiting),
    waitingFor: text(t.waiting_for),
    due: time(t.due_at),
    note: text(t.note),
    line: str(t.line),
    waits: waits(t.waits),
    history: history(t.history),
    onYou: onYou(t.on_you),
    stoppable: typeof t.stoppable === "number" ? t.stoppable : 0,
  };
}

function sessionRow(raw: unknown): WaitingRow[] {
  const s = obj(raw);
  const ball = pick(BALLS, s.ball);
  if (typeof s.session_id !== "string" || !s.session_id || !ball) return [];
  const live = s.live === true;
  return [{
    ...common(s, ball),
    session: s.session_id,
    pane: live && typeof s.pane === "number" ? s.pane : null,
    title: str(s.title) || "Untitled session",
    // The cwd's last part, with `/` or `\` separators, when the CLI has no project name.
    project: str(s.project) || (str(s.cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""),
    live,
    agentState: text(s.agent_state),
    pinned: s.pinned === true,
    size: text(s.size),
    unseen: s.unseen === true,
    suggested: text(s.suggested_note),
    nextStep: text(s.next_step),
    recap: text(s.recap),
    recapAt: time(s.recap_at),
    recapStale: s.recap_stale === true,
    since: time(s.set_aside_at),
    prs: prs(s.prs),
  }];
}

function paneRow(raw: unknown): WaitingRow[] {
  const p = obj(raw);
  const ball = pick(BALLS, p.ball);
  if (typeof p.pane !== "number" || !ball) return [];
  return [{
    ...common(p, ball),
    session: null,
    pane: p.pane,
    title: str(p.label) || `Pane ${p.pane}`,
    project: "",
    live: true,
    agentState: null,
    pinned: false,
    size: null,
    unseen: false,
    suggested: null,
    nextStep: null,
    recap: null,
    recapAt: 0,
    recapStale: false,
    since: time(p.set_aside_at) || time(obj(arr(p.waits)[0]).created_at),
    prs: [],
  }];
}

/** The CLI's `list` output (or an answer's `view`); null when it isn't one. Rows it can't read are left out. */
export function parseView(value: unknown): WaitingView | null {
  const v = obj(value);
  if (v.ok !== true || !Array.isArray(v.sessions)) return null;
  const h = health(v.health);
  return { onMe: num(obj(v.counts).on_me), rows: [...v.sessions.flatMap(sessionRow), ...arr(v.panes).flatMap(paneRow)], ...(h && { health: h }) };
}

/** A tick older than this means nothing checks the waits, as AgentView's "Waits not checked since" says. */
const TICK_STALE_MS = 15 * 60_000;
const UNCHECKED: Close = { verdict: "park", reason: "unchecked", text: "park only: nothing checks waits" };

/**
 * Whether the row is safe to close, as shown: while nothing checks the waits (a failed or stale tick,
 * or none yet), closing loses them whatever the CLI's verdict says. Null for a row without waits.
 */
export function closeOf(row: WaitingRow, health: Health | null | undefined, now: number): Close | null {
  if (!row.close && !row.waits.length) return null;
  if (health && (health.failed || !health.checkedAt || now - health.checkedAt > TICK_STALE_MS)) return UNCHECKED;
  return row.close ?? null;
}

/** What identifies a row across views. */
export function rowId(row: WaitingRow): string {
  return row.session ?? `pane:${row.pane}`;
}

/**
 * The wait Snooze 1d pushes, as AgentView picks it: one on the user first, then the earliest due.
 * It skips what `snooze` refuses: a chain step not started, one done, "when I have time", a job
 * still running in time, and one whose prompt the agent runs now. None: nothing to snooze.
 */
export function snoozeTarget(row: WaitingRow): Wait | undefined {
  let first: Wait | undefined;
  for (const w of row.waits) {
    const refused =
      w.state === "pending" || w.state === "done" || w.kind === "later" ||
      (w.kind === "job" && w.state === "waiting" && !w.overdue) ||
      (w.state === "acting" && w.kind !== "time" && !w.repeats);
    if (refused) continue;
    const mine = w.ball === "on_me";
    const firstMine = first?.ball === "on_me";
    if (!first || (mine && !firstMine) || (mine === firstMine && (w.due || Infinity) < (first.due || Infinity))) first = w;
  }
  return first;
}

/** The headline without the outcome mark the row already leads with. */
export function headlineText(row: WaitingRow): string | null {
  if (!row.headline || !row.outcome) return null;
  const mark = `${OUTCOME_MARK[row.outcome]} `;
  return row.headline.startsWith(mark) ? row.headline.slice(mark.length) : row.headline;
}

/** Every query word must be in the title, note, project, a thread, "waiting for" or the headline. */
export function matchesRow(row: WaitingRow, query: string): boolean {
  return matchesWords(query, [row.title, row.note, row.project, ...row.threads, row.waitingFor, row.headline].filter(Boolean).join("\n"));
}

export const GROUPS: readonly { ball: Ball; label: string }[] = [
  { ball: "on_me", label: "On me" },
  { ball: "on_machine", label: "Machine watching" },
  { ball: "on_someone", label: "Waiting on something" },
  { ball: "on_my_time", label: "When I have time" },
];
/** On me, what needs a look leads and what merely came stays visible last until Seen. */
const ON_ME_RANK: Record<Outcome, number> = { attention: 0, overdue: 1, fulfilled: 2 };

/**
 * The rows that match `query`, in the groups' order, empty groups left out. Sessions come before
 * panes within each; On me sorts by outcome, keeping the CLI's order within one; the rest keep it.
 */
export function groupRows(rows: WaitingRow[], query = ""): { ball: Ball; label: string; rows: WaitingRow[] }[] {
  const shown = rows.filter((r) => matchesRow(r, query));
  const ordered = [...shown.filter((r) => r.session !== null), ...shown.filter((r) => r.session === null)];
  return GROUPS.flatMap(({ ball, label }) => {
    const group = ordered.filter((r) => r.ball === ball);
    if (ball === "on_me") group.sort((a, b) => (a.outcome ? ON_ME_RANK[a.outcome] : 3) - (b.outcome ? ON_ME_RANK[b.outcome] : 3));
    return group.length ? [{ ball, label, rows: group }] : [];
  });
}

/** The CLI's reason for a wait whose agent stopped to ask something: the ask the bridge reports as *blocked*. */
const AGENT_ASKS = "agent asks a question";

/** A row that newly waits on the user, and what its notification says. `asking`: all that's new is the agent's own question. */
export type OnMe = { row: WaitingRow; text: string; asking: boolean };

/**
 * The rows with a wait on the user that `known` doesn't hold, and the waits on the user now, for
 * the next call. `known` null is the first look: what already waits is no news.
 */
export function newlyOnMe(rows: WaitingRow[], known: Set<string> | null): { keys: Set<string>; fresh: OnMe[] } {
  const keys = new Set<string>();
  const fresh: OnMe[] = [];
  for (const row of rows) {
    if (row.ball !== "on_me") continue;
    const onMe = row.waits.filter((w) => w.ball === "on_me");
    const added = (onMe.length ? onMe : [null]).filter((w) => {
      const key = `${rowId(row)}\0${w?.id ?? ""}`;
      keys.add(key);
      return known !== null && !known.has(key);
    });
    if (!added.length) continue;
    const other = added.find((w) => w?.reason !== AGENT_ASKS);
    const wait = other ?? added[0];
    fresh.push({ row, text: wait?.reason || wait?.label || wait?.summary || row.line, asking: other === undefined });
  }
  return { keys, fresh };
}

/** The Tern block running a row, among the list's: by its session when a bridge reports it, else by its pane. */
export function blockOf<B extends { block: string; agent: { sessionId: string } | null }>(blocks: B[], row: WaitingRow): B | null {
  const mine = row.session === null ? undefined : blocks.find((b) => b.agent?.sessionId === row.session);
  if (mine) return mine;
  return row.pane === null ? null : (blocks.find((b) => b.block === String(row.pane)) ?? null);
}

export const WAITING_ACTIONS = ["mark-seen", "stop", "snooze", "seen", "note", "accept-suggested", "what"] as const;
export type WaitingAction = (typeof WAITING_ACTIONS)[number];

/** A note goes out as one argument, which the OS limits; a sentence never gets near this. */
const MAX_NOTE = 10_000;

/**
 * The CLI arguments of a request, or why it is refused. Ids come from the phone, so they must name
 * a row and a wait of the current view; only those go on the command line. `mark-seen` closes what
 * is on the user (one wait of it with `wait`); `stop` ends one wait, or every open one with `all:
 * true`. `seen` only marks the return card viewed. Whether anything is on the user or open is the
 * CLI's to refuse: the view here may be a tick old.
 */
export function waitingArgs(action: WaitingAction, body: Obj, rows: WaitingRow[]): string[] | { status: number; error: string } {
  const row = rows.find((r) => (typeof body.session === "string" ? r.session === body.session : r.session === null && r.pane === body.pane));
  if (!row) return { status: 404, error: "not on the waiting list" };
  const target = row.session === null ? ["--pane", String(row.pane)] : ["--session", row.session];
  const wait = row.waits.find((w) => w.id === body.wait);
  if (body.wait !== undefined && !wait) return { status: 404, error: "no such wait" };
  switch (action) {
    case "mark-seen":
      return ["mark-seen", ...target, ...(wait ? ["--wait", wait.id] : [])];
    case "stop":
      if (wait) return body.all === undefined ? ["stop", ...target, "--wait", wait.id] : { status: 400, error: "stop takes a wait or all, not both" };
      if (body.all !== true) return { status: 400, error: "stop needs a wait or all" };
      return ["stop", ...target, "--all"];
    case "snooze":
      if (!wait) return { status: 400, error: "snooze needs a wait" };
      return ["snooze", ...target, "--wait", wait.id, "--for", "1d"];
    case "seen":
      if (row.session === null) return { status: 400, error: "only sessions have a return card" };
      return ["seen", "--session", row.session];
    case "note":
    case "what":
      if (typeof body.text !== "string" || body.text.length > MAX_NOTE) return { status: 400, error: `bad ${action === "note" ? "note" : "text"}` };
      // `=` so a text starting with `-` stays the option's value; an empty one clears it.
      return [action, ...target, `--text=${body.text}`];
    case "accept-suggested":
      return ["note", ...target, "--accept-suggested"];
  }
}
