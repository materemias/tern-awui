import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Extension, type Sandbox } from "../server-harness";
import { Transcript, call } from "../fixtures";
import { CHROMIUM, bodies, closeBrowser, openApp, startSandbox, type App } from "./helpers";

describe.skipIf(!CHROMIUM)("multi-question ask", () => {
  let s: Sandbox;
  let app: App;
  beforeAll(async () => {
    s = await startSandbox((s) => {
      const t = s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      t.user("Choose checks and timing", 1000);
      s.leaf = t.assistant([call("checks", "ask", { questions: [
        { question: "Which checks?", multi: true, options: ["Lint", "Types", "Tests"] },
        { question: "When?", options: ["Now", "Later"] },
      ] })], 2000, { stop: "toolUse" });
      writeFileSync(s.transcriptPath, t.text());
    });
    const agent = new Extension(s);
    agent.snapshot.status = "blocked";
    await agent.connect();
    app = await openApp(s, undefined, "#/b/1");
  }, 20_000);
  afterAll(async () => {
    await app?.context.close();
    await closeBrowser();
    await s?.close();
  });

  test("checkbox toggles and Other serialize actual picks, with no POST until every question is ready", async () => {
    const { page } = app;
    const send = page.getByRole("button", { name: "Send answer" });
    await send.waitFor();
    expect(await send.isDisabled()).toBe(true);
    const checks = page.locator(".ask-block").first();
    await checks.getByRole("button", { name: /^Lint/ }).click();
    await checks.getByRole("button", { name: "Types", exact: true }).click();
    await checks.getByRole("button", { name: "Types", exact: true }).click();
    await checks.getByRole("button", { name: "Tests", exact: true }).click();
    expect(await checks.locator(".opt.on").count()).toBe(2);
    expect(await send.isDisabled()).toBe(true);
    await page.locator(".ask-block").nth(1).getByRole("button", { name: /Other/ }).click();
    await page.getByPlaceholder("Your answer").fill("   ");
    expect(await send.isDisabled()).toBe(true);
    expect(bodies(app, "/api/blocks/1/answer")).toEqual([]);
    await page.getByPlaceholder("Your answer").fill("  After review  ");
    const response = page.waitForResponse((r) => r.url().endsWith("/answer"));
    await send.click();
    expect((await response).status()).toBe(200);
    expect(bodies(app, "/api/blocks/1/answer")).toEqual([{
      id: "checks", answers: [{ option: null, picks: [0, 2] }, { other: "After review", picks: [] }],
    }]);
    expect(s.calls()).toContainEqual(["send", "1", "text", "After review"]);
    expect(s.calls().at(-1)).toEqual(["send", "1", "keys", "Enter"]);
    await page.locator(".ask.sent").waitFor();
    expect(await checks.getByRole("button", { name: /^Lint/ }).isDisabled()).toBe(true);
    expect(app.errors).toEqual([]);
  });
});
