// Short facts parsed from a tool's own output ("25 passed · 1 failed", "3 type errors in 2 files"),
// shown after the call's intent so a phone shows how a test run or a typecheck went without
// opening anything. Every parser reads only an output shape it is sure of: when no parser is
// sure, the call gets no facts. Nothing of the raw output leaves the server.

import { num, obj, type Obj } from "./json";

/** Facts are one short line; a long failing test name is cut. */
const MAX_FACTS = 160;
const MAX_NAME = 80;

/** CSI and OSC escape sequences: colours, cursor moves, hyperlinks. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/**
 * omp's marks for output cut short: a line or byte limit, pruned or minimised text, a timeout, or a
 * command sent to the background (its output arrives later, as a message of its own).
 */
const CUT_MARK = /^(?:\[(?:Showing (?:lines?|head|\d)|Output truncated|shaken |…\d+ .*elided…|Command timed out)|Backgrounded as job )/m;
/** omp's notes after a bash command's own output. */
const OMP_NOTE = /^(?:Wall time: [\d.]+ seconds?|Command exited with code \d+|\[raw output: artifact:\/\/.*\]|\[Some lines truncated .*\]|\(no output, exit code \d+\))$/;

type Fact = { at: number; text: string };
type Output = { lines: string[]; cut: boolean; command: string; error: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** A count that may be short (`more` is "+": omp cut the output), as "3+ packages". */
const counted = (n: number, word: string, more: string) => `${n}${more} ${word}${n === 1 && !more ? "" : "s"}`;

/** The output's lines without escape codes; a line a progress bar rewrote keeps its last state. */
function cleanLines(text: string): string[] {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.slice(l.lastIndexOf("\r") + 1).trimEnd());
}

/** The command's own output: the lines before omp's notes, without trailing blanks. */
function body(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (!lines[end - 1].trim() || OMP_NOTE.test(lines[end - 1].trim()))) end--;
  return lines.slice(0, end);
}

/** A shell command's simple commands (pipes kept together), without `cd`, `set` and `export`. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(?:cd|set|export)\b/.test(s));
}

/** A pipe that drops or reorders lines, so a count over them may be short. */
const FILTERED = /\|\s*(?:head|grep|egrep|rg|sed|awk|cut|sort|uniq)\b/;
const TAILED = /\|\s*tail\b/;

/** "25 passed · 1 failed: suite > name", from whatever counts the runner printed; `more` "+" when they may be short. */
function testLine(passed: number | null, failed: number, ran: number | null, firstFailure: string, more = ""): string {
  if (passed === 0 && failed === 0) return "no tests ran";
  const parts: string[] = [];
  if (passed !== null) parts.push(`${passed}${more} passed`);
  else if (ran !== null) parts.push(counted(ran, "test", more));
  if (failed > 0 || passed === null) {
    const name = failed > 0 && firstFailure ? `: ${firstFailure.slice(0, MAX_NAME)}` : "";
    parts.push(`${failed}${more} failed${name}`);
  }
  return parts.join(" · ");
}

function firstMatch(lines: string[], re: RegExp): string {
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1].trim();
  }
  return "";
}

/** Counts like "2 failed | 25 passed" or "1 failed, 214 passed"; null when any part is something else. */
function countParts(text: string, sep: RegExp, kinds: RegExp): Map<string, number> | null {
  const counts = new Map<string, number>();
  for (const part of text.split(sep)) {
    const m = kinds.exec(part.trim());
    if (!m) return null;
    counts.set(m[2], (counts.get(m[2]) ?? 0) + Number(m[1]));
  }
  return counts;
}

/**
 * bun test's summary: " 47 pass", optional skip/todo lines, " 1 fail", then "N expect() calls" and
 * "Ran N tests across M files." A tail may cut the pass line, a grep the lines after it; a block
 * counts when it has its fail line and either its pass line or the lines after it.
 */
function bunTest(o: Output): Fact | null {
  const { lines } = o;
  const COUNT = /^ (\d+) (pass|skip|todo|fail)$/;
  let at = -1;
  let passed: number | null = 0;
  let failed = 0;
  let ran: number | null = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!COUNT.test(lines[i]) || (i > 0 && COUNT.test(lines[i - 1]))) continue;
    const block = new Map<string, number>();
    let j = i;
    for (let m; j < lines.length && (m = COUNT.exec(lines[j])); j++) block.set(m[2], Number(m[1]));
    const expects = /^ \d+ expect\(\) calls?$/.test(lines[j] ?? "");
    const ranLine = /^Ran (\d+) tests? across \d+ files?\./.exec(lines[expects ? j + 1 : j] ?? "");
    if (!block.has("fail") || (!block.has("pass") && !expects && !ranLine)) continue;
    if (at < 0) at = i;
    passed = passed !== null && block.has("pass") ? passed + block.get("pass")! : null;
    failed += block.get("fail")!;
    ran = ran !== null && ranLine ? ran + Number(ranLine[1]) : null;
  }
  if (at < 0) return null;
  const first = firstMatch(lines, /^(?:\(fail\)|✗) (.+?)(?: \[[\d.]+m?s\])?$/);
  return { at, text: testLine(passed, failed, ran, first) };
}

/** vitest: " Test Files  1 failed | 3 passed (4)" then "      Tests  2 failed | 25 passed (27)". */
function vitest(o: Output): Fact | null {
  const { lines } = o;
  let at = -1;
  let passed = 0;
  let failed = 0;
  for (let i = 1; i < lines.length; i++) {
    const m = /^\s*Tests\s+(.+?)\s+\(\d+\)$/.exec(lines[i]);
    if (!m || !/^\s*Test Files\s+.+\(\d+\)$/.test(lines[i - 1])) continue;
    const counts = countParts(m[1], /\|/, /^(\d+) (passed|failed|skipped|todo)$/);
    if (!counts) continue;
    if (at < 0) at = i - 1;
    passed += counts.get("passed") ?? 0;
    failed += counts.get("failed") ?? 0;
  }
  if (at < 0) return null;
  const first = firstMatch(lines, /^\s*(?:FAIL|×)\s+(?:\S+\.(?:test|spec)\.[cm]?[jt]sx? > )?(.+? > .+?)(?: \d+ms)?$/);
  return { at, text: testLine(passed, failed, null, first) };
}

/** jest: "Tests:       1 failed, 9 passed, 10 total", one per project. */
function jest(o: Output): Fact | null {
  const { lines } = o;
  let at = -1;
  let passed = 0;
  let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^Tests:\s+(.+), \d+ total$/.exec(lines[i]);
    const counts = m && countParts(m[1], /,/, /^(\d+) (passed|failed|skipped|todo|pending)$/);
    if (!counts) continue;
    if (at < 0) at = i;
    passed += counts.get("passed") ?? 0;
    failed += counts.get("failed") ?? 0;
  }
  if (at < 0) return null;
  const first = firstMatch(lines, /^\s*● (.+ › .+)$/).replaceAll(" › ", " > ");
  return { at, text: testLine(passed, failed, null, first) };
}

/** pytest's last line: "=== 1 failed, 214 passed, 1 skipped in 19.61s ===" (-q drops the rules). */
function pytest(o: Output): Fact | null {
  const { lines } = o;
  const KINDS = /^(\d+) (passed|failed|skipped|deselected|xfailed|xpassed|warnings?|errors?|rerun|subtests (?:passed|failed|skipped))$/;
  let at = -1;
  let passed = 0;
  let failed = 0;
  let errors = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:=+ )?(\d+ [a-z ]+(?:, \d+ [a-z ]+)*) in [\d.]+s(?: \([\d:]+\))?(?: =+)?$/.exec(lines[i]);
    const counts = m && countParts(m[1], /,/, KINDS);
    if (!counts || !["passed", "failed", "error", "errors"].some((k) => counts.has(k))) continue;
    if (at < 0) at = i;
    passed += counts.get("passed") ?? 0;
    failed += counts.get("failed") ?? 0;
    errors += (counts.get("error") ?? 0) + (counts.get("errors") ?? 0);
  }
  if (at < 0) return null;
  const first = firstMatch(lines, /^FAILED (?:[^:\s]+::)?(\S+?)(?: - .*)?$/);
  const text = testLine(passed, failed, null, first);
  return { at, text: errors ? `${text} · ${plural(errors, "error")}` : text };
}

/**
 * cargo test: one "test result: ok. 12 passed; 0 failed; 1 ignored; …" per test binary, summed: a
 * cut output may miss binaries, so its counts are a lower bound then.
 */
function cargoTest(o: Output): Fact | null {
  const { lines } = o;
  let at = -1;
  let passed = 0;
  let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; \d+ ignored;/.exec(lines[i]);
    if (!m) continue;
    if (at < 0) at = i;
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  if (at < 0 || (o.cut && !passed && !failed)) return null;
  return { at, text: testLine(passed, failed, null, firstMatch(lines, /^test (\S+) \.\.\. FAILED$/), o.cut ? "+" : "") };
}

/** go test: "ok  \tpkg\t0.01s" or "FAIL\tpkg\t0.01s" per package (a lower bound in a cut output), "--- FAIL: TestX" per test. */
function goTest(o: Output): Fact | null {
  const { lines } = o;
  let at = -1;
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    const pass = /^ok  \t\S+\t(?:[\d.]+s|\(cached\))/.test(lines[i]);
    const fail = /^FAIL\t\S+\t(?:[\d.]+s|\[(?:build|setup) failed\])/.test(lines[i]);
    if (!pass && !fail) continue;
    if (at < 0) at = i;
    if (pass) ok++;
    else failed++;
  }
  if (at < 0) return null;
  const more = o.cut ? "+" : "";
  const parts = [`${counted(ok, "package", more)} ok`];
  if (failed) {
    const first = firstMatch(lines, /^\s*--- FAIL: (\S+)/);
    parts.push(`${failed}${more} failed${first ? `: ${first}` : ""}`);
  }
  return { at, text: parts.join(" · ") };
}

const TSC_SEGMENT = /\b(?:vue-)?tsc\b|\btype-?check\b/;
/** `bun run`, npm and pnpm echo the script they run: "$ tsc -p ." or "> tsc --noEmit". */
const TSC_ECHO = /^(?:\$|>) (?:vue-)?tsc\b/;
/** A tsc diagnostic: "file(1,7): error TS2322: …", pretty "file:1:7 - error TS2322: …", or one without a file. */
const TSC_ERROR = /^(?:(.+?)\(\d+,\d+\): |(.+?):\d+:\d+ - )?error TS\d+: /;
/** A script runner reporting its script failed, or a shell not finding tsc: no claim about type errors then. */
const SCRIPT_FAILED = /^error: script ".*" exited with code \d+|^npm (?:ERR!|error) |^\s*ERR_PNPM_|^error Command failed with exit code \d+|\btsc: (?:command )?not found$/;

/**
 * tsc, only when the command runs it: its "Found N errors in M files." when pretty; else its error
 * lines, counted only when all of them are in sight (a tail that kept the echo, or no filter),
 * otherwise as a lower bound. "No type errors" needs proof that tsc ran and printed nothing: the
 * script echo with nothing cut and no failure (a lone command must also have succeeded), or a lone
 * tsc command that succeeded silently.
 */
function tsc(o: Output): Fact | null {
  const { lines, cut, command, error } = o;
  const segs = segments(command);
  const seg = segs.find((s) => TSC_SEGMENT.test(s));
  if (!seg) return null;
  for (let i = 0; i < lines.length; i++) {
    const many = /^Found (\d+) errors? in (\d+) files\.$/.exec(lines[i]);
    const one = /^Found (\d+) errors? in (?:the same file, starting at: )?\S+:\d+$/.exec(lines[i]);
    if (many) return { at: i, text: `${plural(Number(many[1]), "type error")} in ${many[2]} files` };
    if (one) return { at: i, text: `${plural(Number(one[1]), "type error")} in 1 file` };
  }
  const echo = lines.findIndex((l) => TSC_ECHO.test(l));
  const files = new Set<string>();
  let first = -1;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = TSC_ERROR.exec(lines[i]);
    if (!m) continue;
    if (first < 0) first = i;
    count++;
    const file = m[1] ?? m[2];
    if (file) files.add(file);
  }
  const whole = !cut && !FILTERED.test(seg) && (!TAILED.test(seg) || (echo >= 0 && echo < first));
  if (count) return { at: first, text: whole ? `${plural(count, "type error")} in ${plural(files.size, "file")}` : `${count}+ type errors` };
  if (cut || FILTERED.test(seg)) return null;
  // The script failed without a diagnostic tsc prints (a missing tsconfig, tsc not installed, a crash): no claim.
  if (echo >= 0) return (segs.length === 1 && error) || lines.some((l) => SCRIPT_FAILED.test(l)) ? null : { at: echo, text: "no type errors" };
  const lone = segs.length === 1 && /^(?:\S*\/)?(?:(?:bunx|npx|pnpm(?: exec)?|yarn) )?(?:vue-)?tsc\b/.test(seg) && !/\||>\s*[^&\s]/.test(seg);
  if (lone && !error && !body(lines).length) return { at: 0, text: "no type errors" };
  return null;
}

/** eslint's summary: "✖ 5 problems (3 errors, 2 warnings)", one per run. */
function eslint(o: Output): Fact | null {
  const { lines } = o;
  let at = -1;
  let errors = 0;
  let warnings = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)$/.exec(lines[i]);
    if (!m) continue;
    if (at < 0) at = i;
    errors += Number(m[1]);
    warnings += Number(m[2]);
  }
  if (at < 0) return null;
  const parts = [errors && plural(errors, "lint error"), warnings && plural(warnings, "lint warning")].filter(Boolean);
  return { at, text: parts.join(" · ") };
}

/** git's stat summary (diff --stat, show, commit): " 3 files changed, 12 insertions(+), 4 deletions(-)"; one only. */
function diffStat(o: Output): Fact | null {
  const RE = /^ (\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
  const at = o.lines.findIndex((l) => RE.test(l));
  if (at < 0 || o.lines.findLastIndex((l) => RE.test(l)) !== at) return null;
  const [, files, added, removed] = RE.exec(o.lines[at])!;
  return { at, text: `${plural(Number(files), "file")} changed +${added ?? 0} −${removed ?? 0}` };
}

function statusLine(changed: number, untracked: number): string {
  if (!changed && !untracked) return "clean";
  return [changed && `${changed} changed`, untracked && `${untracked} untracked`].filter(Boolean).join(" · ");
}

const STATUS_SECTION = /^(Changes to be committed|Changes not staged for commit|Unmerged paths|Untracked files):$/;
const STATUS_ENTRY = /^\t(?:(?:modified|new file|deleted|renamed|copied|typechange|both modified|both added|both deleted|added by us|added by them|deleted by us|deleted by them):\s+)(.+)$/;

/**
 * git status, long form: one repository's "On branch" header, then its sections of tab-indented
 * paths up to a blank line. Short form (`-s`, `--porcelain`): only when the whole output is status
 * lines and the segment prints it here (no redirect, pipe or command substitution), so that an
 * empty output means a clean tree.
 */
function gitStatus(o: Output): Fact | null {
  const { lines, cut, command } = o;
  const seg = segments(command).find((s) => /\bgit\b.*\bstatus\b/.test(s));
  if (!seg || cut || FILTERED.test(seg) || TAILED.test(seg)) return null;
  const heads = lines.flatMap((l, i) => (/^(?:On branch \S|HEAD detached (?:at|from) \S|Not currently on any branch\.)/.test(l) ? [i] : []));
  if (heads.length === 1) {
    const at = heads[0];
    const changed = new Set<string>();
    const untracked = new Set<string>();
    let section = "";
    let sure = false;
    for (const line of lines.slice(at)) {
      if (line === "nothing to commit, working tree clean") return { at, text: "clean" };
      const head = STATUS_SECTION.exec(line);
      if (head) {
        section = head[1];
        sure = true;
        continue;
      }
      if (!line) section = "";
      if (!section || !line.startsWith("\t")) continue;
      if (section === "Untracked files") untracked.add(line.slice(1));
      else {
        const m = STATUS_ENTRY.exec(line);
        if (!m) return null;
        changed.add(m[1].split(" -> ").pop()!);
      }
    }
    return sure ? { at, text: statusLine(changed.size, untracked.size) } : null;
  }
  if (heads.length || !/\s(?:-s\w*|--short|--porcelain(?:=v1)?)\b/.test(seg)) return null;
  if (/[>|`]|\$\(/.test(seg.replace(/\s2>&1\b/g, ""))) return null;
  const out = body(lines).filter((l, i) => !(i === 0 && l.startsWith("## ")));
  if (!out.every((l) => /^[ MADRCUT?!]{2} \S/.test(l))) return null;
  if (!out.length && o.error) return null;
  const untracked = out.filter((l) => l.startsWith("??")).length;
  return { at: 0, text: statusLine(out.length - untracked, untracked) };
}

const BASH_PARSERS = [bunTest, vitest, jest, pytest, cargoTest, goTest, tsc, eslint, diffStat, gitStatus];

/** omp's grep tool counts its matches in `details`; a reached limit makes them a lower bound. */
function grepFacts(details: Obj): string {
  if (typeof details.matchCount !== "number" || typeof details.fileCount !== "number") return "";
  const matches = num(details.matchCount);
  const files = num(details.fileCount);
  if (!matches) return "no results";
  // omp writes a reached limit as `true` or as the limit itself (`perFileLimitReached: 10`).
  const more = details.matchLimitReached || details.perFileLimitReached || details.resultLimitReached ? "+" : "";
  const moreFiles = details.fileLimitReached ? "+" : "";
  return `${matches}${more} result${matches === 1 && !more ? "" : "s"} in ${files}${moreFiles} file${files === 1 && !moreFiles ? "" : "s"}`;
}

/** Facts for a finished tool call, "" when no parser is sure of its output. */
export function toolFacts(name: string, args: Obj, text: string, details: Obj, error: boolean): string {
  if (name === "grep") return error ? "" : grepFacts(details);
  if (name !== "bash" || typeof args.command !== "string") return "";
  const meta = obj(details.meta);
  const output: Output = {
    lines: cleanLines(text),
    cut: CUT_MARK.test(text) || !!meta.truncation || !!meta.minimized,
    command: args.command,
    error,
  };
  const facts = BASH_PARSERS.map((parse) => parse(output))
    .filter((f): f is Fact => !!f && !!f.text)
    .sort((a, b) => a.at - b.at)
    .map((f) => f.text);
  return facts.join(" · ").slice(0, MAX_FACTS);
}
