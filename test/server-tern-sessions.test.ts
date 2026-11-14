import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { arr, obj } from "../lib/json";
import { Events, Sandbox, item } from "./server-harness";

// Two Tern sessions: Default (shown) holds panes 1 and 2, pi-durable pane 5; pane 6 is parked.
const s = new Sandbox();
const away = { id: 6, cwd: `${s.home}/alpha`, program: "/bin/htop", title: "Away" };
s.tree = {
  sessions: [
    { id: 4, name: "Default", shown: true, tabs: [{ blocks: [
      { id: 1, cwd: `${s.home}/alpha`, program: "omp", title: "Build phone UI" },
      { id: 2, cwd: `${s.home}/beta`, program: "/bin/zsh", title: "Terminal" },
    ] }] },
    { id: 77, name: "pi-durable", shown: false, tabs: [{ blocks: [{ id: 5, cwd: `${s.home}/beta`, program: "/bin/zsh", title: "Durable" }] }] },
  ],
  detached: [away],
};
s.saveTree();
beforeAll(() => s.start(), 6000);
afterAll(() => s.close());

test("state lists Tern's sessions in order and the session each row's tab is in; parked rows are in none", async () => {
  const state = await s.state();
  expect(state.ternSessions).toEqual([{ id: "4", name: "Default", shown: true }, { id: "77", name: "pi-durable", shown: false }]);
  expect([1, 2, 5, 6].map((b) => item(state, b).ternSession)).toEqual(["Default", "Default", "pi-durable", null]);
});

test("a renamed session reaches an open stream", async () => {
  const events = new Events();
  await events.open(s);
  await events.take("state");
  obj(arr(s.tree.sessions)[1]).name = "durable";
  s.saveTree();
  s.signal();
  const renamed = obj(await events.take("state", (d) => item(d, 5).ternSession === "durable"));
  expect(arr(renamed.ternSessions).map((t) => obj(t).name)).toEqual(["Default", "durable"]);
  events.close();
  obj(arr(s.tree.sessions)[1]).name = "pi-durable";
  s.saveTree();
  s.signal();
});

test("new and resumed omps open in the named session; an unknown one is refused before Tern runs anything", async () => {
  s.clearCalls();
  expect(await (await s.post("/api/new", { cwd: `${s.home}/alpha`, session: "pi-durable" })).json()).toEqual({ block: "99" });
  expect(await (await s.post("/api/closed/resume", { id: s.session, session: "pi-durable" })).json()).toEqual({ block: "99" });
  // Without `session`, Tern picks the session it shows, as before.
  expect(await (await s.post("/api/new", { cwd: `${s.home}/beta` })).json()).toEqual({ block: "99" });
  expect(s.calls()).toEqual([
    ["new", "tab", "pi-durable", "--cwd", `${s.home}/alpha`, "--json", "--", "omp"],
    ["new", "tab", "pi-durable", "--cwd", `${s.home}/alpha`, "--json", "--", "omp", "--resume", s.transcriptPath],
    ["new", "tab", "--cwd", `${s.home}/beta`, "--json", "--", "omp"],
  ]);
  s.clearCalls();
  for (const [path, body] of [
    ["/api/new", { cwd: `${s.home}/alpha`, session: "gone" }],
    ["/api/new", { cwd: `${s.home}/alpha`, session: 4 }],
    ["/api/closed/resume", { id: s.session, session: "gone" }],
  ] as const) {
    const r = await s.post(path, body);
    expect(r.status).toBe(400);
    expect(String(obj(await r.json()).error)).toContain("Tern has no session named");
  }
  expect(s.calls()).toEqual([]);
});

test("an unpark naming a session asks the plugin for a tab there; an older plugin or unknown session is refused", async () => {
  const unparked = { ...s.tree, sessions: arr(s.tree.sessions).map((t) => obj(t).id === 77 ? { ...obj(t), tabs: [...arr(obj(t).tabs), { blocks: [away] }] } : t), detached: [] };
  const original = JSON.stringify(s.tree);
  try {
    s.clearCalls();
    expect((await s.action(6, "unpark", { session: "gone" })).status).toBe(400);
    writeFileSync(`${s.home}/plugins.json`, JSON.stringify({ plugins: [{ id: "tern-awui", status: "ready", version: "0.1.0" }] }));
    const old = await s.action(6, "unpark", { session: "pi-durable" });
    expect(String(obj(await old.json()).error)).toContain("tern plugin reload tern-awui");
    expect(s.calls()).toEqual([]);

    writeFileSync(`${s.home}/plugins.json`, JSON.stringify({ plugins: [{ id: "tern-awui", status: "ready", version: "0.2.0" }] }));
    writeFileSync(`${s.home}/open-tree.json`, JSON.stringify(unparked));
    expect(await (await s.action(6, "unpark", { session: "pi-durable" })).json()).toEqual({ ok: true });
    expect(readFileSync(`${s.home}/requests`, "utf8")).toBe("unpark 6 77\n");
    expect(item(await s.state(), 6)).toMatchObject({ parked: false, ternSession: "pi-durable" });
  } finally {
    rmSync(`${s.home}/plugins.json`, { force: true });
    rmSync(`${s.home}/open-tree.json`, { force: true });
    rmSync(`${s.home}/requests`, { force: true });
    s.tree = JSON.parse(original);
    s.saveTree();
    s.signal();
  }
});

test("a pane in no tab and in no deck of the window is stranded: listed apart, and unpark refuses it", async () => {
  const left = { id: 9, cwd: `${s.home}/beta`, program: "/bin/zsh", title: "Left behind" };
  s.tree = { ...s.tree, detached: [away, left] };
  s.saveTree();
  writeFileSync(`${s.home}/plugins.json`, JSON.stringify({ plugins: [{ id: "tern-awui", status: "ready", version: "0.3.0" }] }));
  writeFileSync(`${s.home}/decks`, "6\n");
  try {
    s.signal();
    let state = await s.state();
    for (let tries = 0; tries < 20 && !item(state, 9)?.stranded; tries++) {
      await Bun.sleep(100);
      state = await s.state();
    }
    expect([6, 9].map((b) => [item(state, b).parked, item(state, b).stranded])).toEqual([[true, false], [true, true]]);
    const refused = await s.action(9, "unpark");
    expect(refused.status).toBe(409);
    expect(String(obj(await refused.json()).error)).toContain("can't bring it back");
    // An older plugin can't tell: every pane in no tab counts as parked, as before. The answer is
    // kept while the parked panes stay the same, so another one parks too.
    writeFileSync(`${s.home}/plugins.json`, JSON.stringify({ plugins: [{ id: "tern-awui", status: "ready", version: "0.2.0" }] }));
    s.tree = { ...s.tree, detached: [away, left, { id: 10, cwd: `${s.home}/beta`, program: "/bin/zsh", title: "Also away" }] };
    s.saveTree();
    s.signal();
    for (let tries = 0; tries < 20 && item(state, 9).stranded; tries++) {
      await Bun.sleep(100);
      state = await s.state();
    }
    expect(item(state, 9).stranded).toBe(false);
  } finally {
    rmSync(`${s.home}/plugins.json`, { force: true });
    rmSync(`${s.home}/decks`, { force: true });
    s.tree = { ...s.tree, detached: [away] };
    s.saveTree();
    s.signal();
  }
});
