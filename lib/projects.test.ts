import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  test("open block cwds first, then session cwds newest first; each once, existing folders only", async () => {
    const [alpha, beta, gamma, open] = ["alpha", "beta", "gamma", "open"].map(dir);
    session("-alpha", "a1", alpha, 1000);
    session("-alpha", "a2", alpha, 3000);
    session("-beta", "b1", beta, 2000);
    session("-gamma", "g1", gamma, 4000);
    session("-gone", "x1", join(root, "deleted"), 5000);
    session("-open", "o1", open, 500);
    expect(await recentProjects(sessions, [open, beta, join(root, "missing")])).toEqual([open, beta, gamma, alpha]);
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
    expect(await recentProjects(join(root, "nothing"), [only, only])).toEqual([only]);
  });
});
