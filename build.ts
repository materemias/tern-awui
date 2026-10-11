// Bundles web/app.tsx and copies the static files into dist/.
import { rmSync, mkdirSync, copyFileSync } from "node:fs";

const root = new URL(".", import.meta.url).pathname;
rmSync(`${root}dist`, { recursive: true, force: true });
mkdirSync(`${root}dist`);

const result = await Bun.build({
  entrypoints: [`${root}web/app.tsx`],
  outdir: `${root}dist`,
  // mermaid loads as its own chunks, only when a diagram shows up.
  splitting: true,
  minify: true,
  target: "browser",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const f of ["index.html", "style.css", "manifest.webmanifest", "icon.svg", "sw.js"]) copyFileSync(`${root}web/${f}`, `${root}dist/${f}`);
for (const size of [192, 512]) {
  const r = Bun.spawnSync(["rsvg-convert", "-w", String(size), "-h", String(size), `${root}web/icon.svg`, "-o", `${root}dist/icon-${size}.png`]);
  if (r.exitCode !== 0) throw new Error(`rsvg-convert failed for ${size}px`);
}
// Pane titles start with Nerd Font icons; ship the symbols font, private use areas only.
const font = process.env.TERN_MOBILE_SYMBOLS_FONT ?? "/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf";
const subset = Bun.spawnSync([
  "pyftsubset", font, "--unicodes=U+E000-F8FF,U+F0000-F1FFF", "--flavor=woff2", `--output-file=${root}dist/symbols.woff2`,
]);
if (subset.exitCode !== 0) throw new Error(`pyftsubset failed: ${subset.stderr.toString()}`);
console.log("built dist/");
