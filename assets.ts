// Regenerates the committed binary assets in assets/ (`bun run assets`). Needs rsvg-convert, pyftsubset
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

for (const size of [192, 512]) {
  run(["rsvg-convert", "-w", String(size), "-h", String(size), join(root, "web", "icon.svg"), "-o", join(out, `icon-${size}.png`)]);
}
// Pane titles start with Nerd Font icons; ship the symbols font, private use areas only.
const font = process.env.TERN_MOBILE_SYMBOLS_FONT ?? "/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf";
run(["pyftsubset", font, "--unicodes=U+E000-F8FF,U+F0000-F1FFF", "--flavor=woff2", `--output-file=${join(out, "symbols.woff2")}`]);
console.log("regenerated assets/");
