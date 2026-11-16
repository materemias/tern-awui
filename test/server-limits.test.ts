import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { Events, Extension, Sandbox, until } from "./server-harness";
import { T0 } from "./fixtures";
import { obj } from "../lib/json";
import { CONTINUE_TEXT } from "../lib/usage-limit";

// The server's own timers run on the real clock: it is a live Bun.serve with a bridge socket, which
// fake timers would stall. Retry-after times stay short, and a dropped continue is checked by its
// saved file emptying (dropping it also clears its timer), not by waiting out its time.
const s = new Sandbox();
// The continue goes right at the reset here, not a minute after it.
s.continueAfterMs = 0;
let extension = new Extension(s);

/** The session's turn stops now on Codex's limit, lifting `retryMs` later; the errored entry's id. */
function stopOnLimit(retryMs: number): string {
  const at = Date.now() - T0;
  s.transcript.user("Keep going", at);
  const error = `Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded) retry-after-ms=${retryMs}`;
  const id = s.transcript.assistant([], at + 1, { stop: "error", error, provider: "openai-codex" });
  writeFileSync(s.transcriptPath, s.transcript.text());
  return id;
}

/** The continues the server sent the pane's omp so far: messages of its own, past the editor. */
const continues = () => extension.inbox.filter((m) => m.t === "send" && m.text === CONTINUE_TEXT && m.keepDraft === true).length;
/** Anything typed into omp's editor or pane: a continue must do neither. */
const typed = () => extension.inbox.filter((m) => m.t === "set").length + s.calls().filter((c) => c[0] === "send").length;
const saved = () => JSON.parse(readFileSync(`${s.home}/.config/tern-mobile/continues.json`, "utf8")) as unknown[];

beforeAll(async () => {
  s.transcript.result("ask1", "ask", 4500);
  s.leaf = stopOnLimit(60_000);
  await s.start();
  Object.assign(extension.snapshot, { status: "idle", protocol: 6 });
  await extension.connect();
}, 6000);
afterAll(() => s.close());

test("a continue set for the reset is sent once, then, and every phone sees it set", async () => {
  const leaf = stopOnLimit(900);
  extension.report({ leaf });
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  const limit = obj(await events.take("limit", (d) => obj(d).kind === "wait"));
  expect(limit.continueAt).toBeNull();
  extension.inbox = [];
  s.clearCalls();
  const r = obj(await (await s.action(1, "continue", { when: "reset" })).json());
  expect(r.at).toBe(limit.resetAt);
  expect(saved()).toEqual([{ block: "1", id: expect.any(String), sessionId: s.session, entry: leaf, at: r.at }]);
  expect(continues()).toBe(0);
  await until(() => continues() === 1, "the continue", 3000);
  // Dropped once it went: no second send can follow.
  await until(() => saved().length === 0, "the continue dropped");
  expect(continues()).toBe(1);
  expect(typed()).toBe(0);
  events.close();
});

test("an older extension can't take a continue: none is set or sent", async () => {
  extension.inbox = [];
  extension.report({ leaf: stopOnLimit(600), protocol: 5 });
  try {
    await until(async () => (await s.action(1, "continue", { when: "now" })).status === 409, "refused");
    expect((await s.action(1, "continue", { when: "reset" })).status).toBe(409);
    expect(saved()).toEqual([]);
    expect(continues()).toBe(0);
  } finally {
    extension.report({ protocol: 6 });
  }
});

test("a prompt sent to the session drops its continue", async () => {
  extension.inbox = [];
  extension.report({ leaf: stopOnLimit(600) });
  await until(async () => (await s.action(1, "continue", { when: "reset" })).ok, "the continue set");
  expect((await s.action(1, "submit", { text: "do something else" })).ok).toBe(true);
  expect(saved()).toEqual([]);
  expect(continues()).toBe(0);
});

test("a continue is dropped once the session moved on without one: a turn run on the desktop", async () => {
  extension.inbox = [];
  extension.report({ leaf: stopOnLimit(600) });
  await until(async () => (await s.action(1, "continue", { when: "reset" })).ok, "the continue set");
  s.transcript.user("Something else", Date.now() - T0);
  const leaf = s.transcript.say("Done", Date.now() - T0 + 1);
  writeFileSync(s.transcriptPath, s.transcript.text());
  extension.report({ leaf });
  await until(() => saved().length === 0, "the continue dropped");
  expect(continues()).toBe(0);
  // Nothing to continue: no limit, so no time to set one for.
  expect((await s.action(1, "continue", { when: "reset" })).status).toBe(409);
});

test("a continue outlives a server restart, and goes once the session's omp reconnects", async () => {
  extension.report({ leaf: stopOnLimit(1200) });
  await until(async () => (await s.action(1, "continue", { when: "reset" })).ok, "the continue set");
  await s.stop();
  await s.start();
  extension = new Extension(s);
  Object.assign(extension.snapshot, { status: "idle", leaf: s.transcript.last, protocol: 6 });
  await extension.connect();
  await until(() => continues() === 1, "the continue after the restart", 3000);
});

test("cancel drops the continue; without a reset time only Continue now is offered", async () => {
  extension.inbox = [];
  s.clearCalls();
  extension.report({ leaf: stopOnLimit(800) });
  const lifts = Date.now() + 800;
  await until(async () => (await s.action(1, "continue", { when: "reset" })).ok, "the continue set");
  expect((await s.action(1, "continue", { cancel: true })).ok).toBe(true);
  expect(saved()).toEqual([]);
  // Past the limit's time, omp's usage report (the fake omp has none) tells no other.
  await until(() => Date.now() > lifts, "the reset passed", 3000);
  expect(continues()).toBe(0);
  expect(obj(await (await s.action(1, "continue", { when: "reset" })).json())).toEqual({ error: "the reset time isn't known: continue now instead" });
  expect((await s.action(1, "continue", { when: "now", id: "now-1" })).ok).toBe(true);
  expect(continues()).toBe(1);
  // A resend after a lost reply sends nothing again, though the limit is gone by then.
  expect((await s.action(1, "continue", { when: "now", id: "now-1" })).ok).toBe(true);
  expect(continues()).toBe(1);
  expect(typed()).toBe(0);
});
