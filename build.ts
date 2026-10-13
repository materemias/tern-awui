// Bundles web/app.tsx and copies the static files and the prebuilt assets (see assets.ts) into dist/.
import { rmSync, mkdtempSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
const staging = mkdtempSync(join(root, ".dist-"));
try {
  const result = await Bun.build({
    entrypoints: [join(root, "web", "app.tsx")],
    outdir: staging,
    // mermaid loads as its own chunks, only when a diagram shows up.
    splitting: true,
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("build failed");
  }

  for (const f of ["index.html", "style.css", "manifest.webmanifest", "sw.js"]) copyFileSync(join(root, "web", f), join(staging, f));
  for (const f of ["tern-icon-v1-32.png", "tern-icon-v1-180.png", "tern-icon-v1-192.png", "tern-icon-v1-512.png", "tern-icon-v1-maskable-512.png", "symbols.woff2"]) copyFileSync(join(root, "assets", f), join(staging, f));
  // Keep the working release until bundling and all static copies have succeeded.
  rmSync(dist, { recursive: true, force: true });
  renameSync(staging, dist);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log("built dist/");
