import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { PushSubscription, RequestOptions } from "web-push";
import { obj } from "../lib/json";
import { Events, Extension, Sandbox, item, until } from "./server-harness";

const wait = (id: string, ball: string) => ({ id, label: id, summary: `about ${id}`, ball, reason: null, created_at: "2026-11-03T14:10:00Z" });
const session = (id: string, ball: string, over: Record<string, unknown> = {}) => ({
  session_id: id, title: `Session ${id}`, live: false, pane: null, ball, unseen: false, note: null, suggested_note: null,
  line: `line ${id}`, next_step: null, recap: null, set_aside_at: "2026-11-03T14:10:00Z", waits: [wait("w1", ball)], ...over,
});
const view = (...sessions: unknown[]) => ({ ok: true, now: "2026-11-05T16:00:00+01:00", counts: { on_me: sessions.filter((s) => obj(s).ball === "on_me").length }, sessions, panes: [] });

/** Prints `<dir>/view.json`, or for a command that changes state `{ok, view}`; records every argv. */
const FAKE_CLI = `import json, os, sys
d = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
view = json.load(open(os.path.join(d, "view.json")))
with open(os.path.join(d, "argv"), "a") as f:
    f.write(json.dumps(args) + "\\n")
if args[0] == "list":
    print(json.dumps(view))
elif os.path.exists(os.path.join(d, "refuse")):
    print(json.dumps({"ok": False, "error": "refused by the CLI"}))
    sys.exit(2)
else:
    print(json.dumps({"ok": True, "view": view}))
`;

describe("with the CLI", () => {
  const s = new Sandbox();
  const stateDir = `${s.home}/state/codexbar-agentview`;
  const cli = `${s.home}/fake/codexbar_waiting.py`;
  const sent: { payload: Record<string, unknown>; options: RequestOptions }[] = [];
  let agent: Extension;
  const setView = (v: unknown) => writeFileSync(`${s.home}/fake/view.json`, JSON.stringify(v));
  /** What the CLI does on a change: the view file replaced by renaming. */
  function publish(v: unknown) {
    setView(v);
    writeFileSync(`${stateDir}/waiting_view.json.tmp`, JSON.stringify(v));
    renameSync(`${stateDir}/waiting_view.json.tmp`, `${stateDir}/waiting_view.json`);
  }
  const argv = (): string[][] => readFileSync(`${s.home}/fake/argv`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const acted = () => argv().filter((a) => a[0] !== "list");
  const waiting = async () => obj(await (await s.get("/api/waiting")).json());

  beforeAll(async () => {
    mkdirSync(`${s.home}/fake`);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(cli, FAKE_CLI);
    writeFileSync(`${s.home}/fake/argv`, "");
    publish(view(session("closed", "on_machine", { waits: [wait("w1", "on_machine"), wait("w2", "on_machine")] }), session(s.session, "on_machine", { live: true, pane: 1 })));
    s.sendNotification = async (_sub: PushSubscription, payload: string, options: RequestOptions) => {
      sent.push({ payload: JSON.parse(payload), options });
    };
    await s.start({ CODEXBAR_WAITING: cli, XDG_STATE_HOME: `${s.home}/state` });
    expect((await s.post("/api/push/subscribe", { endpoint: "https://push.test/a", keys: { p256dh: "k", auth: "a" } })).status).toBe(200);
    agent = new Extension(s);
    await agent.connect();
    await until(async () => obj(item(await s.state(), 1).agent).sessionId === s.session, "bridged session");
  });
  afterAll(() => s.close());
  beforeEach(() => writeFileSync(`${s.home}/fake/argv`, ""));

  test("GET /api/waiting gives the parsed view", async () => {
    const w = await waiting();
    expect(w).toMatchObject({ available: true, onMe: 0, rows: [{ session: "closed", title: "Session closed" }, { session: s.session, pane: 1 }] });
  });

  test("a change to the view file reaches open list streams, and only those", async () => {
    const list = new Events();
    await list.open(s);
    const chat = new Events();
    await chat.open(s, "?block=1&view=chat");
    await list.take("waiting", (d) => obj(d).available === true);
    publish(view(session("closed", "on_machine"), session("new", "on_my_time"), session(s.session, "on_machine", { live: true, pane: 1 })));
    await list.take("waiting", (d) => JSON.stringify(d).includes("Session new"));
    // A rewritten file is read as it is, without starting Python.
    expect(argv()).toEqual([]);
    expect(chat.events.filter((e) => e.event === "waiting")).toEqual([]);
    list.close();
    chat.close();
  });

  test("POST stop runs the CLI with the checked ids, as argv", async () => {
    const r = await s.post("/api/waiting/stop", { session: "closed", wait: "w1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(acted()).toEqual([["stop", "--session", "closed", "--wait", "w1"]]);
  });

  test("snooze, seen, note, accept-suggested, what, mark-seen and stop all", async () => {
    expect((await s.post("/api/waiting/snooze", { session: "closed", wait: "w1" })).status).toBe(200);
    expect((await s.post("/api/waiting/seen", { session: "closed" })).status).toBe(200);
    expect((await s.post("/api/waiting/note", { session: "closed", text: "$(rm -rf /); `x`" })).status).toBe(200);
    expect((await s.post("/api/waiting/accept-suggested", { session: "closed" })).status).toBe(200);
    expect((await s.post("/api/waiting/what", { session: "closed", text: "--Anna's reply" })).status).toBe(200);
    expect((await s.post("/api/waiting/what", { session: "closed", text: "" })).status).toBe(200);
    expect((await s.post("/api/waiting/mark-seen", { session: "closed" })).status).toBe(200);
    expect((await s.post("/api/waiting/stop", { session: "closed", all: true })).status).toBe(200);
    expect(acted()).toEqual([
      ["snooze", "--session", "closed", "--wait", "w1", "--for", "1d"],
      ["seen", "--session", "closed"],
      ["note", "--session", "closed", "--text=$(rm -rf /); `x`"],
      ["note", "--session", "closed", "--accept-suggested"],
      ["what", "--session", "closed", "--text=--Anna's reply"],
      ["what", "--session", "closed", "--text="],
      ["mark-seen", "--session", "closed"],
      ["stop", "--session", "closed", "--all"],
    ]);
  });

  test("what needs its text, and an id on the view", async () => {
    expect((await s.post("/api/waiting/what", { session: "closed" })).status).toBe(400);
    expect((await s.post("/api/waiting/what", { session: "--help", text: "x" })).status).toBe(404);
    expect(acted()).toEqual([]);
  });

  test("ids off the view don't reach the CLI", async () => {
    expect((await s.post("/api/waiting/stop", { session: "--help", all: true })).status).toBe(404);
    expect((await s.post("/api/waiting/stop", { session: "closed", wait: "w9" })).status).toBe(404);
    expect((await s.post("/api/waiting/done", { session: "closed" })).status).toBe(404);
    expect((await s.post("/api/waiting/nonsense", { session: "closed" })).status).toBe(404);
    expect(acted()).toEqual([]);
  });

  test("POSTs need the app's header, like every other", async () => {
    const r = await fetch(`${s.base}/api/waiting/stop`, { method: "POST", headers: { ...s.headers, "content-type": "application/json" }, body: JSON.stringify({ session: "closed", all: true }) });
    expect(r.status).toBe(403);
    expect(acted()).toEqual([]);
  });

  test("the CLI's refusal reaches the phone", async () => {
    writeFileSync(`${s.home}/fake/refuse`, "");
    try {
      const r = await s.post("/api/waiting/stop", { session: "closed", all: true });
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: "refused by the CLI" });
    } finally {
      rmSync(`${s.home}/fake/refuse`);
    }
  });

  test("a session in a pane newly on you notifies like one that needs you and shows unseen", async () => {
    sent.length = 0;
    publish(view(session("closed", "on_machine"), session(s.session, "on_me", { live: true, pane: 1, waits: [{ ...wait("w1", "on_me"), reason: "ran, take a look" }] })));
    await until(() => sent.length === 1, "push");
    expect(sent[0].payload).toEqual({ title: `Session ${s.session}`, body: "Needs you · ran, take a look", block: "1", badge: 1 });
    expect(sent[0].options).toMatchObject({ TTL: 900, urgency: "high" });
    await until(async () => item(await s.state(), 1).unseen === "blocked", "unseen row");
    // Opening the session clears it, the same as any notification's.
    const open = new Events();
    await open.open(s, "?block=1&view=chat");
    await until(async () => item(await s.state(), 1).unseen === null, "seen row");
    open.close();
  });

  test("the same wait doesn't notify twice", async () => {
    sent.length = 0;
    publish(view(session("closed", "on_machine"), session(s.session, "on_me", { live: true, pane: 1, line: "moved on", waits: [{ ...wait("w1", "on_me"), reason: "ran, take a look" }] })));
    await until(async () => JSON.stringify(await waiting()).includes("moved on"), "new view");
    expect(sent).toEqual([]);
  });

  test("a blocked session's own question isn't announced twice, but another wait firing is", async () => {
    sent.length = 0;
    agent.report({ status: "blocked" });
    await until(() => sent.length === 1, "the status's push");
    const asks = [wait("w1", "on_me"), { ...wait("w2", "on_me"), reason: "agent asks a question" }];
    publish(view(session(s.session, "on_me", { live: true, pane: 1, waits: asks })));
    await until(async () => JSON.stringify(await waiting()).includes("agent asks"), "new view");
    publish(view(session(s.session, "on_me", { live: true, pane: 1, waits: [...asks, wait("w3", "on_me")] })));
    await until(() => sent.length === 2, "the other wait's push");
    expect(sent.map((p) => p.payload.body)).toEqual(["Needs you · Choose", "Needs you · w3"]);
    agent.report({ status: "working" });
  });

  test("a closed session has no pane to open: its notification leads to the Waiting screen", async () => {
    sent.length = 0;
    publish(view(session("closed", "on_me")));
    await until(() => sent.length === 1, "push");
    expect(sent[0].payload).toEqual({ title: "Session closed", body: "Needs you · w1", tag: "wclosed", url: "/#/waiting", badge: 0 });
  });
});

describe("without the CLI", () => {
  const s = new Sandbox();
  beforeAll(() => s.start());
  afterAll(() => s.close());

  test("the API says so and streams carry the same", async () => {
    expect(await (await s.get("/api/waiting")).json()).toEqual({ available: false });
    const events = new Events();
    await events.open(s);
    expect(await events.take("waiting")).toEqual({ available: false });
    events.close();
  });

  test("actions are refused", async () => {
    const r = await s.post("/api/waiting/stop", { session: "a", all: true });
    expect(r.status).toBe(409);
  });
});

test("the script is found through the linked Tern plugin", async () => {
  const s = new Sandbox();
  try {
    const scripts = `${s.home}/checkout/contents/scripts`;
    mkdirSync(scripts, { recursive: true });
    mkdirSync(`${s.home}/.config/tern/plugins`, { recursive: true });
    writeFileSync(`${s.home}/.config/tern/plugins/codexbar-agentview.path`, `${s.home}/checkout/tern\n`);
    writeFileSync(`${scripts}/codexbar_waiting.py`, `import json; print(json.dumps({"ok": True, "sessions": [], "panes": [], "counts": {"on_me": 0}}))\n`);
    await s.start();
    expect(await (await s.get("/api/waiting")).json()).toEqual({ available: true, onMe: 0, rows: [] });
  } finally {
    await s.close();
  }
});
