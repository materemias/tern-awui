// Regenerates committed assets (`bun run assets`). Needs ImageMagick's magick, pyftsubset
// (fonttools with brotli) and the Symbols Nerd Font; `bun build.ts` only copies the results.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const out = join(root, "assets");
mkdirSync(out, { recursive: true });

function run(argv: string[]): void {
  const r = Bun.spawnSync(argv, { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${argv[0]} failed: ${r.stderr.toString()}`);
}

// Source: ~/.local/share/icons/hicolor/512x512/apps/so.stencil.tern.png, copied unchanged.
// Tern's third-party artwork: no local license metadata. Bump v1 filenames when artwork changes.
const icon = join(out, "tern-icon-source.png");
for (const size of [32, 180, 192, 512]) {
  run(["magick", icon, "-resize", `${size}x${size}`, join(out, `tern-icon-v1-${size}.png`)]);
}
// The original light mark already fits the maskable 40%-radius safe circle; only fill transparency.
run(["magick", icon, "-background", "#111317", "-alpha", "remove", "-alpha", "off",
  join(out, "tern-icon-v1-maskable-512.png")]);
// Pane titles start with Nerd Font icons; ship the symbols font, private use areas only.
const font = process.env.TERN_MOBILE_SYMBOLS_FONT ?? "/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf";
run(["pyftsubset", font, "--unicodes=U+E000-F8FF,U+F0000-F1FFF", "--flavor=woff2", `--output-file=${join(out, "symbols.woff2")}`]);
console.log("regenerated assets/");
