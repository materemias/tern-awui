import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId, classifyInstall, extensionCheck, offersCommand, sessionMismatch } from "./extension-check";

let dir: string;
let source: string;
let installed: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tern-mobile-ext-"));
  mkdirSync(join(dir, "repo", "omp-extension"), { recursive: true });
  mkdirSync(join(dir, "omp", "extensions"), { recursive: true });
  source = join(dir, "repo", "omp-extension", "tern-mobile.ts");
  installed = join(dir, "omp", "extensions", "tern-mobile.ts");
  writeFileSync(source, "export default function ternMobile() {}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildId", () => {
  test("16 hex digits of the sha256, the same for a string and its bytes", () => {
    expect(buildId("abc")).toBe("ba7816bf8f01cfea");
    expect(buildId(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea");
    expect(buildId("abd")).not.toBe(buildId("abc"));
  });
});

describe("classifyInstall", () => {
  test("nothing there is missing", () => {
    expect(classifyInstall(installed, source)).toEqual({ status: "missing", target: "" });
  });

  test("a link to the checkout's file is ok, absolute or relative", () => {
    symlinkSync(source, installed);
    expect(classifyInstall(installed, source)).toEqual({ status: "ok", target: "" });
    rmSync(installed);
    symlinkSync("../../repo/omp-extension/tern-mobile.ts", installed);
    expect(classifyInstall(installed, source)).toEqual({ status: "ok", target: "" });
  });

  test("a link elsewhere is foreign, even to the same content; a dangling link is missing", () => {
    const other = join(dir, "other-checkout.ts");
    writeFileSync(other, readFileSync(source));
    symlinkSync(other, installed);
    expect(classifyInstall(installed, source)).toEqual({ status: "foreign", target: other });
    rmSync(other);
    expect(classifyInstall(installed, source)).toEqual({ status: "missing", target: "" });
  });

  test("a copy is ok while it matches and stale once the checkout moves on", () => {
    writeFileSync(installed, readFileSync(source));
    expect(classifyInstall(installed, source)).toEqual({ status: "ok", target: "" });
    writeFileSync(source, "// pulled\nexport default function ternMobile() {}\n");
    expect(classifyInstall(installed, source)).toEqual({ status: "stale", target: "" });
  });
});

describe("extensionCheck", () => {
  // Whole milliseconds: a file's own mtime can carry nanoseconds a Date can't restore.
  const T = new Date(1_700_000_000_000);
  /** Rewrites `path` with same-length content and the pinned mtime: invisible to the cache key but the inode. */
  function sneak(path: string, content: string) {
    writeFileSync(path, content);
    utimesSync(path, T, T);
  }

  test("rechecks the installed file only when it or the source changes", () => {
    const check = extensionCheck(installed, source);
    expect(check.install().status).toBe("missing");
    writeFileSync(installed, readFileSync(source));
    utimesSync(installed, T, T);
    expect(check.install().status).toBe("ok");
    // Same inode, size and mtime: the cached answer stands.
    sneak(installed, readFileSync(source, "utf8").replace("ternMobile", "ternMobilX"));
    expect(check.install().status).toBe("ok");
    utimesSync(installed, new Date(), new Date(Date.now() + 5000));
    expect(check.install().status).toBe("stale");
    // A source change counts too: the checkout catching up with the copy.
    writeFileSync(source, readFileSync(installed));
    expect(check.install().status).toBe("ok");
    rmSync(installed);
    symlinkSync(join(dir, "elsewhere.ts"), installed);
    expect(check.install().status).toBe("missing");
    writeFileSync(join(dir, "elsewhere.ts"), "x");
    expect(check.install()).toEqual({ status: "foreign", target: join(dir, "elsewhere.ts") });
  });

  test("the checkout's build follows its file and is empty without one", () => {
    const check = extensionCheck(installed, source);
    utimesSync(source, T, T);
    expect(check.build()).toBe(buildId(readFileSync(source)));
    sneak(source, readFileSync(source, "utf8").replace("ternMobile", "ternMobilX"));
    expect(check.build()).toBe(buildId("export default function ternMobile() {}\n"));
    utimesSync(source, new Date(), new Date(Date.now() + 5000));
    expect(check.build()).toBe(buildId(readFileSync(source)));
    rmSync(source);
    expect(check.build()).toBe("");
  });
});

describe("sessionMismatch", () => {
  const server = { protocol: 2, build: "aaaaaaaaaaaaaaaa" };
  test("the same protocol and build match", () => {
    expect(sessionMismatch({ protocol: 2, build: "aaaaaaaaaaaaaaaa" }, server)).toBeNull();
  });
  test("another build at the same protocol is an older extension: omp loaded it before the checkout changed", () => {
    expect(sessionMismatch({ protocol: 2, build: "bbbbbbbbbbbbbbbb" }, server)).toBe("older");
  });
  test("a lower protocol is older, builds aside; extensions from before versioning too", () => {
    expect(sessionMismatch({ protocol: 1, build: "" }, server)).toBe("older");
    expect(sessionMismatch({ protocol: 0, build: "" }, server)).toBe("older");
    expect(sessionMismatch({ protocol: 1, build: "aaaaaaaaaaaaaaaa" }, server)).toBe("older");
  });
  test("a higher protocol means the server is the older side", () => {
    expect(sessionMismatch({ protocol: 3, build: "bbbbbbbbbbbbbbbb" }, server)).toBe("newer");
  });
  test("a build nobody could read isn't evidence of a difference", () => {
    expect(sessionMismatch({ protocol: 2, build: "" }, server)).toBeNull();
    expect(sessionMismatch({ protocol: 2, build: "bbbbbbbbbbbbbbbb" }, { protocol: 2, build: "" })).toBeNull();
  });
});

describe("offersCommand", () => {
  test("finds the command among omp's autocomplete items, with or without its slash", () => {
    expect(offersCommand({ prefix: "/restart", items: [{ value: "restart", label: "restart" }] }, "restart")).toBe(true);
    expect(offersCommand({ items: [{ value: "/restart", label: "restart" }] }, "restart")).toBe(true);
  });
  test("near matches, other commands, empty and missing replies don't count", () => {
    expect(offersCommand({ items: [{ value: "restart-all", label: "restart-all" }, { value: "reload-plugins" }] }, "restart")).toBe(false);
    expect(offersCommand({ prefix: "", items: [] }, "restart")).toBe(false);
    expect(offersCommand({ t: "state" }, "restart")).toBe(false);
    expect(offersCommand(null, "restart")).toBe(false);
  });
});
