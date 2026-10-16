// The bridge token omp sessions present to /bridge, kept in the server's config dir.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writePrivateFile } from "./private-file";

/**
 * The token in `file`, created first when missing: 32 random bytes as base64url, mode 600
 * (Windows ignores the mode). `wx` makes the creation exclusive, so two processes starting at
 * once can't end with two different tokens. An empty file (cut off before its token was written)
 * gets a new one: `sameToken` refuses an empty token, so no session could connect.
 */
export function ensureToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const fresh = randomBytes(32).toString("base64url");
  try {
    writeFileSync(file, fresh, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
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
