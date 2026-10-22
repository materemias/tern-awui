import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "../test/fixtures";
import { recentProjects, transcriptCwd } from "./projects";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tern-awui-projects-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sessions = join(root, "sessions");
const dir = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};
/** A transcript for a session in `cwd`, last written at `at` (seconds). */
function session(folder: string, id: string, cwd: string, at: number): string {
  mkdirSync(join(sessions, folder), { recursive: true });
  const file = join(sessions, folder, `2026-10-01_${id}.jsonl`);
  writeFileSync(file, new Transcript(id, cwd).text());
  utimesSync(file, at, at);
  return file;
}

describe("transcriptCwd", () => {
  test("reads the session header after the title row; none without one", async () => {
    expect(await transcriptCwd(session("x", "head", "/some/where", 1))).toBe("/some/where");
    const bare = join(root, "bare.jsonl");
    writeFileSync(bare, '{"type":"title","title":"t"}\nnot json\n');
    expect(await transcriptCwd(bare)).toBe("");
  });
});

describe("recentProjects", () => {
  test("most recently used first across open blocks and sessions; each folder once, existing folders only", async () => {
    const [alpha, beta, gamma, open, idle] = ["alpha", "beta", "gamma", "open", "idle"].map(dir);
    session("-alpha", "a1", alpha, 1000);
    session("-alpha", "a2", alpha, 3000);
    session("-beta", "b1", beta, 2000);
    session("-gamma", "g1", gamma, 4000);
    session("-gone", "x1", join(root, "deleted"), 5000);
    session("-open", "o1", open, 500);
    // An open block's activity counts as a use; an undated one ranks after every dated use.
    const blocks = [{ cwd: idle, at: 0 }, { cwd: open, at: 3_500_000 }, { cwd: join(root, "missing"), at: 9_000_000 }];
    expect(await recentProjects(sessions, blocks)).toEqual([gamma, open, alpha, beta, idle]);
  });

  test("a trailing separator does not make a second folder", async () => {
    const work = dir("work");
    const trailing = join(root, "trailing-sessions");
    mkdirSync(join(trailing, "w"), { recursive: true });
    writeFileSync(join(trailing, "w", "s.jsonl"), new Transcript("s", `${work}/`).text());
    expect(await recentProjects(trailing, [{ cwd: work, at: 0 }])).toEqual([work]);
  });

  test("folders differing only in case stay apart where the file system tells them apart", async () => {
    const upper = dir("case/App");
    const lower = join(root, "case", "app");
    mkdirSync(lower, { recursive: true });
    const distinct = readdirSync(join(root, "case")).length === 2;
    const found = await recentProjects(join(root, "nothing"), [{ cwd: upper, at: 2 }, { cwd: lower, at: 1 }]);
    expect(found).toEqual(distinct ? [upper, lower] : [upper]);
  });

  test("a transcript discovered before its header is written is retried", async () => {
    const pending = dir("pending-sessions");
    const project = dir("late-project");
    mkdirSync(join(pending, "x"));
    const file = join(pending, "x", "new.jsonl");
    writeFileSync(file, "");
    expect(await recentProjects(pending, [])).toEqual([]);
    writeFileSync(file, new Transcript("new", project).text());
    expect(await recentProjects(pending, [])).toEqual([project]);
  });

  test("no sessions folder: only the open blocks", async () => {
    const only = dir("only");
    expect(await recentProjects(join(root, "nothing"), [{ cwd: only, at: 0 }, { cwd: only, at: 0 }])).toEqual([only]);
  });
});
