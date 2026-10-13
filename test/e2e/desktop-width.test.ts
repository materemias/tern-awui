import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Extension, type Sandbox } from "../server-harness";
import { Transcript } from "../fixtures";
import { CHROMIUM, closeBrowser, openApp, startSandbox } from "./helpers";

describe.skipIf(!CHROMIUM)("session reading width", () => {
  let s: Sandbox;
  beforeAll(async () => {
    s = await startSandbox((s) => {
      s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      s.prompt = s.transcript.user("Show the report", 1000);
      s.leaf = s.transcript.say("## Report\n\nThe session uses the available reading space.", 2000);
      writeFileSync(s.transcriptPath, s.transcript.text());
    });
    await new Extension(s).connect();
  }, 20_000);
  afterAll(async () => {
    await closeBrowser();
    await s?.close();
  });

  test.each([393, 412, 999, 1000, 1001, 1400, 1800, 1920])("aligned reading space without page overflow at %ipx", async (width) => {
    const { context, page } = await openApp(s, { width, height: 900 }, "#/b/1");
    try {
      await page.locator(".assistant").waitFor();
      await page.locator(".composer-wrap").waitFor();
      await page.locator(".ext-session").waitFor();
      const layout = await page.evaluate(() => {
        const box = (selector: string, inner = false) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing layout element: ${selector}`);
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const left = rect.left + (inner ? parseFloat(style.paddingLeft) : 0);
          const right = rect.right - (inner ? parseFloat(style.paddingRight) : 0);
          return { left, right, width: right - left };
        };
        return {
          message: box(".assistant"),
          main: box(innerWidth >= 1000 ? ".desk-main" : ".scroll"),
          sidebar: innerWidth >= 1000 ? box(".desk-side") : null,
          header: box(".session-bar", true),
          composer: box(".composer-wrap", true),
          notice: box(".ext-session"),
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      expect(layout.documentWidth).toBe(width);
      expect(layout.message.width).toBeGreaterThan(0);
      if (width >= 1000) {
        expect(layout.sidebar?.width).toBe(360);
        expect(Math.abs((layout.message.left + layout.message.right) - (layout.main.left + layout.main.right))).toBeLessThan(2);
        expect(layout.message.width).toBeCloseTo(Math.min(1100, layout.main.width - 48), 0);
        expect(layout.header.left).toBeLessThanOrEqual(layout.message.left);
        expect(layout.header.right).toBeGreaterThanOrEqual(layout.message.right);
        expect(layout.message.left - layout.header.left).toBeLessThanOrEqual(12);
        expect(layout.header.right - layout.message.right).toBeLessThanOrEqual(12);
        expect(layout.notice.left).toBeLessThanOrEqual(layout.message.left);
        expect(Math.abs(layout.header.left - layout.composer.left)).toBeLessThan(1);
        expect(Math.abs(layout.header.right - layout.composer.right)).toBeLessThan(1);
        expect(layout.notice.right).toBeGreaterThanOrEqual(layout.message.right);
        expect(layout.message.left - layout.notice.left).toBeLessThanOrEqual(12);
        expect(layout.notice.right - layout.message.right).toBeLessThanOrEqual(12);
        if (width >= 1400) expect(layout.message.width).toBeGreaterThan(780);
      }
    } finally {
      await context.close();
    }
  });
});
