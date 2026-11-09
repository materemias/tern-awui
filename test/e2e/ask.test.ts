import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Extension, type Sandbox } from "../server-harness";
import { Transcript, call } from "../fixtures";
import { CHROMIUM, bodies, closeBrowser, openApp, startSandbox, type App } from "./helpers";

const FORM = `<form>
  <fieldset><legend>Which checks?</legend>
    <label><input type="checkbox" name="checks" value="lint"> Lint</label>
    <label><input type="checkbox" name="checks" value="types" checked> Types</label>
    <label><input type="checkbox" name="checks" value="tests"> Tests</label>
  </fieldset>
  <fieldset><legend>When?</legend>
    <label><input type="radio" name="when" value="now" required> Now</label>
    <label><input type="radio" name="when" value="later"> Later</label>
  </fieldset>
</form>`;

describe.skipIf(!CHROMIUM)("ask form", () => {
  let s: Sandbox;
  let app: App;
  beforeAll(async () => {
    s = await startSandbox((s) => {
      const t = s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      t.user("Choose checks and timing", 1000);
      s.leaf = t.assistant([call("checks", "ask", { html: FORM })], 2000, { stop: "toolUse" });
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

  test("a required group holds Send back until Other's text answers it; boxes and text reach omp as keys", async () => {
    const { page } = app;
    const send = page.getByRole("button", { name: "Send answer" });
    await send.waitFor();
    await page.getByLabel("Lint").check();
    await page.getByLabel("Types").uncheck();
    await send.click();
    // The browser's own check stops the unanswered required group: nothing is posted.
    expect(bodies(app, "/api/blocks/1/answer")).toEqual([]);
    await page.getByRole("textbox", { name: "When?: other" }).fill("  After review  ");
    const response = page.waitForResponse((r) => r.url().endsWith("/answer"));
    await send.click();
    expect((await response).status()).toBe(200);
    expect(bodies(app, "/api/blocks/1/answer")).toEqual([{ id: "checks", values: { checks: ["lint"] }, other: { when: "After review" } }]);
    expect(s.calls()).toContainEqual(["send", "1", "text", "--", "After review"]);
    expect(s.calls().at(-1)).toEqual(["send", "1", "keys", "Tab", "Enter"]);
    await page.locator(".ask.sent").waitFor();
    expect(await page.getByLabel("Lint").isDisabled()).toBe(true);
    expect(app.errors).toEqual([]);
  });
});
