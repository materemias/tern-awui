import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Extension, type Sandbox } from "../server-harness";
import { Transcript, call } from "../fixtures";
import { CHROMIUM, bodies, closeBrowser, openApp, startSandbox, texts, until, type App } from "./helpers";

describe.skipIf(!CHROMIUM)("phone session", () => {
  let s: Sandbox;
  let agent: Extension;
  let app: App;
  beforeEach(async () => {
    s = await startSandbox((s) => {
      const t = s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      s.prompt = t.user("Fix the build", 1000);
      t.assistant([call("run", "bash", { i: "Running build" }), call("todo", "todo", { i: "Tracking tasks" })], 2000, { stop: "toolUse" });
      t.result("run", "bash", 3000, { isError: true, content: "Build failed" });
      t.result("todo", "todo", 4000, { details: { phases: [{ name: "Build", tasks: [
        { content: "Read config", status: "completed" },
        { content: "Fix compiler", status: "in_progress" },
        { content: "Deploy", status: "blocked", blocker: "Needs approval" },
      ] }] } });
      t.say("## Build report\n\nThe **compiler** needs a fix.\n\n- Keep the API\n- Add tests", 5000);
      t.user("Which route?", 6000);
      s.leaf = t.assistant([call("ask1", "ask", { questions: [{ question: "Choose", options: ["A", "B"], recommended: 1 }] })], 7000, { stop: "toolUse" });
      writeFileSync(s.transcriptPath, t.text());
    });
    agent = new Extension(s);
    await agent.connect();
    app = await openApp(s);
    await app.page.locator('a.row[href="#/b/1"]').click();
    await app.page.locator("textarea").waitFor();
    await app.page.locator(".sync").waitFor();
  }, 20_000);
  afterEach(async () => {
    try {
      expect(app.errors).toEqual([]);
    } finally {
      await app?.context.close();
      await s?.close();
    }
  });
  afterAll(closeBrowser);

  test("opening a session renders markdown, expandable tools, the latest todo and an answerable ask", async () => {
    const { page } = app;
    await texts(page.locator(".assistant h2"), ["Build report"]);
    expect(await page.locator(".assistant strong").textContent()).toBe("compiler");
    await texts(page.locator(".assistant li"), ["Keep the API", "Add tests"]);
    expect(await page.locator(".tools-head").textContent()).toContain("2 tools· 1 failedTracking tasks");
    expect(await page.locator(".tools > ul").count()).toBe(0);
    await page.locator(".tools-head").click();
    await texts(page.locator(".tool-name"), ["bash", "todo"]);
    expect(await page.locator(".tools li.err").textContent()).toBe("bash Running build");
    await texts(page.locator(".todo-mark"), ["✓", "▸", "!"]);
    expect(await page.locator(".todo-blocker").textContent()).toBe(" — Needs approval");
    await page.locator(".todo-head").click();
    await texts(page.locator(".todo-task"), []);
    expect(await page.locator(".todo-count").textContent()).toBe("1/3");
    await page.locator(".todo-head").click();
    await texts(page.locator(".ask-q"), ["Choose"]);
    expect(await page.locator(".opt", { hasText: "B" }).locator(".rec").textContent()).toBe("recommended");
    expect(await page.locator(".ask button").first().isEnabled()).toBe(true);
  });

  test("typing mirrors a draft to omp; send presses Enter once and clears the composer", async () => {
    const { page } = app;
    agent.inbox = [];
    s.clearCalls();
    await page.locator("textarea").pressSequentially("Please fix this");
    await until(() => agent.snapshot.text === "Please fix this", "mirrored draft");
    const drafts = agent.inbox.filter((m) => m.t === "set").map((m) => m.text);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.at(-1)).toBe("Please fix this");
    expect(drafts.every((t) => typeof t === "string" && "Please fix this".startsWith(t))).toBe(true);
    const response = page.waitForResponse((r) => r.url().endsWith("/submit"));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect((await response).status()).toBe(200);
    await until(async () => (await page.locator("textarea").inputValue()) === "", "cleared composer");
    expect(s.calls()).toEqual([["send", "1", "keys", "Enter"]]);
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([{ text: "Please fix this" }]);
    agent.report({ text: "Desktop correction" });
    await until(async () => (await page.locator("textarea").inputValue()) === "Desktop correction", "desktop draft adopted");
  });

  test("two taps in the same event turn submit only once", async () => {
    const { page } = app;
    s.clearCalls();
    app.posts.length = 0;
    await page.locator("textarea").fill("Only once");
    await until(() => agent.snapshot.text === "Only once", "draft synced");
    const response = page.waitForResponse((r) => r.url().endsWith("/submit"));
    // Real DOM clicks in the same task: no render can disable the button between them.
    await page.getByRole("button", { name: "Send", exact: true }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    expect((await response).status()).toBe(200);
    await until(async () => (await page.locator("textarea").inputValue()) === "", "send completed");
    expect(bodies(app, "/api/blocks/1/submit")).toEqual([{ text: "Only once" }]);
    expect(s.calls()).toEqual([["send", "1", "keys", "Enter"]]);
  });

  test("a single-choice ask sends the selected option and the matching Tern dialog keys", async () => {
    s.clearCalls();
    const response = app.page.waitForResponse((r) => r.url().endsWith("/answer"));
    await app.page.locator(".ask .opt").nth(1).click();
    expect((await response).status()).toBe(200);
    expect(bodies(app, "/api/blocks/1/answer")).toEqual([{ id: "ask1", answers: [{ option: 1, picks: [] }] }]);
    expect(s.calls()).toEqual([["send", "1", "keys", "Up", "Up", "Down", "Enter"]]);
    await app.page.locator(".ask.sent").waitFor();
    expect(await app.page.locator(".ask .opt").first().isDisabled()).toBe(true);
  });

  test("model picker sends effort, priority, role and catalog model selections", async () => {
    const { page } = app;
    agent.inbox = [];
    await page.locator("button.pick").click();
    await page.locator(".sheet.mp").waitFor();
    await page.getByRole("button", { name: "High", exact: true }).click();
    expect((await agent.take("thinking")).level).toBe("high");
    await texts(page.locator(".mp-opt").first().locator("button.on"), ["High"]);
    await page.locator(".mp-opt").nth(1).getByRole("button", { name: "Fast", exact: true }).click();
    expect((await agent.take("tier")).tier).toBe("priority");
    await texts(page.locator(".mp-opt").nth(1).locator("button.on"), ["Fast"]);
    await page.locator(".mp-row", { has: page.locator(".mp-role", { hasText: "smart" }) }).click();
    expect((await agent.take("model")).spec).toBe("test/smart:high");
    await page.locator(".sheet.mp").waitFor({ state: "detached" });
    await page.locator("button.pick").click();
    await page.locator(".mp-provider").click();
    await page.locator(".mp-row", { has: page.locator(".mp-name", { hasText: /^Fast$/ }) }).click();
    expect((await agent.take("model")).spec).toBe("test/fast");
    await page.locator(".sheet.mp").waitFor({ state: "detached" });
    expect(await page.evaluate(() => localStorage.getItem("tern-mobile:recent-models"))).toBe('["test/fast"]');
    await page.locator("button.pick").click();
    await page.locator(".mp-section", { hasText: "Recent" }).waitFor();
    await page.getByPlaceholder("Search models").fill("no such model");
    await texts(page.locator(".mp-row"), []);
    await page.getByPlaceholder("Search models").fill("fast");
    await texts(page.locator(".mp-row .mp-name").last(), ["Fast"]);
    await page.keyboard.press("Escape");
    await page.locator(".sheet.mp").waitFor({ state: "detached" });
  });

  test("Rewind asks first: cancel does nothing, confirm submits the selected entry", async () => {
    const { page } = app;
    agent.report({ status: "idle", text: "" });
    await page.getByPlaceholder("Ask for changes or send a follow-up").waitFor();
    const prompt = page.locator(".msg.user", { hasText: "Fix the build" });
    await prompt.click();
    s.clearCalls();
    agent.inbox = [];
    app.posts.length = 0;
    let question = "";
    page.once("dialog", async (dialog) => { question = dialog.message(); await dialog.dismiss(); });
    await prompt.getByRole("button", { name: "Rewind" }).click();
    expect(question).toContain("Rewind to before this prompt?");
    expect(bodies(app, "/api/blocks/1/rewind")).toEqual([]);
    expect(s.calls()).toEqual([]);
    page.once("dialog", (dialog) => dialog.accept());
    const response = page.waitForResponse((r) => r.url().endsWith("/rewind"));
    await prompt.getByRole("button", { name: "Rewind" }).click();
    expect((await response).status()).toBe(200);
    expect(bodies(app, "/api/blocks/1/rewind")).toEqual([{ entry: s.prompt }]);
    expect((await agent.take("set")).text).toBe(`/tern-mobile-rewind ${s.prompt}`);
    expect(s.calls()).toEqual([["send", "1", "keys", "Enter"]]);
  });

  test("live text stays until the final transcript replaces it, and queued steers show their kind", async () => {
    const { page } = app;
    agent.send({ t: "live", text: "A **streaming** answer", done: false });
    await texts(page.locator(".live strong"), ["streaming"]);
    agent.send({ t: "live", text: "A **streaming** answer", done: true });
    expect((await page.locator(".live").textContent())?.trim()).toBe("A streaming answer");
    const leaf = s.transcript.say("A **finished** answer", 8000);
    appendFileSync(s.transcriptPath, s.transcript.lines().at(-1)! + "\n");
    agent.report({ leaf, queued: ["Check the tests", { text: "Then deploy", followUp: true }] });
    await texts(page.locator(".assistant").last().locator("strong"), ["finished"]);
    expect(await page.locator(".live").count()).toBe(0);
    await texts(page.locator(".queued-text"), ["Check the tests", "Then deploy"]);
    await texts(page.locator(".queued-mark"), ["↳", "→"]);
    agent.report({ queued: [] });
    await texts(page.locator(".queued"), []);
  });

  test("replacing a bridge owner clears old live text without waiting for a transcript change", async () => {
    const { page } = app;
    agent.send({ t: "live", text: "Old owner's partial answer", done: false });
    await texts(page.locator(".live"), ["Old owner's partial answer"]);
    const transcript = await page.locator(".assistant:not(.live)").allTextContents();
    const replacement = new Extension(s, "1", "test/replacement");
    // Same session and leaf: no new transcript message can clear the old live text for us.
    expect(replacement.snapshot.sessionId).toBe(agent.snapshot.sessionId);
    expect(replacement.snapshot.leaf).toBe(agent.snapshot.leaf);
    await replacement.connect();
    await page.locator(".live").waitFor({ state: "detached", timeout: 1000 });
    await texts(page.locator("button.pick > span").first(), ["Replacement"]);
    expect(await page.locator(".assistant:not(.live)").allTextContents()).toEqual(transcript);
  });

  test("follow-up sends a bridge message rather than terminal keys", async () => {
    const { page } = app;
    agent.report({ status: "working", text: "" });
    await page.getByPlaceholder("Steer the agent…").waitFor();
    await page.locator("textarea").fill("After this turn");
    s.clearCalls();
    await page.getByRole("button", { name: "Send after this turn", exact: true }).click();
    expect(await agent.take("send")).toMatchObject({ text: "After this turn", images: [], followUp: true });
    await until(async () => (await page.locator("textarea").inputValue()) === "", "follow-up sent");
    expect(s.calls()).toEqual([]);
  });

  test("the subagent strip opens a live read-only transcript and back returns to its session", async () => {
    const { page } = app;
    const dir = s.transcriptPath.slice(0, -6);
    mkdirSync(dir);
    const sub = new Transcript("scout", `${s.home}/alpha`);
    sub.user("Inspect the build", 1000);
    sub.say("The **config** is wrong.", 2000);
    sub.assistant([call("sub-ask", "ask", { questions: [{ question: "Subagent question", options: ["yes", "no"] }] })], 3000, { stop: "toolUse" });
    writeFileSync(`${dir}/Scout.jsonl`, sub.text());
    agent.report({ jobs: [{ id: "job-1", type: "task", label: "Inspect build", agent: "Scout", since: Date.now() }] });
    await page.locator("a.job-open", { hasText: "Scout" }).click();
    await texts(page.locator(".sub-bar .title"), ["Scout"]);
    await texts(page.locator(".assistant strong"), ["config"]);
    expect(await page.locator(".sub-bar .row-meta").textContent()).toContain("running");
    expect(await page.locator("textarea, .composer, .user-acts, .ask button").count()).toBe(0);
    expect(await page.locator(".ask-answer").textContent()).toBe("not answered");
    sub.say("Inspection done", 4000);
    appendFileSync(`${dir}/Scout.jsonl`, sub.lines().at(-1)! + "\n");
    await page.locator(".assistant", { hasText: "Inspection done" }).waitFor();
    await page.getByRole("link", { name: "Back to the session" }).click();
    await page.locator("textarea").waitFor();
    expect(page.url()).toBe(`${s.base}/#/b/1`);
    agent.report({ jobs: [] });
  });

  test("queued Nerd Font markers render with the bundled symbols font without changing their text", async () => {
    const text = "1. \uea61 ponytail-audit and fix what you find\n2. \uf03e #1";
    agent.report({ queued: [{ text, followUp: true }] });
    const { page, context } = app;
    await texts(page.locator(".queued-text"), [text]);
    await page.evaluate(() => document.fonts.ready);
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".queued-text" });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      expect(fonts.find((font) => font.familyName === "Symbols Nerd Font" && font.isCustomFont)?.glyphCount).toBe(2);
      expect(await page.locator(".queued-text").textContent()).toBe(text);
    } finally {
      await cdp.detach();
      agent.report({ queued: [] });
    }
  });

  test("an old extension explains the mismatch; a restartable idle omp offers a confirmed Reload", async () => {
    const { page } = app;
    expect(await page.locator(".ext-session").textContent()).toContain("The installed file is outdated too");
    const dir = `${s.home}/.omp/agent/extensions`;
    mkdirSync(dir);
    symlinkSync(resolve(import.meta.dir, "../../omp-extension/tern-mobile.ts"), `${dir}/tern-mobile.ts`);
    const ext = new Extension(s, "4");
    ext.restart = true;
    ext.snapshot.status = "idle";
    await ext.connect();
    s.signal();
    await page.goto(`${s.base}/#/b/4`);
    await page.getByRole("button", { name: "Reload", exact: true }).waitFor();
    expect(await page.locator(".ext-session").textContent()).toContain("loaded an older tern-mobile extension");
    s.clearCalls();
    page.once("dialog", (dialog) => dialog.accept());
    const response = page.waitForResponse((r) => r.url().endsWith("/submit"));
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    expect((await response).status()).toBe(200);
    expect((await ext.take("set")).text).toBe("/restart");
    expect(bodies(app, "/api/blocks/4/submit")).toEqual([{ text: "/restart" }]);
    expect(s.calls()).toEqual([["send", "4", "keys", "Enter"]]);
  });
});
