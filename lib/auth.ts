// The bridge token omp sessions present to /bridge, kept in the server's config dir.

import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writePrivateFile } from "./private-file";

/**
 * The token in `file`, created first when missing: 32 random bytes as base64url, mode 600
 * (Windows ignores the mode). The token is written to a temp file and hard-linked into place, so
 * the file never appears without its token, and two processes starting at once can't end with
 * two different tokens (the second link fails with EEXIST). An empty file (left by an older,
 * non-atomic version) gets a new one: `sameToken` refuses an empty token, so no session could connect.
 */
export function ensureToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const fresh = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    unlinkSync(tmp);
  }
  const token = readFileSync(file, "utf8").trim();
  if (token) return token;
  writePrivateFile(file, fresh);
  return readFileSync(file, "utf8").trim();
}

/** `given === expected` in constant time (for equal lengths). */
export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
