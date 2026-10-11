// Whether omp runs the tern-mobile extension this checkout ships: the file the installer put into
// `<omp dir>/extensions`, and the build each bridged session loaded.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arr, obj, str, type Obj } from "./json";

/**
 * An extension source's identity: the first 16 hex digits of its sha256. The extension computes
 * the same of its own file when omp loads it (`BUILD` in omp-extension/tern-mobile.ts).
 */
export function buildId(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/**
 * `ok`: a link to this checkout's file, or a copy with the same content. `missing`: nothing there
 * (or a link to nothing). `stale`: a copy that differs (a Windows install after `git pull`).
 * `foreign`: a link to some other file (another checkout).
 */
export type InstallStatus = "ok" | "missing" | "stale" | "foreign";
/** `target`: where a `foreign` link points; "" otherwise. */
export type Install = { status: InstallStatus; target: string };

/** How the extension at `installed` relates to `source`, the checkout's own file. */
export function classifyInstall(installed: string, source: string): Install {
  let link: boolean;
  try {
    link = lstatSync(installed).isSymbolicLink();
  } catch {
    return { status: "missing", target: "" };
  }
  let real: string;
  try {
    real = realpathSync(installed);
  } catch {
    // A link whose target is gone: omp has nothing to load.
    return { status: "missing", target: "" };
  }
  let sourceReal = source;
  try {
    sourceReal = realpathSync(source);
  } catch {}
  if (real === sourceReal) return { status: "ok", target: "" };
  if (link) return { status: "foreign", target: resolve(dirname(installed), readlinkSync(installed)) };
  try {
    return { status: readFileSync(installed).equals(readFileSync(source)) ? "ok" : "stale", target: "" };
  } catch {
    return { status: "stale", target: "" };
  }
}

/** A file's change marker: its inode, mtime and size; "" when it doesn't exist. */
function marker(path: string, follow: boolean): string {
  try {
    const st = follow ? statSync(path) : lstatSync(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

/**
 * The installed file's status and the checkout's build id, each recomputed only when the files
 * behind it change (inode, mtime, size), so the list can recheck them on every rebuild.
 */
export function extensionCheck(installed: string, source: string) {
  let install = { key: "-", value: { status: "missing", target: "" } as Install };
  let build = { key: "-", value: "" };
  return {
    install(): Install {
      const key = `${marker(installed, false)}|${marker(installed, true)}|${marker(source, true)}`;
      if (key !== install.key) install = { key, value: classifyInstall(installed, source) };
      return install.value;
    },
    build(): string {
      const key = marker(source, true);
      if (key !== build.key) {
        let value = "";
        try {
          value = buildId(readFileSync(source));
        } catch {}
        build = { key, value };
      }
      return build.value;
    },
  };
}

/**
 * How a bridged session's extension differs from this server's: `older` (a lower protocol, or
 * another build at the same protocol: restarting omp loads the installed one), `newer` (a higher
 * protocol: the server is the older side), or null. An empty build is one the extension couldn't
 * read (or, below the current protocol, didn't report); it doesn't count as different.
 */
export type Mismatch = "older" | "newer";
export function sessionMismatch(session: { protocol: number; build: string }, server: { protocol: number; build: string }): Mismatch | null {
  if (session.protocol > server.protocol) return "newer";
  if (session.protocol < server.protocol) return "older";
  return session.build && server.build && session.build !== server.build ? "older" : null;
}

/** Whether a `complete` reply from omp's own autocomplete offers the slash command `name`. */
export function offersCommand(reply: Obj | null, name: string): boolean {
  return arr(reply?.items).some((item) => str(obj(item).value).replace(/^\//, "") === name);
}
