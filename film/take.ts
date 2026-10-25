// Films one take of the handover: a real omp with the tern-mobile extension in a real Tern window,
// a real tern-awui server, and the app in a desktop and a phone browser (headless Chromium), all
// answered by fake-model.ts. Tern runs on a private daemon with a scratch copy of your Tern settings,
// omp and the server on a scratch HOME, so your windows, sessions and live service stay out of it.
// All three screens are shot for the whole take, often while the camera is on one, a few times a
// second while it only shows small; the frames, pointer moves, taps, captions and scene changes go
// to WORK/timeline.json for compose.py.
//   bun film/take.ts [WORK]   (default /tmp/tern-awui-film)
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { CHROMIUM, closeBrowser, launch } from "../test/e2e/helpers";
import { until } from "../test/server-harness";
import { ASK_TERN, DRAFT_PHONE, DRAFT_TERN, DRAFT_WEB, ORDERS_TS, PAST, PROJECT, STRETCH_KEY_GIST, STRETCH_LIMIT_GIST, WHERE } from "./script";

if (!CHROMIUM) throw new Error("no headless Chromium: install Playwright's chromium_headless_shell or set TERN_AWUI_CHROMIUM");

const REPO = resolve(import.meta.dir, "..");
const WORK = resolve(process.argv[2] ?? "/tmp/tern-awui-film");
const MODEL_PORT = 4598;
const SERVER_PORT = 4597;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const SOCK = join(WORK, "win.sock");
const HOME = join(WORK, "home");
const CODE = join(HOME, "code", PROJECT);
const SHOTS = join(WORK, "shots");
const TERN_SHOTS = join(WORK, "target/shots/tern/live");
const TERN_SIZE = [960, 640] as const;
const FONT = 16;
// Tern's title bar and bottom bar at font 16, which compose.py drops.
const TERN_CROP = [6, 48, TERN_SIZE[0] - 6, TERN_SIZE[1] - 34] as const;
const WEB = { width: 1280, height: 760 };
const PHONE = { width: 412, height: 800 };
const DPR = 2;

// Only a folder an earlier take made (it holds SENTINEL) is cleared; anything else is refused.
const SENTINEL = join(WORK, ".tern-awui-film");
if (existsSync(WORK)) {
  if (!existsSync(SENTINEL)) throw new Error(`${WORK} exists and wasn't made by film/take.ts: pick a new folder`);
  rmSync(WORK, { recursive: true, force: true });
}
mkdirSync(SHOTS, { recursive: true });
writeFileSync(SENTINEL, "");
const agent = join(HOME, ".omp/agent");
mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(join(agent, "models.yml"), `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${MODEL_PORT}\n    apiKey: x\n`);
writeFileSync(
  join(agent, "config.yml"),
  `setupVersion: 2\nmodelRoles:\n  default: anthropic/claude-opus-5-5\nsymbolPreset: nerd\nhideThinkingBlock: true\nstartup:\n  changelogMode: "off"\nmarketplace:\n  autoUpdate: "off"\n`,
);
symlinkSync(join(REPO, "omp-extension/tern-mobile.ts"), join(agent, "extensions/tern-mobile.ts"));
// omp-stretch writes the done reply as stretches; the take opens, closes and deepens them.
const STRETCH = resolve(process.env.OMP_STRETCH ?? join(REPO, "../omp-stretch"));
if (!existsSync(join(STRETCH, "stretch.ts"))) throw new Error(`no omp-stretch checkout at ${STRETCH}: set OMP_STRETCH`);
writeFileSync(join(agent, "stretch.json"), `{"mode":"dense"}`);
mkdirSync(join(CODE, "src/api"), { recursive: true });
writeFileSync(join(CODE, "src/api/orders.ts"), ORDERS_TS);
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", CODE, "-c", "user.name=film", "-c", "user.email=film@example.test", ...args]);
git("init", "-q", "-b", "rate-limit");
git("add", ".");
git("commit", "-q", "-m", "Orders API");

// The other projects' folders: their sessions are started and prompted live before the take, since
// omp names a pane only when it titles a new session, not when it resumes one.
const pastDirs = PAST.map((p) => join(HOME, "code", p.project));
for (const dir of pastDirs) mkdirSync(dir, { recursive: true });

// The film hides Tern's banners and the pane's alert glow: they would cover the conversation.
writeFileSync(
  join(WORK, "film.css"),
  `div#banners.tn-bn-stack, div#banners.tn-bn-stack > div.tn-bn { display: none !important; }\n.tn-glow { display: none !important; }\n`,
);
const config = join(WORK, "tern-config");
mkdirSync(join(config, "plugins"), { recursive: true });
copyFileSync(join(process.env.TERN_CONFIG_DIR ?? join(homedir(), ".config/tern"), "settings.json"), join(config, "settings.json"));
writeFileSync(join(config, "plugins/omp-stretch.path"), join(STRETCH, "tern-plugin"));

// Nothing that points at your own Tern pane, daemon, omp session or XDG folders.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !/^(TERN_|PI_|OMP_|XDG_(DATA|STATE|CONFIG|CACHE)_HOME$)/.test(key)) env[key] = value;
}
Object.assign(env, { TERN_DAEMON_SOCKET: join(WORK, "d.sock"), TERN_CONFIG_DIR: config });
// `ctl run` takes one word. HOME points omp at the film's home, the bridge at the film's server.
const omp = `HOME=${HOME} TERN_AWUI_BRIDGE=ws://127.0.0.1:${SERVER_PORT}/bridge exec omp --model anthropic/claude-opus-5-5 -e ${join(STRETCH, "stretch.ts")}`;
writeFileSync(join(WORK, "omp.sh"), `#!/bin/sh\ncd ${CODE} && ${omp}\n`, { mode: 0o755 });
// The other projects' tabs start omp in the folder Tern opens them in.
writeFileSync(join(WORK, "omp-here.sh"), `#!/bin/sh\n${omp}\n`, { mode: 0o755 });

/** Tern's command line against the film's daemon and window. */
async function tern(...args: string[]): Promise<string> {
  const p = Bun.spawn(["tern", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`tern ${args.join(" ")}: ${err || out}`);
  return out;
}

const sleep = (ms: number) => Bun.sleep(ms);
const t0 = performance.now();
const now = () => performance.now() - t0;

async function ctl(...args: string[]): Promise<any> {
  const p = Bun.spawn(["tern", "ctl", "--control", SOCK, ...args], { env, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").find((l) => l.startsWith("{"));
  const reply = line ? JSON.parse(line) : { ok: false, error: out };
  if (!reply.ok) throw new Error(`ctl ${args.join(" ")}: ${reply.error}`);
  return reply;
}

const procs: Bun.Subprocess[] = [
  Bun.spawn(["bun", join(import.meta.dir, "fake-model.ts"), String(MODEL_PORT), join(WORK, "model.log")], { stdout: "ignore", stderr: "inherit" }),
  Bun.spawn(["tern", "daemon", "--socket", env.TERN_DAEMON_SOCKET], { env, stdout: "ignore", stderr: "ignore" }),
  Bun.spawn(["bun", join(REPO, "server.ts")], { cwd: HOME, env: { ...env, HOME, TERN_AWUI_PORT: String(SERVER_PORT) }, stdout: "ignore", stderr: "inherit" }),
];
await sleep(1500);
procs.push(Bun.spawn(["tern", "--control", SOCK], { cwd: WORK, env, stdout: "ignore", stderr: "ignore" }));

type Surface = "tern" | "web" | "phone";
/** `phone:reply` is a close-up of the lower half of the phone's screen. */
type Scene = Surface | "phone:reply" | "wide";
type Event =
  | { t: number; kind: "move" | "tap"; surface: Surface; x: number; y: number }
  | { t: number; kind: "click"; surface: Surface }
  | { t: number; kind: "caption"; eyebrow: string; headline: string }
  | { t: number; kind: "scene"; scene: Scene };
const frames: Record<Surface, { t: number; file: string }[]> = { tern: [], web: [], phone: [] };
const events: Event[] = [];
let scene: Scene = "wide";
let previous: Scene = "wide";
let cutAt = 0;
const pointer: Record<Surface, { x: number; y: number }> = { tern: { x: 0, y: 0 }, web: { x: 0, y: 0 }, phone: { x: 0, y: 0 } };
let pages: { web: Page; phone: Page } | undefined;

/**
 * Shoots `surface` for the whole take: about 15 times a second while the camera is on it (or still
 * leaving it), 3 times a second while it only shows small in a wide shot.
 */
async function shoot(surface: Surface) {
  while (filming) {
    const t = now();
    const file = join(surface === "tern" ? TERN_SHOTS : SHOTS, `${surface}-${String(frames[surface].length).padStart(5, "0")}.png`);
    if (surface === "tern") await ctl("shot", file.slice(TERN_SHOTS.length + 1, -4));
    else await pages![surface].screenshot({ path: file });
    frames[surface].push({ t, file });
    const on = (s: Scene) => s.split(":")[0] === surface;
    const close = on(scene) || (on(previous) && t - cutAt < TRANSITION_MS);
    await sleep(Math.max(0, (close ? 66 : 330) - (now() - t)));
  }
}

let filming = false;
/** compose.py moves the camera over TRANSITION_MS after a cut, so the action waits that long. */
const TRANSITION_MS = 1700;
async function cut(next: Scene) {
  previous = scene;
  scene = next;
  cutAt = now();
  events.push({ t: cutAt, kind: "scene", scene: next });
  await sleep(TRANSITION_MS);
}
const caption = (eyebrow: string, headline: string) => events.push({ t: now(), kind: "caption", eyebrow, headline });

/** Eases the pointer to (x, y) in surface pixels, moving Tern's or the page's real pointer along. */
async function glide(surface: Surface, x: number, y: number, ms = 450) {
  const from = pointer[surface];
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const at = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
    pointer[surface] = at;
    if (surface === "tern") await ctl("move", at.x.toFixed(1), at.y.toFixed(1));
    else await pages![surface].mouse.move(at.x, at.y);
    events.push({ t: now(), kind: "move", surface, ...at });
    await sleep(ms / steps);
  }
}

async function center(locator: Locator, dx = 0.5) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return { x: box.x + box.width * dx, y: box.y + box.height / 2 };
}

async function click(locator: Locator, dx = 0.5) {
  const at = await center(locator, dx);
  await glide("web", at.x, at.y);
  await sleep(250);
  await pages!.web.mouse.click(at.x, at.y);
  events.push({ t: now(), kind: "click", surface: "web" });
}

/** A finger tap: compose.py draws the touch, Chromium gets a real touch event. */
async function tap(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const at = await center(locator);
  events.push({ t: now(), kind: "tap", surface: "phone", ...at });
  await sleep(220);
  await pages!.phone.touchscreen.tap(at.x, at.y);
}

/** Taps a stretch link on its first line: a link that wraps has its box's middle between lines. */
async function tapLink(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const r = await locator.evaluate((a) => {
    const first = a.getClientRects()[0];
    return { x: first.left + Math.min(first.width / 2, 60), y: first.top + first.height / 2 };
  });
  events.push({ t: now(), kind: "tap", surface: "phone", ...r });
  await sleep(220);
  await pages!.phone.touchscreen.tap(r.x, r.y);
}

async function typeTern(text: string) {
  for (const ch of text) {
    await ctl("type", JSON.stringify(ch));
    await sleep(14);
  }
}

const contexts: BrowserContext[] = [];
async function open(viewport: { width: number; height: number }, phone: boolean): Promise<Page> {
  const context = await (await launch()).newContext({ viewport, deviceScaleFactor: DPR, isMobile: phone, hasTouch: phone, serviceWorkers: "block" });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/#/`);
  return page;
}

try {
  await until(() => existsSync(SOCK), "the window's control socket", 10_000);
  await ctl("ready");
  await ctl("resize", String(TERN_SIZE[0]), String(TERN_SIZE[1]));
  await ctl("font", String(FONT));
  await ctl("css", "tern-awui-film", join(WORK, "film.css"));
  await ctl("run", join(WORK, "omp.sh"));
  await sleep(1500);
  // The other projects' sessions go in tabs of their own; the webshop pane keeps the window.
  type Tree = { sessions: { tabs: { blocks: { id: number | string; cwd: string }[] }[] }[] };
  const blocks = async () => (JSON.parse(await tern("ls", "--json")) as Tree).sessions.flatMap((s) => s.tabs.flatMap((t) => t.blocks));
  const webshop = (await blocks())[0].id;
  for (const dir of pastDirs) await tern("new", "tab", "--cwd", dir, "--", join(WORK, "omp-here.sh"));
  await sleep(9000);
  // Earlier work in the other projects: one prompt each, answered and titled by the fake model.
  for (const [n, dir] of pastDirs.entries()) {
    const id = String((await blocks()).find((b) => b.cwd === dir)!.id);
    await tern("send", id, "text", "--", PAST[n].prompt);
    await tern("send", id, "keys", "Enter");
  }
  await sleep(5000);
  await tern("focus", String(webshop));
  pages = { web: await open(WEB, false), phone: await open(PHONE, true) };
  // The film's session, wherever the list puts it; its title comes with the first prompt.
  const row = (page: Page) => page.locator(".row").filter({ hasText: "Rate limit" }).first();
  await pages.web.locator(".row").nth(PAST.length).waitFor({ timeout: 20_000 });
  await sleep(4000);
  pointer.tern = { x: TERN_SIZE[0] * 0.62, y: TERN_SIZE[1] * 0.72 };
  await ctl("move", String(pointer.tern.x), String(pointer.tern.y));
  pointer.web = { x: WEB.width * 0.7, y: WEB.height * 0.6 };
  await pages.web.mouse.move(pointer.web.x, pointer.web.y);

  filming = true;
  const loops = (["tern", "web", "phone"] as const).map(shoot);
  events.push({ t: now(), kind: "scene", scene: "wide" });
  events.push({ t: now(), kind: "move", surface: "tern", ...pointer.tern });
  events.push({ t: now(), kind: "move", surface: "web", ...pointer.web });
  caption("tern-awui", "One agent. Every screen.");
  await sleep(3200);

  // At the desk: a prompt in the Tern pane.
  caption("At the desk", "Start in Tern.");
  await cut("tern");
  await typeTern(ASK_TERN);
  await sleep(300);
  await ctl("key", "Enter");
  await sleep(4500);
  caption("At the desk", "Walk away mid‑thought.");
  await sleep(500);
  await typeTern(DRAFT_TERN);
  await sleep(1400);

  // A browser elsewhere: the same session, the draft waiting in the composer.
  caption("In any browser", "Your draft is already there.");
  await cut("web");
  await click(row(pages.web), 0.3);
  const textarea = pages.web.locator("textarea");
  await textarea.waitFor();
  await until(async () => (await textarea.inputValue()).startsWith(DRAFT_TERN), "the Tern draft in the browser", 5000);
  await sleep(1500);
  caption("In any browser", "Finish it. Send it.");
  await click(textarea, 0.9);
  await pages.web.keyboard.press("Control+End");
  await textarea.pressSequentially(DRAFT_WEB, { delay: 45 });
  await sleep(400);
  await click(pages.web.getByRole("button", { name: "Send", exact: true }));
  await pages.web.locator(".ask .opt").first().waitFor({ timeout: 8000 });
  await sleep(1400);

  // On the phone: the session waits for an answer.
  caption("On your phone", "Red means it needs you.");
  await cut("phone");
  await sleep(900);
  await tap(row(pages.phone));
  const option = pages.phone.locator(".ask .opt").filter({ hasText: WHERE.options[0] }).first();
  await option.waitFor();
  caption("On your phone", "One tap answers.");
  await sleep(1500);
  await tap(option);
  await pages.phone.locator(".assistant table").waitFor({ timeout: 12_000 });
  await sleep(1200);

  // omp-stretch: the reply's gists open in place, fold back, and ✦ asks the pane's model for more.
  const stretch = (op: string) => pages!.phone.locator(`.assistant a[href^='#stretch/${op}/']`);
  caption("With omp-stretch", "Tap a phrase. It opens in place.");
  await cut("phone:reply");
  await tapLink(stretch("open").filter({ hasText: STRETCH_KEY_GIST }));
  await sleep(1600);
  await tapLink(stretch("close").first());
  await sleep(1000);
  await tapLink(stretch("open").filter({ hasText: STRETCH_LIMIT_GIST }));
  await sleep(1300);
  caption("With omp-stretch", "Tap the star, and the model writes more.");
  await tapLink(stretch("deepen").first());
  await pages.phone.locator(".assistant", { hasText: "Well-behaved clients" }).first().waitFor({ timeout: 12_000 });
  await sleep(1800);
  caption("On your phone", "Reply on the go.");
  const phoneText = pages.phone.locator("textarea");
  await tap(phoneText);
  await sleep(300);
  await phoneText.pressSequentially(DRAFT_PHONE, { delay: 60 });
  await sleep(1300);

  // Back at the desk: the open stretches and the ✦ answer are in the pane too, the draft in omp's editor.
  caption("Back at the desk", "Same stretches, open here too.");
  await cut("tern");
  await sleep(2200);
  caption("Back at the desk", "Send it from Tern.");
  await glide("tern", TERN_SIZE[0] * 0.86, TERN_SIZE[1] * 0.83, 600);
  await sleep(700);
  await ctl("key", "Enter");
  await sleep(3800);

  caption("tern-awui", "Leave the desk. Keep the agent.");
  await cut("wide");
  await sleep(3500);

  filming = false;
  await Promise.all(loops);
  writeFileSync(join(WORK, "timeline.json"), JSON.stringify({ ternCrop: TERN_CROP, web: WEB, phone: PHONE, dpr: DPR, transitionMs: TRANSITION_MS, frames, events }, null, 1));
  const seconds = (now() - events[0].t) / 1000;
  console.log(`${Object.values(frames).flat().length} frames over ${seconds.toFixed(1)} s -> ${join(WORK, "timeline.json")}`);
} finally {
  filming = false;
  for (const context of contexts) await context.close().catch(() => {});
  await closeBrowser();
  await ctl("quit").catch(() => {});
  for (const p of procs) p.kill();
}
