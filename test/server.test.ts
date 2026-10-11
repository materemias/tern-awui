import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arr, obj } from "../lib/json";
import { HASH, T0 } from "./fixtures";
import { Events, Extension, Sandbox, item, until } from "./server-harness";

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
  expect((await s.action(2, "submit", { text: "hello" })).status).toBe(200);
  expect(s.calls()).toEqual([["send", "2", "text", "hello"], ["send", "2", "keys", "Enter"]]);
  s.clearCalls();
  await s.action(2, "submit", { text: "one\ntwo" });
  expect(s.calls()[0]).toEqual(["send", "2", "paste", "one\ntwo"]);
  s.clearCalls();
  await s.action(2, "type", { back: 2.9, text: "x" });
  expect(s.calls()).toEqual([["send", "2", "keys", "Backspace", "Backspace"], ["send", "2", "text", "x"]]);
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
  expect(item(state, 1).agent).toEqual({ sessionId: s.session, lastPrompt: "Which route?", recap: "Earlier recap", recapStale: true, lastActivity: T0 + 4000 });
  expect(obj(item(state, 1).live).context).toEqual({ tokens: 40000, window: 200000, percent: 20, compactAt: 80 });
  expect(state.counts).toEqual({ working: 1, blocked: 0, idle: 0 });
});

test("SSE streams chat, draft, live and queued updates and pushes state without polling", async () => {
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  expect((await agent.take("watch")).on).toBe(true);
  expect(await events.take("draft")).toEqual({ live: true, text: "" });
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
  agent.report({ leaf: s.leaf });
  events.close();
  expect((await agent.take("watch")).on).toBe(false);
});

test("submit/draft and image/follow-up submissions use the bridge protocol", async () => {
  agent.inbox = [];
  s.clearCalls();
  expect((await s.action(1, "draft", { text: "mobile draft" })).status).toBe(200);
  expect(await agent.take("set")).toMatchObject({ text: "mobile draft", seq: expect.any(Number) });
  expect((await s.action(1, "submit", { text: "send this" })).status).toBe(200);
  expect((await agent.take("set")).text).toBe("send this");
  expect(s.calls()).toEqual([["send", "1", "keys", "Enter"]]);
  agent.inbox = [];
  await s.action(1, "submit", { text: "send this" });
  expect(agent.inbox.filter((m) => m.t === "set")).toEqual([]);
  const images = [{ data: "AAAA", mimeType: "image/png" }];
  s.clearCalls();
  await s.action(1, "submit", { text: "picture", images });
  expect(await agent.take("send")).toMatchObject({ text: "picture", images, followUp: false });
  await s.action(1, "submit", { text: "afterward", followUp: true });
  expect(await agent.take("send")).toMatchObject({ text: "afterward", images: [], followUp: true });
  expect(s.calls()).toEqual([]);
});

test("model catalog and model/thinking/tier commands correlate sequenced bridge replies", async () => {
  const models = await s.action(1, "models");
  expect(await models.json()).toEqual({ models: [{ id: "fast", provider: "test", name: "Fast", contextWindow: 200000 }] });
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
  expect(await events.take("live")).toEqual({ text: "", done: true });
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
  // No connected extensions in the restarted process: nothing can deliver these subscriptions.
  s.proc!.kill();
  await s.proc!.exited;
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
