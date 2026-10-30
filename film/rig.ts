// The stage every take shares: a private Tern daemon and window, a tern-awui server and omp with the
// tern-mobile extension on a scratch HOME, the fake model, and headless Chromium pages. Tern runs on
// a private daemon with a scratch copy of your Tern settings, omp and the server on a scratch HOME,
// so your windows, sessions and live service stay out of it. The recorder shoots the filmed screens
// for the whole take, often while the camera is on one, a few times a second while it only shows
// small, and writes the frames, pointer moves, taps, touches, captions and scene changes to
// WORK/timeline.json for compose.py.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, CDPSession, Locator, Page } from "playwright-core";
import { CHROMIUM, closeBrowser, launch } from "../test/e2e/helpers";
import { until } from "../test/server-harness";

if (!CHROMIUM) throw new Error("no headless Chromium: install Playwright's chromium_headless_shell or set TERN_AWUI_CHROMIUM");

const REPO = resolve(import.meta.dir, "..");
const MODEL_PORT = 4598;
const SERVER_PORT = 4597;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
export const TERN_SIZE = [960, 640] as const;
const FONT = 16;
// Tern's title bar and bottom bar at font 16, which compose.py drops.
const TERN_CROP = [6, 48, TERN_SIZE[0] - 6, TERN_SIZE[1] - 34] as const;
export const WEB = { width: 1280, height: 760 };
export const PHONE = { width: 412, height: 800 };
const DPR = 2;
/** compose.py moves the camera over TRANSITION_MS after a cut, so the action waits that long. */
const TRANSITION_MS = 1700;

export type Surface = "tern" | "web" | "phone";
/** `phone:reply` is a close-up of the lower half of the phone's screen; `end` holds the last shot for the outro. */
export type Scene = Surface | "phone:reply" | "wide" | "end";
type Event =
  | { t: number; kind: "move" | "tap"; surface: Surface; x: number; y: number }
  | { t: number; kind: "touch"; phase: "down" | "move" | "up"; surface: "phone"; x: number; y: number }
  | { t: number; kind: "click"; surface: Surface }
  | { t: number; kind: "caption"; eyebrow: string; headline: string }
  | { t: number; kind: "scene"; scene: Scene };

/** A project folder: its name, and files committed to a git repository there when given. */
export type Folder = { name: string; files?: Record<string, string>; branch?: string };

export const sleep = (ms: number) => Bun.sleep(ms);

/**
 * Builds the scratch HOME in `work` (only a folder an earlier take made is cleared), starts the fake
 * model on `script` (a module exporting `pick`), the Tern daemon and window, and the server.
 * `extension`: what omp loads as tern-mobile (default the real one; the phone take wraps it).
 */
export async function setUp(o: { work: string; script: string; folders: Folder[]; stretch: boolean; extension?: string }) {
  const work = resolve(o.work);
  const sentinel = join(work, ".tern-awui-film");
  if (existsSync(work)) {
    if (!existsSync(sentinel)) throw new Error(`${work} exists and wasn't made by a film take: pick a new folder`);
    rmSync(work, { recursive: true, force: true });
  }
  const shots = join(work, "shots");
  mkdirSync(shots, { recursive: true });
  writeFileSync(sentinel, "");
  const home = join(work, "home");
  const agent = join(home, ".omp/agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  writeFileSync(join(agent, "models.yml"), `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${MODEL_PORT}\n    apiKey: x\n`);
  writeFileSync(
    join(agent, "config.yml"),
    `setupVersion: 2\nmodelRoles:\n  default: anthropic/claude-opus-5-5\nsymbolPreset: nerd\nhideThinkingBlock: true\nstartup:\n  changelogMode: "off"\nmarketplace:\n  autoUpdate: "off"\n`,
  );
  // A re-export, not a symlink: the module's own relative imports resolve from where it really is.
  writeFileSync(join(agent, "extensions/tern-mobile.ts"), `export { default } from ${JSON.stringify(o.extension ?? join(REPO, "omp-extension/tern-mobile.ts"))};\n`);
  // omp-stretch writes replies as stretches; a take that opens or deepens them loads it.
  let stretchFlag = "";
  const config = join(work, "tern-config");
  mkdirSync(join(config, "plugins"), { recursive: true });
  copyFileSync(join(process.env.TERN_CONFIG_DIR ?? join(homedir(), ".config/tern"), "settings.json"), join(config, "settings.json"));
  if (o.stretch) {
    const stretch = resolve(process.env.OMP_STRETCH ?? join(REPO, "../omp-stretch"));
    if (!existsSync(join(stretch, "stretch.ts"))) throw new Error(`no omp-stretch checkout at ${stretch}: set OMP_STRETCH`);
    writeFileSync(join(agent, "stretch.json"), `{"mode":"dense"}`);
    writeFileSync(join(config, "plugins/omp-stretch.path"), join(stretch, "tern-plugin"));
    stretchFlag = ` -e ${join(stretch, "stretch.ts")}`;
  }
  const dirs = o.folders.map((f) => {
    const dir = join(home, "code", f.name);
    mkdirSync(dir, { recursive: true });
    if (f.files) {
      for (const [path, text] of Object.entries(f.files)) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=film", "-c", "user.email=film@example.test", ...args]);
      git("init", "-q", "-b", f.branch ?? "main");
      git("add", ".");
      git("commit", "-q", "-m", "Start");
    }
    return dir;
  });

  // The film hides Tern's banners and the pane's alert glow: they would cover the conversation.
  writeFileSync(join(work, "film.css"), `div#banners.tn-bn-stack, div#banners.tn-bn-stack > div.tn-bn { display: none !important; }\n.tn-glow { display: none !important; }\n`);

  // Nothing that points at your own Tern pane, daemon, omp session or XDG folders.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(TERN_|PI_|OMP_|XDG_(DATA|STATE|CONFIG|CACHE)_HOME$)/.test(key)) env[key] = value;
  }
  Object.assign(env, { TERN_DAEMON_SOCKET: join(work, "d.sock"), TERN_CONFIG_DIR: config });
  // `ctl run` takes one word. HOME points omp at the film's home, the bridge at the film's server.
  const omp = `HOME=${home} TERN_AWUI_BRIDGE=ws://127.0.0.1:${SERVER_PORT}/bridge exec omp --model anthropic/claude-opus-5-5${stretchFlag}`;
  writeFileSync(join(work, "omp.sh"), `#!/bin/sh\ncd ${dirs[0]} && ${omp}\n`, { mode: 0o755 });
  // The other folders' tabs start omp in the folder Tern opens them in.
  writeFileSync(join(work, "omp-here.sh"), `#!/bin/sh\n${omp}\n`, { mode: 0o755 });

  const sock = join(work, "win.sock");
  const tern = async (...args: string[]): Promise<string> => {
    const p = Bun.spawn(["tern", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`tern ${args.join(" ")}: ${err || out}`);
    return out;
  };
  const ctl = async (...args: string[]): Promise<any> => {
    const p = Bun.spawn(["tern", "ctl", "--control", sock, ...args], { env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const line = out.split("\n").find((l) => l.startsWith("{"));
    const reply = line ? JSON.parse(line) : { ok: false, error: out };
    if (!reply.ok) throw new Error(`ctl ${args.join(" ")}: ${reply.error}`);
    return reply;
  };

  const procs: Bun.Subprocess[] = [
    Bun.spawn(["bun", join(import.meta.dir, "fake-model.ts"), String(MODEL_PORT), join(work, "model.log"), resolve(o.script)], { stdout: "ignore", stderr: "inherit" }),
    Bun.spawn(["tern", "daemon", "--socket", env.TERN_DAEMON_SOCKET], { env, stdout: "ignore", stderr: "ignore" }),
    Bun.spawn(["bun", join(REPO, "server.ts")], { cwd: home, env: { ...env, HOME: home, TERN_AWUI_PORT: String(SERVER_PORT) }, stdout: "ignore", stderr: "inherit" }),
  ];
  await sleep(1500);
  procs.push(Bun.spawn(["tern", "--control", sock], { cwd: work, env, stdout: "ignore", stderr: "ignore" }));
  await until(() => existsSync(sock), "the window's control socket", 10_000);
  await ctl("ready");
  await ctl("resize", String(TERN_SIZE[0]), String(TERN_SIZE[1]));
  await ctl("font", String(FONT));
  await ctl("css", "tern-awui-film", join(work, "film.css"));

  type Tree = { sessions: { tabs: { blocks: { id: number | string; cwd: string }[] }[] }[] };
  const blocks = async () => (JSON.parse(await tern("ls", "--json")) as Tree).sessions.flatMap((s) => s.tabs.flatMap((t) => t.blocks));

  const contexts: BrowserContext[] = [];
  return {
    work,
    home,
    dirs,
    tern,
    ctl,
    blocks,
    /** Starts omp in the first folder in the window's pane, and in the others in tabs of their own. */
    async startOmps() {
      await ctl("run", join(work, "omp.sh"));
      await sleep(1500);
      const first = (await blocks())[0].id;
      for (const dir of dirs.slice(1)) await tern("new", "tab", "--cwd", dir, "--", join(work, "omp-here.sh"));
      return String(first);
    },
    /** Types `prompt` into the omp in `dir` and sends it. */
    async prompt(dir: string, prompt: string) {
      const id = String((await blocks()).find((b) => b.cwd === dir)!.id);
      await tern("send", id, "text", "--", prompt);
      await tern("send", id, "keys", "Enter");
    },
    async open(viewport: { width: number; height: number }, phone: boolean): Promise<Page> {
      const context = await (await launch()).newContext({ viewport, deviceScaleFactor: DPR, isMobile: phone, hasTouch: phone, serviceWorkers: "block" });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(`${BASE}/#/`);
      return page;
    },
    async tearDown() {
      for (const context of contexts) await context.close().catch(() => {});
      await closeBrowser();
      await ctl("quit").catch(() => {});
      for (const p of procs) p.kill();
    },
  };
}

type Rig = Awaited<ReturnType<typeof setUp>>;

/**
 * Records a take of `surfaces`: start() begins shooting, the helpers act and log what compose.py
 * draws (pointer, taps, touches, captions, camera cuts), finish() writes the timeline.
 */
export function recorder(rig: Rig, o: { surfaces: Surface[]; pages: Partial<Record<"web" | "phone", Page>>; first: Scene }) {
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const shots = join(rig.work, "shots");
  const ternShots = join(rig.work, "target/shots/tern/live");
  const frames: Partial<Record<Surface, { t: number; file: string }[]>> = Object.fromEntries(o.surfaces.map((s) => [s, []]));
  const events: Event[] = [];
  let scene: Scene = o.first;
  let previous: Scene = o.first;
  let cutAt = 0;
  let filming = false;
  let loops: Promise<void>[] = [];
  const pointer: Record<Surface, { x: number; y: number }> = { tern: { x: 0, y: 0 }, web: { x: 0, y: 0 }, phone: { x: 0, y: 0 } };
  const page = (s: "web" | "phone") => o.pages[s]!;
  let cdp: CDPSession | undefined;

  /**
   * Shoots `surface` for the whole take: about 15 times a second while the camera is on it (or still
   * leaving it), 3 times a second while it only shows small in a wide shot.
   */
  async function shoot(surface: Surface) {
    const own = frames[surface]!;
    while (filming) {
      const t = now();
      const file = join(surface === "tern" ? ternShots : shots, `${surface}-${String(own.length).padStart(5, "0")}.png`);
      if (surface === "tern") await rig.ctl("shot", file.slice(ternShots.length + 1, -4));
      else await page(surface).screenshot({ path: file });
      own.push({ t, file });
      const on = (s: Scene) => s.split(":")[0] === surface;
      const close = on(scene) || (on(previous) && t - cutAt < TRANSITION_MS);
      await sleep(Math.max(0, (close ? 66 : 330) - (now() - t)));
    }
  }

  async function center(locator: Locator, dx = 0.5) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${locator} has no box`);
    return { x: box.x + box.width * dx, y: box.y + box.height / 2 };
  }

  async function glide(surface: Surface, x: number, y: number, ms = 450) {
    const from = pointer[surface];
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const at = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      pointer[surface] = at;
      if (surface === "tern") await rig.ctl("move", at.x.toFixed(1), at.y.toFixed(1));
      else await page(surface).mouse.move(at.x, at.y);
      events.push({ t: now(), kind: "move", surface, ...at });
      await sleep(ms / steps);
    }
  }

  /** A real touch point on the phone that compose.py draws as a finger. */
  async function touch(phase: "down" | "move" | "up", x: number, y: number) {
    cdp ??= await page("phone").context().newCDPSession(page("phone"));
    events.push({ t: now(), kind: "touch", phase, surface: "phone", x, y });
    const type = phase === "down" ? "touchStart" : phase === "move" ? "touchMove" : "touchEnd";
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: phase === "up" ? [] : [{ x, y, id: 1 }] });
  }

  return {
    now,
    /** Where each surface's pointer rests when shooting starts. */
    pointer,
    start() {
      filming = true;
      loops = o.surfaces.map(shoot);
      events.push({ t: now(), kind: "scene", scene: o.first });
      for (const s of o.surfaces) if (s !== "phone") events.push({ t: now(), kind: "move", surface: s, ...pointer[s] });
    },
    async cut(next: Scene) {
      previous = scene;
      scene = next;
      cutAt = now();
      events.push({ t: cutAt, kind: "scene", scene: next });
      await sleep(TRANSITION_MS);
    },
    caption: (eyebrow: string, headline: string) => events.push({ t: now(), kind: "caption", eyebrow, headline }),
    glide,
    center,
    /** Eases the pointer to `locator` and clicks it. */
    async click(locator: Locator, dx = 0.5) {
      const at = await center(locator, dx);
      await glide("web", at.x, at.y);
      await sleep(250);
      await page("web").mouse.click(at.x, at.y);
      events.push({ t: now(), kind: "click", surface: "web" });
    },
    /** A finger tap: compose.py draws the touch, Chromium gets a real touch event. */
    async tap(locator: Locator) {
      await locator.scrollIntoViewIfNeeded();
      const at = await center(locator);
      events.push({ t: now(), kind: "tap", surface: "phone", ...at });
      await sleep(220);
      await page("phone").touchscreen.tap(at.x, at.y);
    },
    /** Taps a stretch link on its first line: a link that wraps has its box's middle between lines. */
    async tapLink(locator: Locator) {
      await locator.scrollIntoViewIfNeeded();
      const r = await locator.evaluate((a) => {
        const first = a.getClientRects()[0];
        return { x: first.left + Math.min(first.width / 2, 60), y: first.top + first.height / 2 };
      });
      events.push({ t: now(), kind: "tap", surface: "phone", ...r });
      await sleep(220);
      await page("phone").touchscreen.tap(r.x, r.y);
    },
    touch,
    /** Drags a finger along `points` (CSS pixels), `ms` between each. */
    async drag(points: [number, number][], ms = 16) {
      for (const [x, y] of points) {
        await touch("move", x, y);
        await sleep(ms);
      }
    },
    async typeTern(text: string) {
      for (const ch of text) {
        await rig.ctl("type", JSON.stringify(ch));
        await sleep(14);
      }
    },
    /** Stops shooting and writes the timeline compose.py renders as docs/<name>.{gif,mp4}. */
    async finish(name: string, layout: "stage" | "phone") {
      filming = false;
      await Promise.all(loops);
      writeFileSync(
        join(rig.work, "timeline.json"),
        JSON.stringify({ name, layout, ternCrop: TERN_CROP, web: WEB, phone: PHONE, dpr: DPR, transitionMs: TRANSITION_MS, frames, events }, null, 1),
      );
      const seconds = (now() - events[0].t) / 1000;
      console.log(`${Object.values(frames).flat().length} frames over ${seconds.toFixed(1)} s -> ${join(rig.work, "timeline.json")}`);
    },
    stop() {
      filming = false;
    },
  };
}
