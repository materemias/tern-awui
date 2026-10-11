// Installs tern-awui as a per-user service: `bun install.ts [--uninstall] [--port N] [--dry-run]`.
// Linux: systemd user unit, macOS: LaunchAgent, Windows: a scheduled task at logon. `plan` is pure (the
// list of file writes and commands for one platform); `execute` carries it out or, with --dry-run, prints it.
import { copyFileSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type Platform = "linux" | "darwin" | "win32";

export interface PlanInput {
  platform: Platform;
  uninstall: boolean;
  home: string;
  /** The checkout (this file's directory). */
  repo: string;
  /** Absolute path of the bun binary (`process.execPath`). */
  bun: string;
  /** Absolute paths of `tern` and `omp`; their folders go first on the service's PATH. Unused when uninstalling. */
  tern: string;
  omp: string;
  tailscale: string;
  /** `~/.omp/agent` unless TERN_MOBILE_OMP_DIR. */
  ompDir: string;
  /** `~/.config/tern-mobile` unless TERN_MOBILE_CONFIG. */
  configDir: string;
  port: number;
  /** Allowed Tailscale logins. Unused when uninstalling. */
  allow: string[];
  /** The machine's tailnet DNS name, trailing dot allowed. Unused when uninstalling. */
  dnsName: string;
  /** Further TERN_MOBILE_* settings baked into the service (see PASSTHROUGH_ENV). */
  extraEnv: Record<string, string>;
  /** macOS: the user's uid (launchctl domain `gui/<uid>`). */
  uid: number;
  /** Windows: `DOMAIN\user` the logon trigger and principal name. */
  winUser: string;
}

export type Action =
  /** Creates parent folders; replaces whatever is at `path` (a symlink included) with a real file. */
  | { kind: "write"; path: string; content: string; encoding?: "utf8" | "utf16le" }
  /** Replaces whatever is at `path` with a symlink to `target`. */
  | { kind: "symlink"; path: string; target: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "remove"; path: string }
  | { kind: "run"; argv: string[]; cwd?: string; mayFail?: boolean }
  /** Runs `bun server.ts pair`, whose one stdout line is appended to `base` to form the pairing URL. */
  | { kind: "pair"; argv: string[]; cwd: string; base: string };

export const SERVICE_NAME = "tern-mobile";
export const LAUNCHD_LABEL = "dev.tern-awui";
export const TASK_NAME = "tern-awui";
const DESCRIPTION = "tern-awui: phone control surface for Tern panes";
/** Settings passed through from the installer's environment into the service when set. */
export const PASSTHROUGH_ENV = [
  "TERN_MOBILE_CONFIG",
  "TERN_MOBILE_OMP_DIR",
  "TERN_MOBILE_NOTES_DIR",
  "TERN_MOBILE_PROJECTS",
  "TERN_MOBILE_VAPID_SUBJECT",
];

function pathFor(platform: Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The service's PATH entries: the folders of tern, omp and bun, then the system defaults. */
export function servicePath(input: PlanInput): string[] {
  const p = pathFor(input.platform);
  const dirs = [input.tern, input.omp, input.bun].map((f) => p.dirname(f));
  if (input.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  else if (input.platform === "linux") dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(dirs)];
}

function serviceEnv(input: PlanInput): [string, string][] {
  return [
    ["TERN_MOBILE_PORT", String(input.port)],
    ["TERN_MOBILE_ALLOW", input.allow.join(",")],
    ...Object.entries(input.extraEnv),
  ];
}

// systemd: `%` starts a specifier everywhere; inside double quotes `\` and `"` are escaped; in ExecStart `$` expands.
const sdSpec = (s: string) => s.replaceAll("%", "%%");
const sdQuote = (s: string) => `"${sdSpec(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const sdExecArg = (s: string) => sdQuote(s).replaceAll("$", "$$$$");

export function systemdUnit(input: PlanInput): string {
  const server = path.posix.join(input.repo, "server.ts");
  const env = [["PATH", servicePath(input).join(":")] as [string, string], ...serviceEnv(input)];
  return [
    "[Unit]",
    `Description=${DESCRIPTION}`,
    "After=default.target",
    "",
    "[Service]",
    `WorkingDirectory=${sdSpec(input.repo)}`,
    ...env.map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    `ExecStart=${sdExecArg(input.bun)} ${sdExecArg(server)}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export const xmlEscape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function launchdPlist(input: PlanInput): string {
  const str = (s: string) => `<string>${xmlEscape(s)}</string>`;
  const log = path.posix.join(input.home, "Library", "Logs", "tern-awui.log");
  const env = [["PATH", servicePath(input).join(":")] as [string, string], ...serviceEnv(input)];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${str(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    `  <array>${str(input.bun)}${str(path.posix.join(input.repo, "server.ts"))}</array>`,
    `  <key>WorkingDirectory</key>${str(input.repo)}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>${str(v)}`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>3</integer>",
    `  <key>StandardOutPath</key>${str(log)}`,
    `  <key>StandardErrorPath</key>${str(log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const vbsString = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Runs bun with no window and restarts it 3 s after it exits, like systemd's Restart= and launchd's KeepAlive. */
export function windowsLauncher(input: PlanInput): string {
  const server = path.win32.join(input.repo, "server.ts");
  const cmd = `"${input.bun}" "${server}"`;
  return [
    "' tern-awui launcher, written by install.ts. Started at logon by the scheduled task tern-awui.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${vbsString(input.repo)}`,
    'Set env = sh.Environment("Process")',
    `env("PATH") = ${vbsString(servicePath(input).join(";") + ";")} & env("PATH")`,
    ...serviceEnv(input).map(([k, v]) => `env(${vbsString(k)}) = ${vbsString(v)}`),
    "Do",
    `  sh.Run ${vbsString(cmd)}, 0, True`,
    "  WScript.Sleep 3000",
    "Loop",
    "",
  ].join("\r\n");
}

/** Task Scheduler XML: a logon trigger for this user only (no admin needed) and no 72-hour run limit. */
export function windowsTask(input: PlanInput, launcher: string): string {
  const user = xmlEscape(input.winUser);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xmlEscape(DESCRIPTION)}</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    `    <Exec><Command>wscript.exe</Command><Arguments>${xmlEscape(`//B //NoLogo "${launcher}"`)}</Arguments></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** PowerShell single-quoted literal: only `'` needs escaping (doubled). */
export function psString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

export type OurProcesses = { bun: string; server: string; launcher: string };

/**
 * Stops only tern-awui's own processes: bun (by name or our bun path) with our server.ts as an argument, and
 * wscript/cscript with our .vbs as an argument (the launcher; its bun outlives `schtasks /End`). Excludes
 * this helper ($PID), whose own command line contains both paths, and e.g. an editor open on server.ts.
 * Never stops by port: on install, anything still listening afterwards is someone else's, so it fails instead.
 */
export function windowsStopScript(port: number, ours: OurProcesses, checkConflict: boolean): string {
  const lines = [
    // Paths are case-insensitive on Windows; an argument is the exact path, quoted or space-delimited.
    "function Test-Arg($c, $p) { $c = $c.ToLowerInvariant(); $p = $p.ToLowerInvariant(); $c.Contains('\"' + $p + '\"') -or $c.EndsWith(' ' + $p) -or $c.Contains(' ' + $p + ' ') }",
    `$bun = ${psString(ours.bun)}; $server = ${psString(ours.server)}; $vbs = ${psString(ours.launcher)}`,
    "$mine = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and (" +
      "(($_.Name -eq 'bun.exe' -or $_.ExecutablePath -eq $bun) -and (Test-Arg $_.CommandLine $server)) -or " +
      "(@('wscript.exe', 'cscript.exe') -contains $_.Name -and (Test-Arg $_.CommandLine $vbs))) })",
    "$mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ];
  if (checkConflict) {
    lines.push(
      "if ($mine.Count -gt 0) { Start-Sleep -Seconds 1 }",
      `$held = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)`,
      `if ($held.Count -gt 0) { [Console]::Error.WriteLine("Port ${port} is in use by another program (PID $($held -join ', ')); stop it or pick another --port."); exit 1 }`,
    );
  }
  return lines.join("; ");
}

function windowsStopServer(port: number, ours: OurProcesses, install: boolean): Action {
  const ps = windowsStopScript(port, ours, install);
  return { kind: "run", argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], ...(install ? {} : { mayFail: true }) };
}

export function plan(input: PlanInput): Action[] {
  const p = pathFor(input.platform);
  const extension = p.join(input.ompDir, "extensions", "tern-mobile.ts");
  const extensionSource = p.join(input.repo, "omp-extension", "tern-mobile.ts");
  const serveOn: Action = { kind: "run", argv: [input.tailscale, "serve", "--bg", `--https=${input.port}`, `http://127.0.0.1:${input.port}`] };
  const serveOff: Action = { kind: "run", argv: [input.tailscale, "serve", `--https=${input.port}`, "off"], mayFail: true };

  const unit = p.join(input.home, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  const systemctl = (...args: string[]): Extract<Action, { kind: "run" }> => ({ kind: "run", argv: ["systemctl", "--user", ...args] });
  const plist = p.join(input.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const bootout: Action = { kind: "run", argv: ["launchctl", "bootout", `gui/${input.uid}/${LAUNCHD_LABEL}`], mayFail: true };
  const launcher = p.join(input.configDir, "tern-awui.vbs");
  const taskXml = p.join(input.configDir, "tern-awui-task.xml");
  const endTask: Action = { kind: "run", argv: ["schtasks", "/End", "/TN", TASK_NAME], mayFail: true };
  const ours: OurProcesses = { bun: input.bun, server: p.join(input.repo, "server.ts"), launcher };

  if (input.uninstall) {
    const service: Action[] =
      input.platform === "linux"
        ? [{ ...systemctl("disable", "--now", `${SERVICE_NAME}.service`), mayFail: true }, { kind: "remove", path: unit }, systemctl("daemon-reload")]
        : input.platform === "darwin"
          ? [bootout, { kind: "remove", path: plist }]
          : [
              endTask,
              windowsStopServer(input.port, ours, false),
              { kind: "run", argv: ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], mayFail: true },
              { kind: "remove", path: launcher },
              { kind: "remove", path: taskXml },
            ];
    return [...service, { kind: "remove", path: extension }, serveOff];
  }

  const base = `https://${input.dnsName.replace(/\.$/, "")}:${input.port}`;
  const actions: Action[] = [
    { kind: "run", argv: [input.bun, "build.ts"], cwd: input.repo },
    input.platform === "win32"
      ? { kind: "copy", from: extensionSource, to: extension }
      : { kind: "symlink", path: extension, target: extensionSource },
    // Before the service starts, so the server and this command don't both create the access token.
    { kind: "pair", argv: [input.bun, p.join(input.repo, "server.ts"), "pair"], cwd: input.repo, base },
  ];
  if (input.platform === "linux") {
    actions.push(
      { kind: "write", path: unit, content: systemdUnit(input) },
      systemctl("daemon-reload"),
      systemctl("enable", `${SERVICE_NAME}.service`),
      // restart, not `enable --now`: a re-run applies the new unit to a running server.
      systemctl("restart", `${SERVICE_NAME}.service`),
    );
  } else if (input.platform === "darwin") {
    actions.push(
      { kind: "write", path: plist, content: launchdPlist(input) },
      bootout,
      { kind: "run", argv: ["launchctl", "bootstrap", `gui/${input.uid}`, plist] },
    );
  } else {
    actions.push(
      // UTF-16 with a BOM: what wscript and schtasks read reliably for non-ASCII paths.
      { kind: "write", path: launcher, content: windowsLauncher(input), encoding: "utf16le" },
      { kind: "write", path: taskXml, content: windowsTask(input, launcher), encoding: "utf16le" },
      endTask,
      windowsStopServer(input.port, ours, true),
      { kind: "run", argv: ["schtasks", "/Create", "/TN", TASK_NAME, "/XML", taskXml, "/F"] },
      { kind: "run", argv: ["schtasks", "/Run", "/TN", TASK_NAME] },
    );
  }
  actions.push(serveOn);
  return actions;
}

export function quoteArg(a: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`;
}

export function describe(a: Action): string {
  switch (a.kind) {
    case "write":
      return `write ${a.path}${a.encoding === "utf16le" ? " (UTF-16LE)" : ""}\n${a.content.replace(/\r?\n$/, "").replace(/^/gm, "    ")}`;
    case "symlink":
      return `symlink ${a.path} -> ${a.target}`;
    case "copy":
      return `copy ${a.from} -> ${a.to}`;
    case "remove":
      return `remove ${a.path}`;
    case "run":
      return `run ${a.argv.map(quoteArg).join(" ")}${a.cwd ? `  (in ${a.cwd})` : ""}${a.mayFail ? "  (failure ignored)" : ""}`;
    case "pair":
      return `pair ${a.argv.map(quoteArg).join(" ")}  (in ${a.cwd}; URL starts ${a.base})`;
  }
}

function replace(file: string): void {
  // lstat: a dangling symlink still has to go; rmSync then removes the link, never its target.
  try {
    lstatSync(file);
  } catch {
    return;
  }
  rmSync(file, { force: true });
}

/** Carries out the actions in order; returns the pairing URL when a `pair` action ran. */
export function execute(actions: Action[], opts: { dryRun: boolean; log?: (line: string) => void }): string | undefined {
  const log = opts.log ?? console.log;
  let pairUrl: string | undefined;
  for (const a of actions) {
    log(`${opts.dryRun ? "[dry-run] " : ""}${describe(a)}`);
    if (opts.dryRun) continue;
    switch (a.kind) {
      case "write": {
        mkdirSync(path.dirname(a.path), { recursive: true });
        replace(a.path);
        const body = a.encoding === "utf16le" ? Buffer.from(`\ufeff${a.content}`, "utf16le") : a.content;
        writeFileSync(a.path, body);
        break;
      }
      case "symlink":
        mkdirSync(path.dirname(a.path), { recursive: true });
        replace(a.path);
        symlinkSync(a.target, a.path);
        break;
      case "copy":
        mkdirSync(path.dirname(a.to), { recursive: true });
        replace(a.to);
        copyFileSync(a.from, a.to);
        break;
      case "remove":
        replace(a.path);
        break;
      case "run": {
        const r = Bun.spawnSync(a.argv, { cwd: a.cwd, stdout: "inherit", stderr: "inherit" });
        if (r.exitCode !== 0 && !a.mayFail) throw new Error(`${a.argv.join(" ")} exited with ${r.exitCode}`);
        break;
      }
      case "pair": {
        const r = Bun.spawnSync(a.argv, { cwd: a.cwd, stderr: "inherit" });
        const line = r.stdout.toString().trim();
        if (r.exitCode !== 0 || !line.startsWith("/pair?code=")) throw new Error(`${a.argv.join(" ")} failed (exit ${r.exitCode}): ${line}`);
        pairUrl = a.base + line;
        break;
      }
    }
  }
  return pairUrl;
}

export interface Args {
  uninstall: boolean;
  dryRun: boolean;
  port?: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { uninstall: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uninstall") args.uninstall = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a === "--port" ? argv[++i] : a.slice("--port=".length);
      args.port = parsePort(v, "--port");
    } else throw new Error(`unknown argument: ${a} (usage: bun install.ts [--uninstall] [--port N] [--dry-run])`);
  }
  return args;
}

function parsePort(v: string | undefined, what: string): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${what}: not a port: ${v}`);
  return n;
}

/** `.Self.DNSName` and the login of the device's own user from `tailscale status --json`. */
export function parseTailscaleStatus(json: string): { dnsName: string; login: string } {
  const s = JSON.parse(json) as { Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }> };
  const dnsName = s.Self?.DNSName ?? "";
  const login = s.Self?.UserID === undefined ? "" : (s.User?.[String(s.Self.UserID)]?.LoginName ?? "");
  if (!dnsName) throw new Error("tailscale status: no Self.DNSName (is MagicDNS on and the device logged in?)");
  return { dnsName, login };
}

function which(name: string, platform: Platform): string {
  const found = Bun.which(name) ?? (platform === "darwin" && name === "tailscale" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : null);
  if (!found) throw new Error(`${name} not found on PATH`);
  return found;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") throw new Error(`unsupported platform: ${platform}`);
  const env = process.env;
  const home = homedir();
  const p = pathFor(platform);
  const port = args.port ?? (env.TERN_MOBILE_PORT ? parsePort(env.TERN_MOBILE_PORT, "TERN_MOBILE_PORT") : 4380);
  const tailscale = which("tailscale", platform);
  let tern = "", omp = "", dnsName = "", allow: string[] = [];
  if (!args.uninstall) {
    tern = which("tern", platform);
    omp = which("omp", platform);
    const r = Bun.spawnSync([tailscale, "status", "--json"], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`tailscale status failed: ${r.stderr.toString()}`);
    const status = parseTailscaleStatus(r.stdout.toString());
    dnsName = status.dnsName;
    allow = (env.TERN_MOBILE_ALLOW ?? status.login).split(",").map((s) => s.trim()).filter(Boolean);
    if (allow.length === 0) throw new Error("no allowed login: set TERN_MOBILE_ALLOW (tailscale reports no user for this device)");
  }
  const extraEnv = Object.fromEntries(PASSTHROUGH_ENV.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
  const actions = plan({
    platform,
    uninstall: args.uninstall,
    home,
    repo: import.meta.dir,
    bun: process.execPath,
    tern,
    omp,
    tailscale,
    ompDir: env.TERN_MOBILE_OMP_DIR ?? p.join(home, ".omp", "agent"),
    configDir: env.TERN_MOBILE_CONFIG ?? p.join(home, ".config", "tern-mobile"),
    port,
    allow,
    dnsName,
    extraEnv,
    uid: process.getuid?.() ?? 0,
    winUser: env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME ?? ""}` : (env.USERNAME ?? ""),
  });
  const url = execute(actions, { dryRun: args.dryRun });
  if (args.uninstall) console.log(args.dryRun ? "\nwould uninstall tern-awui" : "\ntern-awui uninstalled (config and tokens kept)");
  else if (args.dryRun) console.log("\nwould print the pairing URL: <base> + the output of `bun server.ts pair`");
  else console.log(`\nOpen this link on the phone to pair it (it holds the access token; anyone with it and an allowed login gets in):\n${url}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    console.error(`install.ts: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
