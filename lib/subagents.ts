// A session's subagents: omp writes each `task` subagent's transcript next to the session's own,
// in the folder named like the transcript without `.jsonl`: `<stamp>_<id>/<AgentName>.jsonl`.
// The folder also holds advisor transcripts (`__advisor.<model>.jsonl`), tool logs and the
// subagents' results (`.md`), which aren't subagents.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arr, num, obj, str, type Obj } from "./json";
import { callIntent, yieldText } from "./transcript";

/**
 * A subagent name as omp writes it (the job's `agent`, the file's basename): no separators, no
 * leading dot or underscore, so no path traversal and no advisor transcripts.
 */
const NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;
export const validSubagentName = (name: string): boolean => NAME.test(name);

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
export type RunningJob = { agent: string; since: number };

/** How many subagents a session has: those with a transcript and running ones without one yet. */
export function countSubagents(dir: string, jobs: RunningJob[]): number {
  return new Set([...subagentNames(dir), ...jobs.map((j) => j.agent).filter(validSubagentName)]).size;
}

/** What the list shows of a subagent transcript, scanned from where the previous scan stopped. */
export type SubagentFacts = { offset: number; started: number; lastActivity: number; summary: string; messages: number };

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
 * Brings `prev` (the previous scan of this file, updated in place) up to the file's end; starts
 * over when there is none or the file shrank. A line still being written waits for the next scan.
 */
export async function scanSubagent(path: string, prev: SubagentFacts | undefined): Promise<SubagentFacts> {
  const file = Bun.file(path);
  const size = file.size;
  const facts = !prev || size < prev.offset ? { offset: 0, started: 0, lastActivity: 0, summary: "", messages: 0 } : prev;
  if (size <= facts.offset) return facts;
  const bytes = new Uint8Array(await file.slice(facts.offset, size).arrayBuffer());
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");
  // omp writes `type` first, so most rows are told apart without parsing.
  const MESSAGE = '{"type":"message"';
  const parse = (line: string): Obj | null => {
    try {
      return obj(JSON.parse(line));
    } catch {
      return null;
    }
  };
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
  facts.offset += end;
  return facts;
}

/**
 * The subagents in `dir`, running ones (in `jobs`, by agent name) first, then newest activity
 * first. A running job whose transcript isn't written yet shows with what the job tells.
 * `cache` keeps each file's scan between calls.
 */
export async function listSubagents(dir: string, jobs: RunningJob[], cache: Map<string, SubagentFacts>): Promise<Subagent[]> {
  const running = new Map(jobs.filter((j) => validSubagentName(j.agent)).map((j) => [j.agent, j.since]));
  const list: Subagent[] = await Promise.all(
    subagentNames(dir).map(async (name) => {
      const path = join(dir, `${name}.jsonl`);
      const facts = await scanSubagent(path, cache.get(path));
      cache.set(path, facts);
      const { started, lastActivity, summary, messages } = facts;
      return { name, started, lastActivity, running: running.has(name), summary, messages };
    }),
  );
  const written = new Set(list.map((s) => s.name));
  for (const [name, since] of running)
    if (!written.has(name)) list.push({ name, started: since, lastActivity: since, running: true, summary: "", messages: 0 });
  return list.sort((a, b) => Number(b.running) - Number(a.running) || b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
}
