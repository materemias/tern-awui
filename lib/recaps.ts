// omp's session recaps (history.db `session_recaps`), written when a session goes idle.

import type { Database } from "bun:sqlite";
import { obj, num, str } from "./json";

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
