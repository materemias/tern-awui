// Project and branch names for a pane's cwd, from git when it is there.

import { basename } from "node:path";

/** Lookups that take longer are given up: a hung mount or a slow git mustn't stall the list. */
const GIT_TIMEOUT_MS = 2000;

/** `git -C cwd ARGS`: its exit and stdout lines; null without git or after the timeout. */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; lines: string[] } | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: GIT_TIMEOUT_MS });
    const reader = proc.stdout.getReader();
    const out = (async () => {
      const parts: Uint8Array[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
      return Buffer.concat(parts).toString();
    })();
    const code = await proc.exited;
    if (proc.signalCode) {
      // Killed: whatever git started may still hold the pipe open, so stop reading it.
      out.catch(() => {});
      void reader.cancel().catch(() => {});
      return null;
    }
    return { ok: code === 0, lines: (await out).split("\n").map((l) => l.trim()).filter(Boolean) };
  } catch {
    return null;
  }
}

export type Repo = {
  /** The repo's folder name, else the cwd's own ("~" for home). */
  project: string;
  /** Checked-out branch (short sha when detached); null outside a repo. */
  branch: string | null;
};

async function readRepo(cwd: string, home: string): Promise<Repo> {
  // One run in the common case: the top level and the full ref (`--abbrev-ref` prints `heads/main` when a tag is also named main).
  const r = await git(cwd, ["rev-parse", "--show-toplevel", "--symbolic-full-name", "HEAD"]);
  const top = r?.lines[0] ?? null;
  const project = (top && basename(top)) || (cwd === home ? "~" : basename(cwd) || cwd);
  if (!top) return { project, branch: null };
  const ref = r?.ok ? r.lines[1] : undefined;
  if (ref?.startsWith("refs/heads/")) return { project, branch: ref.slice("refs/heads/".length) };
  // Detached (`HEAD`) or unborn (no commit to resolve): the branch name or else the short sha.
  const current = (await git(cwd, ["branch", "--show-current"]))?.lines[0];
  if (current) return { project, branch: current };
  const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return { project, branch: sha?.ok ? (sha.lines[0] ?? null) : null };
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; current: Promise<Repo>; refreshing: boolean }>();

/**
 * Project and branch of `cwd`. Only the first lookup waits for git; after that the cached answer comes
 * back at once, and once it is older than 10 s a refresh runs behind it and calls `onChange` if the
 * answer moved (a checkout, a `git init`).
 */
export function repoOf(cwd: string, home: string, onChange: () => void): Promise<Repo> {
  const hit = cache.get(cwd);
  if (!hit) {
    const current = readRepo(cwd, home);
    cache.set(cwd, { at: Date.now(), current, refreshing: false });
    return current;
  }
  if (!hit.refreshing && Date.now() - hit.at >= CACHE_TTL_MS) {
    hit.refreshing = true;
    const next = readRepo(cwd, home);
    void Promise.all([hit.current, next]).then(([before, after]) => {
      Object.assign(hit, { at: Date.now(), current: next, refreshing: false });
      // A folder dropped by `forgetRepos` meanwhile is no longer shown: no rebuild for it.
      if (cache.get(cwd) === hit && (before.project !== after.project || before.branch !== after.branch)) onChange();
    });
  }
  return hit.current;
}

/** Drops the folders no open block uses any more. */
export function forgetRepos(keep: Set<string>): void {
  for (const cwd of cache.keys()) if (!keep.has(cwd)) cache.delete(cwd);
}
