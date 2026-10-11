// Where tern-mobile, omp and Tern keep their files, per OS. Every function takes the
// environment, home and platform so tests can ask about any OS from any OS.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

/** tern-mobile's own files (tokens, VAPID keys, push subscriptions): `$TERN_MOBILE_CONFIG` or ~/.config/tern-mobile, on every OS. */
export function configDir(env: Env, home: string): string {
  return env.TERN_MOBILE_CONFIG || join(home, ".config", "tern-mobile");
}

/**
 * omp's data directory: `sessions/`, `blobs/` and `history.db`. `$TERN_MOBILE_OMP_DIR` overrides.
 * Otherwise as omp's own resolver (pi-utils `dirs.ts`, DirResolver) places its "data" files:
 * the agent dir is `$PI_CODING_AGENT_DIR`, else ~/<`$PI_CONFIG_DIR` or `.omp`>/agent; with the
 * default agent dir on Linux and macOS, `$XDG_DATA_HOME/omp` takes over once it exists (omp's
 * XDG migration). Windows always uses the agent dir. Named profiles (`OMP_PROFILE`) are not
 * followed. Only the Linux path has been run; macOS and Windows follow omp's source, unverified.
 */
export function ompDataDir(env: Env, home: string, platform: NodeJS.Platform, exists: (path: string) => boolean = existsSync): string {
  if (env.TERN_MOBILE_OMP_DIR) return resolve(env.TERN_MOBILE_OMP_DIR);
  const defaultAgent = join(home, env.PI_CONFIG_DIR || ".omp", "agent");
  const agent = env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : defaultAgent;
  if (agent === defaultAgent && (platform === "linux" || platform === "darwin") && env.XDG_DATA_HOME) {
    const xdg = join(env.XDG_DATA_HOME, "omp");
    if (exists(xdg)) return xdg;
  }
  return agent;
}

/**
 * Tern's notes (`note:<id>` → `<dir>/<id>.md`); `$TERN_MOBILE_NOTES_DIR` overrides. Linux:
 * `$XDG_STATE_HOME/tern/notes`, else ~/.local/state/tern/notes (verified). macOS and Windows are
 * read off the tern binary's directory lookup (Application Support, %LOCALAPPDATA%, an app
 * folder named "Tern"), not run: unverified.
 */
export function ternNotesDir(env: Env, home: string, platform: NodeJS.Platform): string {
  if (env.TERN_MOBILE_NOTES_DIR) return resolve(env.TERN_MOBILE_NOTES_DIR);
  if (platform === "darwin") return join(home, "Library", "Application Support", "Tern", "notes");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Tern", "notes");
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(state, "tern", "notes");
}
