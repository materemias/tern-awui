import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Extension, type Sandbox } from "../server-harness";
import { CHROMIUM, bodies, closeBrowser, openApp, startSandbox, texts, until, type App } from "./helpers";

const saved = {
  id: "saved", leafId: null, question: "Why this **design**?", answer: "## Saved answer\n\nKeep **native history**.\n\n- Read only",
  status: "complete", createdAt: 1000, updatedAt: 2000,
  followUps: [{ question: "What about follow-ups?", answer: "Use `Markdown` too.", status: "error", createdAt: 2100, updatedAt: 2200, error: "Saved provider error" }],
};

describe.skipIf(!CHROMIUM)("native btw history on the phone", () => {
  let s: Sandbox;
  let agent: Extension;
  let app: App;
  let folder: string;
  let gets: string[];
  beforeEach(async () => {
    s = await startSandbox((sandbox) => {
      folder = `${sandbox.transcriptPath.slice(0, -6)}/btw-history`;
      mkdirSync(folder, { recursive: true });
      writeFileSync(`${folder}/entry-saved.json`, JSON.stringify(saved));
      writeFileSync(`${folder}/entry-newer.json`, JSON.stringify({ ...saved, id: "newer", question: "Newest question", createdAt: 3000, updatedAt: 4000, followUps: [] }));
      writeFileSync(`${folder}/entry-broken.json`, '{"id":"broken","question":42}');
    });
    agent = new Extension(s);
    await agent.connect();
    app = await openApp(s, undefined, "#/b/1");
    await app.page.locator(".sync").waitFor();
    gets = [];
    app.page.on("request", (request) => {
      if (request.method() === "GET" && request.url().endsWith("/btw-history")) gets.push(new URL(request.url()).pathname);
    });
    agent.inbox = [];
    s.clearCalls();
  }, 20_000);
  afterEach(async () => {
    try { expect(app.errors).toEqual([]); }
    finally { await app?.context.close(); await s?.close(); }
  });
  afterAll(closeBrowser);

  async function open(command = "/btw") {
    await app.page.locator("textarea").fill(command);
    await until(() => agent.snapshot.text === command, "command draft mirrored");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
  }

  test("bare /btw reads native history without submitting or calling a model, then clears one draft", async () => {
    const before = new Map(readdirSync(folder).map((file) => [file, readFileSync(`${folder}/${file}`, "utf8")]));
    await open("/btw   ");
    await app.page.getByRole("dialog", { name: "Btw history" }).waitFor();
    expect(gets).toEqual(["/api/blocks/1/btw-history"]);
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([]);
    expect(bodies(app, "/api/blocks/1/btw")).toEqual([]);
    await until(() => agent.snapshot.text === "", "desktop command cleared");
    expect(agent.inbox.filter((message) => message.t === "set" && message.text === "")).toHaveLength(1);
    expect(s.calls()).toEqual([]);
    expect(await app.page.locator("textarea").inputValue()).toBe("");
    await texts(app.page.locator(".btw-history .sheet-row .role"), ["Newest question", "Why this **design**?"]);
    await app.page.getByRole("button", { name: /Why this \*\*design\*\*\?/ }).click();
    await texts(app.page.locator(".btw-history h2"), ["Saved answer"]);
    expect(bodies(app, "/api/blocks/1/draft").filter((body) => body && typeof body === "object" && "text" in body && body.text === "")).toEqual([
      { text: "", expectedSessionId: s.session, expectedText: "/btw   " },
    ]);
    await texts(app.page.locator(".btw-history strong"), ["design", "native history"]);
    await texts(app.page.locator(".btw-history code"), ["Markdown"]);
    expect(await app.page.getByText("Saved provider error", { exact: true }).isVisible()).toBe(true);
    await app.page.getByRole("button", { name: "Back to history" }).click();
    await texts(app.page.locator(".btw-history .sheet-row .role"), ["Newest question", "Why this **design**?"]);
    await app.page.keyboard.press("Escape");
    await app.page.locator(".btw-history").waitFor({ state: "detached" });
    expect(new Map(readdirSync(folder).map((file) => [file, readFileSync(`${folder}/${file}`, "utf8")]))).toEqual(before);
  });

  test("missing history shows an empty state and reopening reads newly saved native files", async () => {
    rmSync(folder, { recursive: true });
    await open();
    await app.page.getByText("No saved btw questions.", { exact: true }).waitFor();
    await app.page.getByRole("button", { name: "Close history" }).click();
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/entry-saved.json`, JSON.stringify(saved));
    await open();
    await texts(app.page.locator(".btw-history .sheet-row .role"), ["Why this **design**?"]);
    expect(gets).toHaveLength(2);
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([]);
  });

  test("a failed history fetch keeps the command and Send retries it", async () => {
    await app.page.route("**/api/blocks/1/btw-history", (route) => route.abort("failed"));
    await open();
    await app.page.locator(".composer-wrap > .error").waitFor();
    expect(await app.page.locator("textarea").inputValue()).toBe("/btw");
    expect(agent.snapshot.text).toBe("/btw");
    expect(await app.page.locator(".btw-history").count()).toBe(0);
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([]);
    expect(bodies(app, "/api/blocks/1/btw")).toEqual([]);
    await app.page.unroute("**/api/blocks/1/btw-history");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await app.page.getByRole("dialog", { name: "Btw history" }).waitFor();
    await until(() => agent.snapshot.text === "", "retry cleared draft");
    expect(await app.page.locator(".composer-wrap > .error").count()).toBe(0);
    expect(gets).toHaveLength(2);
  });

  test("delayed history cannot appear after opening another block", async () => {
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    await app.page.route("**/api/blocks/1/btw-history", async (route) => {
      const response = await route.fetch();
      ready.resolve();
      await release.promise;
      await route.fulfill({ response });
      finished.resolve();
    });
    await open();
    await ready.promise;
    await app.page.evaluate(() => { location.hash = "#/b/2"; });
    await app.page.getByPlaceholder("Type into the terminal").waitFor();
    release.resolve();
    await finished.promise;
    // Let the old fetch resolve in the browser before inspecting the newly mounted composer.
    await app.page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return promise;
    });
    expect(await app.page.locator(".btw-history").count()).toBe(0);
    expect(await app.page.locator("textarea").inputValue()).toBe("");
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([]);
    expect(bodies(app, "/api/blocks/1/btw")).toEqual([]);
    expect(bodies(app, "/api/blocks/2/draft")).toEqual([]);
  });

  test("an old response cannot open history or clear a replacement session in the same pane", async () => {
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    await app.page.route("**/api/blocks/1/btw-history", async (route) => {
      const response = await route.fetch();
      ready.resolve();
      await release.promise;
      await route.fulfill({ response });
      finished.resolve();
    });
    await open();
    await ready.promise;
    agent.report({ sessionId: "replacement", text: "New session draft", model: "test/replacement" });
    await texts(app.page.locator("button.pick > span").first(), ["Replacement"]);
    release.resolve();
    await finished.promise;
    await until(async () => (await app.page.locator("textarea").inputValue()) === "New session draft", "replacement session draft retained");
    expect(await app.page.locator(".btw-history").count()).toBe(0);
    expect(agent.snapshot.text).toBe("New session draft");
    expect(bodies(app, "/api/blocks/1/draft")).toEqual([{ text: "/btw" }]);
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([]);
    expect(bodies(app, "/api/blocks/1/btw")).toEqual([]);
  });

  test("a saved history sheet closes when the same pane starts a new session", async () => {
    await open();
    await app.page.getByRole("dialog", { name: "Btw history" }).waitFor();
    await until(() => agent.snapshot.text === "", "history command cleared");
    agent.report({ sessionId: "replacement", text: "New session draft", model: "test/replacement" });
    await texts(app.page.locator("button.pick > span").first(), ["Replacement"]);
    await app.page.locator(".btw-history").waitFor({ state: "detached" });
    await until(async () => (await app.page.locator("textarea").inputValue()) === "New session draft", "new session draft adopted");
    expect(agent.snapshot.text).toBe("New session draft");
  });

  test("a desktop draft arriving during history loading is not overwritten by command clearing", async () => {
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    await app.page.route("**/api/blocks/1/btw-history", async (route) => {
      const response = await route.fetch();
      ready.resolve();
      await release.promise;
      await route.fulfill({ response });
      finished.resolve();
    });
    await open();
    await ready.promise;
    agent.report({ text: "New desktop draft", thinking: "high" });
    await texts(app.page.locator("button.pick .pick-sub").first(), ["high"]);
    release.resolve();
    await finished.promise;
    await app.page.getByRole("dialog", { name: "Btw history" }).waitFor();
    await until(async () => (await app.page.locator("textarea").inputValue()) === "New desktop draft", "newer desktop draft retained");
    expect(agent.snapshot.text).toBe("New desktop draft");
    expect(bodies(app, "/api/blocks/1/draft")).toEqual([{ text: "/btw" }]);
  });
});
