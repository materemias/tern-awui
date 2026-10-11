import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Action, type PlanInput, execute, parseArgs, parseTailscaleStatus, plan } from "../install";

const linux: PlanInput = {
  platform: "linux",
  uninstall: false,
  home: "/home/ann",
  repo: "/home/ann/My Code/tern-awui",
  bun: "/home/ann/.bun/bin/bun",
  tern: "/home/ann/.local/bin/tern",
  omp: "/home/ann/bin/omp",
  tailscale: "/usr/bin/tailscale",
  ompDir: "/home/ann/.omp/agent",
  configDir: "/home/ann/.config/tern-mobile",
  port: 4380,
  allow: ["ann@example.com", "bob@example.com"],
  dnsName: "box.tail1234.ts.net.",
  extraEnv: {},
  uid: 1000,
  winUser: "",
};
const darwin: PlanInput = {
  ...linux,
  platform: "darwin",
  home: "/Users/ann",
  repo: "/Users/ann/Code & Stuff/<tern>",
  bun: "/opt/homebrew/bin/bun",
  tern: "/usr/local/bin/tern",
  omp: "/Users/ann/.local/bin/omp",
  tailscale: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ompDir: "/Users/ann/.omp/agent",
  configDir: "/Users/ann/.config/tern-mobile",
  uid: 501,
};
const win32: PlanInput = {
  ...linux,
  platform: "win32",
  home: "C:\\Users\\Ann",
  repo: "C:\\Users\\Ann\\My Code\\tern-awui",
  bun: "C:\\Users\\Ann\\.bun\\bin\\bun.exe",
  tern: "C:\\Program Files\\Tern\\tern.exe",
  omp: "C:\\Users\\Ann\\.bun\\bin\\omp.exe",
  tailscale: "C:\\Program Files\\Tailscale\\tailscale.exe",
  ompDir: "C:\\Users\\Ann\\.omp\\agent",
  configDir: "C:\\Users\\Ann\\.config\\tern-mobile",
  winUser: "DESK\\Ann",
};

function writes(actions: Action[]): Extract<Action, { kind: "write" }>[] {
  return actions.filter((a): a is Extract<Action, { kind: "write" }> => a.kind === "write");
}
function runs(actions: Action[]): string[][] {
  return actions.flatMap((a) => (a.kind === "run" ? [a.argv] : []));
}

describe("plan: linux", () => {
  const actions = plan(linux);
  const [unit] = writes(actions);

  test("builds, links the extension, pairs, writes the unit, starts it, serves it", () => {
    expect(actions.map((a) => a.kind)).toEqual(["run", "symlink", "pair", "write", "run", "run", "run", "run"]);
    expect(actions[0]).toEqual({ kind: "run", argv: ["/home/ann/.bun/bin/bun", "build.ts"], cwd: linux.repo });
    expect(actions[1]).toEqual({
      kind: "symlink",
      path: "/home/ann/.omp/agent/extensions/tern-mobile.ts",
      target: "/home/ann/My Code/tern-awui/omp-extension/tern-mobile.ts",
    });
    expect(actions[2]).toEqual({
      kind: "pair",
      argv: ["/home/ann/.bun/bin/bun", "/home/ann/My Code/tern-awui/server.ts", "pair"],
      cwd: linux.repo,
      base: "https://box.tail1234.ts.net:4380",
    });
    expect(unit.path).toBe("/home/ann/.config/systemd/user/tern-mobile.service");
    expect(runs(actions).slice(1)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "tern-mobile.service"],
      ["systemctl", "--user", "restart", "tern-mobile.service"],
      ["/usr/bin/tailscale", "serve", "--bg", "--https=4380", "http://127.0.0.1:4380"],
    ]);
  });

  test("the unit quotes paths with spaces and sets PATH, port and logins", () => {
    expect(unit.content).toContain("WorkingDirectory=/home/ann/My Code/tern-awui\n");
    expect(unit.content).toContain('ExecStart="/home/ann/.bun/bin/bun" "/home/ann/My Code/tern-awui/server.ts"\n');
    expect(unit.content).toContain('Environment="PATH=/home/ann/.local/bin:/home/ann/bin:/home/ann/.bun/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.content).toContain('Environment="TERN_MOBILE_PORT=4380"\n');
    expect(unit.content).toContain('Environment="TERN_MOBILE_ALLOW=ann@example.com,bob@example.com"\n');
    expect(unit.content).toContain("Restart=on-failure\n");
    expect(unit.content).toContain("WantedBy=default.target\n");
  });

  test("systemd specifiers, quotes and $ in paths are escaped", () => {
    const [u] = writes(plan({ ...linux, repo: '/home/ann/100% "x" $y', extraEnv: { TERN_MOBILE_VAPID_SUBJECT: "mailto:a@b" } }));
    expect(u.content).toContain('WorkingDirectory=/home/ann/100%% "x" $y\n');
    expect(u.content).toContain('ExecStart="/home/ann/.bun/bin/bun" "/home/ann/100%% \\"x\\" $$y/server.ts"\n');
    expect(u.content).toContain('Environment="TERN_MOBILE_VAPID_SUBJECT=mailto:a@b"\n');
  });

  test("the port flows into the unit, serve and the pairing URL", () => {
    const a = plan({ ...linux, port: 5000 });
    expect(writes(a)[0].content).toContain('Environment="TERN_MOBILE_PORT=5000"');
    expect(runs(a).at(-1)).toEqual(["/usr/bin/tailscale", "serve", "--bg", "--https=5000", "http://127.0.0.1:5000"]);
    expect(a.find((x) => x.kind === "pair")).toMatchObject({ base: "https://box.tail1234.ts.net:5000" });
  });

  test("uninstall stops and removes the unit, the extension link and the serve entry", () => {
    expect(plan({ ...linux, uninstall: true })).toEqual([
      { kind: "run", argv: ["systemctl", "--user", "disable", "--now", "tern-mobile.service"], mayFail: true },
      { kind: "remove", path: "/home/ann/.config/systemd/user/tern-mobile.service" },
      { kind: "run", argv: ["systemctl", "--user", "daemon-reload"] },
      { kind: "remove", path: "/home/ann/.omp/agent/extensions/tern-mobile.ts" },
      { kind: "run", argv: ["/usr/bin/tailscale", "serve", "--https=4380", "off"], mayFail: true },
    ]);
  });
});

describe("plan: darwin", () => {
  const actions = plan(darwin);
  const [plist] = writes(actions);

  test("symlinks the extension and bootstraps a LaunchAgent", () => {
    expect(actions[1]).toEqual({
      kind: "symlink",
      path: "/Users/ann/.omp/agent/extensions/tern-mobile.ts",
      target: "/Users/ann/Code & Stuff/<tern>/omp-extension/tern-mobile.ts",
    });
    expect(plist.path).toBe("/Users/ann/Library/LaunchAgents/dev.tern-awui.plist");
    expect(runs(actions).slice(1)).toEqual([
      ["launchctl", "bootout", "gui/501/dev.tern-awui"],
      ["launchctl", "bootstrap", "gui/501", "/Users/ann/Library/LaunchAgents/dev.tern-awui.plist"],
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "serve", "--bg", "--https=4380", "http://127.0.0.1:4380"],
    ]);
    expect(actions.find((a) => a.kind === "run" && a.argv[1] === "bootout")).toMatchObject({ mayFail: true });
  });

  test("the plist escapes XML and keeps the server alive", () => {
    expect(plist.content).toContain("<key>Label</key><string>dev.tern-awui</string>");
    expect(plist.content).toContain(
      "<array><string>/opt/homebrew/bin/bun</string><string>/Users/ann/Code &amp; Stuff/&lt;tern&gt;/server.ts</string></array>",
    );
    expect(plist.content).toContain("<key>WorkingDirectory</key><string>/Users/ann/Code &amp; Stuff/&lt;tern&gt;</string>");
    expect(plist.content).toContain(
      "<key>PATH</key><string>/usr/local/bin:/Users/ann/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
    expect(plist.content).toContain("<key>TERN_MOBILE_ALLOW</key><string>ann@example.com,bob@example.com</string>");
    expect(plist.content).toContain("<key>KeepAlive</key><true/>");
    expect(plist.content).not.toMatch(/Code & |<tern>/);
    // Well-formed: every opened element closes.
    for (const tag of ["plist", "dict", "array"]) {
      expect(plist.content.split(`<${tag}`).length).toBe(plist.content.split(`</${tag}>`).length);
    }
  });

  test("uninstall boots out and removes the agent, the extension and the serve entry", () => {
    expect(plan({ ...darwin, uninstall: true })).toEqual([
      { kind: "run", argv: ["launchctl", "bootout", "gui/501/dev.tern-awui"], mayFail: true },
      { kind: "remove", path: "/Users/ann/Library/LaunchAgents/dev.tern-awui.plist" },
      { kind: "remove", path: "/Users/ann/.omp/agent/extensions/tern-mobile.ts" },
      { kind: "run", argv: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "serve", "--https=4380", "off"], mayFail: true },
    ]);
  });
});

describe("plan: win32", () => {
  const actions = plan(win32);
  const [launcher, task] = writes(actions);

  test("copies the extension instead of linking it", () => {
    expect(actions[1]).toEqual({
      kind: "copy",
      from: "C:\\Users\\Ann\\My Code\\tern-awui\\omp-extension\\tern-mobile.ts",
      to: "C:\\Users\\Ann\\.omp\\agent\\extensions\\tern-mobile.ts",
    });
    expect(actions.some((a) => a.kind === "symlink")).toBe(false);
  });

  test("registers the task from XML, restarting a running server, then serves it", () => {
    const r = runs(actions);
    expect(r[1]).toEqual(["schtasks", "/End", "/TN", "tern-awui"]);
    expect(r[2][0]).toBe("powershell.exe");
    expect(r[2].at(-1)).toContain("Get-NetTCPConnection -LocalPort 4380 -State Listen");
    expect(r.slice(3)).toEqual([
      ["schtasks", "/Create", "/TN", "tern-awui", "/XML", "C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui-task.xml", "/F"],
      ["schtasks", "/Run", "/TN", "tern-awui"],
      ["C:\\Program Files\\Tailscale\\tailscale.exe", "serve", "--bg", "--https=4380", "http://127.0.0.1:4380"],
    ]);
  });

  test("the launcher runs bun hidden, with PATH, port and logins, and restarts it", () => {
    expect(launcher.path).toBe("C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui.vbs");
    expect(launcher.encoding).toBe("utf16le");
    expect(launcher.content).toContain('sh.CurrentDirectory = "C:\\Users\\Ann\\My Code\\tern-awui"');
    expect(launcher.content).toContain(
      'env("PATH") = "C:\\Program Files\\Tern;C:\\Users\\Ann\\.bun\\bin;" & env("PATH")',
    );
    expect(launcher.content).toContain('env("TERN_MOBILE_PORT") = "4380"');
    expect(launcher.content).toContain('env("TERN_MOBILE_ALLOW") = "ann@example.com,bob@example.com"');
    expect(launcher.content).toContain(
      'sh.Run """C:\\Users\\Ann\\.bun\\bin\\bun.exe"" ""C:\\Users\\Ann\\My Code\\tern-awui\\server.ts""", 0, True',
    );
    expect(launcher.content).toMatch(/Do\r\n.*\r\n {2}WScript\.Sleep 3000\r\nLoop/);
  });

  test("the task triggers at this user's logon with no run-time limit", () => {
    expect(task.path).toBe("C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui-task.xml");
    expect(task.encoding).toBe("utf16le");
    expect(task.content).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>DESK\\Ann</UserId></LogonTrigger>");
    expect(task.content).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(task.content).toContain(
      "<Command>wscript.exe</Command><Arguments>//B //NoLogo &quot;C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui.vbs&quot;</Arguments>",
    );
  });

  test("uninstall ends and deletes the task, stops the server, removes the files and the serve entry", () => {
    const u = plan({ ...win32, uninstall: true });
    expect(runs(u).map((a) => a[0] === "powershell.exe" ? "powershell.exe" : a.join(" "))).toEqual([
      "schtasks /End /TN tern-awui",
      "powershell.exe",
      "schtasks /Delete /TN tern-awui /F",
      "C:\\Program Files\\Tailscale\\tailscale.exe serve --https=4380 off",
    ]);
    expect(u.flatMap((a) => (a.kind === "remove" ? [a.path] : []))).toEqual([
      "C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui.vbs",
      "C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui-task.xml",
      "C:\\Users\\Ann\\.omp\\agent\\extensions\\tern-mobile.ts",
    ]);
    expect(u.every((a) => a.kind !== "run" || a.mayFail)).toBe(true);
  });
});

describe("parseArgs", () => {
  test("flags and port", () => {
    expect(parseArgs([])).toEqual({ uninstall: false, dryRun: false });
    expect(parseArgs(["--uninstall", "--dry-run", "--port", "5000"])).toEqual({ uninstall: true, dryRun: true, port: 5000 });
    expect(parseArgs(["--port=4400"]).port).toBe(4400);
  });
  test("rejects bad ports and unknown flags", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow("not a port");
    expect(() => parseArgs(["--port"])).toThrow("not a port");
    expect(() => parseArgs(["--port", "12ab"])).toThrow("not a port");
    expect(() => parseArgs(["--force"])).toThrow("unknown argument");
  });
});

describe("parseTailscaleStatus", () => {
  test("reads the DNS name and the device user's login", () => {
    const json = JSON.stringify({
      Self: { DNSName: "box.tail1234.ts.net.", UserID: 42 },
      User: { "42": { LoginName: "ann@example.com" }, "7": { LoginName: "other@example.com" } },
    });
    expect(parseTailscaleStatus(json)).toEqual({ dnsName: "box.tail1234.ts.net.", login: "ann@example.com" });
  });
  test("a tagged device has no login; no DNS name is an error", () => {
    expect(parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "x.ts.net.", UserID: 9 }, User: {} })).login).toBe("");
    expect(() => parseTailscaleStatus(JSON.stringify({ Self: {} }))).toThrow("DNSName");
  });
});

describe("execute", () => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/tern-awui-install-`));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("dry run only prints", () => {
    const lines: string[] = [];
    const file = `${root}/dry/unit.service`;
    execute([{ kind: "write", path: file, content: "a\nb\n" }, { kind: "run", argv: ["false"] }], { dryRun: true, log: (l) => lines.push(l) });
    expect(lines).toEqual([`[dry-run] write ${file}\n    a\n    b`, "[dry-run] run false"]);
    expect(() => lstatSync(file)).toThrow();
  });

  test("write replaces a symlink with a real file and leaves the link's target alone", () => {
    const target = `${root}/repo.service`;
    const unit = `${root}/systemd/user/tern-mobile.service`;
    writeFileSync(target, "old");
    mkdirSync(`${root}/systemd/user`, { recursive: true });
    symlinkSync(target, unit);
    execute([{ kind: "write", path: unit, content: "new" }], { dryRun: false, log: () => {} });
    expect(lstatSync(unit).isSymbolicLink()).toBe(false);
    expect(readFileSync(unit, "utf8")).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("old");
  });

  test("symlink replaces a stale file; copy overwrites; remove tolerates absence", () => {
    const src = `${root}/src.ts`;
    writeFileSync(src, "v1");
    const link = `${root}/ext/link.ts`;
    const copy = `${root}/ext/copy.ts`;
    mkdirSync(`${root}/ext`);
    writeFileSync(link, "stale");
    execute(
      [
        { kind: "symlink", path: link, target: src },
        { kind: "copy", from: src, to: copy },
      ],
      { dryRun: false, log: () => {} },
    );
    expect(readlinkSync(link)).toBe(src);
    writeFileSync(src, "v2");
    execute([{ kind: "copy", from: src, to: copy }], { dryRun: false, log: () => {} });
    expect(readFileSync(copy, "utf8")).toBe("v2");
    execute([{ kind: "remove", path: link }, { kind: "remove", path: `${root}/nope` }], { dryRun: false, log: () => {} });
    expect(() => lstatSync(link)).toThrow();
    expect(readFileSync(src, "utf8")).toBe("v2");
  });

  test("UTF-16 writes carry a BOM", () => {
    const f = `${root}/w.vbs`;
    execute([{ kind: "write", path: f, content: "Máté", encoding: "utf16le" }], { dryRun: false, log: () => {} });
    expect([...readFileSync(f)].slice(0, 2)).toEqual([0xff, 0xfe]);
    expect(readFileSync(f, "utf16le")).toBe("\ufeffMáté");
  });

  test("pair builds the URL from the command's line; failures stop the run", () => {
    const stub = `${root}/pair.ts`;
    writeFileSync(stub, 'console.log("/pair?code=abc_DEF-123")');
    const url = execute([{ kind: "pair", argv: [process.execPath, stub], cwd: root, base: "https://box.ts.net:4380" }], {
      dryRun: false,
      log: () => {},
    });
    expect(url).toBe("https://box.ts.net:4380/pair?code=abc_DEF-123");
    writeFileSync(stub, 'console.log("nope")');
    expect(() => execute([{ kind: "pair", argv: [process.execPath, stub], cwd: root, base: "x" }], { dryRun: false, log: () => {} })).toThrow(
      "failed",
    );
    expect(() => execute([{ kind: "run", argv: [process.execPath, "-e", "process.exit(3)"] }], { dryRun: false, log: () => {} })).toThrow(
      "exited with 3",
    );
    execute([{ kind: "run", argv: [process.execPath, "-e", "process.exit(3)"], mayFail: true }], { dryRun: false, log: () => {} });
  });
});
