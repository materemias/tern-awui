import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type MainDeps, main } from "../install";

// The fake tailscale, tern, omp and systemctl are shell scripts, which Windows cannot run from PATH.
const POSIX = process.platform !== "win32";

const STATUS = JSON.stringify({ Self: { DNSName: "box.tail1234.ts.net.", UserID: 7 }, User: { "7": { LoginName: "ann@example.com" } } });

let dir: string, home: string, bin: string, calls: string, repo: string, ompDir: string, configDir: string, out: string[];

/** A fake tool that appends `name argv...` to the calls file; `tailscale status --json` prints `$TS_STATUS`. */
function fake(name: string, body = "") {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\nexit 0\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "install-main-"));
  home = path.join(dir, "home");
  bin = path.join(dir, "bin");
  repo = path.join(dir, "repo");
  ompDir = path.join(dir, "omp");
  configDir = path.join(dir, "config");
  calls = path.join(dir, "calls");
  for (const d of [home, bin, repo]) mkdirSync(d);
  writeFileSync(calls, "");
  fake("tailscale", `[ "$1" = status ] && printf '%s' "$TS_STATUS"; [ "$1" = status ] && exit "\${TS_EXIT:-0}"`);
  for (const t of ["tern", "omp", "systemctl", "launchctl", "bun"]) fake(t);
  out = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(argv: string[], env: Record<string, string> = {}, platform = "linux"): MainDeps {
  return {
    argv,
    env: { PATH: bin, TS_STATUS: STATUS, TERN_AWUI_OMP_DIR: ompDir, TERN_AWUI_CONFIG: configDir, ...env },
    platform,
    home,
    repo,
    bun: path.join(bin, "bun"),
    uid: 1000,
    log: (l) => out.push(l),
  };
}
const recorded = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
const unit = () => path.join(home, ".config", "systemd", "user", "tern-mobile.service");
const extension = () => path.join(ompDir, "extensions", "tern-mobile.ts");

describe.skipIf(!POSIX)("main: linux", () => {
  test("--dry-run prints every action and changes nothing", () => {
    main(deps(["--dry-run"]));
    // Only the read-only status probe ran.
    expect(recorded()).toEqual(["tailscale status --json"]);
    expect(existsSync(path.join(home, ".config"))).toBe(false);
    expect(existsSync(ompDir)).toBe(false);
    const actions = out.filter((l) => l.startsWith("[dry-run] "));
    expect(actions).toHaveLength(8);
    expect(actions.join("\n")).toContain(unit());
    expect(actions.join("\n")).toContain(extension());
    expect(actions.at(-1)).toContain("serve --bg --https=4380 http://127.0.0.1:4380");
    expect(out.at(-1)).toBe("\nwould serve: https://box.tail1234.ts.net:4380/");
  });

  test("a real run writes the unit and symlink, calls the tools in order and prints the plain app URL", () => {
    main(deps([], { TERN_AWUI_NOTES_DIR: "/notes" }));
    const u = readFileSync(unit(), "utf8");
    expect(u).toContain("TERN_AWUI_ALLOW=ann@example.com");
    expect(u).toContain("TERN_AWUI_PORT=4380");
    expect(u).toContain("TERN_AWUI_NOTES_DIR=/notes");
    expect(u).toContain(`TERN_AWUI_OMP_DIR=${ompDir}`);
    expect(lstatSync(extension()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(home, ".config", "tern-mobile", "bridge.json"), "utf8"))).toEqual({
      endpoint: "ws://127.0.0.1:4380/bridge",
      tokenFile: path.join(configDir, "bridge-token"),
    });
    expect(readlinkSync(extension())).toBe(path.join(repo, "omp-extension", "tern-mobile.ts"));
    expect(recorded()).toEqual([
      "tailscale status --json",
      "bun build.ts",
      "systemctl --user daemon-reload",
      "systemctl --user enable tern-mobile.service",
      "systemctl --user restart tern-mobile.service",
      "tailscale serve --bg --https=4380 http://127.0.0.1:4380",
    ]);
    expect(out.at(-1)).toBe("\nOpen this on the phone (signed in to Tailscale as an allowed login): https://box.tail1234.ts.net:4380/");
  });

  test("--uninstall reverses the install without needing tern, omp or tailscale status", () => {
    main(deps([]));
    writeFileSync(calls, "");
    rmSync(path.join(bin, "tern"));
    rmSync(path.join(bin, "omp"));
    main(deps(["--uninstall"]));
    expect(existsSync(unit())).toBe(false);
    expect(() => lstatSync(extension())).toThrow();
    expect(recorded()).toEqual([
      "systemctl --user disable --now tern-mobile.service",
      "systemctl --user daemon-reload",
      "tailscale serve --https=4380 off",
    ]);
    expect(out.at(-1)).toBe("\ntern-awui uninstalled (config and tokens kept)");
  });

  test("--uninstall still removes the service after tailscale was removed", () => {
    main(deps([]));
    rmSync(path.join(bin, "tailscale"));
    main(deps(["--uninstall"]));
    expect(existsSync(unit())).toBe(false);
    expect(() => lstatSync(extension())).toThrow();
    expect(existsSync(path.join(home, ".config", "tern-mobile", "bridge.json"))).toBe(false);
    expect(out.some((line) => line.includes("warning:"))).toBe(true);
  });

  test("uninstall preserves discovery belonging to another configuration", () => {
    main(deps([]));
    const discovery = path.join(home, ".config", "tern-mobile", "bridge.json");
    const other = '{"endpoint":"ws://127.0.0.1:5999/bridge","tokenFile":"/another/config/bridge-token"}\n';
    writeFileSync(discovery, other);
    main(deps(["--uninstall"]));
    expect(readFileSync(discovery, "utf8")).toBe(other);
  });

  test("--uninstall --dry-run removes nothing", () => {
    main(deps([]));
    writeFileSync(calls, "");
    main(deps(["--uninstall", "--dry-run"]));
    expect(existsSync(unit())).toBe(true);
    expect(recorded()).toEqual([]);
    expect(out.at(-1)).toBe("\nwould uninstall tern-awui");
  });

  test("--port flows into the unit, tailscale serve and the URL", () => {
    main(deps(["--port", "5123"], { TERN_AWUI_PORT: "6000" }));
    expect(readFileSync(unit(), "utf8")).toContain("TERN_AWUI_PORT=5123");
    expect(recorded()).toContain("tailscale serve --bg --https=5123 http://127.0.0.1:5123");
    expect(JSON.parse(readFileSync(path.join(home, ".config", "tern-mobile", "bridge.json"), "utf8"))).toEqual({
      endpoint: "ws://127.0.0.1:5123/bridge",
      tokenFile: path.join(configDir, "bridge-token"),
    });
    expect(out.at(-1)).toEndWith(": https://box.tail1234.ts.net:5123/");
    writeFileSync(calls, "");
    main(deps(["--uninstall", "--port=5123"]));
    expect(recorded()).toContain("tailscale serve --https=5123 off");
  });

  test("TERN_AWUI_PORT is used without --port, and rejected when not a port", () => {
    main(deps(["--dry-run"], { TERN_AWUI_PORT: "4999" }));
    expect(out.at(-1)).toEndWith(":4999/");
    expect(() => main(deps(["--dry-run"], { TERN_AWUI_PORT: "99999" }))).toThrow("TERN_AWUI_PORT: not a port: 99999");
  });

  test("TERN_AWUI_ALLOW overrides the tailscale login, trimmed and split", () => {
    main(deps([], { TERN_AWUI_ALLOW: " bob@example.com , ,carl@example.com" }));
    expect(readFileSync(unit(), "utf8")).toContain("TERN_AWUI_ALLOW=bob@example.com,carl@example.com");
  });

  test("relative configured paths keep their installer working-directory meaning in the service", () => {
    const notes = path.join(dir, "notes");
    main(deps([], {
      TERN_AWUI_CONFIG: path.relative(process.cwd(), configDir),
      TERN_AWUI_OMP_DIR: path.relative(process.cwd(), ompDir),
      TERN_AWUI_NOTES_DIR: path.relative(process.cwd(), notes),
    }));
    const u = readFileSync(unit(), "utf8");
    expect(u).toContain(`TERN_AWUI_CONFIG=${configDir}`);
    expect(u).toContain(`TERN_AWUI_OMP_DIR=${ompDir}`);
    expect(u).toContain(`TERN_AWUI_NOTES_DIR=${notes}`);
    expect(readlinkSync(extension())).toBe(path.join(repo, "omp-extension", "tern-mobile.ts"));
    expect(JSON.parse(readFileSync(path.join(home, ".config", "tern-mobile", "bridge.json"), "utf8")).tokenFile).toBe(path.join(configDir, "bridge-token"));
  });

  test("defaults ompDir and configDir under HOME when the env leaves them unset", () => {
    const d = deps(["--dry-run"]);
    delete d.env.TERN_AWUI_OMP_DIR;
    delete d.env.TERN_AWUI_CONFIG;
    main(d);
    expect(out.join("\n")).toContain(path.join(home, ".omp", "agent", "extensions", "tern-mobile.ts"));
    expect(out.join("\n")).not.toContain("TERN_AWUI_CONFIG");
  });
});

describe.skipIf(!POSIX)("main: errors", () => {
  for (const tool of ["tailscale", "tern", "omp"]) {
    test(`missing ${tool} is a clear error and nothing is written`, () => {
      rmSync(path.join(bin, tool));
      expect(() => main(deps([]))).toThrow(`${tool} not found on PATH`);
      expect(existsSync(path.join(home, ".config"))).toBe(false);
    });
  }

  test("tailscale status failure is reported", () => {
    expect(() => main(deps([], { TS_EXIT: "3" }))).toThrow("tailscale status failed");
  });

  test("no login and no TERN_AWUI_ALLOW refuses to install an open server", () => {
    expect(() => main(deps([], { TS_STATUS: JSON.stringify({ Self: { DNSName: "box.ts.net." } }) }))).toThrow("no allowed login");
    expect(existsSync(unit())).toBe(false);
  });

  test("a failing systemctl stops the run before tailscale serve", () => {
    fake("systemctl", "exit 1");
    expect(() => main(deps([]))).toThrow("systemctl --user daemon-reload exited with 1");
    expect(recorded().some((l) => l.startsWith("tailscale serve"))).toBe(false);
  });

  test("unsupported platform and unknown arguments", () => {
    expect(() => main(deps([], {}, "freebsd"))).toThrow("unsupported platform: freebsd");
    expect(() => main(deps(["--force"]))).toThrow("unknown argument: --force");
  });

  test("CLI prints the error and exits 1", () => {
    const r = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "install.ts"), "--bogus"], {
      env: { PATH: bin, HOME: home },
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("install.ts: unknown argument: --bogus");
  });
});

describe.skipIf(!POSIX)("main: other platforms at plan level (dry run)", () => {
  test("darwin plans a LaunchAgent for the user's uid", () => {
    main(deps(["--dry-run"], {}, "darwin"));
    const text = out.join("\n");
    expect(text).toContain(path.join(home, "Library", "LaunchAgents", "dev.tern-awui.plist"));
    expect(text).toContain("launchctl bootstrap gui/1000");
    expect(recorded()).toEqual(["tailscale status --json"]);
  });

  test("darwin falls back to the Tailscale app bundle when tailscale is not on PATH", () => {
    rmSync(path.join(bin, "tailscale"));
    main(deps(["--uninstall", "--dry-run"], {}, "darwin"));
    expect(out.join("\n")).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=4380 off");
  });

  test("win32 names the scheduled task's user from USERDOMAIN\\USERNAME", () => {
    main(deps(["--dry-run"], { USERDOMAIN: "CORP", USERNAME: "ann" }, "win32"));
    expect(out.some((l) => l.includes("schtasks /Create"))).toBe(true);
    expect(existsSync(configDir)).toBe(false);
  });
});
