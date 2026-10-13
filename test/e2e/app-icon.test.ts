import { afterAll, describe, expect, test } from "bun:test";
import { CHROMIUM, closeBrowser, openApp, startSandbox, type App } from "./helpers";

describe.skipIf(!CHROMIUM)("installed app artwork", () => {
  afterAll(closeBrowser);

  test("manifest, favicon and Apple icons decode with visible artwork and a safe opaque maskable icon", async () => {
    const s = await startSandbox();
    let app: App | undefined;
    try {
      app = await openApp(s);
      const icons = await app.page.evaluate(async () => {
        const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
        const response = await fetch(manifestLink.href);
        if (!response.ok) throw new Error(`manifest: ${response.status}`);
        const manifest = await response.json() as { icons: { src: string; sizes: string; purpose: string }[] };
        const entries = manifest.icons.map((icon) => ({
          url: new URL(icon.src, manifestLink.href).href,
          size: Number(icon.sizes.split("x")[0]),
          purpose: icon.purpose,
        }));
        for (const [rel, size] of [["icon", 32], ["apple-touch-icon", 180]] as const) {
          const link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)!;
          entries.push({ url: link.href, size, purpose: rel });
        }
        return Promise.all(entries.map(async (entry) => {
          const image = new Image();
          image.src = entry.url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let minAlpha = 255;
          let light = 0;
          let maxLightRadius = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const alpha = pixels[i + 3]!;
            minAlpha = Math.min(minAlpha, alpha);
            // Count only neutral, high-contrast artwork, not the dark tile or colored logos.
            if (alpha < 240 || Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 180) continue;
            light++;
            const x = (i / 4) % canvas.width;
            const y = Math.floor(i / 4 / canvas.width);
            maxLightRadius = Math.max(maxLightRadius, Math.hypot(x + 0.5 - canvas.width / 2, y + 0.5 - canvas.height / 2) / canvas.width);
          }
          return { ...entry, width: image.naturalWidth, height: image.naturalHeight, minAlpha,
            lightFraction: light / (canvas.width * canvas.height), maxLightRadius };
        }));
      });
      for (const icon of icons) {
        expect(icon.width).toBe(icon.size);
        expect(icon.height).toBe(icon.size);
        expect(icon.lightFraction).toBeGreaterThan(0.02);
        expect(icon.lightFraction).toBeLessThan(0.15);
        if (icon.purpose === "maskable") {
          expect(icon.minAlpha).toBe(255);
          expect(icon.maxLightRadius).toBeLessThanOrEqual(0.4);
        } else {
          expect(icon.minAlpha).toBe(0);
        }
      }
      expect(app.errors).toEqual([]);
    } finally {
      await app?.context.close();
      await s.close();
    }
  }, 30_000);
});
