// Secrets the server keeps in its config dir: the bridge token omp sessions present, and the
// access token a paired browser holds as a cookie.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** The cookie a paired browser sends to /api; its value is the access token. */
export const PAIR_COOKIE = "tern_awui";

/**
 * The token in `file`, created first when missing: 32 random bytes as base64url, mode 600
 * (Windows ignores the mode). `wx` makes the creation exclusive, so a `pair` run racing the
 * server's start can't end with two different tokens.
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

/** A cookie's value from a `Cookie` header; "" when absent. */
export function cookieValue(header: string | null, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}
