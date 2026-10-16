import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { type Action, type PlanInput, appUrl, execute, parseArgs, parseTailscaleStatus, plan, psString, windowsStopScript } from "../install";

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
  const [, unit] = writes(actions);

  test("builds, links the extension, retires the old tern-mobile unit, writes the unit, starts it, serves it", () => {
    expect(actions.map((a) => a.kind)).toEqual(["run", "symlink", "write", "run", "remove", "write", "run", "run", "run", "run"]);
    expect(actions[0]).toEqual({ kind: "run", argv: ["/home/ann/.bun/bin/bun", "build.ts"], cwd: linux.repo });
    expect(actions[1]).toEqual({
      kind: "symlink",
      path: "/home/ann/.omp/agent/extensions/tern-mobile.ts",
      target: "/home/ann/My Code/tern-awui/omp-extension/tern-mobile.ts",
    });
    expect(unit.path).toBe("/home/ann/.config/systemd/user/tern-awui.service");
    expect(actions[4]).toEqual({ kind: "remove", path: "/home/ann/.config/systemd/user/tern-mobile.service" });
    expect(runs(actions).slice(1)).toEqual([
      ["systemctl", "--user", "disable", "--now", "tern-mobile.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "tern-awui.service"],
      ["systemctl", "--user", "restart", "tern-awui.service"],
      ["/usr/bin/tailscale", "serve", "--bg", "--https=4380", "http://127.0.0.1:4380"],
    ]);
  });

  test("the unit quotes paths with spaces and sets PATH, port and logins", () => {
    expect(unit.content).toContain("WorkingDirectory=/home/ann/My Code/tern-awui\n");
    expect(unit.content).toContain('ExecStart="/home/ann/.bun/bin/bun" "/home/ann/My Code/tern-awui/server.ts"\n');
    expect(unit.content).toContain('Environment="PATH=/home/ann/.local/bin:/home/ann/bin:/home/ann/.bun/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.content).toContain('Environment="TERN_AWUI_PORT=4380"\n');
    expect(unit.content).toContain('Environment="TERN_AWUI_ALLOW=ann@example.com,bob@example.com"\n');
    expect(unit.content).toContain("Restart=on-failure\n");
    expect(unit.content).toContain("WantedBy=default.target\n");
  });

  test("systemd specifiers, quotes and $ in paths are escaped", () => {
    const [, u] = writes(plan({ ...linux, repo: '/home/ann/100% "x" $y', extraEnv: { TERN_AWUI_VAPID_SUBJECT: "mailto:a@b" } }));
    expect(u.content).toContain('WorkingDirectory=/home/ann/100%% "x" $y\n');
    expect(u.content).toContain('ExecStart="/home/ann/.bun/bin/bun" "/home/ann/100%% \\"x\\" $$y/server.ts"\n');
    expect(u.content).toContain('Environment="TERN_AWUI_VAPID_SUBJECT=mailto:a@b"\n');
  });

  test("systemd does not expand dollars in the executable name", () => {
    const [, u] = writes(plan({ ...linux, bun: "/home/ann/$tools/bun", repo: "/home/ann/$code" }));
    expect(u.content).toContain('ExecStart="/home/ann/$tools/bun" "/home/ann/$$code/server.ts"\n');
  });

  test("the port flows into the unit, serve and the app URL", () => {
    const a = plan({ ...linux, port: 5000 });
    expect(writes(a)[1].content).toContain('Environment="TERN_AWUI_PORT=5000"');
    expect(runs(a).at(-1)).toEqual(["/usr/bin/tailscale", "serve", "--bg", "--https=5000", "http://127.0.0.1:5000"]);
    expect(appUrl("box.tail1234.ts.net.", 5000)).toBe("https://box.tail1234.ts.net:5000/");
  });

  test("no step touches an access token or a pairing link; the printed URL is the plain app URL", () => {
    for (const a of [...plan(linux), ...plan(darwin), ...plan(win32)]) {
      // The only removal while installing is the pre-rename unit.
      if (a.kind === "remove") expect(a.path).toEndWith("/tern-mobile.service");
      else expect(["run", "symlink", "copy", "write"]).toContain(a.kind);
    }
    for (const argv of runs(plan(linux))) expect(argv).not.toContain("pair");
    expect(appUrl("box.tail1234.ts.net.", 4380)).toBe("https://box.tail1234.ts.net:4380/");
    expect(appUrl("box.tail1234.ts.net", 4380)).toBe("https://box.tail1234.ts.net:4380/");
  });

  test("uninstall stops and removes the unit, the extension link and the serve entry", () => {
    expect(plan({ ...linux, uninstall: true })).toEqual([
      { kind: "run", argv: ["systemctl", "--user", "disable", "--now", "tern-awui.service"], mayFail: true },
      { kind: "remove", path: "/home/ann/.config/systemd/user/tern-awui.service" },
      { kind: "run", argv: ["systemctl", "--user", "disable", "--now", "tern-mobile.service"], mayFail: true },
      { kind: "remove", path: "/home/ann/.config/systemd/user/tern-mobile.service" },
      { kind: "run", argv: ["systemctl", "--user", "daemon-reload"] },
      { kind: "remove", path: "/home/ann/.omp/agent/extensions/tern-mobile.ts" },
      {
        kind: "remove",
        path: "/home/ann/.config/tern-mobile/bridge.json",
        ifContent: '{"endpoint":"ws://127.0.0.1:4380/bridge","tokenFile":"/home/ann/.config/tern-mobile/bridge-token"}\n',
      },
      { kind: "run", argv: ["/usr/bin/tailscale", "serve", "--https=4380", "off"], mayFail: true },
    ]);
  });
});

describe("plan: darwin", () => {
  const actions = plan(darwin);
  const [, plist] = writes(actions);

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
    expect(plist.content).toContain("<key>TERN_AWUI_ALLOW</key><string>ann@example.com,bob@example.com</string>");
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
      {
        kind: "remove",
        path: "/Users/ann/.config/tern-mobile/bridge.json",
        ifContent: '{"endpoint":"ws://127.0.0.1:4380/bridge","tokenFile":"/Users/ann/.config/tern-mobile/bridge-token"}\n',
      },
      { kind: "run", argv: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "serve", "--https=4380", "off"], mayFail: true },
    ]);
  });
});

describe("plan: win32", () => {
  const actions = plan(win32);
  const [, launcher, task] = writes(actions);

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
    expect(r[2].at(-1)).toBe(
      windowsStopScript(4380, {
        bun: "C:\\Users\\Ann\\.bun\\bin\\bun.exe",
        server: "C:\\Users\\Ann\\My Code\\tern-awui\\server.ts",
        launcher: "C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui.vbs",
      }, true),
    );
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
    expect(launcher.content).toContain('env("TERN_AWUI_PORT") = "4380"');
    expect(launcher.content).toContain('env("TERN_AWUI_ALLOW") = "ann@example.com,bob@example.com"');
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
      "C:\\Users\\Ann\\.config\\tern-mobile\\bridge.json",
    ]);
    expect(u.every((a) => a.kind !== "run" || a.mayFail)).toBe(true);
  });

  test("install stops only our bun server and launcher and fails on a foreign listener instead of killing it", () => {
    const stop = actions.find((a) => a.kind === "run" && a.argv[0] === "powershell.exe") as Extract<Action, { kind: "run" }>;
    expect(stop.mayFail).toBeUndefined();
    const ps = stop.argv.at(-1)!;
    expect(ps).toContain(
      "$bun = 'C:\\Users\\Ann\\.bun\\bin\\bun.exe'; $server = 'C:\\Users\\Ann\\My Code\\tern-awui\\server.ts'; $vbs = 'C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui.vbs'",
    );
    // Selection: never this helper, bun with server.ts as an argument, wscript/cscript with our .vbs as an argument.
    expect(ps).toContain("$_.ProcessId -ne $PID");
    expect(ps).toContain("($_.Name -eq 'bun.exe' -or $_.ExecutablePath -eq $bun) -and (Test-Arg $_.CommandLine $server)");
    expect(ps).toContain("@('wscript.exe', 'cscript.exe') -contains $_.Name -and (Test-Arg $_.CommandLine $vbs)");
    // The only Stop-Process targets that set, never a port owner.
    expect(ps.match(/Stop-Process -Id \$\S+/g)).toEqual(["Stop-Process -Id $_.ProcessId"]);
    expect(ps).toContain("$mine | ForEach-Object { Stop-Process");
    expect(ps).toMatch(/Get-NetTCPConnection -LocalPort 4380 .*Port 4380 is in use by another program.*exit 1/);
  });

  test("uninstall stops only our processes and never checks or touches the port", () => {
    const ps = windowsStopScript(4380, { bun: "b", server: "s", launcher: "v" }, false);
    expect(ps).not.toContain("Get-NetTCPConnection");
    expect(ps).not.toContain("exit 1");
  });

  test("psString escapes quotes for a PowerShell literal", () => {
    expect(psString("C:\\Ann's Code\\server.ts")).toBe("'C:\\Ann''s Code\\server.ts'");
    expect(windowsStopScript(1, { bun: "b", server: "C:\\Ann's $x \"q\"\\s.ts", launcher: "v" }, false)).toContain(
      "$server = 'C:\\Ann''s $x \"q\"\\s.ts'",
    );
  });
});

const pwsh = Bun.which("pwsh");
describe.skipIf(!pwsh)("windowsStopScript under pwsh with fake processes", () => {
  const ours = { bun: "C:\\Users\\Ann\\.bun\\bin\\bun.exe", server: "C:\\Ann's Code\\tern-awui\\server.ts", launcher: "C:\\Users\\Ann\\.config\\tern-mobile\\tern-awui.vbs" };
  type Proc = { id: number | "$PID"; name: string; cmd: string; exe?: string; port?: number };
  const run = (procs: Proc[], install: boolean) => {
    const script = windowsStopScript(4380, ours, install);
    const fake = procs
      .map((p) => `[pscustomobject]@{ ProcessId = ${p.id}; Name = ${psString(p.name)}; ExecutablePath = ${psString(p.exe ?? "")}; CommandLine = ${psString(p.cmd)}; Port = ${p.port ?? 0} }`)
      .join(", ");
    const mocks = [
      `$global:procs = [System.Collections.ArrayList]@(${fake})`,
      "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName) $global:procs.ToArray() }",
      "function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) Write-Output \"stopped $Id\"; $global:procs.Remove(@($global:procs | Where-Object { $_.ProcessId -eq $Id })[0]) }",
      "function Start-Sleep { [CmdletBinding()] param([int]$Seconds) }",
      "function Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) $global:procs | Where-Object { $_.Port -eq $LocalPort } | ForEach-Object { [pscustomobject]@{ OwningProcess = $_.ProcessId } } }",
    ].join("; ");
    const r = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", `${mocks}; ${script}`], { encoding: "utf8" });
    return { code: r.status, stopped: r.stdout.trim().split(/\r?\n/).filter(Boolean).sort(), err: r.stderr };
  };
  const server: Proc = { id: 10, name: "bun.exe", exe: ours.bun, cmd: `"${ours.bun}" "${ours.server}"`, port: 4380 };
  const wscript: Proc = { id: 11, name: "wscript.exe", cmd: `wscript.exe //B //NoLogo "${ours.launcher}"` };
  // The helper itself: its command line holds both paths (single-quoted in the script).
  const self: Proc = { id: "$PID", name: "powershell.exe", cmd: `powershell.exe -NoProfile -Command ${windowsStopScript(4380, ours, true)}` };
  const editor: Proc = { id: 21, name: "Code.exe", cmd: `"C:\\VSCode\\Code.exe" "${ours.server}"` };
  const notepad: Proc = { id: 22, name: "notepad.exe", cmd: `notepad.exe ${ours.launcher}` };
  const otherBun: Proc = { id: 23, name: "bun.exe", cmd: `bun.exe "${ours.server}.bak"` };
  const other: Proc = { id: 20, name: "app.exe", cmd: "C:\\other\\app.exe --listen", port: 4380 };
  const survivors = [self, editor, notepad, otherBun];

  // The first pwsh start alone can take several seconds on a cold runner.
  test("install stops our server and launcher only, then succeeds on a free port", () => {
    const r = run([server, wscript, ...survivors], true);
    expect(r.stopped).toEqual(["stopped 10", "stopped 11"]);
    expect(r.code).toBe(0);
  }, 30_000);

  test("install fails on an unrelated listener and leaves it running", () => {
    const r = run([server, other, ...survivors], true);
    expect(r.stopped).toEqual(["stopped 10"]);
    expect(r.err).toContain("Port 4380 is in use by another program (PID 20)");
    expect(r.code).toBe(1);
  });

  test("uninstall stops ours and ignores an unrelated listener", () => {
    const r = run([server, wscript, other, ...survivors], false);
    expect(r.stopped).toEqual(["stopped 10", "stopped 11"]);
    expect(r.code).toBe(0);
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

describe("bridge discovery", () => {
  for (const input of [linux, darwin, win32]) {
    test(`${input.platform} publishes the selected endpoint and token file before starting the service`, () => {
      const actions = plan({ ...input, port: 5123 });
      const [discovery] = writes(actions);
      const separator = input.platform === "win32" ? "\\" : "/";
      expect(discovery.path).toBe([input.home, ".config", "tern-mobile", "bridge.json"].join(separator));
      expect(JSON.parse(discovery.content)).toEqual({
        endpoint: "ws://127.0.0.1:5123/bridge",
        tokenFile: `${input.configDir}${separator}bridge-token`,
      });
      expect(actions.indexOf(discovery)).toBe(2);
    });
  }
});

test("installed services disable inherited development mode before Tailscale publishes them", () => {
  expect(writes(plan(linux))[1].content).toContain('Environment="TERN_AWUI_DEV=0"\n');
  expect(writes(plan(darwin))[1].content).toContain("<key>TERN_AWUI_DEV</key><string>0</string>");
  expect(writes(plan(win32))[1].content).toContain('env("TERN_AWUI_DEV") = "0"\r\n');
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
    const src = join(root, "src.ts");
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

  test("conditional removal keeps unrelated bridge settings and tolerates absence", () => {
    const file = `${root}/bridge.json`;
    const action: Action = { kind: "remove", path: file, ifContent: "ours\n" };
    writeFileSync(file, "another install\n");
    execute([action], { dryRun: false, log: () => {} });
    expect(readFileSync(file, "utf8")).toBe("another install\n");
    writeFileSync(file, "ours\n");
    execute([action, action], { dryRun: false, log: () => {} });
    expect(() => lstatSync(file)).toThrow();
  });

  test("a missing optional command does not abort later cleanup", () => {
    const file = `${root}/after-missing-command`;
    execute([
      { kind: "run", argv: [`${root}/missing-tool`], mayFail: true },
      { kind: "write", path: file, content: "finished" },
    ], { dryRun: false, log: () => {} });
    expect(readFileSync(file, "utf8")).toBe("finished");
    expect(() => execute([{ kind: "run", argv: [`${root}/missing-tool`] }], { dryRun: false, log: () => {} })).toThrow();
  });

  test("a failing run stops the run unless it may fail", () => {
    expect(() => execute([{ kind: "run", argv: [process.execPath, "-e", "process.exit(3)"] }], { dryRun: false, log: () => {} })).toThrow(
      "exited with 3",
    );
    execute([{ kind: "run", argv: [process.execPath, "-e", "process.exit(3)"], mayFail: true }], { dryRun: false, log: () => {} });
  });
});
