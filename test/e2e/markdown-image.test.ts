import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Extension } from "../server-harness";
import { PNG, Transcript } from "../fixtures";
import { CHROMIUM, closeBrowser, openApp, startSandbox, until, type App } from "./helpers";

describe.skipIf(!CHROMIUM)("assistant screenshot markdown", () => {
  afterAll(closeBrowser);

  test("a local screenshot in the actual chat decodes through the authenticated image route", async () => {
    let path = "";
    const s = await startSandbox((s) => {
      path = `${s.home}/tern-awui-queue-after.png`;
      writeFileSync(path, PNG);
      const t = s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      t.user("Show the corrected queued message", 1000);
      s.leaf = t.say(`![Corrected queued message](${path})\n\n![Reference][after]\n\n[after]: ${path} "Screenshot"\n\n\`![literal](${path})\``, 2000);
      writeFileSync(s.transcriptPath, t.text());
    });
    let app: App | undefined;
    try {
      await new Extension(s).connect();
      app = await openApp(s, undefined, "#/b/1");
      const images = app.page.locator(".assistant img");
      await until(async () => {
        if (await images.count() !== 2) return false;
        return images.evaluateAll((nodes) => nodes.every((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0));
      }, "decoded assistant screenshot and reference image");
      const sources = await images.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
      expect(sources).toHaveLength(2);
      for (const src of sources) {
        expect(src).toMatch(/^\/api\/blob\/[0-9a-f]{64}\?type=image%2Fpng$/);
        const response = await app.context.request.get(s.base + src, { headers: s.headers });
        expect(response.status()).toBe(200);
        expect(await response.body()).toEqual(PNG);
      }
      expect(await app.page.locator(".assistant code").textContent()).toBe(`![literal](${path})`);
      expect(app.errors).toEqual([]);
    } finally {
      await app?.context.close();
      await s.close();
    }
  }, 20_000);
});
