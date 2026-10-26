// Bundles web/app.tsx and copies the static files and the prebuilt assets (see assets.ts) into dist/.
// The release's id, a hash of its files, goes into the bundle and dist/build-id: open pages whose
// id differs from the server's reload (web/hooks.ts).
import { rmSync, mkdtempSync, copyFileSync, renameSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const PLACEHOLDER = "@@TERN_AWUI_BUILD@@";

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
    define: { __TERN_AWUI_BUILD__: JSON.stringify(PLACEHOLDER) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("build failed");
  }

  for (const f of ["index.html", "style.css", "manifest.webmanifest", "sw.js"]) copyFileSync(join(root, "web", f), join(staging, f));
  for (const f of ["icon-v2-32.png", "icon-v2-180.png", "icon-v2-192.png", "icon-v2-512.png", "icon-v2-maskable-512.png", "symbols.woff2"]) copyFileSync(join(root, "assets", f), join(staging, f));
  // Hashed with the placeholder in place, so an unchanged rebuild keeps its id and reloads nothing.
  const files = readdirSync(staging).sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f}\0`).update(readFileSync(join(staging, f)));
  const id = hash.digest("hex").slice(0, 16);
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(staging, f), "utf8");
    if (!text.includes(PLACEHOLDER)) continue;
    // Chunks are served as immutable by their content-hashed name: the per-build id may only live in app.js.
    if (f !== "app.js") throw new Error(`${f} holds the build id; only app.js may`);
    writeFileSync(join(staging, f), text.replaceAll(PLACEHOLDER, id));
  }
  writeFileSync(join(staging, "build-id"), id);
  // Text files also go precompressed: the server sends `<file>.br` to browsers that take brotli
  // (neither Bun.serve nor tailscale serve compresses). Quality 9: about 150 ms for all of dist/.
  for (const f of files.filter((f) => /\.(js|css|html|webmanifest)$/.test(f))) {
    const bytes = readFileSync(join(staging, f));
    const params = { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length };
    writeFileSync(join(staging, `${f}.br`), brotliCompressSync(bytes, { params }));
  }
  // Keep the working release until bundling and all static copies have succeeded.
  rmSync(dist, { recursive: true, force: true });
  renameSync(staging, dist);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log("built dist/");
