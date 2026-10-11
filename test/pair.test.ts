import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "./server-harness";

const home = mkdtempSync(join(tmpdir(), "tern-awui-pair-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** `bun server.ts pair` in the isolated home; no login list, no port: it must not start the server. */
function pair(extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "server.ts"), "pair"], { cwd: home, env: isolatedEnv(home, extra), timeout: 10_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("`pair` prints exactly the pairing path, creating a private access token once", () => {
  const first = pair();
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(first.out).toMatch(/^\/pair\?code=[A-Za-z0-9_-]{43}\n$/);
  const file = join(home, ".config", "tern-mobile", "access-token");
  expect(`/pair?code=${readFileSync(file, "utf8")}\n`).toBe(first.out);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  // Only the token: the server's own startup (bridge token, VAPID keys) never ran.
  expect(existsSync(join(home, ".config", "tern-mobile", "vapid.json"))).toBe(false);
  expect(pair().out).toBe(first.out);
});

test("`pair` honors TERN_MOBILE_CONFIG", () => {
  const dir = join(home, "elsewhere");
  const r = pair({ TERN_MOBILE_CONFIG: dir });
  expect(r.out).toBe(`/pair?code=${readFileSync(join(dir, "access-token"), "utf8")}\n`);
});
