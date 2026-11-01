import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { arr, obj } from "../lib/json";
import { Transcript } from "./fixtures";
import { Extension, Sandbox, item, until } from "./server-harness";

const s = new Sandbox();
const sessions = `${s.home}/.omp/agent/sessions/project`;
/** Writes a transcript for `id` in `cwd`, last written at `mtime` (s). */
function transcript(id: string, cwd: string, mtime: number): string {
  const path = `${sessions}/2026-01-01T00-00-00-000Z_${id}.jsonl`;
  writeFileSync(path, new Transcript(id, cwd).text());
  utimesSync(path, mtime, mtime);
  return path;
}
const closedA = transcript("closed-a", `${s.home}/alpha`, 3000);
const closedB = transcript("closed-b", `${s.home}/beta`, 2000);
// Its only prompt was typed again in closed-b: prompt history (prompts are unique) names closed-b alone.
transcript("retaken", `${s.home}/beta`, 2500);
transcript("gone-dir", `${s.home}/deleted`, 4000);
const db = new Database(`${s.home}/.omp/agent/history.db`);
db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT UNIQUE, created_at INTEGER, cwd TEXT, session_id TEXT)");
db.run("CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER)");
for (const [prompt, at, id] of [
  ["first", 50, "closed-a"],
  ["ask claude about it", 55, "closed-a"],
  ["second  prompt", 60, "closed-a"],
  ["other", 70, "closed-b"],
  ["live one", 80, s.session],
  ["no transcript", 90, "no-file"],
  ["folder gone", 95, "gone-dir"],
  ["from print mode", 99, null],
] as const)
  db.run("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, ?, '/x', ?)", [prompt, at, id]);
db.run("INSERT INTO session_titles VALUES ('closed-a', ?, 1)", ["\u{f011c} FIX: Fix the build"]);
db.run("INSERT INTO session_recaps VALUES (2, 'closed-a', 'Build is green.', 61)");
db.close();

// Claude Code: one typed session with a transcript and title, one whose transcript is gone.
const CLAUDE_ID = "5f0c2b1e-0000-4000-8000-00000000c1a0";
mkdirSync(`${s.home}/.claude/projects/-alpha`, { recursive: true });
writeFileSync(
  `${s.home}/.claude/history.jsonl`,
  [
    { display: "explain the parser", project: `${s.home}/alpha`, sessionId: CLAUDE_ID, timestamp: 1_000_000 },
    { display: "now add tests", project: `${s.home}/alpha`, sessionId: CLAUDE_ID, timestamp: 1_500_000 },
    { display: "lost one", project: `${s.home}/alpha`, sessionId: "no-claude-file", timestamp: 1_600_000 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n",
);
const claudeFile = `${s.home}/.claude/projects/-alpha/${CLAUDE_ID}.jsonl`;
writeFileSync(claudeFile, `${JSON.stringify({ type: "user", cwd: `${s.home}/alpha` })}\n${JSON.stringify({ type: "ai-title", aiTitle: "Parser walkthrough", sessionId: CLAUDE_ID })}\n`);
utimesSync(claudeFile, 1000, 1000);
// Codex: a typed session, its cwd early in a first row longer than the head read.
const CODEX_ID = "01a195fc-75c5-7d11-b95d-6e9ab2b85a13";
mkdirSync(`${s.home}/.codex/sessions/2026/01/01`, { recursive: true });
writeFileSync(`${s.home}/.codex/history.jsonl`, `${JSON.stringify({ session_id: CODEX_ID, ts: 1200, text: "port the parser to rust" })}\n`);
writeFileSync(`${s.home}/.codex/session_index.jsonl`, `${JSON.stringify({ id: CODEX_ID, thread_name: "Rust parser port" })}\n`);
const codexFile = `${s.home}/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${CODEX_ID}.jsonl`;
writeFileSync(codexFile, `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: `${s.home}/beta`, base_instructions: "x".repeat(40_000) } })}\n`);
utimesSync(codexFile, 1100, 1100);

beforeAll(async () => {
  await s.start();
  // Pane 1's omp runs the sandbox's session: it is open, not closed.
  await new Extension(s).connect();
  await until(async () => obj(item(await s.state(), 1).agent).sessionId === s.session, "bridged session");
  // Pane 4's omp ran `retaken`, then switched to another session: `retaken` is known only from the bridge.
  const switched = new Extension(s, "4");
  await switched.connect();
  switched.report({ sessionId: "retaken" });
  await until(async () => obj(item(await s.state(), 4).agent).sessionId === "retaken", "retaken bridged");
  switched.report({ sessionId: "elsewhere" });
  await until(async () => obj(item(await s.state(), 4).agent).sessionId === "elsewhere", "switched away");
});
afterAll(() => s.close());

const listed = async () => obj(await (await s.get("/api/closed")).json());

test("lists sessions seen in a pane or prompted that no pane runs, whose transcript and folder exist, newest first", async () => {
  const body = await listed();
  expect(body.home).toBe(s.home);
  expect(body.sessions).toEqual([
    { agent: "omp", id: "closed-a", icon: "\u{f011c}", tag: "FIX", title: "Fix the build", cwd: `${s.home}/alpha`, prompt: "second prompt", recap: "Build is green.", at: 3_000_000 },
    { agent: "omp", id: "retaken", icon: null, tag: null, title: "", cwd: `${s.home}/beta`, prompt: "", recap: "", at: 2_500_000 },
    { agent: "omp", id: "closed-b", icon: null, tag: null, title: "", cwd: `${s.home}/beta`, prompt: "other", recap: "", at: 2_000_000 },
  ]);
});

test("resume opens the transcript in a new tab in its folder, or the pane already running it", async () => {
  s.clearCalls();
  expect(await (await s.post("/api/closed/resume", { id: "closed-a" })).json()).toEqual({ block: "99" });
  expect(await (await s.post("/api/closed/resume", { id: s.session })).json()).toEqual({ block: "1" });
  expect((await s.post("/api/closed/resume", { id: "../etc" })).status).toBe(400);
  expect((await s.post("/api/closed/resume", { id: "no-file" })).status).toBe(404);
  expect((await s.post("/api/closed/resume", { id: "gone-dir" })).status).toBe(409);
  expect(s.calls()).toEqual([["new", "tab", "--cwd", `${s.home}/alpha`, "--json", "--", "omp", "--resume", closedA]]);
});

test("two taps at once start one omp; an omp tab without a bridge is the session's pane, or asks first", async () => {
  s.clearCalls();
  const twice = await Promise.all([1, 2].map(() => s.post("/api/closed/resume", { id: "closed-b" }).then((r) => r.json())));
  expect(twice).toEqual([{ block: "99" }, { block: "99" }]);
  // Tern runs these without a bridge: an omp resumed from a shell command, and a plain omp in alpha.
  const blocks = arr(obj(arr(obj(arr(s.tree.sessions)[0]).tabs)[0]).blocks);
  blocks.push({ id: 7, cwd: `${s.home}/beta`, command: "/bin/zsh -ic 'omp --resume closed-b; exec zsh'", exited: null });
  blocks.push({ id: 8, cwd: `${s.home}/alpha`, command: "omp", exited: null });
  s.saveTree();
  s.signal();
  await until(async () => JSON.stringify(await s.state()).includes('"block":"8"'), "unbridged omps listed");
  expect(await (await s.post("/api/closed/resume", { id: "closed-b" })).json()).toEqual({ block: "7" });
  const asked = await s.post("/api/closed/resume", { id: "closed-a" });
  expect(asked.status).toBe(409);
  expect(obj(await asked.json()).confirm).toBe(true);
  expect(await (await s.post("/api/closed/resume", { id: "closed-a", force: true })).json()).toEqual({ block: "99" });
  expect(s.calls()).toEqual([
    ["new", "tab", "--cwd", `${s.home}/beta`, "--json", "--", "omp", "--resume", closedB],
    ["new", "tab", "--cwd", `${s.home}/alpha`, "--json", "--", "omp", "--resume", closedA],
  ]);
  blocks.splice(-2);
  s.saveTree();
  s.signal();
  await until(async () => !JSON.stringify(await s.state()).includes('"block":"8"'), "unbridged omps gone");
});

const ids = async () => ((await listed()).sessions as { id: string }[]).map((c) => c.id);

test("a dismissed session stays out of the list across restarts", async () => {
  expect(await (await s.post("/api/closed/dismiss", { id: "closed-b" })).json()).toEqual({ ok: true });
  expect(await ids()).toEqual(["closed-a", "retaken"]);
  await s.stop();
  await s.start();
  // Pane 1's bridge is gone with the old server, so its session counts as closed now; `retaken`
  // stays, known from the file the old server kept.
  expect(await ids()).toEqual([s.session, "closed-a", "retaken"]);
});

test("a dismissed session that runs again is back in the list once closed", async () => {
  expect(await (await s.post("/api/closed/dismiss", { id: "retaken" })).json()).toEqual({ ok: true });
  expect(await ids()).not.toContain("retaken");
  const pane = new Extension(s, "4");
  await pane.connect();
  pane.report({ sessionId: "retaken" });
  await until(async () => obj(item(await s.state(), 4).agent).sessionId === "retaken", "retaken runs again");
  pane.report({ sessionId: "elsewhere" });
  await until(async () => obj(item(await s.state(), 4).agent).sessionId === "elsewhere", "switched away");
  expect(await ids()).toContain("retaken");
});

test("a search finds every omp session by any prompt, and Claude Code's and Codex's sessions, which resume in their tool", async () => {
  const search = async (q: string) => obj(await (await s.get(`/api/closed?q=${encodeURIComponent(q)}`)).json()).sessions as Record<string, unknown>[];
  // closed-a's older prompts, not just its last one.
  expect((await search("first")).map((c) => c.id)).toEqual(["closed-a"]);
  expect((await search("about")).map((c) => c.id)).toEqual(["closed-a"]);
  expect(await search("parser")).toEqual([
    { agent: "claude", id: CLAUDE_ID, icon: null, tag: null, title: "Parser walkthrough", cwd: `${s.home}/alpha`, prompt: "now add tests", recap: "", at: 1_500_000 },
    { agent: "codex", id: CODEX_ID, icon: null, tag: null, title: "Rust parser port", cwd: `${s.home}/beta`, prompt: "port the parser to rust", recap: "", at: 1_200_000 },
  ]);
  // A tool's name keeps its sessions only (not omp's that mention it); one whose transcript is gone isn't offered.
  expect((await search("claude")).map((c) => c.id)).toEqual([CLAUDE_ID]);
  expect(await search("claude about")).toEqual([]);
  expect((await search("codex rust")).map((c) => c.id)).toEqual([CODEX_ID]);
  s.clearCalls();
  expect(await (await s.post("/api/closed/resume", { id: CLAUDE_ID, agent: "claude" })).json()).toEqual({ block: "99" });
  expect(await (await s.post("/api/closed/resume", { id: CODEX_ID, agent: "codex" })).json()).toEqual({ block: "99" });
  expect((await s.post("/api/closed/resume", { id: "no-claude-file", agent: "claude" })).status).toBe(404);
  expect((await s.post("/api/closed/resume", { id: CLAUDE_ID, agent: "gemini" })).status).toBe(400);
  expect(s.calls()).toEqual([
    ["new", "tab", "--cwd", `${s.home}/alpha`, "--json", "--", "claude", "--resume", CLAUDE_ID],
    ["new", "tab", "--cwd", `${s.home}/beta`, "--json", "--", "codex", "resume", CODEX_ID],
  ]);
});

test("a Windows tab running the tool (an .exe or .cmd, a quoted path) is the session's pane, or asks first", async () => {
  const blocks = arr(obj(arr(obj(arr(s.tree.sessions)[0]).tabs)[0]).blocks);
  blocks.push({ id: 11, cwd: `${s.home}/alpha`, command: `C:\\Tools\\claude.exe --resume ${CLAUDE_ID}`, exited: null });
  blocks.push({ id: 12, cwd: `${s.home}/beta`, command: `"C:\\Program Files\\nodejs\\codex.cmd"`, exited: null });
  s.saveTree();
  s.signal();
  await until(async () => JSON.stringify(await s.state()).includes('"block":"12"'), "Windows tabs listed");
  s.clearCalls();
  try {
    expect(await (await s.post("/api/closed/resume", { id: CLAUDE_ID, agent: "claude" })).json()).toEqual({ block: "11" });
    const asked = await s.post("/api/closed/resume", { id: CODEX_ID, agent: "codex" });
    expect(asked.status).toBe(409);
    expect(obj(await asked.json()).confirm).toBe(true);
    expect(s.calls()).toEqual([]);
  } finally {
    blocks.splice(-2);
    s.saveTree();
    s.signal();
    await until(async () => !JSON.stringify(await s.state()).includes('"block":"12"'), "Windows tabs gone");
  }
});

test("resume launches nothing, even forced, while Tern's tab list can't be read", async () => {
  // A fresh server, so no cached listing hides the broken one.
  await s.stop();
  writeFileSync(`${s.home}/tree.json`, "{not json");
  await s.start();
  try {
    s.clearCalls();
    for (const body of [{ id: "closed-a" }, { id: "closed-a", force: true }]) {
      const r = await s.post("/api/closed/resume", body);
      expect(r.status).toBe(503);
      expect(String(obj(await r.json()).error)).toContain("can't list Tern's tabs");
    }
    expect(s.calls()).toEqual([]);
  } finally {
    s.saveTree();
  }
});
