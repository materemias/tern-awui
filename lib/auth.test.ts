import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken, sameToken } from "./auth";

const root = mkdtempSync(join(tmpdir(), "tern-awui-auth-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ensureToken", () => {
  test("creates the folder and a 32-byte base64url token, then keeps it", () => {
    const file = join(root, "nested", "dir", "bridge-token");
    const token = ensureToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureToken(file)).toBe(token);
    expect(readFileSync(file, "utf8")).toBe(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("an existing token is read as written, trimmed", () => {
    const file = join(root, "existing");
    writeFileSync(file, "  kept-token\n");
    expect(ensureToken(file)).toBe("kept-token");
  });

  test("an empty token file gets a new private token, which is then kept", () => {
    const file = join(root, "empty");
    writeFileSync(file, "\n", { mode: 0o644 });
    const token = ensureToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureToken(file)).toBe(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("sameToken", () => {
  test("equal non-empty strings only", () => {
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abd", "abc")).toBe(false);
    expect(sameToken("ab", "abc")).toBe(false);
    expect(sameToken("", "")).toBe(false);
  });
});
