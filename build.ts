// Bundles web/app.tsx and copies the static files and the prebuilt assets (see assets.ts) into dist/.
import { rmSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const result = await Bun.build({
  entrypoints: [join(root, "web", "app.tsx")],
  outdir: dist,
  // mermaid loads as its own chunks, only when a diagram shows up.
  splitting: true,
  minify: true,
  target: "browser",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const f of ["index.html", "style.css", "manifest.webmanifest", "icon.svg", "sw.js"]) copyFileSync(join(root, "web", f), join(dist, f));
for (const f of ["icon-192.png", "icon-512.png", "symbols.woff2"]) copyFileSync(join(root, "assets", f), join(dist, f));
console.log("built dist/");
