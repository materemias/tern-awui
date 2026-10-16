// The session list in a real browser: grouping, filter, folding, hiding old sessions, the
// extension banner, leaving on back, and the desktop's two panes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { Extension, type Sandbox } from "../server-harness";
import { CHROMIUM, DESKTOP, closeBrowser, openApp, startSandbox, texts, until, type App } from "./helpers";

const EXTENSION_SOURCE = resolve(import.meta.dir, "../../omp-extension/tern-mobile.ts");

describe.skipIf(!CHROMIUM)("session list", () => {
  let s: Sandbox;
  let app: App;
  beforeAll(async () => {
    s = await startSandbox();
    // An idle omp in block 1: its recap shows, and its last activity (T0) is days old.
    const agent = new Extension(s);
    agent.snapshot.status = "idle";
    await agent.connect();
    app = await openApp(s);
  }, 20_000);
  afterAll(async () => {
    await app?.context.close();
    await closeBrowser();
    await s?.close();
  });
  afterEach(() => expect(app.errors).toEqual([]));

  test("groups blocks by project, newest first, with status dots, titles and the recap", async () => {
    const { page } = app;
    // The bridged agent's activity puts its project first; the home folder shows as ~.
    await texts(page.locator("h2.group-head > span:nth-child(2)"), ["alpha", "beta", "~"]);
    const alpha = page.locator("section", { has: page.locator("h2", { hasText: "alpha" }) });
    await texts(alpha.locator(".row .title"), ["Build phone UI", "htop"]);
    const omp = page.locator('a.row[href="#/b/1"]');
    expect(await omp.getAttribute("class")).toContain("st-idle");
    expect(await omp.locator(".dot").getAttribute("class")).toBe("dot dot-idle");
    expect(await omp.locator(".tag").textContent()).toBe("MOBILE");
    // Idle: omp's recap, marked earlier since turns followed it.
    expect(await omp.locator(".row-sub").getAttribute("class")).toBe("row-sub recap");
    expect(await omp.locator(".row-sub").textContent()).toBe("Earlier: Earlier recap");
    expect(await omp.locator(".age").textContent()).not.toBe("");
    // A shell has no status: a plain dot and no age.
    const shell = page.locator('a.row[href="#/b/2"]');
    expect(await shell.locator(".dot").getAttribute("class")).toBe("dot dot-shell");
    expect(await shell.locator(".age").textContent()).toBe("");
    expect(await page.locator('a.row[href="#/b/3"] .row-sub').textContent()).toBe("Note");
    expect(await page.locator('.counts span[title="1 idle"]').textContent()).toBe("1");
  });

  test("the filter matches project, tag, title and prompt; clearing it restores the list", async () => {
    const { page } = app;
    const filter = page.locator(".search input");
    await filter.fill("htop");
    await texts(page.locator(".row .title"), ["htop"]);
    await filter.fill("mobile");
    await texts(page.locator(".row .title"), ["Build phone UI"]);
    await filter.fill("BETA");
    await texts(page.locator(".row .title"), ["Terminal"]);
    await filter.fill("nothing like this");
    await texts(page.locator(".row"), []);
    await filter.fill("");
    await texts(page.locator(".row .title"), ["Build phone UI", "htop", "Terminal", "Note"]);
  });

  test("a folded project stays folded across reloads, and a filter still finds its rows", async () => {
    const { page } = app;
    await page.locator("h2.group-head", { hasText: "alpha" }).click();
    const alpha = page.locator("section", { has: page.locator("h2", { hasText: "alpha" }) });
    await texts(alpha.locator(".row"), []);
    expect(await alpha.getAttribute("class")).toBe("shut");
    expect(await alpha.locator(".chev").textContent()).toBe("▸");
    expect(await page.evaluate(() => localStorage.getItem("tern-mobile:collapsed-projects"))).toBe('["alpha"]');
    await page.reload();
    await texts(page.locator(".row .title"), ["Terminal", "Note"]);
    expect(await page.locator("section.shut h2 > span:nth-child(2)").textContent()).toBe("alpha");
    await page.locator(".search input").fill("phone");
    await texts(page.locator(".row .title"), ["Build phone UI"]);
    await page.locator(".search input").fill("");
    await page.locator("h2.group-head", { hasText: "alpha" }).click();
    await texts(page.locator(".row .title"), ["Build phone UI", "htop", "Terminal", "Note"]);
    expect(await page.evaluate(() => localStorage.getItem("tern-mobile:collapsed-projects"))).toBe("[]");
  });

  test("hiding old sessions drops the idle day-old omp, counts it, and persists", async () => {
    const { page } = app;
    const clock = page.locator('header.bar button[aria-label*="older than a day"]');
    expect(await clock.getAttribute("aria-label")).toBe("Hide sessions older than a day");
    await clock.click();
    // Blocks without a time (shells, the note, htop) always stay.
    await texts(page.locator(".row .title"), ["htop", "Terminal", "Note"]);
    expect(await clock.getAttribute("aria-label")).toBe("Show 1 sessions older than a day");
    expect(await clock.locator(".icon-count").textContent()).toBe("1");
    // A filter searches the hidden ones too.
    await page.locator(".search input").fill("phone");
    await texts(page.locator(".row .title"), ["Build phone UI"]);
    await page.locator(".search input").fill("");
    await page.reload();
    await texts(page.locator(".row .title"), ["htop", "Terminal", "Note"]);
    await clock.click();
    await texts(page.locator(".row .title"), ["Build phone UI", "htop", "Terminal", "Note"]);
    expect(await page.evaluate(() => localStorage.getItem("tern-mobile:hide-old"))).toBe("off");
  });

  test("the extension banner names the missing file and the fix, and goes once it is installed", async () => {
    const { page } = app;
    const installed = `${s.home}/.omp/agent/extensions/tern-mobile.ts`;
    const banner = page.locator(".ext-banner");
    await until(async () => (await banner.textContent())?.includes(`No tern-mobile extension at ${installed}`), "missing banner", 4000);
    expect(await banner.locator(".ext-cmd code").textContent()).toBe(`cd ${resolve(import.meta.dir, "../..")} && bun install.ts`);
    // The old omp's row carries the mismatch mark, and the header counts it.
    expect(await page.locator('a.row[href="#/b/1"] .ext-mark').textContent()).toBe("!");
    expect(await page.locator(".ext-chip").textContent()).toBe("!1");
    mkdirSync(`${s.home}/.omp/agent/extensions`, { recursive: true });
    symlinkSync(EXTENSION_SOURCE, installed);
    // Any Tern event rebuilds the list, which rechecks the file.
    await until(async () => {
      s.signal();
      return (await banner.count()) === 0;
    }, "banner gone", 4000);
  });

  test("on the list, the first back only warns; a second one within 2 s leaves the app", async () => {
    const { page } = app;
    await page.goto("about:blank");
    await page.goto(`${s.base}/#/`);
    await page.locator(".row").first().waitFor();
    expect(await page.evaluate(() => history.state?.guard)).toBe(true);
    await page.evaluate(() => history.back());
    await page.locator(".toast", { hasText: "Press back again to exit" }).waitFor();
    expect(page.url()).toBe(`${s.base}/#/`);
    await page.evaluate(() => history.back());
    await until(() => page.url() === "about:blank", "left the app", 4000);
  });

  test("a session's ‹ pops back to the list instead of stacking it", async () => {
    const { page } = app;
    await page.goto(`${s.base}/#/`);
    await page.locator('a.row[href="#/b/2"]').click();
    await page.locator(".session-bar .title", { hasText: "Terminal" }).waitFor();
    const depth = await page.evaluate(() => history.length);
    await page.locator(".session-bar a.back").click();
    await page.locator('a.row[href="#/b/2"]').waitFor();
    expect(page.url()).toBe(`${s.base}/#/`);
    expect(await page.evaluate(() => history.length)).toBe(depth);
    // Forward still reaches the session: it was popped, not replaced.
    await page.evaluate(() => history.forward());
    await page.locator(".session-bar .title", { hasText: "Terminal" }).waitFor();
  });

  test("desktop: the list stays beside the open session, which it highlights", async () => {
    const desk = await openApp(s, DESKTOP);
    try {
      const { page } = desk;
      await page.locator(".desk-main .desk-empty", { hasText: "Pick a session on the left." }).waitFor();
      await page.locator('.desk-side a.row[href="#/b/1"]').click();
      await page.locator(".desk-main .session-bar .title", { hasText: "Build phone UI" }).waitFor();
      await texts(page.locator(".desk-side .row.selected .title"), ["Build phone UI"]);
      await page.locator(".desk-main textarea").waitFor();
      const side = await page.locator(".desk-side").boundingBox();
      const main = await page.locator(".desk-main").boundingBox();
      expect(side).not.toBeNull();
      expect(main).not.toBeNull();
      expect(side!.width).toBe(360);
      expect(main!.x).toBeGreaterThanOrEqual(side!.x + side!.width);
      expect(main!.y).toBe(side!.y);
      // The session's ‹ is phone-only; the list is right there.
      expect(await page.locator(".desk-main .session-bar a.back").isVisible()).toBe(false);
      await page.locator('.desk-side a.row[href="#/b/2"]').click();
      await page.locator(".desk-main .session-bar .title", { hasText: "Terminal" }).waitFor();
      await texts(page.locator(".desk-side .row.selected .title"), ["Terminal"]);
      // No back-to-exit guard on a desktop.
      expect(await page.evaluate(() => history.state?.guard ?? null)).toBeNull();
      expect(desk.errors).toEqual([]);
    } finally {
      await desk.context.close();
    }
  });
});
