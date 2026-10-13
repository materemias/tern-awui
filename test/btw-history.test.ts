import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readBtwHistory, type BtwHistoryRecord } from "../lib/btw-history";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(`${tmpdir()}/btw-history-`);
  homes.push(home);
  const transcript = `${home}/session.jsonl`;
  const dir = `${home}/session/btw-history`;
  mkdirSync(dir, { recursive: true });
  return { home, transcript, dir };
}
const native: BtwHistoryRecord = { id: "saved", leafId: "leaf-123", question: "Explain", answer: "Saved answer", status: "complete", createdAt: 1, updatedAt: 2 };

test("all native statuses and large answers survive without marking running records interrupted", async () => {
  const { transcript, dir } = fixture();
  const statuses: BtwHistoryRecord["status"][] = ["running", "complete", "cancelled", "error", "interrupted"];
  for (const [i, status] of statuses.entries()) writeFileSync(`${dir}/entry-${status}.json`, JSON.stringify({ ...native, id: status, status, createdAt: i, answer: status === "complete" ? "x".repeat(5 * 1024 * 1024) : "Saved answer" }));
  const records = await readBtwHistory(transcript);
  expect(records.map((r) => r.status)).toEqual(statuses.toReversed());
  expect(records.find((r) => r.status === "complete")?.answer.length).toBe(5 * 1024 * 1024);
  expect(JSON.parse(await Bun.file(`${dir}/entry-running.json`).text()).status).toBe("running");
});

test("wrong schema, filename and symlinks are ignored while a valid record remains", async () => {
  const { home, transcript, dir } = fixture();
  writeFileSync(`${dir}/entry-saved.json`, JSON.stringify(native));
  for (const [i, change] of [{ leafId: 3 }, { question: null }, { answer: [] }, { createdAt: null }, { error: 1 }, { followUps: null }, { status: "toString" }].entries()) {
    writeFileSync(`${dir}/entry-bad-${i}.json`, JSON.stringify({ ...native, id: `bad-${i}`, ...change }));
  }
  writeFileSync(`${home}/external.json`, JSON.stringify({ ...native, id: "external" }));
  symlinkSync(`${home}/external.json`, `${dir}/entry-external.json`);
  expect(await readBtwHistory(transcript)).toEqual([native]);
});

test("missing folders are empty; invalid transcript and directory types are errors", async () => {
  const { transcript, dir } = fixture();
  await expect(readBtwHistory(transcript.replace(".jsonl", ".json"))).rejects.toThrow("invalid session transcript");
  rmSync(dir, { recursive: true });
  expect(await readBtwHistory(transcript)).toEqual([]);
  writeFileSync(dir, "not a directory");
  await expect(readBtwHistory(transcript)).rejects.toThrow("invalid btw history directory");
});

test.skipIf(process.getuid?.() === 0)("permission errors are surfaced instead of silently dropping history", async () => {
  const { transcript, dir } = fixture();
  writeFileSync(`${dir}/entry-saved.json`, JSON.stringify(native));
  chmodSync(`${dir}/entry-saved.json`, 0);
  try {
    await expect(readBtwHistory(transcript)).rejects.toThrow();
  } finally {
    chmodSync(`${dir}/entry-saved.json`, 0o600);
  }
  chmodSync(dir, 0);
  try {
    await expect(readBtwHistory(transcript)).rejects.toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
});
