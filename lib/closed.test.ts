import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "../test/fixtures";
import { closedSessions, IdList, type HistoryReader } from "./closed";
import type { OtherSession } from "./other-agents";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tern-awui-closed-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sessions = join(root, "sessions");
const work = join(root, "work");
mkdirSync(work);
/** A transcript for a session in `cwd`, last written at `at` (seconds). */
function session(id: string, cwd: string, at: number) {
  mkdirSync(join(sessions, "-f"), { recursive: true });
  const file = join(sessions, "-f", `2026-10-01_${id}.jsonl`);
  writeFileSync(file, new Transcript(id, cwd).text());
  utimesSync(file, at, at);
}

describe("closedSessions", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT UNIQUE, created_at INTEGER, cwd TEXT, session_id TEXT)");
  db.run("CREATE TABLE session_recaps (id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT, recap TEXT, created_at INTEGER)");
  // No session_titles: an older omp. Rows go untitled, the rest still lists.
  const prompt = (text: string, at: number, id: string) => db.run("INSERT INTO history (prompt, created_at, session_id) VALUES (?, ?, ?)", [text, at, id]);
  // Newest prompts first, but their folders are gone, relative or never written down.
  for (let i = 0; i < 5; i++) {
    session(`gone-${i}`, join(root, "deleted"), 900 + i);
    prompt(`gone ${i}`, 900 + i, `gone-${i}`);
  }
  session("relative", "work", 950);
  prompt("relative", 950, "relative");
  // An old prompt, but its transcript was written to since: it ranks by that.
  session("worked-on", work, 800);
  prompt("worked on", 10, "worked-on");
  session("quiet", work, 50);
  prompt("quiet", 50, "quiet");
  const history: HistoryReader = (read, fallback) => {
    try {
      return read(db);
    } catch {
      return fallback;
    }
  };

  test("ranks by last activity and fills the limit past sessions Tern can't reopen", async () => {
    const list = await closedSessions({ history, sessionsDir: sessions, seen: [], skip: new Set(), limit: 1 });
    expect(list).toEqual([{ agent: "omp", id: "worked-on", icon: null, tag: null, title: "", cwd: work, prompt: "worked on", recap: "", at: 800_000 }]);
    const two = await closedSessions({ history, sessionsDir: sessions, seen: [], skip: new Set(), limit: 5 });
    expect(two.map((c) => c.id)).toEqual(["worked-on", "quiet"]);
  });

  test("a search matches a session's transcript folder even when its only history is a recap, and tool names combine", async () => {
    // Known from the bridge only: its prompts moved to later sessions, a recap stayed.
    const atlas = join(root, "atlas");
    mkdirSync(atlas);
    session("bridged", atlas, 700);
    db.run("INSERT INTO session_recaps (session_id, recap, created_at) VALUES ('bridged', 'Mapped the tiles.', 700)");
    const others = async (): Promise<OtherSession[]> => [
      { agent: "claude", id: "c", title: "Claude atlas work", prompts: ["go"], cwd: work, at: 600_000 },
      { agent: "codex", id: "x", title: "Codex atlas work", prompts: ["go"], cwd: work, at: 500_000 },
    ];
    const search = async (query: string) =>
      (await closedSessions({ history, sessionsDir: sessions, seen: ["bridged"], skip: new Set(), limit: 10, query, others })).map((c) => `${c.agent}:${c.id}`);
    expect(await search("atlas")).toEqual(["omp:bridged", "claude:c", "codex:x"]);
    expect(await search("claude codex atlas")).toEqual(["claude:c", "codex:x"]);
    expect(await search("omp atlas")).toEqual(["omp:bridged"]);
  });
});

describe("IdList", () => {
  test("keeps the newest, moves an id still in use up instead of letting it age out, and survives a restart", () => {
    const file = join(root, "ids.json");
    const list = new IdList(file, 4);
    for (const id of ["a", "b", "c", "d"]) list.add(id);
    list.add("a"); // in the older half: moves up
    list.add("e");
    expect(list.all()).toEqual(["c", "d", "a", "e"]);
    list.delete("d");
    expect(new IdList(file, 4).all()).toEqual(["c", "a", "e"]);
  });

  test("a failed write keeps the list in memory instead of throwing", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = join(root, "missing", "ids.json");
      const list = new IdList(file, 10);
      list.add("x");
      expect(list.has("x")).toBe(true);
      expect(() => readFileSync(file)).toThrow();
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});
