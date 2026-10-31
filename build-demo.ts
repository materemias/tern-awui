// Builds the static, backend-free demo into dist-demo/ (`bun run build:demo`): the real app from
// web/demo.ts, with the in-page fake backend (web/demo-backend.ts) and sample sessions. Every
// path is relative, so the site works under a sub-path such as https://<user>.github.io/tern-awui/.
// dist/ is not touched: the demo's code never reaches the production bundle.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const out = join(root, "dist-demo");
const staging = mkdtempSync(join(root, ".dist-demo-"));

/** `text` with `from` replaced; fails when `from` is gone, so a changed source can't ship absolute paths. */
function swap(text: string, from: string, to: string, file: string): string {
  if (!text.includes(from)) throw new Error(`${file} no longer holds ${from}`);
  return text.replaceAll(from, to);
}

const BANNER =
  '<div class="demo-line">Demo: sample data, nothing leaves your browser · <a href="https://github.com/materemias/tern-awui" target="_blank" rel="noopener">tern-awui</a></div>';

try {
  const result = await Bun.build({
    entrypoints: [join(root, "web", "demo.ts")],
    outdir: staging,
    // mermaid and highlight.js load as their own chunks, as in the app.
    splitting: true,
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("demo build failed");
  }

  let html = readFileSync(join(root, "web", "index.html"), "utf8");
  // No service worker in the demo, so nothing to install as an app either; the manifest's paths are root-absolute.
  html = swap(html, '    <link rel="manifest" href="/manifest.webmanifest" />\n', "", "index.html");
  html = swap(html, '<script type="module" src="/app.js">', '<script type="module" src="./demo.js">', "index.html");
  html = swap(html, '<link rel="stylesheet" href="/style.css" />', '<link rel="stylesheet" href="./style.css" />\n    <link rel="stylesheet" href="./demo.css" />', "index.html");
  html = swap(html, 'href="/', 'href="./', "index.html");
  html = swap(html, "<title>tern</title>", "<title>tern · demo</title>", "index.html");
  html = swap(html, '<div id="app"></div>', `${BANNER}\n    <div id="app"></div>`, "index.html");
  if (/(?:src|href)="\//.test(html)) throw new Error("index.html still holds a root-absolute path");
  writeFileSync(join(staging, "index.html"), html);

  // Relative to the stylesheet itself.
  const css = swap(readFileSync(join(root, "web", "style.css"), "utf8"), 'url("/symbols.woff2")', 'url("symbols.woff2")', "style.css");
  writeFileSync(join(staging, "style.css"), css);
  copyFileSync(join(root, "web", "demo.css"), join(staging, "demo.css"));
  for (const f of ["icon-v2-32.png", "icon-v2-180.png", "symbols.woff2"]) copyFileSync(join(root, "assets", f), join(staging, f));

  // mkdtemp makes it owner-only; GitHub Pages serves what its artifact can read.
  chmodSync(staging, 0o755);
  rmSync(out, { recursive: true, force: true });
  renameSync(staging, out);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log("built dist-demo/");
