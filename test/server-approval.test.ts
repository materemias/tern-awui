import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
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

const sends = () => extension.inbox.filter((m) => m.t === "send" || m.t === "set");

test("a Deny's reason needs an extension that sends it past the editor: refused before any key otherwise", async () => {
  extension.report({ protocol: 5, status: "blocked", approval: { id: "call3", tool: "bash", reason: "" } });
  s.clearCalls();
  extension.inbox.length = 0;
  const r = await s.action(1, "approve", { id: "call3", allow: false, reason: "no" });
  expect(r.status).toBe(409);
  expect(obj(await r.json()).error).toContain("older tern-mobile extension");
  expect(keys()).toEqual([]);
  expect(sends()).toEqual([]);
});

test("a Deny's reason steers omp once the deny lands, leaving the editor alone, and a second tap sends neither again", async () => {
  extension.report({ protocol: 6, status: "blocked", approval: { id: "call3", tool: "bash", reason: "" } });
  s.clearCalls();
  extension.inbox.length = 0;
  expect((await s.action(1, "approve", { id: "call3", allow: true, reason: "no" })).status).toBe(400);
  expect((await s.action(1, "approve", { id: "call3", allow: false, reason: "x".repeat(4001) })).status).toBe(400);
  expect(keys()).toEqual([]);
  expect((await s.action(1, "approve", { id: "call3", allow: false, reason: "  use the staging config  " })).status).toBe(200);
  // One message of its own, no draft set and no Enter: nothing lands in a dialog that opened next.
  expect(sends()).toMatchObject([{ t: "send", text: "use the staging config", keepDraft: true, images: [] }]);
  expect(keys()).toEqual([["send", "1", "keys", "Escape"]]);
  expect((await s.action(1, "approve", { id: "call3", allow: false, reason: "use the staging config" })).status).toBe(409);
  expect(keys()).toHaveLength(1);
  expect(sends()).toHaveLength(1);
});

test("a Deny that never reached omp sends no reason; one whose reason failed says the deny landed", async () => {
  extension.report({ status: "blocked", approval: { id: "call4", tool: "bash", reason: "" } });
  s.clearCalls();
  extension.inbox.length = 0;
  writeFileSync(`${s.home}/exit`, "1");
  try {
    expect((await s.action(1, "approve", { id: "call4", allow: false, reason: "why" })).status).toBe(502);
  } finally {
    rmSync(`${s.home}/exit`);
  }
  expect(keys()).toEqual([["send", "1", "keys", "Escape"]]);
  expect(sends()).toEqual([]);
  // The call still waits: a retry denies it, and omp refuses the reason.
  s.clearCalls();
  extension.refuse.send = "no model selected";
  try {
    const r = await s.action(1, "approve", { id: "call4", allow: false, reason: "why" });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "Denied, but the reason didn't reach omp (no model selected): send it as a message.", denied: true });
  } finally {
    delete extension.refuse.send;
  }
  expect(keys()).toEqual([["send", "1", "keys", "Escape"]]);
  // Answered: a retry neither denies nor sends the reason again.
  expect((await s.action(1, "approve", { id: "call4", allow: false, reason: "why" })).status).toBe(409);
  expect(keys()).toHaveLength(1);
});
