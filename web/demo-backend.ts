// The demo's server, in the page: it answers the app's /api requests and feeds its event streams
// from the sample sessions in demo-fixtures.ts, so the real app runs with no Tern, omp or server.
// Prompts stream a canned reply as omp's would (`live`, then the `chat` entry), asks resolve, and
// new sessions, closes and drafts behave; what needs a real omp answers "isn't in the demo".
import type { AskQuestion, ChatEntry, ContextUse, Run, State } from "./api";
import {
  ANSWER_REPLY,
  CONTEXT_WINDOW,
  HOME,
  OPEN_TURN_REPLY,
  REPLIES,
  ROLES,
  demoAgent,
  demoLive,
  demoProjects,
  demoSessions,
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
};

/** Words per streamed update, and the pause between updates. */
const WORDS_PER_STEP = 3;
const STEP_MS = 60;
const TOOLS_MS = 700;
const STARTING_MS = 1200;
const COMPACT_AT = 85;
const NOT_IN_DEMO = "isn't in the demo";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** The answer text omp would record for an ask, from the app's `answers` (see askAnswers in lib.ts). */
function answerText(questions: AskQuestion[], answers: unknown): string {
  const list = Array.isArray(answers) ? answers : [];
  return questions
    .map((q, i) => {
      const a = (list[i] ?? {}) as { option?: number | null; picks?: number[]; other?: string };
      if (typeof a.other === "string" && a.other) return a.other;
      if (q.multi) return (a.picks ?? []).map((p) => q.options[p]?.label).filter(Boolean).join(", ");
      return typeof a.option === "number" ? q.options[a.option]?.label ?? "" : "";
    })
    .join("; ");
}

export class DemoServer {
  private sessions: Session[];
  private sinks = new Set<Sink>();
  private replies = 0;
  private nextBlock = 40;

  constructor(readonly clock: Clock = realClock) {
    this.sessions = demoSessions(clock.now()).map((s) => ({
      ...s,
      draft: "",
      live: null,
      run: s.item.status === "working" ? { since: s.item.since, intent: `Waiting on ${s.subagents.find((a) => a.running)?.name ?? "a subagent"}` } : null,
      queued: [],
      openTurn: s.item.status === "working",
      line: "",
      timers: new Set(),
    }));
  }

  state(): State {
    const projects = new Map<string, Session["item"][]>();
    for (const s of this.sessions) projects.set(s.item.project, [...(projects.get(s.item.project) ?? []), s.item]);
    const items = this.sessions.map((s) => s.item);
    const count = (status: string) => items.filter((i) => i.status === status).length;
    return {
      projects: [...projects].map(([name, list]) => ({ name, items: list })),
      counts: { working: count("working"), blocked: count("blocked"), idle: count("idle") },
      roles: ROLES,
      badge: items.filter((i) => i.unseen).length,
      at: this.clock.now(),
      app: "",
      extension: { status: "ok", path: `${HOME}/.omp/agent/extensions/tern-mobile.ts`, target: "", repo: `${HOME}/code/tern-awui`, windows: false },
    };
  }

  /** Opens a stream: everything the server would send first, then updates until the returned close. */
  connect(sink: Sink): () => void {
    const s = sink.block ? this.find(sink.block) : undefined;
    const pane = !!s && sink.sub === null && sink.view !== "subagents";
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
      sink.send("stretch", null);
      sink.send("voice", null);
    }
    if (seen) this.emitState();
    else sink.send("state", this.state());
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
      const sub = /^\/api\/blocks\/(\d+)\/(subagents|btw-history)$/.exec(path);
      const s = sub && this.find(sub[1]);
      if (sub && !s) return json({ error: "no such block" }, 404);
      if (s && sub?.[2] === "subagents") return json({ subagents: s.subagents });
      if (s) return json({ records: [] });
      return json({ error: `This ${NOT_IN_DEMO}` }, 404);
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "expected a JSON object" }, 400);
    }
    if (path === "/api/new") return this.newSession(String(body.cwd ?? ""));
    if (path.startsWith("/api/push/")) return json({ error: `Notifications need your own server; push ${NOT_IN_DEMO}` }, 409);
    const m = /^\/api\/blocks\/(\d+)\/([a-z-]+)$/.exec(path);
    const s = m && this.find(m[1]);
    if (!m || !s) return json({ error: "no such block" }, 404);
    return this.action(s, m[2], body);
  }

  private action(s: Session, action: string, body: Record<string, unknown>): Response {
    const ok = json({ ok: true });
    const text = typeof body.text === "string" ? body.text : "";
    switch (action) {
      case "focus":
      case "hangup":
        return ok;
      case "close":
        this.cancel(s);
        this.sessions = this.sessions.filter((x) => x !== s);
        this.emitState();
        return ok;
      case "submit":
        if (!s.item.agent) return json({ error: "no bridge" }, 409);
        if (!text.trim()) return json({ error: "empty prompt" }, 400);
        if (s.draft) {
          // omp's editor empties as the prompt goes, and the draft follows it.
          s.draft = "";
          this.toPane(s, "draft", { live: true, text: "" });
        }
        if (s.item.status === "working") {
          s.queued.push({ text, followUp: body.followUp === true });
          this.toPane(s, "queued", s.queued);
          if (s.openTurn) {
            s.openTurn = false;
            this.after(s, 1500, () => this.finishOpenTurn(s));
          }
        } else this.startTurn(s, text);
        return ok;
      case "answer":
        return this.answer(s, body);
      case "abort":
        this.abort(s);
        return ok;
      case "draft":
        if (!s.item.live) return json({ error: "no bridge" }, 409);
        if (typeof body.expectedText === "string" && body.expectedText !== s.draft) return json({ error: "draft changed" }, 409);
        s.draft = text;
        return ok;
      case "model": {
        const live = s.item.live;
        if (!live) return json({ error: "no bridge" }, 409);
        const spec = body.role !== undefined ? ROLES.find((r) => r.role === body.role)?.spec : String(body.spec ?? "");
        if (!spec?.includes("/")) return json({ error: "unknown model" }, 400);
        const [model, thinking] = spec.split(":");
        s.item.live = { ...live, model, thinking: thinking ?? live.thinking };
        this.emitState();
        return ok;
      }
      case "thinking": {
        const live = s.item.live;
        if (!live) return json({ error: "no bridge" }, 409);
        if (typeof body.level !== "string" || !live.levels.includes(body.level)) return json({ error: "unknown level" }, 400);
        s.item.live = { ...live, thinking: body.level };
        this.emitState();
        return ok;
      }
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
      case "models":
        return json({ error: `The full model list ${NOT_IN_DEMO}; the roles above still switch models` }, 409);
      case "voice":
        return json({ error: `Voice calls ${NOT_IN_DEMO}` }, 409);
      case "btw":
        return json({ error: `Side questions ${NOT_IN_DEMO}` }, 409);
      default:
        return json({ error: `${action[0].toUpperCase()}${action.slice(1)} ${NOT_IN_DEMO}` }, 409);
    }
  }

  private find(block: string): Session | undefined {
    return this.sessions.find((s) => s.item.block === block);
  }

  // ---------- streams ----------

  private emitState() {
    const state = this.state();
    for (const sink of this.sinks) sink.send("state", state);
  }

  /** To the session's own streams (not its subagent screens), as the server relays omp's events. */
  private toPane(s: Session, event: string, data: unknown) {
    for (const sink of this.sinks) if (sink.block === s.item.block && sink.sub === null && sink.view !== "subagents") sink.send(event, data);
  }

  private emitDetail(s: Session) {
    for (const sink of this.sinks) if (sink.block === s.item.block && sink.sub === null) this.detail(s, sink);
  }

  /** What a stream shows of its block: the subagent list or chat, the chat, or the screen. */
  private detail(s: Session, sink: Sink) {
    if (sink.sub !== null) return sink.send("chat", { entries: s.subagentChats[sink.sub] ?? [] });
    if (sink.view === "subagents") return sink.send("subagents", s.subagents);
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
    for (const sink of this.sinks) if (sink.block === s.item.block && sink.sub === null && sink.view !== "subagents") return true;
    return false;
  }

  // ---------- turns ----------

  private after(s: Session, ms: number, fn: () => void) {
    const cancel = this.clock.after(ms, () => {
      s.timers.delete(cancel);
      fn();
    });
    s.timers.add(cancel);
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

  private startTurn(s: Session, prompt: string) {
    const started = this.clock.now();
    s.chat = [...s.chat, { role: "user", id: `demo-${started}-${s.chat.length}`, text: prompt, images: [], ts: started }];
    if (s.item.agent) s.item.agent = { ...s.item.agent, lastPrompt: prompt, lastActivity: started };
    this.work(s, "Reading the project");
    this.emitDetail(s);
    this.after(s, TOOLS_MS, () => {
      const ts = this.clock.now();
      const calls = [
        { name: "read", intent: "Reading README.md" },
        { name: "grep", intent: `Searching for “${prompt.slice(0, 40)}”` },
      ];
      s.chat = [...s.chat, { role: "tools", calls, images: [], todo: null, ts }];
      this.emitDetail(s);
      this.setRun(s, { since: started, intent: "Writing the reply" });
      const reply = REPLIES[this.replies++ % REPLIES.length].replaceAll("{prompt}", prompt.trim().slice(0, 120));
      this.stream(s, reply, started);
    });
  }

  /** Streams `text` a few words at a time as `live`, then lands it in the chat. */
  private stream(s: Session, text: string, started: number) {
    const words = text.match(/\S+\s*/g) ?? [];
    let shown = 0;
    const step = () => {
      shown = Math.min(shown + WORDS_PER_STEP, words.length);
      s.live = words.slice(0, shown).join("");
      this.toPane(s, "live", { text: s.live, done: false });
      this.after(s, STEP_MS, shown < words.length ? step : () => this.finish(s, text, started));
    };
    this.after(s, STEP_MS, step);
  }

  private finish(s: Session, text: string, started: number) {
    const ts = this.clock.now();
    s.live = null;
    this.toPane(s, "live", { text, done: true });
    s.chat = [...s.chat, { role: "assistant", text, ts }, { role: "turn", ms: ts - started, model: s.item.live?.model ?? "", ts }];
    s.tokens += 1500 + text.length;
    this.idle(s);
    this.toPane(s, "context", this.context(s));
    const next = s.queued.shift();
    if (!next) return;
    this.toPane(s, "queued", s.queued);
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
    const text = answerText(ask.questions, body.answers);
    if (!text) return json({ error: "no answer picked" }, 400);
    s.chat = s.chat.map((e) => (e === ask ? { ...ask, answer: text } : e));
    const started = this.clock.now();
    this.work(s, "Wiring up the answer");
    this.emitDetail(s);
    this.after(s, TOOLS_MS, () => this.stream(s, ANSWER_REPLY.replaceAll("{answer}", text), started));
    return json({ ok: true });
  }

  // ---------- shells and new sessions ----------

  private enterLine(s: Session) {
    if (s.item.agent) return;
    const cmd = s.line.trim();
    const out = cmd ? `demo: “${cmd}” didn't run; this shell is a recording.\n\n` : "";
    s.screen = `${s.screen}${s.line}\n${out}~/code/${s.item.project} ${s.item.branch ?? ""}\n❯ `;
    s.line = "";
    this.emitDetail(s);
  }

  private newSession(cwd: string): Response {
    if (!cwd.startsWith("/")) return json({ error: "cwd must be an existing directory" }, 400);
    const block = String(this.nextBlock++);
    const project = this.sessions.find((s) => s.item.cwd === cwd)?.item.project ?? cwd.split("/").filter(Boolean).at(-1) ?? "home";
    const now = this.clock.now();
    const s: Session = {
      item: { block, icon: null, tag: null, title: "New session", cwd, project, branch: "main", agent: null, live: null, status: null, starting: true, since: now, doc: null, unseen: null },
      chat: [],
      screen: "",
      subagents: [],
      subagentChats: {},
      tokens: 9_000,
      draft: "",
      live: null,
      run: null,
      queued: [],
      openTurn: false,
      line: "",
      timers: new Set(),
    };
    this.sessions.push(s);
    this.emitState();
    // omp takes a moment to start and connect, as it does in a real Tern tab.
    this.after(s, STARTING_MS, () => {
      s.item = { ...s.item, starting: false, status: "idle", since: this.clock.now(), agent: demoAgent(`demo-${block}`), live: demoLive() };
      this.emitState();
      for (const sink of this.sinks) {
        if (sink.block !== block || sink.sub !== null) continue;
        sink.send("draft", { live: true, text: "" });
        sink.send("context", this.context(s));
        this.detail(s, sink);
      }
    });
    return json({ block });
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
