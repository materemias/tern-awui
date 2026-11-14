import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateWaitingCli, waitingViewFile, WaitingWatch, type WaitingOptions } from "./waiting";

const dirs: string[] = [];
const watches: WaitingWatch[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "tern-awui-waiting-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const w of watches.splice(0)) w.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Polls: a file event has no promise to await, and the watcher batches them on a real timer. */
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

/** A checkout whose Tern plugin is linked from `dir`, and the script's path. */
function linked(dir: string): string {
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "contents", "scripts"), { recursive: true });
  mkdirSync(join(dir, ".config", "tern", "plugins"), { recursive: true });
  const cli = join(checkout, "contents", "scripts", "codexbar_waiting.py");
  writeFileSync(cli, "");
  writeFileSync(join(dir, ".config", "tern", "plugins", "codexbar-agentview.path"), `${join(checkout, "tern")}\n`);
  return cli;
}

describe("locateWaitingCli", () => {
  test("CODEXBAR_WAITING names the script", () => {
    const dir = home();
    const cli = join(dir, "cli.py");
    writeFileSync(cli, "");
    expect(locateWaitingCli({ CODEXBAR_WAITING: cli }, dir)).toBe(cli);
    expect(locateWaitingCli({ CODEXBAR_WAITING: join(dir, "gone.py") }, dir)).toBeNull();
  });

  test("else the script beside the linked Tern plugin", () => {
    const dir = home();
    expect(locateWaitingCli({}, dir)).toBeNull();
    const cli = linked(dir);
    expect(locateWaitingCli({}, dir)).toBe(cli);
    rmSync(cli);
    expect(locateWaitingCli({}, dir)).toBeNull();
  });

  test("a set CODEXBAR_WAITING that is gone doesn't fall through to the plugin", () => {
    const dir = home();
    linked(dir);
    expect(locateWaitingCli({ CODEXBAR_WAITING: join(dir, "gone.py") }, dir)).toBeNull();
  });

  test("a relative path in the link file counts as none", () => {
    const dir = home();
    linked(dir);
    writeFileSync(join(dir, ".config", "tern", "plugins", "codexbar-agentview.path"), "checkout/tern\n");
    expect(locateWaitingCli({}, dir)).toBeNull();
  });
});

test("waitingViewFile follows the CLI's state folder", () => {
  expect(waitingViewFile({}, "/h")).toBe("/h/.local/state/codexbar-agentview/waiting_view.json");
  expect(waitingViewFile({ XDG_STATE_HOME: "/s" }, "/h")).toBe("/s/codexbar-agentview/waiting_view.json");
  expect(waitingViewFile({ XDG_STATE_HOME: "relative" }, "/h")).toBe("/h/.local/state/codexbar-agentview/waiting_view.json");
});

const session = (id: string, ball = "on_machine") => ({ session_id: id, title: id, ball, line: "", waits: [{ id: "w1", ball, summary: `about ${id}` }] });
const listing = (...sessions: unknown[]) => JSON.stringify({ ok: true, now: String(Math.random()), counts: { on_me: 0 }, sessions, panes: [] });

/** Lets a `list` that already answered land. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * A watch over a scratch home, answering `list` with `out`; `calls` records every argv, and `gate`
 * holds the next `list` with the output it read when it started. `folder`: the CLI's state folder exists.
 */
function setup(first: string | null = listing(), folder = true) {
  const dir = home();
  const cli = linked(dir);
  const file = join(dir, "state", "codexbar-agentview", "waiting_view.json");
  if (folder) rewrite(file);
  const t = {
    file,
    cli,
    out: first,
    calls: [] as string[][],
    changes: 0,
    fresh: [] as string[],
    answer: null as string | null,
    gate: null as Promise<void> | null,
    lists() {
      return t.calls.filter((c) => c[0] === "list").length;
    },
  };
  const watch = new WaitingWatch({
    env: { XDG_STATE_HOME: join(dir, "state") },
    home: dir,
    run: async (argv) => {
      t.calls.push(argv.slice(1));
      if (argv[1] !== "list") return t.answer;
      const out = t.out;
      const gate = t.gate;
      t.gate = null;
      await gate;
      return out;
    },
    changed: () => t.changes++,
    onMe: (fresh) => t.fresh.push(...fresh.map((f) => f.text)),
  });
  watches.push(watch);
  return { t, watch };
}

function rewrite(file: string, content = "{}") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
}

describe("WaitingWatch", () => {
  test("off without the CLI, and on once a check finds it", async () => {
    const dir = home();
    const watch = new WaitingWatch({ env: {}, home: dir, run: async () => listing(), changed: () => {}, onMe: () => {} });
    watches.push(watch);
    expect(await watch.view()).toEqual({ available: false });
    linked(dir);
    await watch.check();
    expect((await watch.view()).available).toBe(true);
  });

  test("lists once, then reads a replaced file without starting Python", async () => {
    const { t, watch } = setup();
    await watch.view();
    expect(t.calls).toEqual([["list"]]);
    rewrite(t.file, listing(session("a")));
    await until(() => watch.key.includes("about a"));
    expect(t.calls).toEqual([["list"]]);
  });

  test("a replaced file that isn't a view falls back to list", async () => {
    const { t, watch } = setup();
    await watch.view();
    t.out = listing(session("a"));
    rewrite(t.file, "half a view");
    await until(() => watch.key.includes("about a"));
    expect(t.lists()).toBe(2);
  });

  test("a check with an unchanged file reads nothing", async () => {
    const { t, watch } = setup();
    await watch.view();
    await watch.check();
    expect(t.lists()).toBe(1);
  });

  test("a view that only moved its clock is no change", async () => {
    const { t, watch } = setup();
    await watch.view();
    const key = watch.key;
    const changes = t.changes;
    t.out = listing();
    rewrite(t.file);
    await watch.check();
    expect(t.lists()).toBeGreaterThan(1);
    expect(watch.key).toBe(key);
    expect(t.changes).toBe(changes);
  });

  test("a state folder that came later is picked up by a check", async () => {
    const { t, watch } = setup(listing(), false);
    await watch.view();
    t.out = listing(session("late"));
    rewrite(t.file);
    await watch.check();
    expect(watch.key).toContain("about late");
    t.out = listing(session("later"));
    rewrite(t.file);
    await until(() => watch.key.includes("about later"));
  });

  test("a failed list keeps the last good view, says so, and the next check retries", async () => {
    const { t, watch } = setup(listing(session("a")));
    await watch.view();
    t.out = "not json";
    rewrite(t.file);
    await watch.check();
    expect(await watch.view()).toMatchObject({ available: true, error: "codexbar_waiting.py list gave no answer", rows: [{ session: "a" }] });
    t.out = listing(session("a"));
    await watch.check();
    expect(watch.key).not.toContain("error");
  });

  test("a failed list is retried only while someone is looking", async () => {
    const { t, watch } = setup(null);
    await watch.view();
    await watch.check(false);
    expect(t.lists()).toBe(1);
    await watch.check(true);
    expect(t.lists()).toBe(2);
  });

  test("a first list that fails still counts as available, with nothing to show", async () => {
    const { watch } = setup(null);
    expect(await watch.view()).toMatchObject({ available: true, rows: [], onMe: 0, error: "codexbar_waiting.py list gave no answer" });
  });

  test("what newly waits on the user is announced once", async () => {
    const { t, watch } = setup();
    await watch.view();
    t.out = listing(session("a", "on_me"));
    rewrite(t.file);
    await watch.check();
    expect(t.fresh).toEqual(["about a"]);
    rewrite(t.file, "{ }");
    await watch.check();
    expect(t.lists()).toBeGreaterThan(2);
    expect(t.fresh).toEqual(["about a"]);
  });

  test("a read in flight when the CLI goes away can't turn the feature back on", async () => {
    const { t, watch } = setup(listing(session("a")));
    await watch.view();
    const gate = Promise.withResolvers<void>();
    t.gate = gate.promise;
    rewrite(t.file, "not a view");
    const reading = watch.check();
    await until(() => t.gate === null);
    rmSync(t.cli);
    await watch.check();
    expect(watch.held).toEqual({ available: false });
    gate.resolve();
    await reading;
    expect(watch.held).toEqual({ available: false });
  });

  test("what already waits when the watch starts is no news", async () => {
    const { t, watch } = setup(listing(session("a", "on_me")));
    await watch.view();
    expect(watch.key).toContain("about a");
    expect(t.fresh).toEqual([]);
  });

  describe("actions", () => {
    async function ready() {
      const s = setup(listing(session("a")));
      await s.watch.view();
      return s;
    }

    test("runs the checked argv and takes the view from its answer without listing again", async () => {
      const { t, watch } = await ready();
      t.answer = JSON.stringify({ ok: true, view: JSON.parse(listing()) });
      const lists = t.calls.length;
      expect(await watch.act("stop", { session: "a", wait: "w1" })).toEqual({ status: 200, body: { ok: true } });
      expect(t.calls.at(-1)).toEqual(["stop", "--session", "a", "--wait", "w1"]);
      expect(t.calls.length).toBe(lists + 1);
      expect(await watch.view()).toMatchObject({ rows: [] });
    });

    test("an id off the view never reaches the CLI", async () => {
      const { t, watch } = await ready();
      const lists = t.calls.length;
      expect((await watch.act("stop", { session: "--help", all: true })).status).toBe(404);
      expect(t.calls.length).toBe(lists);
    });

    test("the CLI's refusal comes back as it said it", async () => {
      const { t, watch } = await ready();
      t.answer = JSON.stringify({ ok: false, error: "that wait has no due time" });
      expect(await watch.act("snooze", { session: "a", wait: "w1" })).toEqual({ status: 502, body: { error: "that wait has no due time" } });
      t.answer = null;
      expect(await watch.act("stop", { session: "a", wait: "w1" })).toEqual({ status: 502, body: { error: "codexbar_waiting.py gave no answer" } });
    });

    test("an answer without a view lists again", async () => {
      const { t, watch } = await ready();
      t.answer = JSON.stringify({ ok: true });
      const lists = t.calls.length;
      await watch.act("seen", { session: "a" });
      await until(() => t.calls.length > lists + 1);
      expect(t.calls.at(-1)).toEqual(["list"]);
    });

    test("a list started before an action can't overwrite its answer", async () => {
      const { t, watch } = await ready();
      const gate = Promise.withResolvers<void>();
      t.gate = gate.promise;
      rewrite(t.file);
      void watch.check();
      await until(() => t.gate === null);
      t.answer = JSON.stringify({ ok: true, view: JSON.parse(listing()) });
      expect((await watch.act("stop", { session: "a", wait: "w1" })).status).toBe(200);
      t.out = listing();
      gate.resolve();
      await until(() => t.lists() === 3);
      await flush();
      expect(watch.key).not.toContain("about a");
    });

    test("without the CLI an action is refused", async () => {
      const dir = home();
      const watch = new WaitingWatch({ env: {}, home: dir, run: async () => null, changed: () => {}, onMe: () => {} });
      watches.push(watch);
      expect(await watch.act("stop", { session: "a", wait: "w1" })).toEqual({ status: 409, body: { error: "CodexBar AgentView isn't installed" } });
    });
  });
});
