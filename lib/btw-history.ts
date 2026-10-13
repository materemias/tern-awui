import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export type BtwHistoryTurn = {
  question: string;
  answer: string;
  status: "running" | "complete" | "cancelled" | "error" | "interrupted";
  createdAt: number;
  updatedAt: number;
  error?: string;
};
export type BtwHistoryRecord = BtwHistoryTurn & {
  id: string;
  leafId: string | null;
  followUps?: BtwHistoryTurn[];
};

const statuses: Record<string, true> = { running: true, complete: true, cancelled: true, error: true, interrupted: true };
function isTurn(value: unknown): value is BtwHistoryTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.question === "string" && typeof v.answer === "string"
    && typeof v.status === "string" && statuses[v.status] === true
    && typeof v.createdAt === "number" && Number.isFinite(v.createdAt)
    && typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt)
    && (v.error === undefined || typeof v.error === "string");
}
function isRecord(value: unknown, id: string): value is BtwHistoryRecord {
  if (!isTurn(value)) return false;
  const v = value as BtwHistoryRecord;
  return v.id === id && (v.leafId === null || typeof v.leafId === "string")
    && (v.followUps === undefined || (Array.isArray(v.followUps) && v.followUps.every(isTurn)));
}
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** Read native saved records, without changing running statuses or touching subagent history. */
export async function readBtwHistory(transcriptPath: string): Promise<BtwHistoryRecord[]> {
  if (!transcriptPath.endsWith(".jsonl")) throw new Error("invalid session transcript");
  const sessionDir = transcriptPath.slice(0, -6);
  const dir = join(sessionDir, "btw-history");
  try {
    for (const path of [sessionDir, dir]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid btw history directory");
    }
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
  const records: BtwHistoryRecord[] = [];
  // Read one file at a time: no arbitrary size cutoff discards a legitimate long answer.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const id = /^entry-([\w-]+)\.json$/.exec(entry.name)?.[1];
    if (!id || !entry.isFile()) continue;
    let file;
    try {
      file = await open(join(dir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await file.stat()).isFile()) continue;
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (isRecord(value, id)) records.push(value);
    } catch (error) {
      if (error instanceof SyntaxError || code(error) === "ENOENT" || code(error) === "ELOOP") continue;
      throw error;
    } finally {
      await file?.close();
    }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
