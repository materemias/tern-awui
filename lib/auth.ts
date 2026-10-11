// The bridge token omp sessions present to /bridge, kept in the server's config dir.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The token in `file`, created first when missing: 32 random bytes as base64url, mode 600
 * (Windows ignores the mode). `wx` makes the creation exclusive, so two processes starting at
 * once can't end with two different tokens.
 */
export function ensureToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return readFileSync(file, "utf8").trim();
}

/** `given === expected` in constant time (for equal lengths). */
export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
