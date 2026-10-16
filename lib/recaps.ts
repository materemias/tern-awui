// omp's session recaps (history.db `session_recaps`), written when a session goes idle.

import type { Database } from "bun:sqlite";
import { obj, num, str } from "./json";
import type { ChatEntry } from "./transcript";

const RECAP_CHARS = 600;

/** The newest recap omp wrote for each session, with its time (whole seconds). Throws on a schema omp doesn't have. */
export function queryRecaps(db: Database, ids: string[]): Map<string, { text: string; createdAt: number }> {
  const out = new Map<string, { text: string; createdAt: number }>();
  if (!ids.length) return out;
  // Oldest first, so the newest recap of each session wins; `id` orders recaps within a second.
  const rows = db
    .query(`SELECT session_id, recap, created_at FROM session_recaps WHERE session_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, id`)
    .all(...ids);
  for (const raw of rows) {
    const r = obj(raw);
    const text = str(r.recap).replace(/\s+/g, " ").trim();
    if (text) out.set(str(r.session_id), { text: text.slice(0, RECAP_CHARS), createdAt: num(r.created_at) });
  }
  return out;
}

/** Every recap omp wrote for one session, oldest first, with its time (whole seconds). Throws on a schema omp doesn't have. */
export function querySessionRecaps(db: Database, id: string): { text: string; createdAt: number }[] {
  return db
    .query("SELECT recap, created_at FROM session_recaps WHERE session_id = ? ORDER BY created_at, id")
    .all(id)
    .map((raw) => {
      const r = obj(raw);
      return { text: str(r.recap).trim(), createdAt: num(r.created_at) };
    })
    .filter((r) => r.text);
}

/**
 * The chat with each recap where the terminal shows it: after everything said before it was
 * written. Recaps older than the oldest entry shown belong to the part of the chat left out.
 */
export function withRecaps(entries: ChatEntry[], recaps: { text: string; createdAt: number }[]): ChatEntry[] {
  if (!entries.length || !recaps.length) return entries;
  const out: ChatEntry[] = [];
  let next = 0;
  // `created_at` holds whole seconds, so it may trail the turn it follows by up to one.
  const end = (r: { createdAt: number }) => (r.createdAt + 1) * 1000;
  while (next < recaps.length && end(recaps[next]) <= entries[0].ts) next++;
  for (const e of entries) {
    for (; next < recaps.length && end(recaps[next]) <= e.ts; next++) out.push({ role: "recap", text: recaps[next].text, ts: recaps[next].createdAt * 1000 });
    out.push(e);
  }
  for (; next < recaps.length; next++) out.push({ role: "recap", text: recaps[next].text, ts: recaps[next].createdAt * 1000 });
  return out;
}
