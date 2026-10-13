// Shared setup for the browser suites: a headless Chromium (playwright-core), the app built into
// a temp folder (this checkout's dist/ may be serving the live app), and a page on a Sandbox.
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from "playwright-core";
import { Sandbox, until } from "../server-harness";

const REPO = resolve(import.meta.dir, "../..");

/** `TERN_AWUI_CHROMIUM`, else the newest Playwright headless shell in its cache; null: the suite skips. */
function findChromium(): string | null {
  const env = process.env.TERN_AWUI_CHROMIUM;
  if (env) return existsSync(env) ? env : null;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  const found = [...new Bun.Glob("chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell").scanSync({ cwd: cache, onlyFiles: true })]
    .map((path) => ({ path, revision: Number(/chromium_headless_shell-(\d+)/.exec(path)?.[1] ?? 0) }))
    .sort((a, b) => b.revision - a.revision);
  return found[0] ? join(cache, found[0].path) : null;
}

export const CHROMIUM = findChromium();

let built: Promise<string> | undefined;
/** The app built by this checkout's build.ts into a temp folder, once per test process. */
export function buildApp(): Promise<string> {
  built ??= (async () => {
    const root = mkdtempSync(`${tmpdir()}/tern-awui-e2e-dist-`);
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    // build.ts writes next to itself: give it a checkout whose dist/ is this temp folder.
    copyFileSync(join(REPO, "build.ts"), join(root, "build.ts"));
    for (const f of ["web", "assets", "node_modules", "tsconfig.json", "package.json"]) symlinkSync(join(REPO, f), join(root, f));
    const proc = Bun.spawn([process.execPath, join(root, "build.ts")], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`build failed: ${await new Response(proc.stderr).text()}`);
    return join(root, "dist");
  })();
  return built;
}

let browser: Promise<Browser> | undefined;
export function launch(): Promise<Browser> {
  browser ??= chromium.launch({ executablePath: CHROMIUM! });
  return browser;
}
export async function closeBrowser() {
  const b = await browser;
  browser = undefined;
  await b?.close();
}

export const PHONE = { width: 412, height: 900 };
export const DESKTOP = { width: 1400, height: 900 };

/** A sandboxed server serving the temp build. */
export async function startSandbox(setup?: (s: Sandbox) => void): Promise<Sandbox> {
  const s = new Sandbox();
  s.dist = await buildApp();
  setup?.(s);
  await s.start();
  return s;
}

/** `posts`: every POST the page made (path, JSON body); `errors`: its uncaught exceptions. */
export type App = { context: BrowserContext; page: Page; posts: { path: string; body: unknown }[]; errors: string[] };

/**
 * A browser context as a phone (or desktop) behind Tailscale Serve: every request carries the
 * allowed login. Block service workers so their caching cannot mask the build under test.
 */
export async function openApp(s: Sandbox, viewport = PHONE, hash = "#/"): Promise<App> {
  const phone = viewport === PHONE;
  const context = await (await launch()).newContext({
    viewport,
    hasTouch: phone,
    isMobile: phone,
    extraHTTPHeaders: s.headers,
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(3500);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === s.base ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  const posts: App["posts"] = [];
  const errors: string[] = [];
  page.on("request", (r: Request) => {
    if (r.method() !== "POST") return;
    const path = new URL(r.url()).pathname;
    let body: unknown = null;
    try {
      body = r.postDataJSON();
    } catch {
      body = r.postData();
    }
    posts.push({ path, body });
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(s.base + "/" + hash);
  return { context, page, posts, errors };
}

/** The bodies POSTed to `path` so far. */
export function bodies(app: App, path: string): unknown[] {
  return app.posts.filter((p) => p.path === path).map((p) => p.body);
}

/** Waits for all matching elements to have exactly these trimmed texts. */
export async function texts(locator: Locator, want: string[], timeout = 4000): Promise<string[]> {
  let last: string[] = [];
  try {
    await until(async () => {
      last = (await locator.allTextContents()).map((t) => t.trim());
      return last.length === want.length && last.every((text, i) => text === want[i]);
    }, "texts", timeout);
  } catch {
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(last)}`);
  }
  return last;
}

export { until };
