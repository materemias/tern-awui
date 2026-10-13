import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tern-awui-build-failure-"));
  copyFileSync(join(import.meta.dir, "..", "build.ts"), join(root, "build.ts"));
  for (const dir of ["web", "assets", "dist"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "web", "app.tsx"), 'console.log("new release");');
  for (const file of ["index.html", "style.css", "manifest.webmanifest", "sw.js"]) writeFileSync(join(root, "web", file), `new ${file}`);
  for (const file of ["icon-v2-32.png", "icon-v2-180.png", "icon-v2-192.png", "icon-v2-512.png", "icon-v2-maskable-512.png", "symbols.woff2"]) writeFileSync(join(root, "assets", file), "asset");
  writeFileSync(join(root, "dist", "index.html"), "working release");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const build = () => Bun.spawnSync([process.execPath, join(root, "build.ts")], { stdout: "pipe", stderr: "pipe" });

describe("installer build publication", () => {
  test("a syntax error leaves the previous release intact", () => {
    writeFileSync(join(root, "web", "app.tsx"), "export const broken = ;");
    expect(build().exitCode).not.toBe(0);
    expect(readFileSync(join(root, "dist", "index.html"), "utf8")).toBe("working release");
    expect(readdirSync(root).filter((file) => file.startsWith(".dist-"))).toEqual([]);
  });

  test.each(["symbols.woff2", "icon-v2-maskable-512.png"])("missing %s leaves the previous release intact", (asset) => {
    rmSync(join(root, "assets", asset));
    expect(build().exitCode).not.toBe(0);
    expect(readFileSync(join(root, "dist", "index.html"), "utf8")).toBe("working release");
    expect(readdirSync(root).filter((file) => file.startsWith(".dist-"))).toEqual([]);
  });

  test("a complete build replaces the old release and removes staging files", () => {
    writeFileSync(join(root, "dist", "stale.js"), "old chunk");
    const result = build();
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "dist", "index.html"), "utf8")).toBe("new index.html");
    expect(existsSync(join(root, "dist", "app.js"))).toBe(true);
    expect(existsSync(join(root, "dist", "stale.js"))).toBe(false);
    expect(readdirSync(root).filter((file) => file.startsWith(".dist-"))).toEqual([]);
  });
});
