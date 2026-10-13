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

// The app icon: assets/icon.svg is a full-bleed tile, used as is for the maskable icon (its mark
// fits the 40%-radius safe circle); the other sizes get rounded corners. Bump v2 when it changes.
const svg = join(out, "icon.svg");
const tile = join(out, "icon-v2-maskable-512.png");
run(["magick", "-background", "none", "-density", "96", svg, "-resize", "512x512", tile]);
const rounded = ["-alpha", "set", "(", "-size", "512x512", "xc:none", "-fill", "white", "-draw", "roundrectangle 0,0,511,511,112,112", ")", "-compose", "DstIn", "-composite"];
for (const size of [32, 180, 192, 512]) {
  run(["magick", tile, ...rounded, "-resize", `${size}x${size}`, join(out, `icon-v2-${size}.png`)]);
}
// Pane titles start with Nerd Font icons; ship the symbols font, private use areas only.
const font = process.env.TERN_AWUI_SYMBOLS_FONT ?? "/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf";
run(["pyftsubset", font, "--unicodes=U+E000-F8FF,U+F0000-F1FFF", "--flavor=woff2", `--output-file=${join(out, "symbols.woff2")}`]);
console.log("regenerated assets/");
