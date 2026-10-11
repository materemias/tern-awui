// The folders `+ omp` offers by default: where omp sessions ran (each transcript's header names
// its cwd) and where Tern blocks are open now, newest first.

import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { obj, str } from "./json";

/** omp writes the `session` row first, after an optional `title` row; this covers both. */
const HEAD_BYTES = 4096;
/** Transcripts read at once: a few thousand files must not exhaust file descriptors. */
const BATCH = 64;

/** The cwd in a transcript's `session` header row; "" when the head has none. */
export async function transcriptCwd(path: string): Promise<string> {
  const head = await Bun.file(path).slice(0, HEAD_BYTES).text();
  for (const line of head.split("\n")) {
    let row;
    try {
      row = obj(JSON.parse(line));
    } catch {
      continue; // the cut-off last line, or a blank one
    }
    if (row.type === "session") return str(row.cwd);
  }
  return "";
}

/** Header cwds by transcript path: a header never changes once written. */
const cwdCache = new Map<string, string>();

/**
 * `open` (the cwds of open Tern blocks, already newest first) ahead of the cwds of omp sessions
 * under `sessionsDir`, newest transcript first; each folder once, existing folders only.
 */
export async function recentProjects(sessionsDir: string, open: string[]): Promise<string[]> {
  let files: string[] = [];
  try {
    files = [...new Bun.Glob("*/*.jsonl").scanSync(sessionsDir)].map((rel) => join(sessionsDir, rel));
  } catch {
    // No sessions folder yet: only the open blocks.
  }
  const sessions: { cwd: string; at: number }[] = [];
  for (let i = 0; i < files.length; i += BATCH)
    await Promise.all(
      files.slice(i, i + BATCH).map(async (file) => {
        try {
          const at = (await stat(file)).mtimeMs;
          let cwd = cwdCache.get(file);
          if (cwd === undefined) cwdCache.set(file, (cwd = await transcriptCwd(file)));
          if (cwd) sessions.push({ cwd, at });
        } catch {
          // Deleted while listing.
        }
      }),
    );
  sessions.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...open, ...sessions.map((s) => s.cwd)]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    try {
      if (statSync(dir).isDirectory()) out.push(dir);
    } catch {}
  }
  return out;
}
