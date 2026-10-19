// Syntax highlighting for opened files and their fenced code. highlight.js (its common languages)
// loads as its own chunk on first use. Its output is the source, escaped, in class-only <span>s.
import type { HLJSApi } from "highlight.js";

let ready: Promise<HLJSApi> | null = null;

/** Bigger files stay plain: highlighting them would stall a phone. */
const HIGHLIGHT_MAX_CHARS = 256 * 1024;

/** Extensions highlight.js has no alias for. */
const EXTRA: Record<string, string> = { jsonl: "json", ndjson: "json", conf: "ini", env: "bash" };

/** The highlight.js language for a file: by extension, else by its bare name (`Makefile`). */
function pathLanguage(hljs: HLJSApi, path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const key = dot > 0 ? name.slice(dot + 1) : name.replace(/^\./, "");
  const lang = EXTRA[key] ?? key;
  return hljs.getLanguage(lang) ? lang : undefined;
}

/** `text` as highlighted HTML when `path` names a known language; null leaves it plain. */
export async function highlightFile(text: string, path: string): Promise<string | null> {
  if (!text || text.length > HIGHLIGHT_MAX_CHARS) return null;
  const hljs = await (ready ??= import("highlight.js/lib/common").then((m) => m.default));
  const lang = pathLanguage(hljs, path);
  return lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : null;
}

/** Highlights the fenced blocks under `root` whose `data-lang` highlight.js knows. */
export async function highlightFences(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre[data-lang] > code:not(.hljs)")];
  if (!blocks.length) return;
  const hljs = await (ready ??= import("highlight.js/lib/common").then((m) => m.default));
  for (const code of blocks) {
    const lang = code.parentElement!.dataset.lang!;
    const text = code.textContent ?? "";
    if (!code.isConnected || !hljs.getLanguage(lang) || text.length > HIGHLIGHT_MAX_CHARS) continue;
    code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    code.classList.add("hljs");
  }
}
