// Project and branch names for a pane's cwd, from git when it is there.

import { basename } from "node:path";

/** `git -C cwd ARGS` output; null outside a repo or without git. */
export function gitOut(cwd: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 10_000;
const projectCache = new Map<string, { at: number; value: string | null }>();
/** The repo's folder name, else the cwd's own ("~" for `home`). */
export function projectOf(cwd: string, home: string): string {
  let hit = projectCache.get(cwd);
  if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) {
    const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
    hit = { at: Date.now(), value: top ? basename(top) : null };
    projectCache.set(cwd, hit);
  }
  return hit.value || (cwd === home ? "~" : basename(cwd) || cwd);
}

const branchCache = new Map<string, { at: number; value: string | null }>();
/** Checked-out branch of the cwd (short sha when detached); null outside a repo. */
export function branchOf(cwd: string): string | null {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const current = gitOut(cwd, ["branch", "--show-current"]);
  const value = current === null ? null : current || gitOut(cwd, ["rev-parse", "--short", "HEAD"]);
  branchCache.set(cwd, { at: Date.now(), value });
  return value;
}
