import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { arr, obj } from "../lib/json";
import { PROTOCOL } from "../lib/bridge-state";
import { buildId } from "../lib/extension-check";
import { HASH, PNG, T0, Transcript, call } from "./fixtures";
import { Events, Extension, Sandbox, item, until } from "./server-harness";

const REPO = resolve(import.meta.dir, "..");
const EXTENSION_SOURCE = `${REPO}/omp-extension/tern-mobile.ts`;

const s = new Sandbox();
let agent: Extension;
beforeAll(() => s.start(), 6000);
afterAll(() => s.close());

test("HTTP identity and POST CSRF gates reject missing/wrong credentials", async () => {
  expect((await fetch(`${s.base}/api/state`)).status).toBe(403);
  expect((await fetch(`${s.base}/api/state`, { headers: { "tailscale-user-login": "wrong" } })).status).toBe(403);
  expect((await fetch(`${s.base}/api/state`, { headers: { "tailscale-user-login": "second@example.test" } })).status).toBe(200);
  const denied = await fetch(`${s.base}/api/blocks/2/submit`, { method: "POST", headers: { "tailscale-user-login": s.login }, body: '{}' });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "missing header" });
  expect(s.calls()).toEqual([]);
});

test("an allowed login is all the API, its stream and the app's files need; /pair is not special", async () => {
  const login = { "tailscale-user-login": s.login };
  const state = await fetch(`${s.base}/api/state`, { headers: login });
  expect(state.status).toBe(200);
  expect(state.headers.get("set-cookie")).toBeNull();
  const stream = await fetch(`${s.base}/api/stream`, { headers: login });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  await stream.body?.cancel();
  for (const headers of [{}, { "tailscale-user-login": "wrong" }] as Record<string, string>[]) {
    for (const path of ["/api/state", "/api/stream", "/", "/manifest.webmanifest", "/sw.js"]) {
      expect((await fetch(s.base + path, { headers })).status).toBe(403);
    }
  }
  // The app's files: 404 only in an unbuilt checkout.
  for (const path of ["/", "/manifest.webmanifest", "/sw.js"]) expect([200, 404]).toContain((await fetch(s.base + path, { headers: login })).status);
  // /pair is just an unknown path: the static fallback (index.html, or the unbuilt 404), no cookie.
  const index = await (await fetch(`${s.base}/`, { headers: login })).text();
  const pair = await fetch(`${s.base}/pair?code=anything`, { headers: login, redirect: "manual" });
  expect([200, 404]).toContain(pair.status);
  expect(pair.headers.get("set-cookie")).toBeNull();
  expect(await pair.text()).toBe(index);
  expect((await fetch(`${s.base}/pair?code=anything`, { redirect: "manual" })).status).toBe(403);
});

test("bridge WebSocket upgrades require the local token", async () => {
  for (const token of ["", "wrong-token"]) {
    const headers = { "x-tern-mobile-bridge": token };
    expect((await fetch(`${s.base}/bridge`, { headers })).status).toBe(403);
    // Bun accepts headers here; lib.dom only declares the browser overload.
    const options = { headers } as unknown as string[];
    const ws = new WebSocket(s.base.replace("http", "ws") + "/bridge", options);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    });
    expect(opened).toBe(false);
  }
});

test("state groups by project, parses title/icon/tag and exposes configured roles", async () => {
  const state = await s.state();
  expect(arr(state.projects).map((p) => obj(p).name)).toEqual(["beta", "alpha", "~"]);
  expect(arr(obj(arr(state.projects)[1]).items).map((i) => obj(i).block)).toEqual(["4", "1"]);
  expect(item(state, 1)).toMatchObject({ icon: "󰄜", tag: "MOBILE", title: "Build phone UI", branch: null, status: null, agent: null });
  expect(item(state, 4).title).toBe("htop");
  expect(item(state, 3)).toMatchObject({ doc: `${s.home}/.local/state/tern/notes/abc.md`, branch: null });
  expect(state.roles).toEqual([{ role: "smart", spec: "test/smart:high" }, { role: "fast", spec: "test/fast:low" }]);
});

test("projects default to open block and omp session cwds, most recently used first, existing folders only", async () => {
  mkdirSync(`${s.home}/gamma`);
  mkdirSync(`${s.home}/.omp/agent/sessions/other`);
  writeFileSync(`${s.home}/.omp/agent/sessions/other/date_gamma.jsonl`, new Transcript("gamma", `${s.home}/gamma`).text());
  writeFileSync(`${s.home}/.omp/agent/sessions/other/date_gone.jsonl`, new Transcript("gone", `${s.home}/gone`).text());
  // gamma's transcript was just written; alpha has an omp session; beta's blocks carry no activity.
  // The note block (3) has no folder of its own.
  expect(await (await s.get("/api/projects")).json()).toEqual({ projects: [`${s.home}/gamma`, `${s.home}/alpha`, `${s.home}/beta`], home: s.home });
});

test("push subscriptions persist, replace by endpoint and unsubscribe without sending push", async () => {
  const path = `${s.home}/.config/tern-mobile/push.json`;
  const subscription = { endpoint: "https://127.0.0.1:9/push", keys: { p256dh: "test-key", auth: "test-auth" } };
  const vapid = JSON.parse(readFileSync(`${s.home}/.config/tern-mobile/vapid.json`, "utf8"));
  expect(await (await s.get("/api/push/key")).json()).toEqual({ key: vapid.publicKey });
  expect((await s.post("/api/push/subscribe", { ...subscription, endpoint: "http://bad" })).status).toBe(400);
  expect((await s.post("/api/push/subscribe", { endpoint: subscription.endpoint })).status).toBe(400);
  expect((await s.post("/api/push/subscribe", subscription)).status).toBe(200);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([subscription]);
  const updated = { ...subscription, keys: { ...subscription.keys, auth: "replacement" } };
  await s.post("/api/push/subscribe", updated);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([updated]);
  await s.post("/api/push/unsubscribe", { endpoint: subscription.endpoint });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
});

test("blob serving allows only known image types and hashes", async () => {
  const r = await s.get(`/api/blob/${HASH}?type=image/png`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(r.headers.get("cache-control")).toContain("immutable");
  expect(await r.text()).toBe("image-bytes");
  expect((await s.get(`/api/blob/${HASH}?type=text/html`)).status).toBe(404);
  expect((await s.get(`/api/blob/${"a".repeat(64)}?type=image/png`)).status).toBe(404);
});

test("assistant markdown local images resolve through authenticated blob URLs", async () => {
  const local = new Sandbox();
  const path = `${local.home}/tern-awui-queue-after.png`;
  writeFileSync(path, PNG);
  local.leaf = local.transcript.say(`![Corrected queued message](${path})`, 5000);
  writeFileSync(local.transcriptPath, local.transcript.text());
  try {
    await local.start();
    await new Extension(local).connect();
    const events = new Events();
    await events.open(local, "?block=1&view=chat");
    const chat = obj(await events.take("chat"));
    const assistant = arr(chat.entries).map(obj).find((entry) => entry.text === `![Corrected queued message](${path})`)!;
    const src = obj(assistant.imageSources)[path];
    expect(src).toMatch(/^\/api\/blob\/[0-9a-f]{64}\?type=image%2Fpng$/);
    const image = await local.get(String(src));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    expect((await fetch(local.base + src)).status).toBe(403);
    expect((await local.get(path)).headers.get("content-type")).not.toBe("image/png");
    // Overwritten in place, transcript unchanged: a reopened chat gets the new image's hash, not the shared read's old one.
    const changed = Buffer.concat([PNG, Buffer.from("more")]);
    writeFileSync(path, changed);
    const again = new Events();
    await again.open(local, "?block=1&view=chat");
    const reread = arr(obj(await again.take("chat")).entries).map(obj).find((entry) => entry.text === `![Corrected queued message](${path})`)!;
    const fresh = String(obj(reread.imageSources)[path]);
    expect(fresh).not.toBe(src);
    expect(Buffer.from(await (await local.get(fresh)).arrayBuffer())).toEqual(changed);
  } finally {
    await local.close();
  }
});

test("inherited object names are not allowed keys or image MIME types", async () => {
  s.clearCalls();
  for (const name of ["constructor", "__proto__", "toString"]) {
    expect((await s.action(2, "keys", { keys: [name] })).status).toBe(502);
    expect((await s.get(`/api/blob/${HASH}?type=${name}`)).status).toBe(404);
  }
  expect(s.calls()).toEqual([]);
});

test("terminal submit/type/keys route to tern and validate errors before sending", async () => {
  s.clearCalls();
  expect((await s.action(2, "submit", { text: "--help" })).status).toBe(200);
  // `--`: text starting with a dash is typed, not read as tern's flags.
  expect(s.calls()).toEqual([["send", "2", "text", "--", "--help"], ["send", "2", "keys", "Enter"]]);
  s.clearCalls();
  await s.action(2, "submit", { text: "one\ntwo" });
  expect(s.calls()[0]).toEqual(["send", "2", "paste", "--", "one\ntwo"]);
  expect((await s.action(2, "submit", { text: "x".repeat(1_000_001) })).status).toBe(400);
  s.clearCalls();
  await s.action(2, "type", { back: 2.9, text: "x" });
  expect(s.calls()).toEqual([["send", "2", "keys", "Backspace", "Backspace"], ["send", "2", "text", "--", "x"]]);
  s.clearCalls();
  await s.action(2, "type", { back: 900 });
  expect(s.calls()[0].slice(3)).toHaveLength(500);
  s.clearCalls();
  expect((await s.action(2, "keys", { keys: ["ctrl+z"] })).status).toBe(502);
  expect(s.calls()).toEqual([]);
  expect((await s.action(999, "keys", { keys: ["Enter"] })).status).toBe(404);
  const image = { data: "AAAA", mimeType: "image/png" };
  const noBridge = await s.action(2, "submit", { images: [image] });
  expect(noBridge.status).toBe(502);
  expect(obj(await noBridge.json()).error).toContain("images need an omp session");
  expect((await s.action(2, "submit", { followUp: true, text: "later" })).status).toBe(502);
  expect((await s.action(2, "submit", { images: ["invalid"] })).status).toBe(400);
  expect((await s.action(2, "draft", { text: "a" })).status).toBe(409);
  await s.action(2, "abort");
  expect(s.calls()).toEqual([["send", "2", "keys", "Escape"]]);
});

test("tern stderr errors propagate even on exit 0; WARN noise is ignored", async () => {
  writeFileSync(`${s.home}/fail`, "WARN startup noise\n");
  expect((await s.action(2, "keys", { keys: ["Enter"] })).status).toBe(200);
  writeFileSync(`${s.home}/fail`, "WARN startup noise\nno such key\n");
  const r = await s.action(2, "keys", { keys: ["Enter"] });
  expect(r.status).toBe(502);
  expect(await r.json()).toEqual({ error: "no such key" });
  rmSync(`${s.home}/fail`);
});

test("a bridge snapshot creates an agent, reads transcript facts/recap and reorders the list", async () => {
  agent = new Extension(s);
  await agent.connect();
  const state = await until(async () => { const state = await s.state(); return item(state, 1).status === "working" ? state : null; }, "bridge state");
  expect(arr(state.projects).map((p) => obj(p).name)).toEqual(["alpha", "beta", "~"]);
  expect(arr(obj(arr(state.projects)[0]).items).map((i) => obj(i).block)).toEqual(["1", "4"]);
  expect(item(state, 1).agent).toEqual({ sessionId: s.session, lastPrompt: "Which route?", recap: "Earlier recap", recapStale: true, lastActivity: T0 + 4000, subagents: 0 });
  // A snapshot without them is an extension from before versioning.
  expect(obj(item(state, 1).live)).toMatchObject({ protocol: 0, caps: null, build: "", mismatch: "older", restart: false });
  expect(state.counts).toEqual({ working: 1, blocked: 0, idle: 0 });
});

test("SSE streams chat, draft, live and queued updates and pushes state without polling", async () => {
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  expect((await agent.take("watch")).on).toBe(true);
  expect(await events.take("draft")).toEqual({ live: true, text: "" });
  // The gauge comes as its own event, with where auto-compaction fires (omp config: 80 %).
  expect(await events.take("context")).toEqual({ tokens: 40000, window: 200000, percent: 20, compactAt: 80 });
  expect(item(await events.take("state"), 1).status).toBe("working");
  const chat = obj(await events.take("chat"));
  expect(arr(chat.entries).map((e) => obj(e).role)).toEqual(["user", "assistant", "turn", "user", "ask"]);
  agent.report({ text: "desktop draft", queued: ["old steer", { text: "later", followUp: true }] });
  expect(await events.take("draft", (d) => obj(d).text === "desktop draft")).toEqual({ live: true, text: "desktop draft" });
  expect(await events.take("queued")).toEqual([{ text: "old steer", followUp: false }, { text: "later", followUp: true }]);
  agent.send({ t: "live", text: "Streaming answer", done: false });
  expect(await events.take("live")).toEqual({ text: "Streaming answer", done: false });
  agent.send({ t: "live", text: "Finished", done: true });
  expect(await events.take("live")).toEqual({ text: "Finished", done: true });
  agent.send({ t: "btw", id: "side", text: "side answer", done: true });
  expect(await events.take("btw")).toEqual({ id: "side", text: "side answer", done: true, error: "" });
  agent.report({ context: { tokens: 50000, window: 200000, percent: 25 } });
  expect(await events.take("context")).toEqual({ tokens: 50000, window: 200000, percent: 25, compactAt: 80 });
  const start = Date.now();
  agent.report({ model: "test/changed" });
  await events.take("state", (state) => obj(item(state, 1).live).model === "test/changed", 1500);
  expect(Date.now() - start).toBeLessThan(1500); // safety polling is 15 seconds
  agent.report({ leaf: "-" });
  expect(await events.take("chat", (c) => arr(obj(c).entries).length === 0)).toEqual({ entries: [] });
  agent.report({ leaf: s.leaf });
  await events.take("chat", (c) => arr(obj(c).entries).length === 5);
  // A file write, independent of a bridge message, refreshes the open transcript.
  s.transcript.say("new on disk", 5000);
  agent.report({ leaf: "" });
  appendFileSync(s.transcriptPath, s.transcript.lines().at(-1)! + "\n");
  await events.take("chat", (c) => arr(obj(c).entries).some((e) => obj(e).text === "new on disk"));
  // omp's idle recap lands in history.db with the transcript unchanged: the open chat gets it after the reply.
  const db = new Database(`${s.home}/.omp/agent/history.db`);
  db.run("INSERT INTO session_recaps (session_id, recap, created_at) VALUES (?, 'You asked for a route.', ?)", [s.session, Math.floor((T0 + 6000) / 1000)]);
  db.close();
  const recapped = obj(await events.take("chat", (c) => arr(obj(c).entries).some((e) => obj(e).role === "recap")));
  expect(arr(recapped.entries).slice(-3).map((e) => obj(e).role)).toEqual(["assistant", "turn", "recap"]);
  expect(obj(arr(recapped.entries).at(-1)).text).toBe("You asked for a route.");
  agent.report({ leaf: s.leaf });
  events.close();
  expect((await agent.take("watch")).on).toBe(false);
});

describe("subagents", () => {
  /** The session's subagent folder: its transcript's path without `.jsonl`. */
  const dir = () => s.transcriptPath.replace(/\.jsonl$/, "");
  const done = new Transcript("sub-done", `${s.home}/alpha`);
  const busy = new Transcript("sub-busy", `${s.home}/alpha`);

  beforeAll(() => {
    mkdirSync(dir());
    done.user("Run sleep 20 and report", 1000);
    done.assistant([call("c1", "bash", { i: "Sleeping 20 s", command: "sleep 20" })], 2000, { stop: "toolUse" });
    done.result("c1", "bash", 22000);
    done.say("Slept for twenty seconds.", 23000);
    writeFileSync(`${dir()}/ViewA.jsonl`, done.text());
    busy.user("Run sleep 20", 3000);
    busy.assistant([call("c1", "bash", { i: "Sleeping in B", command: "sleep 20" })], 4000, { stop: "toolUse" });
    writeFileSync(`${dir()}/ViewB.jsonl`, busy.text());
    // Not subagents: an advisor transcript, a result, a tool log, and a link out of the folder.
    const advisor = new Transcript("advisor");
    advisor.say("secret advice", 100);
    writeFileSync(`${dir()}/__advisor.sol61-high.jsonl`, advisor.text());
    writeFileSync(`${dir()}/ViewA.md`, "{}");
    writeFileSync(`${dir()}/12.bash.log`, "output");
    const outside = new Transcript("outside");
    outside.say("outside the folder", 100);
    writeFileSync(`${s.home}/outside.jsonl`, outside.text());
    symlinkSync(`${s.home}/outside.jsonl`, `${dir()}/Escape.jsonl`);
    agent.report({ jobs: [{ id: "j1", type: "task", label: "B", agent: "ViewB", since: T0 + 3000 }, { id: "j2", type: "task", label: "C", agent: "ViewC", since: T0 + 9000 }] });
  });
  afterAll(() => agent.report({ jobs: [] }));

  test("the list endpoint merges transcripts with running jobs and leaves out advisors, logs and links", async () => {
    const list = await until(async () => {
      const r = obj(await (await s.get("/api/blocks/1/subagents")).json());
      return arr(r.subagents).length === 3 ? arr(r.subagents) : null;
    }, "subagents with jobs");
    expect(list).toEqual([
      { name: "ViewC", started: T0 + 9000, lastActivity: T0 + 9000, running: true, summary: "", messages: 0 },
      { name: "ViewB", started: T0, lastActivity: T0 + 4000, running: true, summary: "Sleeping in B", messages: 2 },
      { name: "ViewA", started: T0, lastActivity: T0 + 23000, running: false, summary: "Slept for twenty seconds.", messages: 4 },
    ]);
    // The session row counts them, finished ones too.
    expect(obj(item(await s.state(), 1).agent).subagents).toBe(3);
    // A terminal has none; a missing block is 404.
    expect(await (await s.get("/api/blocks/2/subagents")).json()).toEqual({ subagents: [] });
    expect((await s.get("/api/blocks/999/subagents")).status).toBe(404);
  });

  test("a subagent's chat streams read-only through the transcript parser and follows appends", async () => {
    const events = new Events();
    await events.open(s, "?block=1&view=chat&sub=ViewB");
    const chat = obj(await events.take("chat"));
    expect(arr(chat.entries)).toEqual([
      { role: "user", id: expect.any(String), text: "Run sleep 20", images: [], ts: T0 + 3000 },
      { role: "tools", calls: [{ name: "bash", intent: "Sleeping in B" }], images: [], todo: null, ts: T0 + 4000 },
    ]);
    busy.result("c1", "bash", 24000);
    busy.say("B is awake.", 25000);
    appendFileSync(`${dir()}/ViewB.jsonl`, busy.lines().slice(-2).join("\n") + "\n");
    const next = obj(await events.take("chat", (c) => arr(obj(c).entries).some((e) => obj(e).text === "B is awake.")));
    expect(arr(next.entries).map((e) => obj(e).role)).toEqual(["user", "tools", "assistant", "turn"]);
    // The parent session's draft, live text and queue don't reach a subagent screen.
    expect(events.events.filter((e) => ["draft", "live", "queued"].includes(e.event))).toEqual([]);
    events.close();
  });

  test("the subagent list streams and picks up a subagent that starts", async () => {
    const events = new Events();
    await events.open(s, "?block=1&view=subagents");
    const first = arr(await events.take("subagents"));
    // Both running; ViewB wrote last (the append above), so it leads.
    expect(first.map((x) => obj(x).name)).toEqual(["ViewB", "ViewC", "ViewA"]);
    const fresh = new Transcript("sub-d");
    fresh.user("Start D", 30000);
    writeFileSync(`${dir()}/ViewD.jsonl`, fresh.text());
    const next = arr(await events.take("subagents", (l) => arr(l).some((x) => obj(x).name === "ViewD")));
    expect(obj(next.find((x) => obj(x).name === "ViewD"))).toMatchObject({ running: false, messages: 1, lastActivity: T0 + 30000 });
    expect(events.events.filter((e) => e.event === "draft")).toEqual([]);
    events.close();
  });

  test("names that could leave the folder or reach an advisor are refused; links and unknown names show nothing", async () => {
    for (const sub of ["..", "../date_test-session", "..%2F..%2Fx", "__advisor.sol61-high", "a%2Fb", ".hidden", ""]) {
      const r = await s.get(`/api/stream?block=1&view=chat&sub=${sub}`);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad subagent" });
    }
    expect((await s.get("/api/stream?view=chat&sub=ViewA")).status).toBe(400);
    expect((await s.get("/api/stream?block=999&view=chat&sub=ViewA")).status).toBe(404);
    for (const sub of ["Escape", "Missing"]) {
      const events = new Events();
      await events.open(s, `?block=1&view=chat&sub=${sub}`);
      expect(await events.take("chat")).toEqual({ entries: [] });
      events.close();
    }
  });

  test("the list and the subagent stream need an allowed login, nothing more", async () => {
    for (const path of ["/api/blocks/1/subagents", "/api/stream?block=1&view=chat&sub=ViewA", "/api/stream?block=1&view=subagents"]) {
      const r = await fetch(s.base + path, { headers: { "tailscale-user-login": s.login } });
      expect(r.status).toBe(200);
      await r.body?.cancel();
      expect((await fetch(s.base + path)).status).toBe(403);
    }
  });
});

test("submit/draft and image/follow-up submissions use the bridge protocol", async () => {
  agent.inbox = [];
  s.clearCalls();
  expect((await s.action(1, "draft", { text: "mobile draft" })).status).toBe(200);
  expect(await agent.take("set")).toMatchObject({ text: "mobile draft", seq: expect.any(Number) });
  expect((await s.action(1, "submit", { text: "send this" })).status).toBe(200);
  expect((await agent.take("set")).text).toBe("send this");
  expect(s.calls()).toEqual([["send", "1", "keys", "Enter"]]);
  // Sent again even when the reported draft already matches: the report may be stale.
  await s.action(1, "submit", { text: "send this" });
  expect((await agent.take("set")).text).toBe("send this");
  expect(s.calls()).toEqual([["send", "1", "keys", "Enter"], ["send", "1", "keys", "Enter"]]);
  const images = [{ data: "AAAA", mimeType: "image/png" }];
  s.clearCalls();
  await s.action(1, "submit", { text: "picture", images });
  expect(await agent.take("send")).toMatchObject({ text: "picture", images, followUp: false, expected: expect.any(String) });
  await s.action(1, "submit", { text: "afterward", followUp: true });
  expect(await agent.take("send")).toMatchObject({ text: "afterward", images: [], followUp: true });
  expect(s.calls()).toEqual([]);
});

test("model catalog and model/thinking/tier commands correlate sequenced bridge replies", async () => {
  const models = await s.action(1, "models");
  expect(await models.json()).toEqual({ models: [{ p: "test", id: "fast", name: "Fast", ctx: 200000, r: false, in: 0, out: 0, img: false }] });
  expect((await agent.take("models")).seq).toBeNumber();
  agent.inbox = [];
  await s.action(1, "models");
  expect(agent.inbox).toEqual([]); // catalog cache
  expect((await s.action(1, "model", { role: "smart" })).status).toBe(200);
  expect((await agent.take("model")).spec).toBe("test/smart:high");
  expect((await s.action(1, "model", { spec: "test/fast" })).status).toBe(200);
  expect((await agent.take("model")).spec).toBe("test/fast");
  expect((await s.action(1, "model", { role: "missing" })).status).toBe(400);
  expect((await s.action(1, "model", { spec: "invalid" })).status).toBe(400);
  const denied = await s.action(1, "model", { spec: "bad/model" });
  expect(denied.status).toBe(502);
  expect(await denied.json()).toEqual({ error: "no credentials for this model" });
  expect((await s.action(2, "model", { spec: "test/model" })).status).toBe(409);
  await s.action(1, "thinking", { level: "high" });
  expect((await agent.take("thinking")).level).toBe("high");
  await s.action(1, "tier", { tier: "priority" });
  expect((await agent.take("tier")).tier).toBe("priority");
  expect((await s.action(1, "tier", { tier: "invalid" })).status).toBe(502);
});

test("reported caps reach the list and refuse rewind, models and tier when off", async () => {
  const all = { models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: true, levels: true };
  agent.report({ protocol: 1, caps: { ...all, rewind: false, models: false, tiers: false } });
  // The list cache lives 15 s; seeing the caps at once means the change invalidated it.
  const live = obj(item(await until(async () => {
    const state = await s.state();
    return obj(item(state, 1).live).protocol === 1 ? state : null;
  }, "caps in the list"), 1).live);
  expect(live.caps).toEqual({ ...all, rewind: false, models: false, tiers: false });
  agent.inbox = [];
  for (const [action, body, word] of [["rewind", { entry: s.prompt }, "rewind"], ["models", {}, "models"], ["tier", { tier: "priority" }, "tiers"]] as const) {
    const r = await s.action(1, action, body);
    expect(r.status).toBe(409);
    expect(obj(await r.json()).error).toContain(word);
  }
  expect(agent.inbox.filter((m) => m.t !== "watch")).toEqual([]);
  // Thinking has no cap: it still goes through.
  await s.action(1, "thinking", { level: "high" });
  expect((await agent.take("thinking")).level).toBe("high");
  agent.report({ caps: all });
  await until(async () => obj(obj(item(await s.state(), 1).live).caps).rewind === true, "caps restored");
});

test("the installed extension's status and the fix's checkout reach the list, rechecked as the file changes", async () => {
  const installed = `${s.home}/.omp/agent/extensions/tern-mobile.ts`;
  const status = async (want: string) => obj(await until(async () => {
    s.signal(); // any Tern event rebuilds the list, which rechecks the file
    const state = await s.state();
    return obj(state.extension).status === want ? state.extension : null;
  }, `install ${want}`));
  expect(await status("missing")).toEqual({ status: "missing", target: "", path: installed, repo: REPO, windows: false });
  mkdirSync(`${s.home}/.omp/agent/extensions`);
  symlinkSync(EXTENSION_SOURCE, installed);
  expect(await status("ok")).toMatchObject({ target: "", repo: REPO });
  rmSync(installed);
  writeFileSync(installed, `// before git pull\n${readFileSync(EXTENSION_SOURCE, "utf8")}`);
  await status("stale");
  rmSync(installed);
  writeFileSync(`${s.home}/other-checkout.ts`, readFileSync(EXTENSION_SOURCE));
  symlinkSync(`${s.home}/other-checkout.ts`, installed);
  expect(await status("foreign")).toMatchObject({ target: `${s.home}/other-checkout.ts` });
  rmSync(installed);
  copyFileSync(EXTENSION_SOURCE, installed);
  await status("ok");
});

test("each bridged session is classified against the checkout's build and the server's protocol", async () => {
  const current = buildId(readFileSync(EXTENSION_SOURCE));
  const ext = new Extension(s, "4");
  ext.restart = true;
  await ext.connect();
  const live = (want: Record<string, unknown>, description: string) =>
    until(async () => {
      const l = obj(item(await s.state(), 4).live);
      return Object.entries(want).every(([k, v]) => l[k] === v) ? l : null;
    }, description);
  // No protocol: from before versioning, so older; its omp's autocomplete offers /restart.
  await live({ protocol: 0, mismatch: "older", restart: true }, "older, restartable");
  expect((await ext.take("complete")).text).toBe("/restart");
  ext.report({ protocol: PROTOCOL, build: current });
  await live({ build: current, mismatch: null }, "current");
  ext.report({ build: "0000000000000000" });
  await live({ build: "0000000000000000", mismatch: "older" }, "another build");
  ext.report({ protocol: PROTOCOL + 1 });
  await live({ mismatch: "newer" }, "newer protocol");
  // A build the extension couldn't read proves nothing.
  ext.report({ protocol: PROTOCOL, build: "" });
  await live({ build: "", mismatch: null }, "unknown build");
  // Asked once per connection, not on every rebuild.
  expect(ext.inbox.filter((m) => m.t === "complete")).toEqual([]);
  // Rows without a bridge are never flagged: terminals and notes.
  const state = await s.state();
  expect(item(state, 2).live).toBeNull();
  expect(item(state, 3).live).toBeNull();
  ext.ws.close();
  await until(async () => item(await s.state(), 4).live === null, "pane 4 unbridged");
});

test("an older omp without /restart, or without autocomplete, gets no Reload", async () => {
  const plain = new Extension(s, "4");
  await plain.connect();
  await until(async () => obj(item(await s.state(), 4).live).mismatch === "older", "older session");
  expect((await plain.take("complete")).text).toBe("/restart");
  expect(obj(item(await s.state(), 4).live).restart).toBe(false);
  plain.ws.close();
  await until(async () => item(await s.state(), 4).live === null, "pane 4 unbridged");
  const noCompletion = new Extension(s, "4");
  noCompletion.restart = true;
  Object.assign(noCompletion.snapshot, { protocol: 1, caps: { models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: false, levels: true } });
  await noCompletion.connect();
  await until(async () => obj(item(await s.state(), 4).live).mismatch === "older", "older session without completion");
  // A probe would have gone out with that rebuild; anything the server sends later arrives after it.
  await s.action(4, "thinking", { level: "high" });
  await noCompletion.take("thinking");
  expect(noCompletion.inbox.filter((m) => m.t === "complete")).toEqual([]);
  expect(obj(item(await s.state(), 4).live).restart).toBe(false);
  noCompletion.ws.close();
  await until(async () => item(await s.state(), 4).live === null, "pane 4 unbridged");
});

test("completion, side question and abort endpoints speak the extension protocol", async () => {
  expect(await (await s.action(1, "complete", { text: "/he" })).json()).toEqual({ prefix: "/he", items: [{ value: "/help", label: "help", description: "" }] });
  expect((await agent.take("complete")).text).toBe("/he");
  expect(await (await s.action(1, "completion", { text: "/he", value: "/help", label: "help", prefix: "/he" })).json()).toEqual({ text: "/help " });
  expect(await agent.take("apply")).toMatchObject({ text: "/he", value: "/help", label: "help", prefix: "/he" });
  expect((await s.action(1, "completion", { value: "bad" })).status).toBe(502);
  expect((await s.action(1, "btw", { text: " " })).status).toBe(400);
  const reply = obj(await (await s.action(1, "btw", { text: "  why?  " })).json());
  expect(await agent.take("btw")).toMatchObject({ id: reply.id, text: "why?" });
  expect(reply.id).toBeString();
  await s.action(1, "abort");
  expect((await agent.take("abort")).seq).toBeNumber();
});

test("answer keys follow the open ask; rewind validates the entry and requires idle", async () => {
  s.clearCalls();
  expect((await s.action(1, "answer", { id: "stale", answers: [{ option: 1 }] })).status).toBe(502);
  expect(s.calls()).toEqual([]);
  expect((await s.action(1, "answer", { id: "ask1", answers: [{ option: 1 }] })).status).toBe(200);
  expect(s.calls()).toEqual([["send", "1", "keys", "Up", "Up", "Down", "Enter"]]);
  expect((await s.action(1, "rewind", { entry: "../bad" })).status).toBe(400);
  expect((await s.action(2, "rewind", { entry: s.prompt })).status).toBe(409);
  expect((await s.action(1, "rewind", { entry: s.prompt })).status).toBe(409);
  agent.report({ status: "idle" });
  await until(async () => item(await s.state(), 1).status === "idle", "idle state");
  s.clearCalls();
  expect((await s.action(1, "rewind", { entry: s.prompt })).status).toBe(200);
  expect((await agent.take("set")).text).toBe(`/tern-mobile-rewind ${s.prompt}`);
  expect(s.calls()).toEqual([["send", "1", "keys", "Enter"]]);
  expect(item(await s.state(), 1).since).toBe(T0 + 5000);
});

test("a non-answering extension yields a bounded error instead of hanging HTTP", async () => {
  agent.silent = true;
  const r = await s.action(1, "draft", { text: "ignored" });
  agent.silent = false;
  expect(r.status).toBe(502);
  expect(await r.json()).toEqual({ error: "omp did not answer" });
}, 3500);

test("disconnect restores the newest surviving socket with sync, then clears phone state", async () => {
  const second = new Extension(s, "1", "test/second");
  await second.connect();
  await until(async () => obj(item(await s.state(), 1).live).model === "test/second", "second bridge");
  const newest = new Extension(s, "1", "test/newest");
  await newest.connect();
  await until(async () => obj(item(await s.state(), 1).live).model === "test/newest", "newest bridge");
  newest.ws.close();
  expect((await second.take("sync")).t).toBe("sync");
  await until(async () => obj(item(await s.state(), 1).live).model === "test/second", "surviving bridge");
  agent.ws.close(); // closing a non-owner must not unregister the owner
  await s.action(1, "thinking", { level: "high" });
  expect((await second.take("thinking")).level).toBe("high");
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  await events.take("draft", (d) => obj(d).live === true);
  second.ws.close();
  expect(await events.take("draft", (d) => obj(d).live === false)).toEqual({ live: false, text: "" });
  expect(await events.take("live")).toEqual({ text: "", done: false });
  expect(await events.take("queued")).toEqual([]);
  const state = await events.take("state", (d) => item(d, 1).live === null);
  expect(item(state, 1)).toMatchObject({ agent: null, status: null });
  events.close();
});

test("document writes and terminal screens stream without touching real panes", async () => {
  const doc = new Events();
  await doc.open(s, "?block=3");
  expect(await doc.take("doc")).toEqual({ text: "# Note\n", markdown: true, missing: false, clipped: false });
  writeFileSync(`${s.home}/.local/state/tern/notes/abc.md`, "# Updated\n");
  expect(obj(await doc.take("doc")).text).toBe("# Updated\n");
  doc.close();
  const terminal = new Events();
  await terminal.open(s, "?block=2");
  expect(await terminal.take("screen")).toEqual({ text: "<pre>terminal output</pre>", html: true });
  terminal.close();
});

test("tern events invalidate cached state and new/focus/close route to the CLI", async () => {
  const events = new Events();
  await events.open(s);
  await events.take("state");
  const blocks = arr(obj(arr(obj(arr(s.tree.sessions)[0]).tabs)[0]).blocks);
  blocks.push({ id: 8, cwd: `${s.home}/beta`, title: "added" });
  s.saveTree();
  s.signal();
  expect(item(await events.take("state", (d) => item(d, 8).title === "added"), 8).block).toBe("8");
  events.close();
  s.clearCalls();
  expect((await s.post("/api/new", { cwd: "/does-not-exist" })).status).toBe(400);
  expect(await (await s.post("/api/new", { cwd: `${s.home}/alpha` })).json()).toEqual({ block: "99" });
  await s.action(2, "focus");
  await s.action(2, "close");
  expect(s.calls()).toEqual([["new", "tab", "--cwd", `${s.home}/alpha`, "--json", "--", "omp"], ["focus", "2"], ["close", "2"]]);
});

test("blocked updates set an unseen badge; viewing clears it, settled completion sets it again", async () => {
  const extension = new Extension(s, "2");
  await extension.connect();
  await until(async () => item(await s.state(), 2).status === "working", "working pane");
  extension.report({ status: "blocked" });
  const blocked = await until(async () => {
    const state = await s.state();
    return item(state, 2).unseen === "blocked" ? state : null;
  }, "unseen question");
  expect(blocked.badge).toBeGreaterThanOrEqual(1);
  const events = new Events();
  await events.open(s, "?block=2&view=chat");
  expect(item(await events.take("state", (state) => item(state, 2).unseen === null), 2).unseen).toBeNull();
  events.close();
  await extension.take("watch");
  await extension.take("watch");
  extension.report({ status: "working" });
  await until(async () => item(await s.state(), 2).status === "working", "resumed pane");
  extension.report({ status: "idle" });
  await until(async () => item(await s.state(), 2).unseen === "done", "settled completion", 4000);
  extension.ws.close();
}, 6000);

test("subscriptions and VAPID keys survive a server restart in the isolated HOME", async () => {
  const subscription = { endpoint: "https://127.0.0.1:9/saved", keys: { p256dh: "key", auth: "auth" } };
  const path = `${s.home}/.config/tern-mobile/push.json`;
  const key = await (await s.get("/api/push/key")).json();
  // No connected extensions in the restarted server: nothing can deliver these subscriptions.
  await s.stop();
  writeFileSync(path, JSON.stringify([subscription]));
  await s.start();
  expect(await (await s.get("/api/push/key")).json()).toEqual(key);
  const second = { ...subscription, endpoint: "https://127.0.0.1:9/second" };
  await s.post("/api/push/subscribe", second);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([subscription, second]);
  await s.post("/api/push/unsubscribe", subscription);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([second]);
  await s.post("/api/push/unsubscribe", second);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
});

test("TERN_AWUI_PROJECTS replaces the default list with a command's absolute, existing folders", async () => {
  writeFileSync(`${s.home}/bin/projects`, `#!/bin/bash\nprintf '%s\\n' '${s.home}/alpha' relative/dir '${s.home}/missing' '${s.home}/tree.json' '  ${s.home}/beta  '\n`);
  chmodSync(`${s.home}/bin/projects`, 0o755);
  await s.stop();
  await s.start({ TERN_AWUI_PROJECTS: `${s.home}/bin/projects` });
  expect(await (await s.get("/api/projects")).json()).toEqual({ projects: [`${s.home}/alpha`, `${s.home}/beta`], home: s.home });
});
