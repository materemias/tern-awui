import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Transcript, call, HASH } from "./fixtures";

import { arr, obj, type Obj as Message } from "../lib/json";
import { startServer, type ServerHandle, type ServerOptions } from "../server";

const DEFAULT_SERVER = `${import.meta.dir}/../server.ts`;

export async function until<T>(fn: () => T | Promise<T>, description: string, timeout = 2000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out: ${description}`);
}

/** Variables that would point the server at the user's real omp, Tern or tern-mobile files. */
const LEAKY = /^(TERN_AWUI_|PI_CODING_AGENT_DIR$|PI_CONFIG_DIR$|OMP_PROFILE$|PI_PROFILE$|XDG_(DATA|STATE|CONFIG|CACHE)_HOME$)/;
/** The test process's environment without anything that reaches outside `home`. */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !LEAKY.test(key)) env[key] = value;
  return { ...env, HOME: home, ...extra };
}

export class Sandbox {
  home = mkdtempSync(`${tmpdir()}/tern-awui-server-`);
  token = "test-only-bridge-token";
  session = "test-session";
  login = "phone@example.test";
  base = "";
  proc?: Bun.Subprocess;
  transcript = new Transcript(this.session, `${this.home}/alpha`);
  prompt: string;
  leaf: string;
  tree: Message;
  sockets: WebSocket[] = [];
  streams: Events[] = [];

  constructor() {
    for (const rel of ["bin", "alpha", "beta", ".config/tern-mobile", ".omp/agent/sessions/project", ".omp/agent/blobs", ".local/state/tern/notes"])
      mkdirSync(`${this.home}/${rel}`, { recursive: true });
    writeFileSync(`${this.home}/.config/tern-mobile/bridge-token`, this.token);
    writeFileSync(`${this.home}/.omp/agent/blobs/${HASH}`, "image-bytes");
    writeFileSync(`${this.home}/.local/state/tern/notes/abc.md`, "# Note\n");
    this.prompt = this.transcript.user("Fix the build", 1000);
    this.transcript.say("Fixed", 2000);
    this.transcript.user("Which route?", 3000);
    this.leaf = this.transcript.assistant([call("ask1", "ask", { questions: [{ question: "Choose", options: ["A", "B"], recommended: 1 }] })], 4000, { stop: "toolUse" });
    writeFileSync(this.transcriptPath, this.transcript.text());
    const db = new Database(`${this.home}/.omp/agent/history.db`);
    db.run("CREATE TABLE session_recaps (id INTEGER PRIMARY KEY, session_id TEXT, recap TEXT, created_at INTEGER)");
    db.run("INSERT INTO session_recaps VALUES (1, ?, '  Earlier recap  ', 1)", [this.session]);
    db.close();
    this.tree = { sessions: [{ tabs: [{ blocks: [
      { id: 2, cwd: `${this.home}/beta`, program: "/bin/zsh", title: "Terminal" },
      { id: 4, cwd: `${this.home}/alpha`, program: "/bin/htop" },
      { id: 1, cwd: `${this.home}/alpha`, program: "omp", title: "󰄜 MOBILE: Build phone UI" },
      { id: 3, cwd: this.home, file: "note:abc", title: "Note" },
    ] }] }] };
    this.saveTree();
    writeFileSync(`${this.home}/events`, "");
    writeFileSync(`${this.home}/calls`, "");
    // NUL-delimited arguments and an extra NUL between calls preserve multiline text.
    writeFileSync(`${this.home}/bin/tern`, `#!/bin/bash
case "$1" in
  ls) cat "$TERN_FAKE_DIR/tree.json" ;;
  capture) if [ "$3" = --surfaces ] && [ -f "$TERN_FAKE_DIR/surfaces" ]; then cat "$TERN_FAKE_DIR/surfaces"; else printf '<pre>terminal output</pre>'; fi ;;
  events) exec /usr/bin/tail --pid="$PPID" --sleep-interval=0.05 -n +1 -F "$TERN_FAKE_DIR/events" ;;
  *) printf '%s\\0' "$@" >> "$TERN_FAKE_DIR/calls"; printf '\\0' >> "$TERN_FAKE_DIR/calls"
     if [ -f "$TERN_FAKE_DIR/fail" ]; then cat "$TERN_FAKE_DIR/fail" >&2; fi
     if [ "$1" = new ]; then if [ -f "$TERN_FAKE_DIR/new-out" ]; then cat "$TERN_FAKE_DIR/new-out"; else printf '{"block":99}'; fi; fi
     if [ -f "$TERN_FAKE_DIR/exit" ]; then exit "$(cat "$TERN_FAKE_DIR/exit")"; fi ;;
esac
`);
    writeFileSync(`${this.home}/bin/omp`, `#!/bin/bash
case "$3" in
modelRoles) echo '{"fast":"test/fast:low","smart":"test/smart:high"}' ;;
cycleOrder) echo '["smart","missing","fast"]' ;;
compaction.enabled) echo true ;;
compaction.thresholdPercent) echo 80 ;;
*) echo null ;;
esac
`);
    for (const name of ["tern", "omp"]) chmodSync(`${this.home}/bin/${name}`, 0o755);
  }

  get transcriptPath() { return `${this.home}/.omp/agent/sessions/project/date_${this.session}.jsonl`; }
  saveTree() { writeFileSync(`${this.home}/tree.json`, JSON.stringify(this.tree)); }
  signal() { appendFileSync(`${this.home}/events`, '{"event":"block_opened"}\n'); }
  calls(): string[][] {
    return readFileSync(`${this.home}/calls`, "utf8").split("\0\0").filter(Boolean).map((r) => r.split("\0"));
  }
  clearCalls() { writeFileSync(`${this.home}/calls`, ""); }

  /** The server file a subprocess runs; another file always runs as a subprocess. */
  server = DEFAULT_SERVER;
  /** Run `server` as its own process even when it is this checkout's (no coverage, process-wide state). */
  subprocess = false;
  /** The built app an in-process server serves; this checkout's dist/ when unset. */
  dist?: string;
  /** Delivers Web Push for an in-process server; web-push (the network) when unset. */
  sendNotification?: ServerOptions["sendNotification"];
  /** The in-process server, while it runs. */
  handle?: ServerHandle;

  /** The server's environment: this sandbox's HOME, fake tern/omp first on PATH, two allowed logins. */
  env(extraEnv: Record<string, string> = {}): Record<string, string> {
    return isolatedEnv(this.home, { PATH: `${this.home}/bin:${process.env.PATH}`, TERN_FAKE_DIR: this.home,
      TERN_AWUI_ALLOW: ` ${this.login}, second@example.test `, ...extraEnv });
  }

  async start(extraEnv: Record<string, string> = {}) {
    if (this.subprocess || this.server !== DEFAULT_SERVER) return this.spawn(extraEnv);
    this.handle = startServer({ env: this.env({ TERN_AWUI_PORT: "0", ...extraEnv }), home: this.home, dist: this.dist, sendNotification: this.sendNotification });
    this.base = `http://127.0.0.1:${this.handle.port}`;
  }

  private async spawn(extraEnv: Record<string, string>) {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    reservation.stop(true);
    this.base = `http://127.0.0.1:${port}`;
    this.proc = Bun.spawn([process.execPath, this.server], {
      cwd: this.home,
      env: this.env({ TERN_AWUI_PORT: String(port), ...extraEnv }),
      stdout: "ignore", stderr: "inherit",
    });
    await until(async () => {
      try { return (await this.get("/api/state")).status === 200; } catch { return false; }
    }, "server startup", 5000);
  }

  /** Stops the server, keeping the sandbox for another `start`. */
  async stop() {
    await this.handle?.stop();
    this.handle = undefined;
    this.proc?.kill();
    await this.proc?.exited;
    this.proc = undefined;
  }

  /** A phone's headers: an allowed Tailscale login. */
  get headers() { return { "tailscale-user-login": this.login }; }
  get(path: string) { return fetch(this.base + path, { headers: this.headers }); }
  post(path: string, body: unknown = {}) {
    return fetch(this.base + path, { method: "POST", headers: { ...this.headers, "x-tern-mobile": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  action(block: number, action: string, body: unknown = {}) { return this.post(`/api/blocks/${block}/${action}`, body); }
  async state(): Promise<Message> { return obj(await (await this.get("/api/state")).json()); }
  async close() {
    for (const stream of this.streams) stream.close();
    for (const socket of this.sockets) socket.close();
    await this.stop();
    // A subprocess server's fake event follower terminates itself when its parent dies.
    await Bun.sleep(75);
    rmSync(this.home, { recursive: true, force: true });
  }
}

export function item(state: unknown, block: number): Message {
  return obj(arr(obj(state).projects).flatMap((p) => arr(obj(p).items)).map(obj).find((i) => i.block === String(block)));
}

export class Extension {
  ws!: WebSocket;
  inbox: Message[] = [];
  silent = false;
  /** Whether this fake omp has `/restart`, as its autocomplete answers. */
  restart = false;
  snapshot: Message;
  constructor(private sandbox: Sandbox, pane = "1", model = "test/initial") {
    this.snapshot = { t: "state", pane, sessionId: sandbox.session, text: "", model, thinking: "medium", status: "working",
      levels: ["off", "medium", "high"], tiers: ["", "priority"], tier: "", context: { tokens: 40000, window: 200000, percent: 20 }, queued: [], jobs: [], leaf: sandbox.leaf };
  }
  async connect() {
    // Bun accepts headers here; lib.dom only declares the browser overload.
    const options = { headers: { "x-tern-mobile-bridge": this.sandbox.token } } as unknown as string[];
    this.ws = new WebSocket(this.sandbox.base.replace("http", "ws") + "/bridge", options);
    this.sandbox.sockets.push(this.ws);
    this.ws.onmessage = (event) => {
      const msg = obj(JSON.parse(String(event.data)));
      this.inbox.push(msg);
      if (this.silent || msg.t === "watch") return;
      if (msg.t === "sync") return this.report({});
      const reply = (data: Message) => this.send({ t: "reply", seq: msg.seq, ...data });
      if (msg.t === "models") return reply({ models: [{ p: "test", id: "fast", name: "Fast", ctx: 200000, r: false, in: 0, out: 0, img: false }] });
      if (msg.t === "model") {
        if (msg.spec === "bad/model") return reply({ error: "no credentials for this model" });
        this.snapshot.model = msg.spec;
      }
      if (msg.t === "set") this.snapshot.text = msg.text;
      if (msg.t === "thinking") this.snapshot.thinking = msg.level;
      if (msg.t === "tier") {
        if (msg.tier === "invalid") return reply({ error: "this model has no such tier" });
        this.snapshot.tier = msg.tier;
      }
      if (msg.t === "complete" && msg.text === "/restart") return reply({ prefix: "/restart", items: this.restart ? [{ value: "restart", label: "restart" }] : [] });
      if (msg.t === "complete") return reply({ prefix: "/he", items: [{ value: "/help", label: "help" }] });
      if (msg.t === "apply") return reply(msg.value === "bad" ? {} : { text: "/help " });
      this.send({ ...this.snapshot, seq: msg.seq });
    };
    await new Promise<void>((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = () => reject(new Error("bridge connection failed")); });
    this.report({});
  }
  send(msg: Message) { this.ws.send(JSON.stringify(msg)); }
  report(patch: Message) { Object.assign(this.snapshot, patch); this.send(this.snapshot); }
  take(t: string) {
    return until(() => {
      const i = this.inbox.findIndex((m) => m.t === t);
      return i < 0 ? null : this.inbox.splice(i, 1)[0];
    }, `bridge ${t}`);
  }
}

export class Events {
  events: { event: string; data: unknown }[] = [];
  abort = new AbortController();
  reading?: Promise<void>;
  async open(s: Sandbox, query = "") {
    s.streams.push(this);
    const r = await fetch(`${s.base}/api/stream${query}`, { headers: s.headers, signal: this.abort.signal });
    if (!r.ok) throw new Error(`SSE ${r.status}`);
    this.reading = (async () => {
      let buf = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of r.body!) {
          buf += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, end);
            buf = buf.slice(end + 2);
            const event = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (event && data) this.events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch (err) { if (!this.abort.signal.aborted) throw err; }
    })();
  }
  take(event: string, predicate = (_data: unknown): boolean => true, timeout = 2000) {
    return until(() => {
      const i = this.events.findIndex((e) => e.event === event && predicate(e.data));
      return i < 0 ? null : this.events.splice(i, 1)[0];
    }, `SSE ${event}`, timeout).then((e) => e.data);
  }
  close() { this.abort.abort(); }
}
