// The card at a turn's end: which files the turn's edit/write calls changed, with line counts.
// The app has no viewer for arbitrary paths, so rows aren't links.

import { useState } from "preact/hooks";
import type { ChangedFile } from "../lib/transcript";

/** Collapsed by default above this many files. */
const OPEN_MAX = 3;

function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  return (
    <span class="cf-counts">
      {added !== null && <span class="cf-add">+{added}</span>}
      {removed !== null && <span class="cf-del">−{removed}</span>}
    </span>
  );
}

export function ChangedFiles({ files }: { files: ChangedFile[] }) {
  const [open, setOpen] = useState(files.length <= OPEN_MAX);
  // A total counts only the files that report it; unknown everywhere → omitted.
  const total = (key: "added" | "removed") => (files.some((f) => f[key] !== null) ? files.reduce((n, f) => n + (f[key] ?? 0), 0) : null);
  return (
    <div class="changed-files">
      <button type="button" class="cf-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          {files.length} changed file{files.length === 1 ? "" : "s"}
        </span>
        <Counts added={total("added")} removed={total("removed")} />
        <span class={`cf-chevron${open ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <ul class="cf-list">
          {files.map((f) => {
            const cut = f.path.lastIndexOf("/");
            return (
              <li key={f.path} class="cf-row" title={f.path}>
                <span class="cf-name">{f.path.slice(cut + 1)}</span>
                {cut > 0 && <span class="cf-dir">{f.path.slice(0, cut)}</span>}
                <Counts added={f.added} removed={f.removed} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
