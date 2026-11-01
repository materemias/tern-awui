// Claude Code and Codex sessions, for the Closed tab's search: the ones someone typed a prompt
// into (each tool's `history.jsonl`, which `claude -p` and `codex exec` don't write) whose
// transcript is still on disk. Only their own files are read, so it works wherever they run.

import type { BunFile } from "bun";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { inBatches } from "./batch";
import { num, obj, str, type Obj } from "./json";
import type { ClosedAgent } from "./search";

export type OtherAgent = Exclude<ClosedAgent, "omp">;

/** A Claude Code or Codex session: what search matches, a row shows and resume needs. */
export type OtherSession = {
  agent: OtherAgent;
  id: string;
  /** The tool's own title for it; "" without one. */
  title: string;
  /** Typed prompts, oldest first. */
  prompts: string[];
  cwd: string;
  /** Last activity (ms): the newest prompt or the transcript's last write. */
  at: number;
};

/** Claude Code appends its `ai-title` row; it sits within the last few KB, else the whole file is read once. */
const TAIL_BYTES = 64 * 1024;
/** Codex's first row (`session_meta`) names the cwd near its start. */
const HEAD_BYTES = 16 * 1024;

/** What a file parsed to, re-read only once its size or last write changes. */
const parsed = new Map<string, { key: string; value: unknown }>();

/** `parse` of the file at `path` with its last write (ms), or null when it can't be read. */
async function readCached<T>(path: string, parse: (file: BunFile) => Promise<T>): Promise<{ value: T; mtimeMs: number } | null> {
  try {
    const st = await stat(path);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = parsed.get(path);
    if (hit?.key === key) return { value: hit.value as T, mtimeMs: st.mtimeMs };
    const value = await parse(Bun.file(path));
    parsed.set(path, { key, value });
    return { value, mtimeMs: st.mtimeMs };
  } catch {
    parsed.delete(path); // none yet, or deleted meanwhile
    return null;
  }
}

function jsonl(text: string): Obj[] {
  const out: Obj[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(obj(JSON.parse(line)));
    } catch {
      // a cut-off line
    }
  }
  return out;
}

type Typed = { prompts: string[]; cwd: string; at: number };

/** History rows grouped by session id, prompts oldest first. */
function bySession(rows: { id: string; text: string; cwd: string; at: number }[]): Map<string, Typed> {
  const out = new Map<string, Typed>();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    if (!r.id) continue;
    let s = out.get(r.id);
    if (!s) out.set(r.id, (s = { prompts: [], cwd: "", at: 0 }));
    if (r.text) s.prompts.push(r.text);
    if (r.cwd) s.cwd = r.cwd;
    s.at = r.at;
  }
  return out;
}

/** Transcript paths under `root` matching `pattern`, by the session id `idOf` reads off the file name. */
async function transcripts(root: string, pattern: string, idOf: (name: string) => string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const rel of new Bun.Glob(pattern).scan(root)) {
      const id = idOf(basename(rel.replaceAll("\\", "/"), ".jsonl"));
      if (id) out.set(id, join(root, rel));
    }
  } catch {
    // No such folder.
  }
  return out;
}

/** The typed sessions with a transcript, dated by their last activity; `extra` reads what the transcript adds. */
async function withTranscripts(
  agent: OtherAgent,
  typed: Map<string, Typed>,
  paths: Map<string, string>,
  extra: (id: string, path: string) => Promise<{ title: string; cwd?: string; mtimeMs: number } | null>,
): Promise<OtherSession[]> {
  const ids = [...typed.keys()].filter((id) => paths.has(id));
  const found = await inBatches(ids, async (id): Promise<OtherSession | null> => {
    const t = typed.get(id)!;
    const x = await extra(id, paths.get(id)!);
    return x && { agent, id, title: x.title, prompts: t.prompts, cwd: x.cwd || t.cwd, at: Math.max(t.at, x.mtimeMs) };
  });
  return found.filter((s) => s !== null);
}

/** The last `ai-title` row's title in `text`, or null without one. */
function lastTitle(text: string): string | null {
  let title: string | null = null;
  for (const row of jsonl(text)) if (row.type === "ai-title") title = str(row.aiTitle);
  return title;
}

/**
 * Claude Code sessions under `dir`: prompts and folder from `history.jsonl` (`display`, `project`,
 * `sessionId`, `timestamp` in ms), transcripts at `projects/<folder>/<id>.jsonl`, the title from
 * the transcript's last `ai-title` row.
 */
export async function claudeSessions(dir: string): Promise<OtherSession[]> {
  const history = await readCached(join(dir, "history.jsonl"), async (f) =>
    bySession(jsonl(await f.text()).map((r) => ({ id: str(r.sessionId), text: str(r.display), cwd: str(r.project), at: num(r.timestamp) }))),
  );
  if (!history?.value.size) return [];
  const paths = await transcripts(join(dir, "projects"), "*/*.jsonl", (name) => name);
  return withTranscripts("claude", history.value, paths, async (_id, path) => {
    const r = await readCached(path, async (f) => {
      const tail = lastTitle(await f.slice(Math.max(0, f.size - TAIL_BYTES)).text());
      return tail ?? (f.size > TAIL_BYTES ? (lastTitle(await f.text()) ?? "") : "");
    });
    return r && { title: r.value, mtimeMs: r.mtimeMs };
  });
}

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Codex sessions under `dir`: prompts from `history.jsonl` (`session_id`, `text`, `ts` in s),
 * titles from `session_index.jsonl` (`thread_name`), transcripts at
 * `sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl`, the folder from their `session_meta` row.
 */
export async function codexSessions(dir: string): Promise<OtherSession[]> {
  const history = await readCached(join(dir, "history.jsonl"), async (f) =>
    bySession(jsonl(await f.text()).map((r) => ({ id: str(r.session_id), text: str(r.text), cwd: "", at: num(r.ts) * 1000 }))),
  );
  if (!history?.value.size) return [];
  const names = await readCached(join(dir, "session_index.jsonl"), async (f) => {
    const out = new Map<string, string>();
    for (const r of jsonl(await f.text())) if (str(r.thread_name)) out.set(str(r.id), str(r.thread_name));
    return out;
  });
  const paths = await transcripts(join(dir, "sessions"), "**/rollout-*.jsonl", (name) => UUID_AT_END.exec(name)?.[1] ?? null);
  return withTranscripts("codex", history.value, paths, async (id, path) => {
    const r = await readCached(path, async (f) => {
      // The row can be longer than the head (it carries instructions); `cwd` comes early in it.
      const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(await f.slice(0, HEAD_BYTES).text());
      return m ? str(JSON.parse(m[1])) : "";
    });
    return r && { title: names?.value.get(id) ?? "", cwd: r.value, mtimeMs: r.mtimeMs };
  });
}

/** A tool whose files don't answer within this long (a hung mount) adds nothing to a search. */
const READ_TIMEOUT_MS = 3000;

/** Reads in progress by tool folder: searches typed in a row, or a resume meanwhile, share one instead of piling up scans. */
const reading = new Map<string, Promise<OtherSession[]>>();

function shared(key: string, read: () => Promise<OtherSession[]>): Promise<OtherSession[]> {
  let pending = reading.get(key);
  if (!pending) {
    pending = read()
      .catch(() => [])
      .finally(() => reading.delete(key));
    reading.set(key, pending);
  }
  return pending;
}

/**
 * Claude Code's sessions under `claude` and Codex's under `codex`, each tool given up after
 * READ_TIMEOUT_MS; `late` says one was, so a missing session may just be unread.
 */
export async function otherSessions(claude: string, codex: string): Promise<{ sessions: OtherSession[]; late: boolean }> {
  const within = async (read: Promise<OtherSession[]>) => {
    const late = Promise.withResolvers<null>();
    const timer = setTimeout(() => late.resolve(null), READ_TIMEOUT_MS);
    try {
      return await Promise.race([read, late.promise]);
    } finally {
      clearTimeout(timer);
    }
  };
  const reads = await Promise.all([
    within(shared(`claude:${claude}`, () => claudeSessions(claude))),
    within(shared(`codex:${codex}`, () => codexSessions(codex))),
  ]);
  return { sessions: reads.flatMap((r) => r ?? []), late: reads.includes(null) };
}
