import { afterAll, beforeAll, expect, test } from "bun:test";
import { Events, Extension, Sandbox, item, until } from "./server-harness";
import { obj } from "../lib/json";

const s = new Sandbox();
const extension = new Extension(s);
const caps = { models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: true, levels: true };
beforeAll(async () => {
  await s.start();
  await extension.connect();
  await until(async () => item(await s.state(), 1).agent, "bridged session");
}, 6000);
afterAll(() => s.close());

const offer = { sdp: "v=0 phone offer", attempt: "phone-a" };

test("a voice call needs an omp that runs them, and a WebRTC offer", async () => {
  extension.report({ caps: { ...caps, voice: false } });
  await until(async () => obj(item(await s.state(), 1).live).caps, "caps in the list");
  expect(await (await s.action(1, "voice", offer)).json()).toEqual({ error: "this omp can't run voice calls (update omp)" });
  expect((await s.action(2, "voice", offer)).status).toBe(409);
  extension.report({ caps: { ...caps, voice: true } });
  await until(async () => obj(obj(item(await s.state(), 1).live).caps).voice, "voice cap");
  expect((await s.action(1, "voice", { sdp: "not sdp" })).status).toBe(400);
  expect((await s.action(1, "voice", { sdp: `v=${"x".repeat(70_000)}` })).status).toBe(400);
  expect(extension.inbox.filter((m) => m.t === "voice")).toEqual([]);
});

test("the phone's offer reaches omp, the call's phase and lines stream to phones, and hanging up ends it once", async () => {
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  expect(await events.take("voice")).toBeNull();

  expect(await (await s.action(1, "voice", offer)).json()).toEqual({ sdp: "v=0 answer to v=0 phone offer" });
  expect(await extension.take("voice")).toMatchObject(offer);
  extension.send({ t: "voice", phase: "listening" });
  extension.send({ t: "voice", role: "user", text: "list the files" });
  // The call carries the starting phone's attempt, so that phone knows it is its own.
  expect(await events.take("voice", (d) => obj(d).user === "list the files")).toEqual({ phase: "listening", user: "list the files", assistant: "", ended: false, error: "", attempt: "phone-a" });
  // One call per session: a second phone can't start another.
  expect(await (await s.action(1, "voice", { ...offer, attempt: "phone-b" })).json()).toEqual({ error: "a voice call is already running" });
  // A phone opening the session mid-call sees it.
  const late = new Events();
  await late.open(s, "?block=1&view=chat");
  expect(await late.take("voice")).toMatchObject({ phase: "listening", ended: false });

  // An automatic hang-up names its attempt, so omp can leave a newer call alone.
  expect((await s.post("/api/blocks/1/hangup", { attempt: "phone-a" })).status).toBe(200);
  expect(await extension.take("hangup")).toMatchObject({ attempt: "phone-a" });
  expect(await events.take("voice", (d) => obj(d).ended === true)).toMatchObject({ ended: true, error: "" });
  // Over: a new call may start, and a reconnecting phone hears of no call.
  const after = new Events();
  await after.open(s, "?block=1&view=chat");
  expect(await after.take("voice")).toBeNull();
});

test("while omp still signals, the call is already known: a second start is refused, and a failed start frees the session", async () => {
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  expect(await events.take("voice")).toBeNull();
  const answer = Promise.withResolvers<Record<string, unknown>>();
  extension.answerVoice = () => answer.promise;
  const first = s.action(1, "voice", offer);
  // Before omp sends a single phase, phones already see the call as connecting.
  expect(await events.take("voice")).toEqual({ phase: "connecting", user: "", assistant: "", ended: false, error: "", attempt: "phone-a" });
  expect(await (await s.action(1, "voice", { ...offer, attempt: "phone-b" })).json()).toEqual({ error: "a voice call is already running" });
  answer.resolve({ error: "signaling failed" });
  expect(await (await first).json()).toEqual({ error: "signaling failed" });
  expect(await events.take("voice", (d) => obj(d).ended === true)).toMatchObject({ attempt: "phone-a", error: "signaling failed" });
  extension.answerVoice = undefined;
  expect((await s.action(1, "voice", { ...offer, attempt: "phone-c" })).status).toBe(200);
  await s.post("/api/blocks/1/hangup", { attempt: "phone-c" });
  await events.take("voice", (d) => obj(d).ended === true);
});

test("omp disconnecting mid-call ends it for the phones", async () => {
  const other = new Extension(s, "3");
  other.snapshot.caps = { ...caps, voice: true };
  await other.connect();
  await until(async () => item(await s.state(), 3).agent, "second bridged session");
  const events = new Events();
  await events.open(s, "?block=3&view=chat");
  expect((await s.action(3, "voice", offer)).status).toBe(200);
  other.send({ t: "voice", phase: "working" });
  await events.take("voice", (d) => obj(d).phase === "working");
  other.ws.close();
  expect(await events.take("voice", (d) => obj(d).ended === true)).toMatchObject({ phase: "working", ended: true, error: "omp disconnected" });
});
