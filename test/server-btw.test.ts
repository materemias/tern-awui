import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Extension, Sandbox, item, until } from "./server-harness";
import { obj } from "../lib/json";

const s = new Sandbox();
const path = "/api/blocks/1/btw-history";
const dir = s.transcriptPath.replace(/\.jsonl$/, "") + "/btw-history";
beforeAll(async () => {
  await s.start();
  await new Extension(s).connect();
  await until(async () => item(await s.state(), 1).agent, "bridged history session");
}, 6000);
afterAll(() => s.close());

const record = (id: string, createdAt = 1000) => ({ id, leafId: null, question: "Why this approach?", answer: "**Saved** desktop answer", status: "complete", createdAt, updatedAt: createdAt + 100 });

test("native btw history is authenticated, session-scoped and empty before persistence", async () => {
  expect((await fetch(s.base + path)).status).toBe(403);
  expect((await fetch(s.base + path, { headers: { "tailscale-user-login": "wrong" } })).status).toBe(403);
  expect((await s.get(path)).status).toBe(200);
  expect(await (await s.get(path)).json()).toEqual({ records: [] });
  expect((await s.get("/api/blocks/999/btw-history")).status).toBe(404);
  expect((await s.get("/api/blocks/2/btw-history")).status).toBe(409);
  expect((await s.get("/api/blocks/1/btw-history/../../etc/passwd")).status).toBe(404);
});

test("native records retain followups and errors, sort newest first and ignore malformed files", async () => {
  mkdirSync(dir, { recursive: true });
  const older = record("older");
  const newer = { ...record("newer", 3000), status: "error", error: "Provider unavailable", followUps: [{ question: "Try another angle?", answer: "Partial", status: "cancelled", createdAt: 3100, updatedAt: 3200 }] };
  for (const entry of [older, newer, record("tie-b", 3000), record("tie-a", 3000)]) writeFileSync(`${dir}/entry-${entry.id}.json`, JSON.stringify(entry));
  writeFileSync(`${dir}/entry-broken.json`, "{broken");
  writeFileSync(`${dir}/entry-mismatch.json`, JSON.stringify(record("other")));
  writeFileSync(`${dir}/entry-status.json`, JSON.stringify({ ...record("status"), status: "unknown" }));
  writeFileSync(`${dir}/entry-time.json`, JSON.stringify({ ...record("time"), updatedAt: null }));
  writeFileSync(`${dir}/entry-turn.json`, JSON.stringify({ ...record("turn"), followUps: [{ question: "missing fields" }] }));
  writeFileSync(`${dir}/other.json`, JSON.stringify(record("other")));
  mkdirSync(`${dir}/entry-directory.json`);
  writeFileSync(`${s.home}/outside.json`, JSON.stringify(record("linked")));
  symlinkSync(`${s.home}/outside.json`, `${dir}/entry-linked.json`);
  const response = await s.get(path + "?path=/etc&sessionId=other");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ records: [newer, record("tie-a", 3000), record("tie-b", 3000), older] });
  expect(s.calls()).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)("unreadable native history returns a handled HTTP error", async () => {
  chmodSync(dir, 0);
  try {
    const response = await s.get(path);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "could not read btw history" });
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("history directory symlinks are refused without following outside files", async () => {
  rmSync(dir, { recursive: true });
  mkdirSync(`${s.home}/outside-history`);
  writeFileSync(`${s.home}/outside-history/entry-secret.json`, JSON.stringify(record("secret")));
  symlinkSync(`${s.home}/outside-history`, dir);
  const response = await s.get(path);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "could not read btw history" });
});

test("history draft clears cannot erase a replacement session's prompt", async () => {
  const local = new Sandbox();
  try {
    await local.start();
    const extension = new Extension(local);
    extension.snapshot.text = "/btw ";
    await extension.connect();
    await until(async () => item(await local.state(), 1).agent, "original session");
    expect((await local.action(1, "draft", { text: "", expectedSessionId: local.session, expectedText: "/btw " })).status).toBe(200);
    expect(await extension.take("set")).toMatchObject({ text: "" });
    extension.report({ sessionId: "replacement-session", text: "Keep this new prompt" });
    await until(async () => obj(item(await local.state(), 1).agent).sessionId === "replacement-session", "replacement session");
    const stale = await local.action(1, "draft", { text: "", expectedSessionId: local.session });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "session changed" });
    expect(extension.snapshot.text).toBe("Keep this new prompt");
    expect(extension.inbox.some((message) => message.t === "set")).toBe(false);
    expect((await local.action(1, "draft", { text: "", expectedSessionId: 42 })).status).toBe(400);
    const changedDraft = await local.action(1, "draft", { text: "", expectedSessionId: "replacement-session", expectedText: "/btw" });
    expect(changedDraft.status).toBe(409);
    expect(await changedDraft.json()).toEqual({ error: "draft changed" });
    expect(extension.snapshot.text).toBe("Keep this new prompt");
    expect(extension.inbox.some((message) => message.t === "set")).toBe(false);
    expect((await local.action(1, "draft", { text: "", expectedSessionId: "replacement-session", expectedText: 42 })).status).toBe(400);
    expect((await local.action(1, "draft", { text: "Ordinary draft" })).status).toBe(200);
    expect(await extension.take("set")).toMatchObject({ text: "Ordinary draft" });
    expect(local.calls()).toEqual([]);
  } finally {
    await local.close();
  }
});
