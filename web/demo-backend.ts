// The demo's server, in the page: it answers the app's /api requests and feeds its event streams
// from the sample data in demo-fixtures.ts, so the real app runs with no Tern, omp or server.
// Prompts stream a canned reply as omp's would (`live`, then the `chat` entry); asks, approvals,
// side questions and ✦ resolve; sessions start, close, park, rewind and resume; Waiting's taps and
// a scripted voice call behave. The bell subscribes, but nothing is ever pushed (demo.test.ts keeps
// this list honest).
import type { Agent, AskField, ChangedFile, ChatEntry, ContextUse, Img, Item, Run, State, Voice } from "./api";
import { approvalQuestion, STRETCH_BLOCK } from "../lib/bridge-state";
import { CLOSED_AGENTS, keepsTool, matchesWords, parseSearch } from "../lib/search";
import { WAITING_ACTIONS } from "../lib/waiting-view";
import { onList } from "./lib";
import { withOpen } from "./stretch";
import { DemoWaiting } from "./demo-waiting";
import {
  ANSWER_REPLY,
  BTW_REPLY,
  CATALOG,
  COMPLETIONS,
  CONTEXT_WINDOW,
  DEEPEN,
  HOME,
  OPEN_TURN_REPLY,
  REPLIES,
  ROLES,
  TERN_SESSIONS,
  VOICE,
  demoAgent,
  demoClosed,
  demoLive,
  demoProjects,
  demoSessions,
  tiersOf,
  type DemoClosed,
  type DemoSession,
} from "./demo-fixtures";

/** Time as the demo sees it: real timers in the page, a hand-driven clock in tests. */
export type Clock = { now(): number; after(ms: number, fn: () => void): () => void };

export const realClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** One open stream, as `/api/stream?block=…&view=…&sub=…` asked for it. */
export type Sink = { block: string | null; view: string; sub: string | null; send(event: string, data: unknown): void };

type Session = DemoSession & {
  draft: string;
  /** The reply streaming now; null between turns. */
  live: string | null;
  run: Run | null;
  queued: { text: string; followUp: boolean }[];
  /** The fixture's turn that was already running at load; it wraps up once a prompt is queued behind it. */
  openTurn: boolean;
  /** A shell's typed line, not yet entered. */
  line: string;
  timers: Set<() => void>;
  /** The voice call, with its script's timers apart from the turn's. */
  voice: Voice | null;
  callTimers: Set<() => void>;
  /** `<agent>:<id>` of the closed session this one resumed. */
  resumed: string | null;
};

/** Words per streamed update, and the pause between updates. */
const WORDS_PER_STEP = 3;
const STEP_MS = 60;
const TOOLS_MS = 700;
const STARTING_MS = 1200;
const DEEPEN_STEP_MS = 250;
const COMPACT_AT = 85;
/** A well-formed VAPID public key for the bell's subscription; no push service ever sees it. */
const DEMO_PUSH_KEY = "BFmEns47IuBUiOWEoubiwt1a4--qd2PsjRzZSxJxBe2TVN6IRw6N4GQ_gqVGSpVONGEbOCFT__reZOSOeKsC2Xk"; // betterleaks:allow (public demo key)
const NOT_FOUND = "not found";
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What omp would record for an ask, from the app's `values` and `other`: each answered field's question and answer. */
function formAnswers(fields: AskField[], body: Record<string, unknown>): { question: string; answer: string }[] {
  const values = (body.values ?? {}) as Record<string, unknown>;
  const other = (body.other ?? {}) as Record<string, unknown>;
  return fields.flatMap((f) => {
    if (!f.name) return [];
    const typed = typeof other[f.name] === "string" ? (other[f.name] as string) : "";
    const picked = [values[f.name]].flat().filter((v): v is string => typeof v === "string" && v !== "");
    const labels = f.kind === "choice" ? picked.map((v) => f.options.find((o) => o.value === v)?.label ?? v) : picked;
    const answer = typed ? [...(f.kind === "choice" && f.multi ? labels : []), `Other: ${typed}`] : labels;
    return answer.length ? [{ question: f.question, answer: answer.join(", ") }] : [];
  });
}

/** A fixture as the server keeps it, with nothing running. */
function fresh(s: DemoSession): Session {
  return { ...s, draft: "", live: null, run: null, queued: [], openTurn: false, line: "", timers: new Set(), voice: null, callTimers: new Set(), resumed: null };
}

export class DemoServer {
  private sessions: Session[];
  private sinks = new Set<Sink>();
  private replies = 0;
  private nextBlock = 40;
  private closed: DemoClosed[];
  private dismissed = new Set<string>();
  private waiting: DemoWaiting;

  constructor(readonly clock: Clock = realClock) {
    const now = clock.now();
    this.sessions = demoSessions(now).map((s) => {
      const working = s.item.status === "working";
      return {
        ...fresh(s),
        run: working ? { since: s.item.since, intent: `Waiting on ${s.subagents.find((a) => a.running)?.name ?? "a subagent"}` } : null,
        openTurn: working,
      };
    });
    this.closed = demoClosed(now);
    this.waiting = new DemoWaiting(now);
  }

  state(): State {
    const projects = new Map<string, Item[]>();
    const items = this.sessions.map((s) => ({ ...s.item, activity: this.activity(s) }));
    for (const i of items) projects.set(i.project, [...(projects.get(i.project) ?? []), i]);
    // The counts follow the list, as the server's do: a parked session only while it needs you.
    const count = (status: string) => items.filter((i) => i.status === status && onList(i)).length;
    return {
      projects: [...projects].map(([name, list]) => ({ name, items: list })),
      counts: { working: count("working"), blocked: count("blocked"), idle: count("idle") },
      roles: ROLES,
      ternSessions: TERN_SESSIONS,
      badge: items.filter((i) => i.unseen).length,
      at: this.clock.now(),
      app: "",
      extension: { status: "ok", path: `${HOME}/.omp/agent/extensions/tern-mobile.ts`, target: "", repo: `${HOME}/code/tern-awui`, windows: false },
    };
  }

  /** What the row says it does: omp's working intent, or what it asks while blocked. */
  private activity(s: Session): string | null {
    if (s.item.status === "working") return s.run?.intent || null;
    if (s.item.status !== "blocked") return null;
    const ask = s.chat.findLast((e) => e.role === "ask");
    if (ask?.role === "ask" && ask.answer === null) return ask.question;
    return s.approval ? approvalQuestion(s.approval) : null;
  }

  /** Opens a stream: everything the server would send first, then updates until the returned close. */
  connect(sink: Sink): () => void {
    const s = sink.block ? this.find(sink.block) : undefined;
    const pane = !!s && this.isPane(s, sink);
    // Opening a session on the phone is seeing its update.
    const seen = pane && s.item.unseen !== null;
    if (seen) s.item.unseen = null;
    this.sinks.add(sink);
    if (pane) {
      sink.send("draft", { live: !!s.item.live, text: s.draft });
      if (s.live !== null) sink.send("live", { text: s.live, done: false });
      if (s.queued.length) sink.send("queued", s.queued);
      sink.send("run", s.run);
      sink.send("context", this.context(s));
      sink.send("stretch", s.stretch);
      sink.send("approval", s.approval);
      sink.send("voice", s.voice);
    }
    if (seen) this.emitState();
    else sink.send("state", this.state());
    sink.send("waiting", this.waiting.view(this.clock.now()));
    if (s) this.detail(s, sink);
    return () => this.sinks.delete(sink);
  }

  /** Answers one of the app's requests to `/api/…`. */
  async fetch(url: URL, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    if (method === "GET") {
      if (path === "/api/state") return json(this.state());
      if (path === "/api/projects") return json({ projects: demoProjects(this.sessions), home: HOME });
      if (path === "/api/closed") return json({ sessions: this.closedList(url.searchParams.get("q") ?? ""), home: HOME });
      if (path === "/api/waiting") return json(this.waiting.view(this.clock.now()));
      if (path === "/api/push/key") return json({ key: DEMO_PUSH_KEY });
      const sub = /^\/api\/blocks\/(\d+)\/(subagents|btw-history)$/.exec(path);
      if (!sub) return json({ error: NOT_FOUND }, 404);
      const s = this.find(sub[1]);
      if (!s) return json({ error: "no such block" }, 404);
      if (sub[2] === "subagents") return json({ subagents: s.subagents });
      if (!s.item.agent) return json({ error: "no bridged omp session" }, 409);
      return json({ records: s.btw });
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "expected a JSON object" }, 400);
    }
    if (path === "/api/new") return this.newSession(str(body.cwd), body);
    if (path === "/api/closed/resume" || path === "/api/closed/dismiss") return this.closedAction(path.endsWith("/dismiss"), body);
    // Subscribe and unsubscribe: the demo keeps no subscription, it only confirms.
    if (path.startsWith("/api/push/")) return json({ ok: true });
    const waitingAction = WAITING_ACTIONS.find((a) => path === `/api/waiting/${a}`);
    if (waitingAction) {
      const r = this.waiting.act(waitingAction, body, this.clock.now());
      if (r.status === 200) this.emitWaiting();
      return json(r.body, r.status);
    }
    const m = /^\/api\/blocks\/(\d+)\/([a-z-]+)$/.exec(path);
    if (!m) return json({ error: NOT_FOUND }, 404);
    const s = this.find(m[1]);
    if (!s) return json({ error: "no such block" }, 404);
    return this.action(s, m[2], body);
  }

  private action(s: Session, action: string, body: Record<string, unknown>): Response {
    const ok = json({ ok: true });
    const text = str(body.text);
    const live = s.item.live;
    switch (action) {
      case "focus":
        // Tern's window on the desktop would show the pane: nothing to see in the page.
        return ok;
      case "close":
        this.close(s);
        return ok;
      case "park":
      case "unpark": {
        if (s.item.parked === (action === "park")) return ok;
        if (action === "unpark" && s.item.stranded)
          return json({ error: "It was parked in a Tern session that has closed since, so Tern can't bring it back. You can still open it here, or close it." }, 409);
        if (s.item.doc) return json({ error: "Files and notes can't be parked from here: Tern's list loses them once parked" }, 409);
        const target = action === "unpark" ? this.ternSession(body) : null;
        if (target instanceof Response) return target;
        s.item.parked = action === "park";
        s.item.ternSession = target;
        this.emitState();
        return ok;
      }
      case "submit":
        return this.submit(s, text, body);
      case "answer":
        return this.answer(s, body);
      case "approve":
        return this.approve(s, body);
      case "abort":
        this.abort(s);
        return ok;
      case "draft":
        if (!live) return json({ error: "no bridge" }, 409);
        if (body.expectedSessionId !== undefined && body.expectedSessionId !== s.item.agent?.sessionId) return json({ error: "session changed" }, 409);
        if (typeof body.expectedText === "string" && body.expectedText !== s.draft) return json({ error: "draft changed" }, 409);
        s.draft = text;
        return ok;
      case "model": {
        if (!live) return json({ error: "no bridge" }, 409);
        const spec = body.role !== undefined ? ROLES.find((r) => r.role === body.role)?.spec : str(body.spec);
        if (!spec?.includes("/")) return json({ error: "unknown model" }, 400);
        const [model, thinking] = spec.split(":");
        if (!CATALOG.some((c) => `${c.p}/${c.id}` === model)) return json({ error: "unknown model" }, 400);
        s.item.live = { ...live, model, thinking: thinking ?? live.thinking, tiers: tiersOf(model), tier: "" };
        this.emitState();
        return ok;
      }
      case "models":
        if (!live) return json({ error: "no bridge" }, 409);
        return json({ models: CATALOG });
      case "thinking":
        if (!live) return json({ error: "no bridge" }, 409);
        if (typeof body.level !== "string" || !live.levels.includes(body.level)) return json({ error: "unknown level" }, 400);
        s.item.live = { ...live, thinking: body.level };
        this.emitState();
        return ok;
      case "tier":
        if (!live) return json({ error: "no bridge" }, 409);
        if (typeof body.tier !== "string" || !live.tiers.includes(body.tier)) return json({ error: "this model has no such tier" }, 400);
        s.item.live = { ...live, tier: body.tier };
        this.emitState();
        return ok;
      case "type": {
        const back = Math.max(Math.trunc(Number(body.back) || 0), 0);
        const chars = [...s.line];
        s.line = chars.slice(0, Math.max(chars.length - back, 0)).join("") + text;
        this.emitDetail(s);
        return ok;
      }
      case "keys":
        if (Array.isArray(body.keys) && body.keys.includes("Enter")) this.enterLine(s);
        return ok;
      case "complete": {
        if (!live) return json({ error: "no bridge" }, 409);
        const prefix = /(?:^|\s)([/@]\S*)$/.exec(text)?.[1] ?? "";
        const items = prefix ? COMPLETIONS.filter((c) => c.value.startsWith(prefix) && c.value !== prefix) : [];
        return json({ prefix, items });
      }
      case "completion": {
        if (!live) return json({ error: "no bridge" }, 409);
        const prefix = str(body.prefix);
        const value = str(body.value);
        if (!prefix || !value || !text.endsWith(prefix)) return json({ error: "omp did not apply it" }, 502);
        s.draft = `${text.slice(0, text.length - prefix.length)}${value} `;
        this.toPane(s, "draft", { live: true, text: s.draft });
        return json({ text: s.draft });
      }
      case "rewind":
        return this.rewind(s, body);
      case "stretch":
        return this.stretch(s, body);
      case "btw":
        return this.btw(s, text);
      case "voice":
        return this.voice(s, body);
      case "hangup":
        if (s.voice && (!str(body.attempt) || body.attempt === s.voice.attempt)) this.endCall(s);
        return ok;
      default:
        return json({ error: NOT_FOUND }, 404);
    }
  }

  private find(block: string): Session | undefined {
    return this.sessions.find((s) => s.item.block === block);
  }

  /** The Tern session a launch names (`session`, from the list's chips): the shown one without; an unknown name is refused. */
  private ternSession(body: Record<string, unknown>): string | Response {
    if (body.session == null) return TERN_SESSIONS.find((t) => t.shown)!.name;
    const name = str(body.session);
    return TERN_SESSIONS.some((t) => t.name === name) ? name : json({ error: `Tern has no session named "${name}"` }, 400);
  }

  // ---------- streams ----------

  private emitState() {
    const state = this.state();
    for (const sink of this.sinks) sink.send("state", state);
  }

  /** To every stream, as the server sends AgentView's view: the list's popup and a session's status line. */
  private emitWaiting() {
    const view = this.waiting.view(this.clock.now());
    for (const sink of this.sinks) sink.send("waiting", view);
  }

  /** Whether `sink` is the session's own stream (its chat or screen), not one of its subagent screens. */
  private isPane(s: Session, sink: Sink): boolean {
    return sink.block === s.item.block && sink.sub === null && sink.view !== "subagents";
  }

  /** To the session's own streams, as the server relays omp's events. */
  private toPane(s: Session, event: string, data: unknown) {
    for (const sink of this.sinks) if (this.isPane(s, sink)) sink.send(event, data);
  }

  private emitDetail(s: Session) {
    for (const sink of this.sinks) if (sink.block === s.item.block && sink.sub === null) this.detail(s, sink);
  }

  /** What a stream shows of its block: the subagent list or chat, the file, the chat, or the screen. */
  private detail(s: Session, sink: Sink) {
    if (sink.sub !== null) return sink.send("chat", { entries: s.subagentChats[sink.sub] ?? [] });
    if (sink.view === "subagents") return sink.send("subagents", s.subagents);
    if (s.item.doc) return sink.send("doc", { text: s.doc ?? "", markdown: true, missing: false, clipped: false });
    if (s.item.agent && sink.view === "chat") return sink.send("chat", { entries: s.chat });
    sink.send("screen", { text: this.screen(s), html: false });
  }

  /** A shell's screen, or a plain rendering of an omp pane for the Raw view. */
  private screen(s: Session): string {
    if (!s.item.agent && !s.item.starting) return s.screen + s.line;
    if (s.item.starting) return "Starting omp…";
    const lines = ["omp · demo session", ""];
    for (const e of s.chat.slice(-6)) {
      if (e.role === "user") lines.push(`❯ ${e.text}`, "");
      else if (e.role === "assistant") lines.push(e.text, "");
      else if (e.role === "tools") lines.push(...e.calls.map((c) => `  ● ${c.name} ${c.intent}`), "");
    }
    return lines.join("\n");
  }

  private context(s: Session): ContextUse | null {
    if (!s.item.agent) return null;
    return { tokens: s.tokens, window: CONTEXT_WINDOW, percent: Math.round((s.tokens / CONTEXT_WINDOW) * 100), compactAt: COMPACT_AT };
  }

  /** Whether a phone has the session's chat open: then a finished turn is seen at once. */
  private watched(s: Session): boolean {
    for (const sink of this.sinks) if (this.isPane(s, sink)) return true;
    return false;
  }

  // ---------- turns ----------

  private after(s: Session, ms: number, fn: () => void, timers = s.timers) {
    const cancel = this.clock.after(ms, () => {
      timers.delete(cancel);
      fn();
    });
    timers.add(cancel);
  }

  private cancel(s: Session) {
    for (const cancel of s.timers) cancel();
    s.timers.clear();
  }

  private setRun(s: Session, run: Run | null) {
    s.run = run;
    this.toPane(s, "run", run);
  }

  private work(s: Session, intent: string) {
    s.item.status = "working";
    s.item.since = this.clock.now();
    s.item.unseen = null;
    if (s.item.agent) s.item.agent.recapStale = !!s.item.agent.recap;
    this.setRun(s, { since: s.item.since, intent });
    this.emitState();
  }

  private submit(s: Session, text: string, body: Record<string, unknown>): Response {
    if (!s.item.agent) return json({ error: "no bridge" }, 409);
    const images: Img[] = [];
    for (const raw of Array.isArray(body.images) ? body.images : []) {
      const image: Record<string, unknown> = raw && typeof raw === "object" ? raw : {};
      const { data, mimeType } = image;
      if (typeof data !== "string" || !data || typeof mimeType !== "string" || !IMAGE_TYPE.test(mimeType)) return json({ error: "bad image" }, 400);
      images.push({ src: `data:${mimeType};base64,${data}` });
    }
    if (!text.trim() && !images.length) return json({ error: "empty prompt" }, 400);
    // omp is waiting on the question; a prompt now would leave it unanswered.
    const ask = s.chat.findLast((e) => e.role === "ask");
    if (ask?.role === "ask" && ask.answer === null) return json({ error: "Answer the question first" }, 409);
    if (s.draft) {
      // omp's editor empties as the prompt goes, and the draft follows it.
      s.draft = "";
      this.toPane(s, "draft", { live: true, text: "" });
    }
    if (text.trim() === "/restart" && s.item.live?.mismatch) {
      this.restart(s);
      return json({ ok: true });
    }
    // A reply to a pending approval denies it, and steers omp.
    if (s.approval) this.setApproval(s, null);
    if (s.item.status === "working") {
      s.queued.push({ text, followUp: body.followUp === true });
      this.toPane(s, "queued", s.queued);
      if (s.openTurn) {
        s.openTurn = false;
        this.after(s, 1500, () => this.finishOpenTurn(s));
      }
    } else this.startTurn(s, text, images);
    return json({ ok: true });
  }

  private startTurn(s: Session, prompt: string, images: Img[] = [], reply?: string) {
    const started = this.clock.now();
    s.chat = [...s.chat, { role: "user", id: `demo-${started}-${s.chat.length}`, text: prompt, images, ts: started }];
    if (s.item.agent) s.item.agent = { ...s.item.agent, lastPrompt: prompt, lastActivity: started };
    this.work(s, "Reading the project");
    this.emitDetail(s);
    this.after(s, TOOLS_MS, () => {
      const ts = this.clock.now();
      const calls = [
        { name: "read", intent: "Reading README.md" },
        { name: "grep", intent: `Searching for “${prompt.slice(0, 40)}”`, facts: "3 results in 2 files" },
      ];
      s.chat = [...s.chat, { role: "tools", calls, images: [], todo: null, ts }];
      this.emitDetail(s);
      this.setRun(s, { since: started, intent: "Writing the reply" });
      this.stream(s, reply ?? REPLIES[this.replies++ % REPLIES.length].replaceAll("{prompt}", prompt.trim().slice(0, 120)), started);
    });
  }

  /** Streams `text` a few words at a time as `live`, then lands it in the chat. */
  private stream(s: Session, text: string, started: number, files?: ChangedFile[]) {
    const words = text.match(/\S+\s*/g) ?? [];
    let shown = 0;
    const step = () => {
      shown = Math.min(shown + WORDS_PER_STEP, words.length);
      s.live = words.slice(0, shown).join("");
      this.toPane(s, "live", { text: s.live, done: false });
      this.after(s, STEP_MS, shown < words.length ? step : () => this.finish(s, text, started, files));
    };
    this.after(s, STEP_MS, step);
  }

  private finish(s: Session, text: string, started: number, files?: ChangedFile[]) {
    const ts = this.clock.now();
    s.live = null;
    this.toPane(s, "live", { text, done: true });
    s.chat = [...s.chat, { role: "assistant", text, ts }, { role: "turn", ms: ts - started, model: s.item.live?.model ?? "", ts, ...(files && { files }) }];
    s.tokens += 1500 + text.length;
    this.idle(s);
    this.toPane(s, "context", this.context(s));
    // A turn the call handed over: the voice reads its result back.
    if (s.voice?.phase === "working") this.setVoice(s, { ...s.voice, phase: "listening", assistant: VOICE.spoken });
    const next = s.queued.shift();
    if (!next) return;
    this.toPane(s, "queued", s.queued);
    // Steer or follow-up, the demo runs it as the next turn: `followUp` only marks it in the queue.
    this.startTurn(s, next.text);
  }

  private idle(s: Session) {
    s.item.status = "idle";
    s.item.since = this.clock.now();
    s.item.unseen = this.watched(s) ? null : "done";
    if (s.item.agent) s.item.agent.lastActivity = s.item.since;
    this.setRun(s, null);
    this.emitState();
    this.emitDetail(s);
  }

  /** The fixture's running turn wraps up: its todo done, its subagent finished, its last reply streamed. */
  private finishOpenTurn(s: Session) {
    const ts = this.clock.now();
    const last = s.chat.findLast((e) => e.role === "tools" && e.todo);
    const todo = last?.role === "tools" && last.todo ? last.todo.map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t, status: "completed" })) })) : null;
    s.chat = [...s.chat, { role: "tools", calls: [{ name: "todo", intent: "Marking the light theme done" }], images: [], todo, ts }];
    s.subagents = s.subagents.map((a) => ({ ...a, running: false, lastActivity: ts }));
    if (s.item.live) s.item.live = { ...s.item.live, jobs: [] };
    this.emitState();
    this.emitDetail(s);
    this.setRun(s, { since: s.item.since, intent: "Writing the summary" });
    this.stream(s, OPEN_TURN_REPLY, s.item.since);
  }

  private abort(s: Session) {
    if (s.item.status !== "working") return;
    this.cancel(s);
    s.openTurn = false;
    if (s.live !== null) {
      this.toPane(s, "live", { text: s.live, done: true });
      s.chat = [...s.chat, { role: "assistant", text: s.live, ts: this.clock.now() }];
      s.live = null;
    }
    s.queued = [];
    this.toPane(s, "queued", []);
    if (s.item.live) s.item.live = { ...s.item.live, jobs: [] };
    s.subagents = s.subagents.map((a) => ({ ...a, running: false }));
    this.idle(s);
  }

  private answer(s: Session, body: Record<string, unknown>): Response {
    const ask = s.chat.findLast((e) => e.role === "ask");
    if (!ask || ask.role !== "ask" || ask.answer !== null || ask.id !== body.id) return json({ error: "no open question" }, 409);
    const answers = formAnswers(ask.fields, body);
    if (!answers.length) return json({ error: "no answer picked" }, 400);
    const text = answers.map((a) => a.answer).join("; ");
    s.chat = s.chat.map((e) => (e === ask ? { ...ask, answer: answers.map((a) => `${a.question}: ${a.answer}`).join("\n") } : e));
    const started = this.clock.now();
    this.work(s, "Wiring up the answer");
    this.emitDetail(s);
    this.after(s, TOOLS_MS, () => this.stream(s, ANSWER_REPLY.replaceAll("{answer}", text), started));
    return json({ ok: true });
  }

  private setApproval(s: Session, approval: Session["approval"]) {
    s.approval = approval;
    this.toPane(s, "approval", approval);
  }

  /** omp's approval dialog answered: Approve once runs the call and the turn ends with what it changed; Deny ends the turn. */
  private approve(s: Session, body: Record<string, unknown>): Response {
    if (typeof body.allow !== "boolean") return json({ error: "allow must be true or false" }, 400);
    if (!s.approval || s.approval.id !== body.id) return json({ error: "omp no longer asks about this call" }, 409);
    const plan = s.approve!;
    this.setApproval(s, null);
    const started = this.clock.now();
    this.work(s, body.allow ? "Applying the edit" : "Writing the reply");
    this.after(s, TOOLS_MS, () => (body.allow ? this.stream(s, plan.allow, started, plan.files) : this.stream(s, plan.deny, started)));
    return json({ ok: true });
  }

  /** omp's Rewind: back to before the prompt, which returns to the editor (and so the composer). */
  private rewind(s: Session, body: Record<string, unknown>): Response {
    const entry = str(body.entry);
    if (!ENTRY_ID.test(entry)) return json({ error: "bad entry" }, 400);
    if (!s.item.agent) return json({ error: "rewind needs an omp session connected to tern-mobile (restart it)" }, 409);
    if (s.item.status !== "idle") return json({ error: "stop the agent first" }, 409);
    const at = s.chat.findIndex((e) => e.role === "user" && e.id === entry);
    const prompt = s.chat[at];
    if (prompt?.role !== "user") return json({ error: "no such prompt" }, 404);
    s.tokens = Math.max(9_000, Math.round((s.tokens * at) / s.chat.length));
    s.chat = s.chat.slice(0, at);
    const before = s.chat.findLast((e) => e.role === "user");
    s.item.agent = { ...s.item.agent, lastPrompt: before?.role === "user" ? before.text : "" };
    s.draft = prompt.text;
    this.toPane(s, "draft", { live: true, text: s.draft });
    this.toPane(s, "context", this.context(s));
    this.emitState();
    this.emitDetail(s);
    return json({ ok: true });
  }

  /** omp-stretch in the pane: a stretch opened or closed, or ✦ asking the model for more. */
  private stretch(s: Session, body: Record<string, unknown>): Response {
    const reply = str(body.block);
    const key = str(body.key);
    if (!STRETCH_BLOCK.test(reply) || !key || key.length > 4000) return json({ error: "bad stretch" }, 400);
    const st = s.stretch;
    if (!st) return json({ error: "this omp doesn't run stretch.ts" }, 409);
    if (body.deepen !== true) {
      const keys = withOpen(st.open[reply] ?? [], key, body.open === true);
      const { [reply]: _, ...rest } = st.open;
      s.stretch = { ...st, open: keys.length ? { ...rest, [reply]: keys } : rest };
      this.toPane(s, "stretch", s.stretch);
      return json({ ok: true });
    }
    if (st.running[reply]?.some((r) => r.key === key)) return json({ ok: true });
    const text = (DEEPEN[key] ?? DEEPEN[""]).replaceAll("{key}", key);
    const words = text.match(/\S+\s*/g) ?? [];
    let shown = 0;
    const update = (partial: string | null) => {
      const now = s.stretch!;
      const others = (now.running[reply] ?? []).filter((r) => r.key !== key);
      const running = partial === null ? others : [...others, { key, seconds: Math.floor((shown * DEEPEN_STEP_MS) / 1000), partial }];
      const { [reply]: _, ...rest } = now.running;
      const answers = partial === null ? { ...now.answers, [reply]: [...(now.answers[reply] ?? []), { key, text }] } : now.answers;
      s.stretch = { ...now, running: running.length ? { ...rest, [reply]: running } : rest, answers };
      this.toPane(s, "stretch", s.stretch);
    };
    const step = () => {
      shown = Math.min(shown + WORDS_PER_STEP, words.length);
      update(words.slice(0, shown).join(""));
      this.after(s, DEEPEN_STEP_MS, shown < words.length ? step : () => update(null));
    };
    update("");
    this.after(s, DEEPEN_STEP_MS, step);
    return json({ ok: true });
  }

  /** A side question: its answer streams as `btw` events and is saved for `/btw`'s history. */
  private btw(s: Session, text: string): Response {
    const question = text.trim();
    if (!question) return json({ error: "empty question" }, 400);
    if (!s.item.agent) return json({ error: "no bridge" }, 409);
    const createdAt = this.clock.now();
    const id = `btw-${createdAt}-${s.btw.length}`;
    const answer = BTW_REPLY.replaceAll("{question}", question.slice(0, 120));
    const record = { id, question, answer: "", status: "running" as const, createdAt, updatedAt: createdAt, leafId: null };
    s.btw = [...s.btw, record];
    const words = answer.match(/\S+\s*/g) ?? [];
    let shown = 0;
    const step = () => {
      shown = Math.min(shown + WORDS_PER_STEP, words.length);
      const done = shown === words.length;
      const said = words.slice(0, shown).join("");
      this.toPane(s, "btw", { id, question, text: said, done, error: "" });
      if (done) s.btw = s.btw.map((r) => (r.id === id ? { ...r, answer: said, status: "complete", updatedAt: this.clock.now() } : r));
      else this.after(s, STEP_MS, step);
    };
    this.after(s, TOOLS_MS, step, s.callTimers);
    return json({ id });
  }

  // ---------- voice ----------

  private setVoice(s: Session, voice: Voice) {
    s.voice = voice.ended ? null : voice;
    this.toPane(s, "voice", voice);
  }

  private endCall(s: Session, error = "") {
    for (const cancel of s.callTimers) cancel();
    s.callTimers.clear();
    if (s.voice) this.setVoice(s, { ...s.voice, ended: true, error });
  }

  /**
   * A scripted call in place of omp's live mode: it listens, "hears" a question, hands it to the
   * session as an ordinary turn and reads the result back (finish). The page's microphone and peer
   * are stand-ins (demo-install.ts), so no audio is recorded or sent.
   */
  private voice(s: Session, body: Record<string, unknown>): Response {
    const sdp = str(body.sdp);
    if (!sdp.startsWith("v=")) return json({ error: "expected a WebRTC offer" }, 400);
    if (!s.item.agent) return json({ error: "voice needs an omp session connected to tern-mobile" }, 409);
    if (s.item.live?.caps?.voice !== true) return json({ error: "this omp can't run voice calls (update omp)" }, 409);
    if (s.voice) return json({ error: "a voice call is already running" }, 409);
    const call: Voice = { phase: "connecting", user: "", assistant: "", ended: false, error: "", attempt: str(body.attempt).slice(0, 64) };
    this.setVoice(s, call);
    const at = (ms: number, fn: () => void) => this.after(s, ms, fn, s.callTimers);
    at(800, () => this.setVoice(s, { ...s.voice!, phase: "listening" }));
    at(2600, () => this.setVoice(s, { ...s.voice!, user: VOICE.ask }));
    at(3400, () => {
      if (s.item.status === "blocked") return this.setVoice(s, { ...s.voice!, assistant: VOICE.busy });
      this.setVoice(s, { ...s.voice!, phase: "working" });
      if (s.item.status === "working") {
        s.queued.push({ text: VOICE.ask, followUp: true });
        this.toPane(s, "queued", s.queued);
      } else this.startTurn(s, VOICE.ask, [], VOICE.reply);
    });
    return json({ sdp: VOICE.sdp });
  }

  // ---------- shells, sessions and Closed ----------

  private enterLine(s: Session) {
    if (s.item.agent) return;
    const cmd = s.line.trim();
    const out = cmd ? `demo: “${cmd}” didn't run; this shell is a recording.\n\n` : "";
    s.screen = `${s.screen}${s.line}\n${out}~/code/${s.item.project} ${s.item.branch ?? ""}\n❯ `;
    s.line = "";
    this.emitDetail(s);
  }

  /** Closes the pane; an omp's session goes to Closed, from where it can be resumed. */
  private close(s: Session) {
    this.cancel(s);
    this.endCall(s);
    this.sessions = this.sessions.filter((x) => x !== s);
    const agent = s.item.agent;
    if (agent) {
      this.closed = this.closed.filter((c) => c.row.id !== agent.sessionId);
      this.dismissed.delete(agent.sessionId);
      const { icon, tag, title, cwd } = s.item;
      this.closed.push({ row: { agent: "omp", id: agent.sessionId, icon, tag, title, cwd, prompt: agent.lastPrompt, recap: agent.recap, at: this.clock.now() }, chat: s.chat, screen: "", tokens: s.tokens });
      this.waiting.setLive(agent.sessionId, null);
      this.emitWaiting();
    }
    this.emitState();
  }

  /** omp restarts with `/restart`: it reconnects with the server's extension. */
  private restart(s: Session) {
    const item = s.item;
    s.item = { ...item, live: null, status: null, starting: true };
    this.emitState();
    this.after(s, STARTING_MS, () => {
      s.item = { ...s.item, starting: false, status: "idle", since: this.clock.now(), live: { ...item.live!, mismatch: null, restart: false } };
      this.emitState();
      this.emitDetail(s);
    });
  }

  /** Closed's list: omp's sessions; a search adds Claude Code's and Codex's, and a tool's name keeps only its own. */
  private closedList(q: string) {
    const open = new Set(this.sessions.flatMap((s) => (s.item.agent ? [s.item.agent.sessionId] : [])));
    const { tools, rest } = parseSearch(q);
    const searching = q.trim() !== "";
    return this.closed
      .filter(({ row }) => !open.has(row.id) && !this.dismissed.has(row.id) && !this.sessions.some((s) => s.resumed === `${row.agent}:${row.id}`))
      .filter(({ row }) => (searching ? keepsTool(tools, row.agent) && matchesWords(rest, [row.title, row.prompt, row.cwd, row.recap].join("\n")) : row.agent === "omp"))
      .map((c) => c.row)
      .sort((a, b) => b.at - a.at);
  }

  private closedAction(dismiss: boolean, body: Record<string, unknown>): Response {
    const id = str(body.id);
    if (!/^[\w-]+$/.test(id)) return json({ error: "bad session id" }, 400);
    if (dismiss) {
      this.dismissed.add(id);
      return json({ ok: true });
    }
    const agent = CLOSED_AGENTS.find((a) => a === (body.agent ?? "omp"));
    if (!agent) return json({ error: "unknown agent" }, 400);
    const target = this.ternSession(body);
    if (target instanceof Response) return target;
    const running = this.sessions.find((s) => (agent === "omp" && s.item.agent?.sessionId === id) || s.resumed === `${agent}:${id}`);
    if (running) return json({ block: running.item.block });
    const c = this.closed.find((x) => x.row.agent === agent && x.row.id === id);
    if (!c) return json({ error: "no transcript for this session" }, 404);
    const { row } = c;
    const s = this.open(row.cwd, target, row.title, `${agent}:${id}`);
    if (agent === "omp") {
      s.chat = c.chat;
      s.tokens = c.tokens;
      this.ready(s, demoAgent(id, { lastPrompt: row.prompt, recap: row.recap, lastActivity: row.at }));
    } else {
      // Claude Code and Codex have no bridge: a plain terminal, as in the app.
      s.item = { ...s.item, title: agent, starting: false, branch: null };
      s.screen = c.screen;
    }
    this.emitState();
    return json({ block: s.item.block });
  }

  /** A new Tern tab running a tool in `cwd`, in Tern session `ternSession`; its omp is still starting. */
  private open(cwd: string, ternSession: string, title: string, resumed: string | null = null): Session {
    const block = String(this.nextBlock++);
    const project = this.sessions.find((s) => s.item.cwd === cwd)?.item.project ?? cwd.split("/").filter(Boolean).at(-1) ?? "home";
    const item: Item = { block, icon: null, tag: null, title, cwd, project, branch: "main", agent: null, live: null, status: null, starting: true, since: this.clock.now(), doc: null, unseen: null, parked: false, ternSession, activity: null, stranded: false };
    const s: Session = { ...fresh({ item, chat: [], screen: "", subagents: [], subagentChats: {}, tokens: 9_000, doc: null, approval: null, approve: null, stretch: null, btw: [] }), resumed };
    this.sessions.push(s);
    return s;
  }

  /** omp takes a moment to start and connect, as it does in a real Tern tab. */
  private ready(s: Session, agent: Agent) {
    this.after(s, STARTING_MS, () => {
      s.item = { ...s.item, starting: false, status: "idle", since: this.clock.now(), agent, live: demoLive() };
      this.waiting.setLive(agent.sessionId, Number(s.item.block));
      this.emitWaiting();
      this.emitState();
      for (const sink of this.sinks) {
        if (sink.block !== s.item.block || sink.sub !== null) continue;
        sink.send("draft", { live: true, text: "" });
        sink.send("context", this.context(s));
        this.detail(s, sink);
      }
    });
  }

  private newSession(cwd: string, body: Record<string, unknown>): Response {
    if (!cwd.startsWith("/")) return json({ error: "cwd must be an existing directory" }, 400);
    const target = this.ternSession(body);
    if (target instanceof Response) return target;
    const s = this.open(cwd, target, "New session");
    this.ready(s, demoAgent(`demo-${s.item.block}`));
    this.emitState();
    return json({ block: s.item.block });
  }
}

/**
 * The browser's EventSource as useStream drives it, fed by `server`: it opens on the next tick,
 * delivers each event as a MessageEvent with JSON data, and stops on close.
 */
export function demoEventSource(server: DemoServer) {
  return class DemoEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
    private stop: () => void;
    constructor(readonly url: string) {
      const u = new URL(url, "http://demo.invalid");
      const sink: Sink = {
        block: u.searchParams.get("block"),
        view: u.searchParams.get("view") ?? "chat",
        sub: u.searchParams.get("sub"),
        send: (event, data) => {
          if (this.readyState !== 1) return;
          const e = new MessageEvent(event, { data: JSON.stringify(data) });
          for (const fn of this.listeners.get(event) ?? []) fn(e);
        },
      };
      this.stop = server.clock.after(0, () => {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        this.stop = server.connect(sink);
      });
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: (e: MessageEvent) => void) {
      this.listeners.get(type)?.delete(fn);
    }
    close() {
      this.readyState = 2;
      this.stop();
    }
  };
}
