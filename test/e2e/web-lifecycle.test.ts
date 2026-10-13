import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { item, state } from "../../web/fakes";
import { CHROMIUM, PHONE, buildApp, closeBrowser, launch, until } from "./helpers";

describe.skipIf(!CHROMIUM)("browser connection lifecycle", () => {
  let server: Bun.Server<undefined>;
  let context: BrowserContext;
  let page: Page;
  let connections = 0;
  let first: ReadableStreamDefaultController<Uint8Array>;
  let errors: string[];
  let dialogs: string[];

  beforeAll(async () => {
    const dist = await buildApp();
    const encoder = new TextEncoder();
    server = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/stream") {
        const block = url.searchParams.get("block");
        const connection = block ? ++connections : 0;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          const send = (name: string, value: unknown) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`));
          controller.enqueue(encoder.encode("retry: 50\n\n"));
          send("state", state([item()]));
          if (!block) return;
          send("draft", { text: "", live: true });
          send("chat", { entries: connection === 1 ? [] : [{ role: "assistant", text: "Completed transcript", ts: 1 }] });
          if (connection === 1) {
            first = controller;
            send("live", { text: "Obsolete live answer", done: false });
            send("queued", [{ text: "Already processed prompt", followUp: true }]);
          }
        } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      return new Response(Bun.file(join(dist, url.pathname === "/" ? "index.html" : url.pathname)));
    } });
  }, 20_000);
  beforeEach(async () => {
    connections = 0;
    errors = [];
    dialogs = [];
    context = await (await launch()).newContext({ viewport: PHONE, serviceWorkers: "block" });
    context.setDefaultTimeout(3500);
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept(); });
  });
  afterEach(async () => { await context?.close(); });
  afterAll(async () => { await closeBrowser(); await server?.stop(true); });

  test("native EventSource reconnect clears completed live text and consumed queued prompts", async () => {
    await page.goto(`${server.url}#/b/5`);
    await page.locator(".live").waitFor();
    await page.locator(".queued").waitFor();
    first.close();
    await until(() => connections === 2, "native SSE reconnect");
    await page.getByText("Completed transcript", { exact: true }).waitFor();
    expect(await page.locator(".live").count()).toBe(0);
    expect(await page.locator(".queued").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test("a rejected new-session request alerts and leaves the button available", async () => {
    await page.goto(`${server.url}#/`);
    const button = page.locator("h2 button");
    await button.waitFor();
    await page.route("**/api/new", (route) => route.abort("failed"));
    const failed = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/api/new");
    await button.click();
    await failed;
    await until(async () => !(await button.isDisabled()), "new-session button re-enabled");
    expect(dialogs).toEqual(["Start a new omp in app?", "TypeError: Failed to fetch"]);
    expect(errors).toEqual([]);
  });
});
