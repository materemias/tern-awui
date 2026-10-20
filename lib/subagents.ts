// A session's subagents: omp writes each `task` subagent's transcript next to the session's own,
// in the folder named like the transcript without `.jsonl`: `<stamp>_<id>/<AgentName>.jsonl`.
// The folder also holds advisor transcripts (`__advisor.<model>.jsonl`), tool logs and the
// subagents' results (`.md`), which aren't subagents.

import { lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { BunFile } from "bun";
import { arr, num, obj, str, type Obj } from "./json";
import { SUBAGENT_NAME } from "./subagent-name";
import { callIntent, yieldText } from "./transcript";

/** The job's `agent` or the file's basename; also keeps advisor transcripts (`__advisor.*`) out. */
export const validSubagentName = (name: string): boolean => SUBAGENT_NAME.test(name);

/** The folder holding a session's subagent transcripts. */
export function subagentDir(transcript: string): string {
  return transcript.replace(/\.jsonl$/, "");
}

/** A subagent's transcript path; null for a name that isn't one. */
export function subagentFile(transcript: string, name: string): string | null {
  return validSubagentName(name) ? join(subagentDir(transcript), `${name}.jsonl`) : null;
}

/** Whether `path` is a regular file: a missing file, a folder or a symlink (which could lead out of the folder) isn't. */
export function regularFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** The subagents with a transcript in `dir`; none when it doesn't exist (yet). */
export function subagentNames(dir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((n) => validSubagentName(n) && regularFile(join(dir, `${n}.jsonl`)));
}

/** A running background job as the bridge reports it; `agent` names a subagent. */
type RunningJob = { agent: string; since: number };

/** How many subagents a session has: those with a transcript and running ones without one yet. */
export function countSubagents(dir: string, jobs: RunningJob[]): number {
  return new Set([...subagentNames(dir), ...jobs.map((j) => j.agent).filter(validSubagentName)]).size;
}

/** What the list shows of a subagent transcript, scanned from where the previous scan stopped. */
export type SubagentFacts = { offset: number; started: number; lastActivity: number; summary: string; messages: number };
const factFiles = new WeakMap<SubagentFacts, Stats>();

export type Subagent = {
  name: string;
  /** The transcript's start and its newest message (ms). */
  started: number;
  lastActivity: number;
  /** One of the bridge's running jobs. */
  running: boolean;
  /** Its newest assistant text, else its newest tool call's intent. */
  summary: string;
  /** Messages in the transcript: prompts, replies, tool results. */
  messages: number;
};

const NEWLINE = 0x0a;
const SUMMARY_MAX = 200;
/** Only this much of a transcript's end is decoded; rows before it are just counted. */
const TAIL_BYTES = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;
// omp writes `type` first, so most rows are told apart without parsing.
const MESSAGE = '{"type":"message"';
const LINE_MESSAGE = Buffer.from(`\n${MESSAGE}`);

/** Message rows starting in [from, to) (`from` a line start), counted on raw bytes, chunk by chunk. */
async function countMessages(file: BunFile, from: number, to: number): Promise<number> {
  let count = 0;
  if (from === 0 && Buffer.from(await file.slice(0, MESSAGE.length).arrayBuffer()).toString() === MESSAGE) count++;
  // A row starts after a newline at p, for p in [from - 1, to - 1).
  for (let a = Math.max(from - 1, 0); a < to - 1; a += CHUNK) {
    const b = Math.min(a + CHUNK, to - 1);
    const bytes = Buffer.from(await file.slice(a, b - 1 + LINE_MESSAGE.length).arrayBuffer());
    for (let i = bytes.indexOf(LINE_MESSAGE); i !== -1 && i < b - a; i = bytes.indexOf(LINE_MESSAGE, i + 1)) count++;
  }
  return count;
}

function parse(line: string): Obj | null {
  try {
    return obj(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * An assistant message as one line: its result when it yields text, else its last text, else its
 * last tool call's intent (or name). A `yield` without text says nothing; "" when nothing is left.
 */
export function assistantSummary(msg: Obj): string {
  const parts = arr(msg.content).map(obj);
  const result = parts
    .filter((p) => p.type === "toolCall" && p.name === "yield")
    .map((p) => yieldText(obj(p.arguments)))
    .findLast(Boolean);
  const text = result ?? str(parts.findLast((p) => p.type === "text" && str(p.text).trim())?.text);
  if (text) return text.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
  const call = parts.findLast((p) => p.type === "toolCall" && p.name !== "yield");
  return call ? callIntent(obj(call.arguments)) || str(call.name) : "";
}

/**
 * Scans from `prev` without mutating it: concurrent readers may share the cached snapshot.
 * Starts over if the file was replaced, shrank, or changed without growing. An incomplete line waits.
 * Only the last TAIL_BYTES are decoded; message rows before them are counted on raw bytes.
 */
export async function scanSubagent(path: string, prev: SubagentFacts | undefined): Promise<SubagentFacts> {
  const file = Bun.file(path);
  const st = statSync(path, { throwIfNoEntry: false });
  const size = st?.size ?? 0;
  const previous = prev && factFiles.get(prev);
  const fresh = !previous || !st || st.dev !== previous.dev || st.ino !== previous.ino ||
    size < previous.size || (size === previous.size && st.mtimeMs !== previous.mtimeMs);
  const facts = !prev || fresh ? { offset: 0, started: 0, lastActivity: 0, summary: "", messages: 0 } : { ...prev };
  if (size <= facts.offset) {
    if (st) factFiles.set(facts, st);
    return facts;
  }
  const tailStart = Math.max(facts.offset, size - TAIL_BYTES);
  let bytes = new Uint8Array(await file.slice(tailStart, size).arrayBuffer());
  let start = tailStart;
  if (tailStart > facts.offset) {
    // Skip to the first whole row in the tail; the rows before it are only counted.
    const first = bytes.indexOf(NEWLINE) + 1;
    if (!first) {
      if (st) factFiles.set(facts, st); // one row longer than the tail, still being written
      return facts;
    }
    start = tailStart + first;
    bytes = bytes.subarray(first);
    if (!facts.offset && !facts.started) {
      // The session row comes near the top (after a title row); the head's last line may be cut off.
      const head = new TextDecoder().decode(await file.slice(0, 64 * 1024).arrayBuffer()).split("\n").slice(0, -1);
      const line = head.find((l) => l.startsWith('{"type":"session"'));
      if (line) facts.started = Date.parse(str(parse(line)?.timestamp)) || 0;
    }
    facts.messages += await countMessages(file, facts.offset, start);
  }
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");
  for (const line of lines) {
    if (line.startsWith(MESSAGE)) facts.messages++;
    else if (!facts.started && line.startsWith('{"type":"session"')) facts.started = Date.parse(str(parse(line)?.timestamp)) || 0;
  }
  // The newest message dates the activity; the newest one with something to say is the summary.
  let dated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(MESSAGE)) continue;
    const row = parse(lines[i]);
    if (!row) continue;
    const msg = obj(row.message);
    if (!dated) {
      facts.lastActivity = Date.parse(str(row.timestamp)) || num(msg.timestamp);
      dated = true;
    }
    const summary = msg.role === "assistant" ? assistantSummary(msg) : "";
    if (summary) {
      facts.summary = summary;
      break;
    }
  }
  facts.started ||= facts.lastActivity;
  facts.offset = start + end;
  if (st) factFiles.set(facts, st);
  return facts;
}

/**
 * The subagents in `dir`, running ones (in `jobs`, by agent name) first, then newest activity
 * first. A running job whose transcript isn't written yet shows with what the job tells.
 * `cache` keeps each file's scan between calls.
 */
export async function listSubagents(dir: string, jobs: RunningJob[], cache: Map<string, SubagentFacts>): Promise<Subagent[]> {
  const running = new Map(jobs.filter((j) => validSubagentName(j.agent)).map((j) => [j.agent, j.since]));
  const list: Subagent[] = [];
  // One file at a time: a folder of big transcripts mustn't be read into memory all at once.
  for (const name of subagentNames(dir)) {
    const path = join(dir, `${name}.jsonl`);
    const facts = await scanSubagent(path, cache.get(path));
    cache.set(path, facts);
    const { started, lastActivity, summary, messages } = facts;
    list.push({ name, started, lastActivity, running: running.has(name), summary, messages });
  }
  const written = new Set(list.map((s) => s.name));
  for (const [name, since] of running)
    if (!written.has(name)) list.push({ name, started: since, lastActivity: since, running: true, summary: "", messages: 0 });
  return list.sort((a, b) => Number(b.running) - Number(a.running) || b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
}
