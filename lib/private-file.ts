// The server's own files (bridge token, VAPID keys, push subscriptions): private, and never
// left half-written, since an empty or cut-off file would stop the next start.

import { renameSync, rmSync, writeFileSync } from "node:fs";

/** Writes `content` to `file` with mode 600 (Windows ignores it) through a temporary sibling and a rename. */
export function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
