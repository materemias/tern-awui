import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Events, Extension, Sandbox, item, until } from "./server-harness";
import { call } from "./fixtures";
import { obj } from "../lib/json";

const s = new Sandbox();
const extension = new Extension(s);
beforeAll(async () => {
  s.transcript.assistant([call("call1", "bash", { command: "ls" }), call("call2", "edit", { input: "x" })], 5000, { stop: "toolUse" });
  writeFileSync(s.transcriptPath, s.transcript.text());
  await s.start();
  // Blocked from its first report on (a server restart, a reconnect): no status change announces it.
  extension.snapshot.status = "blocked";
  await extension.connect();
  await until(async () => item(await s.state(), 1).agent, "bridged session");
}, 6000);
afterAll(() => s.close());

const keys = () => s.calls().filter((c) => c[0] === "send");

test("an omp already blocked when it connects shows its open question in the row", async () => {
  expect(await until(async () => item(await s.state(), 1).activity, "the question in the row")).toBe("Choose");
});

test("an approval is answered once, with omp's own key, after a fresh snapshot confirms omp still asks", async () => {
  extension.report({ protocol: 5, status: "blocked", approval: { id: "call1", tool: "bash", reason: "" } });
  await until(async () => item(await s.state(), 1).status === "blocked", "blocked");
  s.clearCalls();
  expect((await s.action(1, "approve", { id: "call1", allow: "yes" })).status).toBe(400);
  expect((await s.action(1, "approve", { id: "call1", allow: true })).status).toBe(200);
  expect(await extension.take("sync")).toMatchObject({ t: "sync" });
  expect(keys()).toEqual([["send", "1", "keys", "ctrl+q"]]);
  // omp hasn't reported the dialog closed yet: a second answer (another phone, a retry) is refused.
  expect((await s.action(1, "approve", { id: "call1", allow: false })).status).toBe(409);
  expect(keys()).toHaveLength(1);
});

test("a key omp ignored doesn't lock the call: once the duplicate window passes, Deny still answers it", async () => {
  s.clearCalls();
  // The fresh snapshot still shows call1's dialog, well after the Ctrl+Q above.
  setSystemTime(new Date(Date.now() + 6000));
  try {
    expect((await s.action(1, "approve", { id: "call1", allow: false })).status).toBe(200);
    expect(keys()).toEqual([["send", "1", "keys", "Escape"]]);
  } finally {
    setSystemTime();
  }
});

test("an answer is refused when the fresh snapshot shows the dialog already closed, though the last report still asked", async () => {
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  extension.report({ status: "blocked", approval: { id: "call2", tool: "edit", reason: "" } });
  expect(await events.take("approval", (d) => obj(d).id === "call2")).toMatchObject({ args: [{ key: "input", value: "x" }] });
  events.close();
  s.clearCalls();
  // Answered on the desktop a moment ago; omp's report of it hasn't arrived.
  Object.assign(extension.snapshot, { status: "working", approval: null });
  expect((await s.action(1, "approve", { id: "call2", allow: false })).status).toBe(409);
  expect(keys()).toEqual([]);
});
