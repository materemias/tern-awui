// The folders `+ omp` offers by default: where omp sessions ran (each transcript's header names
// its cwd) and where Tern blocks are open now, most recently used first.

import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inBatches } from "./batch";
import { obj, str } from "./json";

/** omp writes the `session` row first, after an optional `title` row; this covers both. */
const HEAD_BYTES = 4096;

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

/** `transcriptCwd`, read once per transcript. */
export async function cachedTranscriptCwd(path: string): Promise<string> {
  const hit = cwdCache.get(path);
  if (hit !== undefined) return hit;
  const cwd = await transcriptCwd(path);
  if (cwd) cwdCache.set(path, cwd);
  return cwd;
}

/**
 * The cwds of `open` blocks (with their last activity, 0 when unknown) and of omp sessions under
 * `sessionsDir` (their transcript's last write), most recently used first; each folder once, at
 * its latest use, existing folders only.
 */
export async function recentProjects(sessionsDir: string, open: { cwd: string; at: number }[]): Promise<string[]> {
  let files: string[] = [];
  try {
    files = [...new Bun.Glob("*/*.jsonl").scanSync(sessionsDir)].map((rel) => join(sessionsDir, rel));
    // Deleted transcripts' header cwds go with them.
    const present = new Set(files);
    for (const file of cwdCache.keys()) if (!present.has(file)) cwdCache.delete(file);
  } catch {
    // No sessions folder yet: only the open blocks.
  }
  const uses = [...open];
  for (const use of await inBatches(files, async (file) => {
    try {
      return { cwd: await cachedTranscriptCwd(file), at: (await stat(file)).mtimeMs };
    } catch {
      return null; // deleted while listing
    }
  }))
    if (use?.cwd) uses.push(use);
  // Stable sort: among undated open blocks, Tern's order stands.
  uses.sort((a, b) => b.at - a.at);
  // Each spelling is checked once; folders are told apart by device and inode, so `C:\Code` and
  // `c:\code` are one folder where the file system ignores case, and `App` and `app` two where not.
  const spellings = new Set<string>();
  const folders = new Set<string>();
  const out: string[] = [];
  for (const use of uses) {
    if (!use.cwd) continue;
    // `resolve` drops a trailing separator: `~/work/` and `~/work` are one folder.
    const dir = resolve(use.cwd);
    if (spellings.has(dir)) continue;
    spellings.add(dir);
    try {
      // bigint: Windows file ids exceed a double's exact range.
      const st = statSync(dir, { bigint: true });
      if (!st.isDirectory()) continue;
      // A file system without inode numbers reports 0: fall back to the spelling.
      const id = st.ino ? `${st.dev}:${st.ino}` : dir;
      if (folders.has(id)) continue;
      folders.add(id);
      out.push(dir);
    } catch {}
  }
  return out;
}
