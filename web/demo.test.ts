import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalView, ChatEntry, Closed, Item, LimitView, Run, State, StretchState, Voice, Waiting } from "./api";
import { DemoServer, demoEventSource, type Clock, type Sink } from "./demo-backend";
import { isOld } from "./lib";
import { ASK_FORM, demoLive, VOICE } from "./demo-fixtures";
import { parseAskForm } from "../lib/ask-form";
import { WAITING_ACTIONS } from "../lib/waiting-view";

/** A clock the test moves by hand: timers run in time order as `advance` passes them. */
class ManualClock implements Clock {
  private t = 1_800_000_000_000;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  after(ms: number, fn: () => void) {
    const timer = { at: this.t + ms, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => void (this.timers = this.timers.filter((x) => x !== timer));
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

const post = (server: DemoServer, path: string, body: unknown) =>
  server.fetch(new URL(path, "http://demo.test"), { method: "POST", body: JSON.stringify(body) });
const get = async <T>(server: DemoServer, path: string): Promise<T> => (await server.fetch(new URL(path, "http://demo.test"))).json();

/** The stream's events the tests read, as the demo sends them. */
type Events = {
  state: State;
  chat: { entries: ChatEntry[] };
  live: { text: string; done: boolean };
  run: Run | null;
  draft: { live: boolean; text: string };
  approval: ApprovalView | null;
  limit: LimitView | null;
  waiting: Waiting;
  voice: Voice | null;
  stretch: StretchState | null;
  btw: { id: string; question: string; text: string; done: boolean };
};
const TYPES = ["state", "chat", "live", "run", "draft", "approval", "limit", "waiting", "voice", "stretch", "btw"] as const;

/** Opens the app's stream for `block` (null: the list) through the demo's EventSource and records what it delivers. */
function open(server: DemoServer, clock: ManualClock, block: string | null) {
  const ES = demoEventSource(server);
  const es = new ES(block ? `/api/stream?block=${block}&view=chat` : "/api/stream?view=chat");
  const events: { type: keyof Events; data: unknown }[] = [];
  for (const type of TYPES) es.addEventListener(type, (e) => events.push({ type, data: JSON.parse(e.data) }));
  clock.advance(0);
  // The payloads come from the demo's own server, typed as it sends them; the assertions check them.
  const all = <K extends keyof Events>(type: K) => events.filter((e) => e.type === type).map((e) => e.data as Events[K]);
  return { all, last: <K extends keyof Events>(type: K) => all(type).at(-1)! };
}

const itemOf = (state: State, block: string): Item => state.projects.flatMap((p) => p.items).find((i) => i.block === block)!;

function setup() {
  const clock = new ManualClock();
  return { clock, server: new DemoServer(clock) };
}

describe("demo backend", () => {
  test("answers the app's state request with the sample sessions", async () => {
    const { clock, server } = setup();
    const state = await get<State>(server, "/api/state");
    expect(state.projects.map((p) => p.name)).toEqual(["tern-awui", "api-server", "dotfiles"]);
    const items = state.projects.flatMap((p) => p.items);
    // Each row opens its own session: a shared block id would show another row's content.
    expect(new Set(items.map((i) => i.block)).size).toBe(items.length);
    expect(items.map((i) => i.status)).toEqual(["working", "blocked", "idle", null, null, "idle", "blocked", "idle", "idle", "idle", "idle", "idle", null]);
    // The parked one is off the list, so it doesn't count.
    expect(state.counts).toEqual({ working: 1, blocked: 2, idle: 6 });
    // The list's eye has something to hide: two sessions are older than a day.
    expect(items.filter((i) => !i.parked && isOld(i, clock.now(), null)).map((i) => i.title)).toEqual(["Fix the swipe wheel", "Tidy the zsh config"]);
    // Busy rows say what they do or ask, as the server's do.
    expect(itemOf(state, "11").activity).toBe("Waiting on CssAudit");
    expect(itemOf(state, "12").activity).toBe(ASK_FORM.question);
    expect(itemOf(state, "23").activity).toBe("Allow edit? Restricted folder: ~/code/api-server/deploy");
  });

  test("a submitted prompt streams its reply as live text, then lands in the chat", async () => {
    const { clock, server } = setup();
    const { all, last } = open(server, clock, "22");
    expect(last("chat").entries.at(-1)?.role).toBe("turn");

    const r = await post(server, "/api/blocks/22/submit", { text: "use bun:sqlite", images: [] });
    expect(r.ok).toBe(true);
    expect(last("chat").entries.at(-1)).toMatchObject({ role: "user", text: "use bun:sqlite" });
    expect(itemOf(last("state"), "22").status).toBe("working");

    clock.advance(60_000);
    const live = all("live");
    expect(live.length).toBeGreaterThan(3);
    // Each update grows the one before it, and the last is the finished reply.
    for (let i = 1; i < live.length - 1; i++) expect(live[i].text.startsWith(live[i - 1].text)).toBe(true);
    const done = live.at(-1)!;
    expect(done.done).toBe(true);
    expect(done.text).toContain("use bun:sqlite");
    const entries = last("chat").entries;
    expect(entries.findLast((e) => e.role === "assistant")).toMatchObject({ text: done.text });
    expect(last("run")).toBeNull();
    // Watched while it finished: the turn counts as seen.
    expect(itemOf(last("state"), "22")).toMatchObject({ status: "idle", unseen: null });
  });

  test("answering the open ask resolves it and starts a turn", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "12");
    expect(await (await post(server, "/api/blocks/12/answer", { id: "ask-12", values: { push: "hand-rolled" }, other: {} })).json()).toEqual({ ok: true });
    expect(last("chat").entries.find((e) => e.role === "ask")).toMatchObject({ answer: "Which push library should the server use?: Hand-rolled" });
    clock.advance(60_000);
    expect(last("chat").entries.findLast((e) => e.role === "assistant")).toMatchObject({ text: expect.stringContaining("Hand-rolled") });
    // A second answer finds no open question.
    expect((await post(server, "/api/blocks/12/answer", { id: "ask-12", values: { push: "skip" }, other: {} })).status).toBe(409);
  });

  test("a session stopped on a usage limit continues a minute after the reset, unless cancelled", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "24");
    const limit = last("limit")!;
    expect(limit).toMatchObject({ kind: "wait", continueAt: null });
    expect(limit.resetAt! - clock.now()).toBe(133 * 60_000);
    // Set, cancelled, and set again: only the last one stands.
    expect(await (await post(server, "/api/blocks/24/continue", { when: "reset" })).json()).toEqual({ ok: true, at: limit.resetAt! + 60_000 });
    expect(last("limit")?.continueAt).toBe(limit.resetAt! + 60_000);
    expect((await post(server, "/api/blocks/24/continue", { cancel: true })).ok).toBe(true);
    expect(last("limit")?.continueAt).toBeNull();
    expect((await post(server, "/api/blocks/24/continue", { when: "reset" })).ok).toBe(true);
    clock.advance(133 * 60_000);
    // Reset, but the minute after it hasn't passed.
    expect(itemOf(last("state"), "24").status).toBe("idle");
    clock.advance(60_000);
    expect(last("chat").entries.findLast((e) => e.role === "user")).toMatchObject({ text: "Continue from where you stopped." });
    expect(itemOf(last("state"), "24").status).toBe("working");
    expect(last("limit")).toBeNull();
    expect((await post(server, "/api/blocks/24/continue", { when: "reset" })).status).toBe(409);
  });

  test("Continue now sends the continue at once", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "24");
    expect((await post(server, "/api/blocks/24/continue", { when: "now" })).ok).toBe(true);
    expect(last("chat").entries.at(-1)).toMatchObject({ role: "user", text: "Continue from where you stopped." });
    expect(itemOf(last("state"), "24").status).toBe("working");
    expect(last("limit")).toBeNull();
  });

  test("the demo's ask fields are what the server parses from its form", () => {
    expect(parseAskForm(ASK_FORM.html)).toEqual(ASK_FORM.fields);
  });

  test("a prompt waits for the open ask to be answered; images go with a prompt", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "12");
    const asked = await post(server, "/api/blocks/12/submit", { text: "never mind" });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toEqual({ error: "Answer the question first" });
    expect(last("chat").entries.findLast((e) => e.role === "user")?.text).not.toBe("never mind");
    // An image-only send is a prompt; its image shows as the browser's own data: URL.
    const s22 = open(server, clock, "22");
    expect((await post(server, "/api/blocks/22/submit", { text: "", images: [{ data: "AAAA", mimeType: "image/png" }] })).ok).toBe(true);
    expect(s22.last("chat").entries.at(-1)).toMatchObject({ role: "user", images: [{ src: "data:image/png;base64,AAAA" }] });
    expect((await post(server, "/api/blocks/22/submit", { text: "x", images: [{ data: "AAAA", mimeType: "text/html" }] })).status).toBe(400);
  });

  test("Approve once runs the edit and ends the turn with its changed file", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "23");
    const approval = last("approval")!;
    expect(approval).toMatchObject({ tool: "edit", reason: "Restricted folder: ~/code/api-server/deploy" });
    expect(approval.args?.[0].value).toStartWith("[deploy/prod.yml#");
    expect((await post(server, "/api/blocks/23/approve", { id: "other", allow: true })).status).toBe(409);
    expect((await post(server, "/api/blocks/23/approve", { id: approval.id, allow: true })).ok).toBe(true);
    expect(last("approval")).toBeNull();
    expect(itemOf(last("state"), "23").status).toBe("working");
    clock.advance(60_000);
    expect(last("chat").entries.at(-1)).toMatchObject({ role: "turn", files: [{ path: expect.stringContaining("deploy/prod.yml"), added: 3, removed: 1 }] });
    expect(itemOf(last("state"), "23")).toMatchObject({ status: "idle", activity: null });
    // Answered: a second tap finds nothing to answer.
    expect((await post(server, "/api/blocks/23/approve", { id: approval.id, allow: true })).status).toBe(409);
  });

  test("Deny ends the turn without changes; a reply denies it too", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "23");
    expect((await post(server, "/api/blocks/23/approve", { id: last("approval")!.id, allow: false })).ok).toBe(true);
    clock.advance(60_000);
    const end = last("chat").entries.at(-1);
    expect(end?.role === "turn" && end.files).toBeFalsy();
    expect(last("chat").entries.findLast((e) => e.role === "assistant")).toMatchObject({ text: expect.stringContaining("Left `deploy/prod.yml`") });

    const again = setup();
    const steered = open(again.server, again.clock, "23");
    expect((await post(again.server, "/api/blocks/23/submit", { text: "scale on load instead" })).ok).toBe(true);
    expect(steered.last("approval")).toBeNull();
    expect(steered.last("chat").entries.at(-1)).toMatchObject({ role: "user", text: "scale on load instead" });
  });

  test("Deny with a reason steers: the reason is the next prompt, and the agent takes it up", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "23");
    const id = last("approval")!.id;
    expect((await post(server, "/api/blocks/23/approve", { id, allow: true, reason: "not on prod" })).status).toBe(400);
    expect((await post(server, "/api/blocks/23/approve", { id, allow: false, reason: "  try staging first  " })).ok).toBe(true);
    expect(last("approval")).toBeNull();
    expect(last("chat").entries.findLast((e) => e.role === "user")).toMatchObject({ text: "try staging first" });
    clock.advance(60_000);
    expect(last("chat").entries.findLast((e) => e.role === "assistant")).toMatchObject({ text: expect.stringContaining("try staging first") });
    expect((await post(server, "/api/blocks/23/approve", { id, allow: false, reason: "again" })).status).toBe(409);
  });

  test("Waiting holds one session per group; Done, Snooze 1d and notes update it", async () => {
    const { clock, server } = setup();
    const list = open(server, clock, null);
    const first = list.last("waiting");
    if (!first.available) throw new Error("no waiting view");
    expect(first.rows.map((r) => r.ball)).toEqual(["on_me", "on_machine", "on_timer", "on_someone", "on_my_time"]);
    expect(first.onMe).toBe(1);
    // Done on the row on you: the review is seen, and CI still runs.
    expect((await post(server, "/api/waiting/mark-seen", { session: "demo-21" })).ok).toBe(true);
    const done = list.last("waiting");
    if (!done.available) throw new Error("no waiting view");
    expect(done.onMe).toBe(0);
    expect(done.rows.find((r) => r.session === "demo-21")).toMatchObject({ ball: "on_machine", outcome: null, onYou: [], threads: ["⏳ PR#212 checks"] });
    // Snooze pushes the timer a day.
    expect((await post(server, "/api/waiting/snooze", { session: "demo-c48", wait: "w-48-rerun" })).ok).toBe(true);
    const snoozed = list.last("waiting");
    if (!snoozed.available) throw new Error("no waiting view");
    expect(snoozed.rows.find((r) => r.session === "demo-c48")!.waits.find((w) => w.id === "w-48-rerun")!.due).toBe(clock.now() + 24 * 60 * 60_000);
    // omp's suggestion becomes the note; a note edits in place.
    expect((await post(server, "/api/waiting/accept-suggested", { session: "demo-25" })).ok).toBe(true);
    expect((await post(server, "/api/waiting/note", { session: "demo-31", text: "next weekend" })).ok).toBe(true);
    const noted = list.last("waiting");
    if (!noted.available) throw new Error("no waiting view");
    expect(noted.rows.find((r) => r.session === "demo-25")).toMatchObject({ note: "Minors are in; the two majors wait for infra.", suggested: null });
    expect(noted.rows.find((r) => r.session === "demo-31")!.note).toBe("next weekend");
    // As the server checks it: an unknown row is refused.
    expect((await post(server, "/api/waiting/seen", { session: "nope" })).status).toBe(404);
  });

  test("Snooze 1d takes the wait off you; the row sits On a timer once only the clock holds it", async () => {
    const { clock, server } = setup();
    const list = open(server, clock, null);
    expect((await post(server, "/api/waiting/snooze", { session: "demo-21", wait: "w-212-review" })).ok).toBe(true);
    const snoozed = list.last("waiting");
    if (!snoozed.available) throw new Error("no waiting view");
    expect(snoozed.onMe).toBe(0);
    expect(snoozed.rows.find((r) => r.session === "demo-21")).toMatchObject({ ball: "on_machine", onYou: [], waits: [{ id: "w-212-review", ball: "on_timer", snoozable: false }, { id: "w-212-ci" }] });
    expect((await post(server, "/api/waiting/stop", { session: "demo-21", wait: "w-212-ci" })).ok).toBe(true);
    const timer = list.last("waiting");
    if (!timer.available) throw new Error("no waiting view");
    expect(timer.rows.find((r) => r.session === "demo-21")!.ball).toBe("on_timer");
  });

  test("Tern sessions spread the list; launches open in the picked one", async () => {
    const { clock, server } = setup();
    const state = await get<State>(server, "/api/state");
    expect(state.ternSessions.map((s) => s.name)).toEqual(["Default", "weekend", "ops"]);
    const items = state.projects.flatMap((p) => p.items);
    expect(new Set(items.map((i) => i.ternSession))).toEqual(new Set(["Default", "weekend", "ops", null]));
    const r: { block: string } = await (await post(server, "/api/new", { cwd: "/home/you/code/api-server", session: "weekend" })).json();
    clock.advance(5_000);
    expect(itemOf(await get<State>(server, "/api/state"), r.block)).toMatchObject({ ternSession: "weekend", status: "idle" });
    expect((await post(server, "/api/new", { cwd: "/home/you/code/api-server", session: "nope" })).status).toBe(400);
    // Unpark lands in the picked session; without one, in the one the desktop shows.
    expect((await post(server, "/api/blocks/25/unpark", { session: "ops" })).ok).toBe(true);
    expect(itemOf(await get<State>(server, "/api/state"), "25")).toMatchObject({ parked: false, ternSession: "ops" });
    expect((await post(server, "/api/blocks/32/unpark", {})).status).toBe(409);
  });

  test("Closed lists omp's sessions, searches all three tools, resumes and dismisses", async () => {
    const { clock, server } = setup();
    const closed = async (q = "") => (await get<{ sessions: Closed[] }>(server, `/api/closed${q && `?q=${encodeURIComponent(q)}`}`)).sessions;
    expect(new Set((await closed()).map((c) => c.agent))).toEqual(new Set(["omp"]));
    expect(new Set((await closed("claude")).map((c) => c.agent))).toEqual(new Set(["claude"]));
    expect((await closed("codex json")).map((c) => c.title)).toEqual(["Benchmark JSON parsers"]);
    expect((await closed("webhook")).map((c) => c.id)).toEqual(["demo-c48"]);

    const list = open(server, clock, null);
    const r: { block: string } = await (await post(server, "/api/closed/resume", { id: "demo-c48", agent: "omp" })).json();
    clock.advance(5_000);
    expect(itemOf(list.last("state"), r.block)).toMatchObject({ title: "Fix the flaky webhook tests", status: "idle", agent: { sessionId: "demo-c48" } });
    // Open now: off Closed, and its Waiting row turns live.
    expect((await closed()).some((c) => c.id === "demo-c48")).toBe(false);
    const view = list.last("waiting");
    expect(view.available && view.rows.find((w) => w.session === "demo-c48")?.live).toBe(true);
    // Resuming again opens the same pane.
    expect(await (await post(server, "/api/closed/resume", { id: "demo-c48" })).json()).toEqual({ block: r.block });

    const claude: { block: string } = await (await post(server, "/api/closed/resume", { id: "0b7e5c1a-3d2f-4e8a-9c61-2a7d5e9f1b30", agent: "claude" })).json();
    expect(itemOf(list.last("state"), claude.block)).toMatchObject({ title: "claude", agent: null, starting: false });

    // A closed omp session goes to Closed; × hides it.
    expect((await post(server, "/api/blocks/22/close", {})).ok).toBe(true);
    expect((await closed())[0]).toMatchObject({ id: "demo-22", title: "Pick a SQLite driver" });
    expect((await post(server, "/api/closed/dismiss", { id: "demo-22" })).ok).toBe(true);
    expect((await closed()).some((c) => c.id === "demo-22")).toBe(false);
  });

  test("a voice call listens, hands its question to the session as a turn and reads the result back", async () => {
    const { clock, server } = setup();
    const { all, last } = open(server, clock, "16");
    const r = await post(server, "/api/blocks/16/voice", { sdp: "v=0\r\n", attempt: "a1" });
    expect(await r.json()).toEqual({ sdp: VOICE.sdp });
    expect((await post(server, "/api/blocks/16/voice", { sdp: "v=0\r\n", attempt: "a2" })).status).toBe(409);
    clock.advance(60_000);
    const phases = all("voice").map((v) => v?.phase);
    expect(phases).toContain("listening");
    expect(phases).toContain("working");
    expect(last("chat").entries.findLast((e) => e.role === "user")).toMatchObject({ text: VOICE.ask });
    expect(last("voice")).toMatchObject({ attempt: "a1", phase: "listening", user: VOICE.ask, assistant: VOICE.spoken, ended: false });
    // Another phone's hang-up for an older attempt leaves the call alone.
    await post(server, "/api/blocks/16/hangup", { attempt: "old" });
    expect(last("voice")?.ended).toBe(false);
    await post(server, "/api/blocks/16/hangup", { attempt: "a1" });
    expect(last("voice")).toMatchObject({ ended: true, error: "" });
  });

  test("side questions, ✦, completions, rewind and service tiers behave", async () => {
    const { clock, server } = setup();
    const { all, last } = open(server, clock, "16");
    // /btw streams its answer and saves it for the history.
    const { id }: { id: string } = await (await post(server, "/api/blocks/16/btw", { text: "is this cached?" })).json();
    clock.advance(10_000);
    expect(all("btw").at(-1)).toMatchObject({ id, question: "is this cached?", done: true });
    const history: { records: { id: string; status: string }[] } = await get(server, "/api/blocks/16/btw-history");
    expect(history.records.at(-1)).toMatchObject({ id, status: "complete" });

    // ✦ on an open stretch: it runs, then its answer lands.
    const reply = last("chat").entries.find((e) => e.role === "assistant" && e.block);
    const block = reply?.role === "assistant" ? reply.block! : "";
    expect((await post(server, "/api/blocks/16/stretch", { block, key: "one WebSocket per session", open: true })).ok).toBe(true);
    expect(last("stretch")?.open[block]).toEqual(["one WebSocket per session"]);
    expect((await post(server, "/api/blocks/16/stretch", { block, key: "one WebSocket per session", deepen: true })).ok).toBe(true);
    expect(last("stretch")?.running[block]?.[0].key).toBe("one WebSocket per session");
    clock.advance(30_000);
    expect(last("stretch")).toMatchObject({ running: {}, answers: { [block]: [{ key: "one WebSocket per session" }] } });

    // omp's autocomplete, applied into the draft.
    const hints: { prefix: string; items: { value: string }[] } = await (await post(server, "/api/blocks/16/complete", { text: "run /sk" })).json();
    expect(hints.prefix).toBe("/sk");
    expect(hints.items.map((i) => i.value)).toContain("/skill:polish");
    expect(await (await post(server, "/api/blocks/16/completion", { text: "run /sk", value: "/skill:polish", label: "/skill:polish", prefix: "/sk" })).json()).toEqual({ text: "run /skill:polish " });

    // Rewind: back to before the prompt, its text returned to the editor.
    expect((await post(server, "/api/blocks/16/rewind", { entry: "u16a" })).ok).toBe(true);
    expect(last("chat").entries).toEqual([]);
    expect(last("draft")).toEqual({ live: true, text: "how does the phone reach omp?" });

    // OpenAI's models bring service tiers.
    expect((await post(server, "/api/blocks/16/tier", { tier: "priority" })).status).toBe(400);
    expect((await post(server, "/api/blocks/16/model", { spec: "openai/gpt-5:high" })).ok).toBe(true);
    expect((await post(server, "/api/blocks/16/tier", { tier: "priority" })).ok).toBe(true);
    expect(itemOf(last("state"), "16").live).toMatchObject({ model: "openai/gpt-5", tier: "priority", tiers: ["", "flex", "priority"] });
  });

  test("Reload restarts an omp on an older extension", async () => {
    const { clock, server } = setup();
    const { last } = open(server, clock, "31");
    expect(itemOf(last("state"), "31").live?.mismatch).toBe("older");
    expect((await post(server, "/api/blocks/31/submit", { text: "/restart" })).ok).toBe(true);
    expect(itemOf(last("state"), "31")).toMatchObject({ starting: true, live: null });
    clock.advance(5_000);
    expect(itemOf(last("state"), "31")).toMatchObject({ starting: false, status: "idle", live: { mismatch: null } });
  });
});

// ---------- the guardrail: the demo keeps up with the server ----------

const SERVER = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
const CHAT_PATCH = readFileSync(join(import.meta.dir, "..", "lib", "chat-patch.ts"), "utf8");

/** What the real server serves and can't exist in a browser-only demo, with why. Nothing else may be left out. */
const ROUTES_OUT: Record<string, string> = {
  // Images read from transcripts on disk; the demo's sample images are data: URLs.
  "GET /api/blob/<hash>": "no disk",
  // Opened through demoEventSource, which the event tour below exercises, not through fetch.
  "GET /api/stream": "EventSource",
};
const EVENTS_OUT: Record<string, string> = {
  // Abbreviations of `state` and `chat` (only what changed); the demo always sends them whole.
  patch: "state",
  chatpatch: "chat",
  // The server's own failures; the app doesn't listen for it.
  error: "server failure",
  // Internal: a moved leaf makes the stream reread the transcript; it never reaches a phone.
  leaf: "internal",
};

/** Every route server.ts answers, as `METHOD /path`, read from its source. */
function serverRoutes(): string[] {
  const routes = new Set<string>();
  for (const m of SERVER.matchAll(/(req\.method === "GET" && )?path === "(\/api\/[^"]+)"/g)) routes.add(`${m[1] ? "GET" : "POST"} ${m[2]}`);
  // The block actions' alternation, POSTs all.
  const actions = /\/\^\\\/api\\\/blocks\\\/\(\\d\+\)\\\/\(([a-z|-]+)\)\$\//.exec(SERVER);
  if (!actions) throw new Error("server.ts no longer has the block actions' regex");
  for (const a of actions[1].split("|")) routes.add(`POST /api/blocks/<n>/${a}`);
  // Single GET routes under a block, and the blob route.
  for (const m of SERVER.matchAll(/\/\^\\\/api\\\/blocks\\\/\(\\d\+\)\\\/([a-z-]+)\$\//g)) routes.add(`GET /api/blocks/<n>/${m[1]}`);
  if (SERVER.includes("/^\\/api\\/blob\\/")) routes.add("GET /api/blob/<hash>");
  // AgentView's actions, routed by template.
  if (!SERVER.includes("path === `/api/waiting/${action}`")) throw new Error("server.ts routes AgentView's actions another way");
  for (const a of WAITING_ACTIONS) routes.add(`POST /api/waiting/${a}`);
  return [...routes];
}

/** Every event server.ts sends a stream, read from its source. */
function serverEvents(): string[] {
  const events = new Set<string>();
  for (const re of [/\bsend\("([a-z]+)"/g, /\bemit\([\w.]+, "([a-z]+)"/g, /\bonPane\("([a-z]+)"/g]) for (const m of SERVER.matchAll(re)) events.add(m[1]);
  // The chat goes out whole or as a patch (lib/chat-patch.ts's chatUpdate).
  for (const m of CHAT_PATCH.matchAll(/\["([a-z]+)", /g)) events.add(m[1]);
  return [...events];
}

describe("the demo covers the server", () => {
  test("the source reads find the routes and events they should", () => {
    // A changed source layout must fail here, not pass by finding nothing.
    expect(serverRoutes()).toEqual(expect.arrayContaining(["GET /api/state", "POST /api/new", "POST /api/blocks/<n>/approve", "GET /api/blocks/<n>/subagents", "POST /api/waiting/snooze"]));
    expect(serverEvents()).toEqual(expect.arrayContaining(["state", "chat", "chatpatch", "approval", "voice", "waiting", "btw"]));
  });

  test("every server route has a demo answer, or a reason it can't", async () => {
    const missing: string[] = [];
    for (const route of serverRoutes()) {
      if (ROUTES_OUT[route]) continue;
      const [method, path] = route.split(" ");
      const url = new URL(path.replace("<n>", "16"), "http://demo.test");
      // A fresh server each: an earlier route (close) must not take the block away from a later one.
      const r = await new DemoServer(new ManualClock()).fetch(url, method === "GET" ? {} : { method, body: "{}" });
      // The demo's own JSON replies: an error string, or none.
      const reply: { error?: string } = r.ok ? {} : await r.json();
      const error = reply.error ?? "";
      // The demo's answer to what it doesn't know, or a refusal that names the demo, is a gap.
      if ((r.status === 404 && error === "not found") || error.includes("isn't in the demo")) missing.push(route);
    }
    expect(missing).toEqual([]);
  });

  test("every event the server sends, the demo sends in a tour of the app", async () => {
    const { clock, server } = setup();
    const seen = new Set<string>();
    const sink = (block: string | null, view = "chat"): Sink => ({ block, view, sub: null, send: (event) => seen.add(event) });
    for (const s of [sink(null), sink("16"), sink("23"), sink("17"), sink("13"), sink("11", "subagents"), sink("22")]) server.connect(s);
    await post(server, "/api/blocks/22/submit", { text: "one" });
    await post(server, "/api/blocks/22/submit", { text: "two" });
    await post(server, "/api/blocks/16/btw", { text: "why?" });
    await post(server, "/api/blocks/16/voice", { sdp: "v=0", attempt: "t" });
    clock.advance(60_000);
    const missing = serverEvents().filter((e) => !EVENTS_OUT[e] && !seen.has(e));
    expect(missing).toEqual([]);
  });

  test("every omp capability is on in the demo", () => {
    expect(Object.entries(demoLive().caps!).filter(([, on]) => !on)).toEqual([]);
  });
});
