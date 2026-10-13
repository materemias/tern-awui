// Regenerates the README screenshots from made-up sessions: a sandboxed server with fake
// tern/omp, fake bridged agents and invented transcripts, so no real paths, prompts or names
// end up in the images. Run: `bun docs/screenshots.ts` (needs the Playwright headless shell).
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { PROTOCOL } from "../lib/bridge-state";
import { obj } from "../lib/json";
import { buildId } from "../lib/extension-check";
import { Extension } from "../test/server-harness";
import { CHROMIUM, closeBrowser, openApp, startSandbox, until } from "../test/e2e/helpers";

if (!CHROMIUM) throw new Error("no headless Chromium: install Playwright's chromium_headless_shell or set TERN_AWUI_CHROMIUM");

const OUT = resolve(import.meta.dir);
const EXT = resolve(import.meta.dir, "../omp-extension/tern-mobile.ts");
const NOW = Date.now();
const min = 60_000;

type Part = Record<string, unknown>;
/** A transcript with timestamps relative to now, shaped like omp's session JSONL. */
class Log {
  rows: Record<string, unknown>[] = [];
  private n = 0;
  private last = "";
  constructor(readonly id: string, cwd: string, readonly start: number) {
    this.rows.push({ type: "session", version: 3, id, timestamp: new Date(start).toISOString(), cwd });
  }
  private add(message: Record<string, unknown>, at: number) {
    const id = `${this.id}-${++this.n}`;
    this.rows.push({ type: "message", id, parentId: this.last || null, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } });
    this.last = id;
    return id;
  }
  user(text: string, at: number) { return this.add({ role: "user", content: [{ type: "text", text }] }, at); }
  assistant(content: Part[], at: number, stop = "stop") { return this.add({ role: "assistant", content, model: "claude-opus-5-5", stopReason: stop }, at); }
  result(id: string, name: string, at: number, details: Part = {}) {
    return this.add({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, details }, at);
  }
  get leaf() { return this.last; }
  text() { return this.rows.map((r) => JSON.stringify(r)).join("\n") + "\n"; }
}
const tool = (id: string, name: string, args: Part) => ({ type: "toolCall", id, name, arguments: args });
const say = (text: string) => ({ type: "text", text });

let logs: { checkout: Log; rates: Log; backup: Log; post: Log } | undefined;
const s = await startSandbox((s) => {
  const code = `${s.home}/code`;
  for (const p of ["webshop", "homelab", "blog"]) mkdirSync(`${code}/${p}`, { recursive: true });
  writeFileSync(`${code}/webshop/README.md`, "# webshop\n\nA small storefront.\n");
  mkdirSync(`${s.home}/.omp/agent/extensions`, { recursive: true });
  symlinkSync(EXT, `${s.home}/.omp/agent/extensions/tern-mobile.ts`);

  const checkout = new Log("checkout", `${code}/webshop`, NOW - 40 * min);
  checkout.user("The checkout e2e test fails about one run in five. Find out why and fix it.", NOW - 40 * min);
  checkout.assistant([tool("t1", "bash", { i: "Running checkout test 20 times", command: "for i in $(seq 20); do bun test checkout; done" }),
    tool("t2", "read", { i: "Reading cart total calculation", path: "src/cart.ts" })], NOW - 39 * min, "toolUse");
  checkout.result("t1", "bash", NOW - 37 * min);
  checkout.result("t2", "read", NOW - 37 * min);
  checkout.assistant([tool("t3", "todo", { i: "Planning the fix" })], NOW - 36 * min, "toolUse");
  checkout.result("t3", "todo", NOW - 36 * min, { phases: [{ name: "Checkout flake", tasks: [
    { content: "Reproduce the failure", status: "completed" },
    { content: "Await the price refresh before submitting", status: "in_progress" },
    { content: "Add a regression test", status: "pending" },
  ] }] });
  checkout.assistant([say(
    "The test fails when the price refresh finishes after the order is submitted. In 20 runs:\n\n" +
    "| Run order | Failures | Cause |\n|---|---|---|\n| refresh first | 0 / 14 | none |\n| submit first | 4 / 6 | stale total |\n\n" +
    "I'm making the submit button wait for the pending refresh.",
  )], NOW - 30 * min);
  checkout.user("Sounds right, go ahead.", NOW - 3 * min);
  checkout.assistant([tool("t4", "edit", { i: "Awaiting price refresh before submit", path: "src/checkout.tsx" })], NOW - 2 * min, "toolUse");

  const rates = new Log("rates", `${code}/webshop`, NOW - 90 * min);
  rates.user("Add rate limiting to the orders API.", NOW - 90 * min);
  rates.assistant([tool("a1", "ask", { questions: [{ question: "Where should the limit apply?", options: [
    { label: "Per API key", description: "Fair to every customer" }, { label: "Per IP address", description: "Also covers anonymous calls" },
  ], recommended: 0 }] })], NOW - 12 * min, "toolUse");

  const backup = new Log("backup", `${code}/homelab`, NOW - 5 * 60 * min);
  backup.user("Check that last night's backups completed and can be restored.", NOW - 5 * 60 * min);
  backup.assistant([say("All three backups completed; a test restore of `photos/` matched the source.")], NOW - 4 * 60 * min);

  const post = new Log("post", `${code}/blog`, NOW - 26 * 60 * min);
  post.user("Draft a post about syncing notes offline.", NOW - 26 * 60 * min);
  post.assistant([say("The draft is in `posts/offline-notes.md`.")], NOW - 25 * 60 * min);

  for (const log of [checkout, rates, backup, post]) writeFileSync(`${s.home}/.omp/agent/sessions/project/x_${log.id}.jsonl`, log.text());
  const db = new Database(`${s.home}/.omp/agent/history.db`);
  db.run("INSERT INTO session_recaps VALUES (2, 'backup', 'Verified the nightly backups and test-restored the photos folder.', ?)", [Math.floor(NOW / 1000)]);
  db.run("INSERT INTO session_recaps VALUES (3, 'post', 'Drafted a post on offline note sync, ready for review.', ?)", [Math.floor(NOW / 1000)]);
  db.close();

  s.tree = { sessions: [{ tabs: [{ blocks: [
    { id: 1, cwd: `${code}/webshop`, program: "omp", title: "\u{F07A} CHECKOUT: Fix flaky checkout test" },
    { id: 2, cwd: `${code}/webshop`, program: "omp", title: "\u{F132} RATES: Add rate limiting to orders API" },
    { id: 3, cwd: `${code}/webshop`, file: `${code}/webshop/README.md`, title: "" },
    { id: 4, cwd: `${code}/homelab`, program: "omp", title: "\u{F1C0} BACKUP: Verify nightly backups" },
    { id: 6, cwd: `${code}/blog`, program: "omp", title: "\u{F040} POST: Draft offline notes post" },
  ] }] }] };
  s.saveTree();
  logs = { checkout, rates, backup, post };
});

if (!logs) throw new Error("sandbox setup did not run");
const { checkout, rates, backup, post } = logs;
const build = buildId(await Bun.file(EXT).bytes());
const agents: [string, Log, string, Part][] = [
  ["1", checkout, "working", { context: { tokens: 68000, window: 200000, percent: 34 }, thinking: "high" }],
  ["2", rates, "blocked", {}],
  ["4", backup, "idle", {}],
  ["6", post, "idle", {}],
];
for (const [pane, log, status, extra] of agents) {
  const ext = new Extension(s, pane, "anthropic/claude-opus-5-5");
  Object.assign(ext.snapshot, { sessionId: log.id, leaf: log.leaf, status, protocol: PROTOCOL, build, ...extra });
  await ext.connect();
}
s.signal();

async function shoot(name: string, viewport: { width: number; height: number }, hash: string, ready: string) {
  const app = await openApp(s, viewport, hash);
  await app.page.locator(ready).first().waitFor();
  await app.page.waitForTimeout(600);
  await app.page.screenshot({ path: `${OUT}/${name}.png` });
  await app.context.close();
  if (app.errors.length) throw new Error(app.errors.join("\n"));
}

const phone = { width: 412, height: 860 };
await until(async () => obj((await s.state()).counts).working === 1, "bridges");
await shoot("phone-list", phone, "#/", ".row");
await shoot("phone-session", phone, "#/b/1", ".todo");
await shoot("phone-ask", phone, "#/b/2", ".ask");
await shoot("desktop", { width: 1400, height: 860 }, "#/b/1", ".todo");
await closeBrowser();
await s.close();
console.log(`wrote ${OUT}/{phone-list,phone-session,phone-ask,desktop}.png`);
