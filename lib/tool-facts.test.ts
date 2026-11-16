import { describe, expect, test } from "bun:test";
import { toolFacts } from "./tool-facts";

const bash = (command: string, text: string, details: Record<string, unknown> = {}, error = false) => toolFacts("bash", { command }, text, details, error);
const E = "\x1b";

describe("test runners", () => {
  test("bun test: counts, the first failing test, omp's notes after it", () => {
    const out = [
      "bun test v1.4.4 (38afee6c8)",
      "",
      "a.test.ts:",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 3",
      "Received: 1",
      "",
      "(fail) math > subtracts [0.04ms]",
      "",
      " 1 pass",
      " 1 skip",
      " 1 fail",
      " 2 expect() calls",
      "Ran 3 tests across 1 file. [2.00ms]",
      "",
      "",
      "Command exited with code 1",
    ].join("\n");
    expect(bash("bun test", out, {}, true)).toBe("1 passed · 1 failed: math > subtracts");
  });

  test("bun test in colour marks the failure with ✗", () => {
    const out = [
      `${E}[0m${E}[31m✗${E}[0m ${E}[0mmath${E}[2m >${E}[0m${E}[1m subtracts${E}[0m ${E}[0m${E}[2m[0.03ms${E}[0m${E}[2m]${E}[0m`,
      "",
      `${E}[0m${E}[32m 1 pass${E}[0m`,
      ` ${E}[0m${E}[33m1 skip${E}[0m`,
      `${E}[0m${E}[31m 1 fail${E}[0m`,
      " 2 expect() calls",
      `Ran 3 tests across 1 file. ${E}[0m${E}[2m[${E}[1m1.00ms${E}[0m${E}[2m]${E}[0m`,
    ].join("\n");
    expect(bash("FORCE_COLOR=1 bun test", out)).toBe("1 passed · 1 failed: math > subtracts");
  });

  test("bun test after a typecheck, grepped down to its counts", () => {
    expect(bash('bun run typecheck 2>&1 | tail -1; bun test 2>&1 | grep -E "^\\(fail\\)| pass$| fail$"', "$ tsc -p .\n 1141 pass\n 0 fail\n")).toBe("no type errors · 1141 passed");
  });

  test("bun test cut by tail before its pass line", () => {
    expect(bash("bun test 2>&1 | tail -3", " 0 fail\n 152 expect() calls\nRan 48 tests across 2 files. [11.00ms]\n")).toBe("48 tests · 0 failed");
  });

  test("a lone fail line or a pass line in other output says nothing", () => {
    expect(bash("cat notes.txt", "checklist\n 3 pass\nnext\n 1 fail\n")).toBe("");
  });

  test("vitest", () => {
    const out = [
      " FAIL  src/math.test.ts > math > subtracts",
      "AssertionError: expected 1 to be 3",
      "",
      " Test Files  1 failed | 3 passed (4)",
      "      Tests  1 failed | 25 passed | 2 skipped (28)",
      "   Start at  10:12:01",
      "   Duration  1.32s",
    ].join("\n");
    expect(bash("npx vitest run", out)).toBe("25 passed · 1 failed: math > subtracts");
  });

  test("jest across projects", () => {
    const out = [
      "  ● positions › flags a problematic position",
      "",
      "Test Suites: 1 failed, 1 passed, 2 total",
      "Tests:       1 failed, 9 passed, 10 total",
      "Snapshots:   0 total",
      "Tests:       4 passed, 4 total",
    ].join("\n");
    expect(bash("pnpm exec jest", out)).toBe("13 passed · 1 failed: positions > flags a problematic position");
  });

  test("pytest -q, with subtests and the short summary", () => {
    const out = [
      "FAILED tests/test_waiting.py::ExtensionSessionMoveTests::test_moved_session_keeps_wait - KeyError: 2",
      "1 failed, 214 passed, 1 skipped, 146 subtests passed in 19.61s",
    ].join("\n");
    expect(bash("python -m pytest -q tests 2>&1 | tail -2", out)).toBe("214 passed · 1 failed: ExtensionSessionMoveTests::test_moved_session_keeps_wait");
  });

  test("pytest with rules and errors", () => {
    expect(bash("pytest", "============ 12 passed, 2 errors in 0.31s ============")).toBe("12 passed · 2 errors");
  });

  test("cargo test sums its binaries", () => {
    const out = [
      "test config::schema::tests::round_trips ... FAILED",
      "test result: FAILED. 1182 passed; 1 failed; 3 ignored; 0 measured; 0 filtered out; finished in 1.53s",
      "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    ].join("\n");
    expect(bash("cargo test", out)).toBe("1186 passed · 1 failed: config::schema::tests::round_trips");
  });

  test("cargo test that filtered everything out", () => {
    expect(bash("cargo test soniox", "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 8 filtered out; finished in 0.00s")).toBe("no tests ran");
  });

  test("go test by package", () => {
    const out = [
      "--- FAIL: TestParse (0.00s)",
      "    parse_test.go:12: got 2, want 3",
      "FAIL",
      "FAIL\texample.com/app/parse\t0.004s",
      "ok  \texample.com/app/store\t0.120s",
      "ok  \texample.com/app/web\t(cached)",
      "?   \texample.com/app/cmd\t[no test files]",
    ].join("\n");
    expect(bash("go test ./...", out)).toBe("2 packages ok · 1 failed: TestParse");
  });

  test("counts summed from per-binary or per-package lines are a lower bound in a cut output", () => {
    const cut = "\n[Showing lines 400-402 of 402]";
    expect(bash("cargo test", "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s" + cut)).toBe("4+ passed");
    expect(bash("go test ./...", "FAIL\texample.com/app/parse\t0.004s\nok  \texample.com/app/store\t0.120s" + cut)).toBe("1+ packages ok · 1+ failed");
  });
});

describe("tsc", () => {
  const errors = [
    "$ tsc -p .",
    "b.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "b.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.",
    "c.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    'error: script "typecheck" exited with code 2',
  ].join("\n");

  test("counts errors and files when all of them are in sight", () => {
    expect(bash("bun run typecheck 2>&1 | tail -15", errors, {}, true)).toBe("3 type errors in 2 files");
  });

  test("a tail that cut the start makes the count a lower bound", () => {
    expect(bash("bun run typecheck 2>&1 | tail -3", errors.split("\n").slice(2).join("\n"), {}, true)).toBe("2+ type errors");
  });

  test("omp's own truncation makes the count a lower bound", () => {
    expect(bash("bunx tsc --noEmit", `${errors}\n[Showing lines 1-5 of 912. Use :6 to continue]`, {}, true)).toBe("3+ type errors");
  });

  test("pretty output's summary line", () => {
    const out = `src/a.ts${E}[90m:12:5${E}[0m - ${E}[91merror${E}[0m${E}[90m TS2322: ${E}[0mType 'string'…\n\nFound 3 errors in 2 files.\n\nErrors  Files\n     2  src/a.ts:12\n     1  src/b.ts:4`;
    expect(bash("npx tsc --pretty", out, {}, true)).toBe("3 type errors in 2 files");
    expect(bash("npx tsc --pretty", "Found 1 error in c.ts:1\n", {}, true)).toBe("1 type error in 1 file");
  });

  test("a clean run: the script echo with nothing after it, or a silent lone tsc", () => {
    expect(bash("bun run typecheck", "$ tsc -p .\n")).toBe("no type errors");
    expect(bash("npm run typecheck", "\n> app@1.0.0 typecheck\n> tsc --noEmit\n\n")).toBe("no type errors");
    expect(bash("cd web && bunx tsc --noEmit 2>&1", "(no output, exit code 0)")).toBe("no type errors");
  });

  test("no claim when the output can't prove a clean run", () => {
    expect(bash("bun run typecheck 2>&1 | head -1", "$ tsc -p .\n")).toBe("");
    expect(bash("bunx tsc --noEmit > /tmp/tsc.log", "")).toBe("");
    expect(bash("bun run typecheck", '$ tsc -p .\nerror: script "typecheck" exited with code 1\n', {}, true)).toBe("");
    // tsc missing: npm's echo, then the shell's error.
    expect(bash("npm run typecheck", "\n> app@1.0.0 typecheck\n> tsc --noEmit\n\nsh: 1: tsc: not found\n", {}, true)).toBe("");
    expect(bash("npm run typecheck", "\n> app@1.0.0 typecheck\n> tsc --noEmit\n\n", {}, true)).toBe("");
  });

  test("a tsc summary in output the command didn't make by running tsc says nothing", () => {
    expect(bash("cat build.log", "Found 3 errors in 2 files.\n")).toBe("");
  });

  test("errors without a file", () => {
    expect(bash("bunx tsc -p /tmp/x", "error TS2688: Cannot find type definition file for 'bun'.\n", {}, true)).toBe("1 type error in 0 files");
  });
});

describe("eslint and git", () => {
  test("eslint's summary", () => {
    expect(bash("pnpm lint", `/app/src/a.ts\n  3:7  error  'x' is unused  no-unused-vars\n\n${E}[31m${E}[1m✖ 3 problems (1 error, 2 warnings)${E}[22m${E}[39m\n`, {}, true)).toBe("1 lint error · 2 lint warnings");
  });

  test("one diff stat", () => {
    expect(bash("git diff --stat", " README.md | 16 +++++++++++-----\n 1 file changed, 11 insertions(+), 5 deletions(-)\n")).toBe("1 file changed +11 −5");
    expect(bash("git diff --stat", " docs/a.md | 3 ---\n 1 file changed, 3 deletions(-)\n")).toBe("1 file changed +0 −3");
  });

  test("two stats in one output say nothing", () => {
    const out = " a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n b.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n";
    expect(bash("git diff --stat; git diff --stat HEAD~1", out)).toBe("");
  });

  test("git status, long form", () => {
    const out = [
      "On branch main",
      "Changes to be committed:",
      '  (use "git restore --staged <file>..." to unstage)',
      "\tmodified:   README.md",
      "\trenamed:    a.ts -> b.ts",
      "",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      "\tmodified:   README.md",
      "\tdeleted:    old.ts",
      "",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      "\tdocs/new.md",
      "",
    ].join("\n");
    expect(bash("git status", out)).toBe("3 changed · 1 untracked");
    expect(bash("git status", "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n")).toBe("clean");
  });

  test("git status, short form only when every line is a status line", () => {
    expect(bash("git status --short", " M README.md\n?? docs/waiting.md\n")).toBe("1 changed · 1 untracked");
    expect(bash("git status -sb", "## main...origin/main\n M lib/a.ts\nM  lib/b.ts\n")).toBe("2 changed");
    expect(bash("cd repo && git status --short", "(no output, exit code 0)")).toBe("clean");
    expect(bash("grep -n '^##' CHANGELOG.md; git status --short", "3:## Unreleased\n M README.md\n")).toBe("");
    expect(bash("git status --short | head -3", " M a.ts\n")).toBe("");
    // Sent to the background: the empty output so far proves nothing.
    expect(bash("uv run take.py 2>&1 | tail -3; git status --short", "Backgrounded as job bg_1 (killed once it has run 1200s in total); its output is injected later.")).toBe("");
    // Its output went elsewhere: the empty output here proves nothing.
    expect(bash("git status --porcelain > /tmp/s", "")).toBe("");
    expect(bash("x=$(git status --short)", "")).toBe("");
    expect(bash("git status --short 2>&1", "")).toBe("clean");
  });
});

describe("grep tool and the rest", () => {
  const grep = (details: Record<string, unknown>, error = false) => toolFacts("grep", { pattern: "x" }, "# a.ts\n*1: x", details, error);

  test("counts from omp's details", () => {
    expect(grep({ matchCount: 4, fileCount: 2, truncated: false })).toBe("4 results in 2 files");
    expect(grep({ matchCount: 1, fileCount: 1, truncated: true, linesTruncated: true })).toBe("1 result in 1 file");
    expect(grep({ matchCount: 0, fileCount: 0 })).toBe("no results");
  });

  test("a reached limit makes the counts lower bounds", () => {
    expect(grep({ matchCount: 10, fileCount: 1, truncated: true, perFileLimitReached: 10 })).toBe("10+ results in 1 file");
    expect(grep({ matchCount: 1, fileCount: 1, perFileLimitReached: true, fileLimitReached: true })).toBe("1+ results in 1+ files");
  });

  test("a failed search or one without counts says nothing", () => {
    expect(grep({}, true)).toBe("");
    expect(grep({ matchCount: 3, fileCount: 1 }, true)).toBe("");
    expect(grep({})).toBe("");
  });

  test("unrecognised output and other tools get no facts", () => {
    expect(bash("ls -la", "total 8\ndrwxr-xr-x 2 me me 4096 Nov 15 a\n")).toBe("");
    expect(bash("bun test", "[shaken ~36 tokens — recover: artifact://722 (region 30)]")).toBe("");
    expect(toolFacts("read", { path: "a.ts" }, " 1 pass\n 0 fail\n", {}, false)).toBe("");
  });
});
