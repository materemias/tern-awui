import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Extension } from "../server-harness";
import { Transcript } from "../fixtures";
import { CHROMIUM, closeBrowser, launch, startSandbox } from "./helpers";

describe.skipIf(!CHROMIUM)("iPhone 16 viewport", () => {
  afterAll(closeBrowser);

  test("normal text, header and composer fit 393×852 without document overflow", async () => {
    const s = await startSandbox((s) => {
      s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      s.prompt = s.transcript.user("Check mobile viewport sizing", 1000);
      s.leaf = s.transcript.say(
        "## Mobile viewport\n\nReadable text and a long URL https://example.test/" +
          "very-long-segment-".repeat(25) + "\n\n```text\n" + "wide-code-line-".repeat(30) + "\n```",
        2000,
      );
      writeFileSync(s.transcriptPath, s.transcript.text());
    });
    const context = await (await launch()).newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      extraHTTPHeaders: s.headers,
      serviceWorkers: "block",
    });
    try {
      await new Extension(s).connect();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(s.base + "/#/b/1");
      await page.locator(".assistant h2").waitFor();
      await page.locator("textarea").waitFor();
      await page.evaluate(() => document.fonts.ready);

      const metrics = await page.evaluate(() => {
        const header = document.querySelector(".session-bar");
        const transcript = document.querySelector(".scroll");
        const composer = document.querySelector(".composer-wrap");
        const text = document.querySelector(".assistant p");
        if (!header || !transcript || !composer || !text || !visualViewport) throw new Error("Session layout missing");
        return {
          width: innerWidth,
          height: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          visualWidth: visualViewport.width,
          scale: visualViewport.scale,
          bodyFont: getComputedStyle(document.body).fontSize,
          headerFont: getComputedStyle(header).fontSize,
          textFont: getComputedStyle(text).fontSize,
          boxes: [header, transcript, composer].map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
          }),
        };
      });
      expect(metrics.width).toBe(393);
      expect(metrics.height).toBe(852);
      expect(metrics.documentWidth).toBe(393);
      expect(metrics.visualWidth).toBe(393);
      expect(metrics.scale).toBe(1);
      expect(metrics.bodyFont).toBe("15px");
      expect(metrics.headerFont).toBe("15px");
      expect(metrics.textFont).toBe("14.5px");
      for (const box of metrics.boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(393);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.bottom).toBeLessThanOrEqual(852);
      }
      expect(await page.locator(".assistant pre").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await s.close();
    }
  }, 20_000);
});
