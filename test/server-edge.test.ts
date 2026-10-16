// Server branches the main scenario (server.test.ts) doesn't reach: startup and shutdown, the
// static app, Web Push delivery, omp without history.db or config, and endpoint/stream errors.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { arr, obj } from "../lib/json";
import { ConfigError, startServer } from "../server";
import { Events, Extension, Sandbox, item, until } from "./server-harness";
import { Transcript } from "./fixtures";
import type { PushSubscription, RequestOptions } from "web-push";

const SERVER = `${import.meta.dir}/../server.ts`;

/** Adds a block to the sandbox's single Tern tab. */
function addBlock(s: Sandbox, block: Record<string, unknown>) {
  arr(obj(arr(obj(arr(s.tree.sessions)[0]).tabs)[0]).blocks).push(block);
  s.saveTree();
}

describe("startup and shutdown", () => {
  const s = new Sandbox();
  afterAll(() => s.close());

  test("without allowed logins the server refuses to start, before writing keys, unless in dev mode", async () => {
    const vapid = `${s.home}/.config/tern-mobile/vapid.json`;
    expect(() => startServer({ env: s.env({ TERN_AWUI_ALLOW: " , ", TERN_AWUI_PORT: "0" }), home: s.home })).toThrow(ConfigError);
    expect(existsSync(vapid)).toBe(false);
    const dev = startServer({ env: s.env({ TERN_AWUI_ALLOW: "", TERN_AWUI_DEV: "1", TERN_AWUI_PORT: "0" }), home: s.home });
    try {
      expect(dev).toMatchObject({ dev: true, allow: [] });
      const base = `http://127.0.0.1:${dev.port}`;
      // Dev mode drops the login check, not the same-origin header on POSTs.
      expect((await fetch(`${base}/api/state`)).status).toBe(200);
      expect((await fetch(`${base}/api/blocks/2/focus`, { method: "POST", body: "{}" })).status).toBe(403);
      expect(existsSync(vapid)).toBe(true);
    } finally {
      await dev.stop();
    }
  });

  test("a taken port fails startup without disturbing the server holding it", async () => {
    await s.start();
    const env = s.env({ TERN_AWUI_PORT: String(s.handle!.port) });
    expect(() => startServer({ env, home: s.home })).toThrow();
    expect((await s.get("/api/state")).status).toBe(200);
    await s.stop();
  });

  test("the event follower retries an exited CLI and stop cancels its retry wait", async () => {
    const command = `${s.home}/bin/tern`;
    const original = readFileSync(command, "utf8");
    writeFileSync(`${command}-real`, original, { mode: 0o755 });
    writeFileSync(command, `#!/bin/bash
if [ "$1" = events ]; then
  echo attempt >> "$TERN_FAKE_DIR/attempts"
  exit 0
fi
exec "$TERN_FAKE_DIR/bin/tern-real" "$@"
`);
    try {
      await s.start();
      // Real subprocess exits drive the reconnect loop; wait for its second attempt.
      await until(() => existsSync(`${s.home}/attempts`) && readFileSync(`${s.home}/attempts`, "utf8").trim().split("\n").length >= 2, "event follower retry", 4000);
      expect((await s.get("/api/state")).status).toBe(200);
      const stopping = Date.now();
      await s.stop();
      expect(Date.now() - stopping).toBeLessThan(1500); // Don't wait out the two-second retry.
    } finally {
      await s.stop();
      writeFileSync(command, original);
      rmSync(`${command}-real`);
    }
  });

  test("stop ends open streams and bridge connections and frees the port", async () => {
    await s.start();
    const port = s.handle!.port;
    const events = new Events();
    await events.open(s, "?block=2");
    await events.take("screen");
    const ext = new Extension(s, "1");
    await ext.connect();
    const closed = new Promise<void>((resolve) => ext.ws.addEventListener("close", () => resolve()));
    // Force-stopping Bun may reset the HTTP socket before its final SSE bytes flush.
    const ended = events.reading!.then(() => "closed", (err) => err.code);
    await s.stop();
    await closed;
    // The stream ended from the server's side; the phone did not abort it.
    expect(["closed", "ECONNRESET"]).toContain(await ended);
    expect(events.abort.signal.aborted).toBe(false);
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("free") });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("free");
    again.stop(true);
    // A second stop is harmless.
    const handle = startServer({ env: s.env({ TERN_AWUI_PORT: "0" }), home: s.home });
    await handle.stop();
    await handle.stop();
  });

  test("a stream lookup completing after stop cannot register a new stream", async () => {
    const late = new Sandbox();
    const command = `${late.home}/bin/tern`;
    writeFileSync(command, `#!/bin/bash
if [ "$1" = ls ]; then
  touch "$TERN_FAKE_DIR/lookup-started"
  while [ ! -e "$TERN_FAKE_DIR/release-lookup" ]; do sleep 0.01; done
fi
${readFileSync(command, "utf8")}
`);
    // Capture the real Bun server to drive a request directly: network cancellation must not
    // conceal whether a response constructed after stop has already allocated stream resources.
    const serving = spyOn(Bun, "serve");
    let server: Bun.Server<{ pane: string | null }>;
    try {
      await late.start();
      server = serving.mock.results[0]!.value as Bun.Server<{ pane: string | null }>;
    } finally {
      serving.mockRestore();
    }
    try {
      const response = Promise.resolve(server.fetch(new Request(`${late.base}/api/stream?block=2`, { headers: late.headers })));
      await until(() => existsSync(`${late.home}/lookup-started`), "pending stream block lookup");
      await late.stop();
      writeFileSync(`${late.home}/release-lookup`, "");
      const reader = (await response).body!.getReader();
      try {
        expect((await reader.read()).done).toBe(true);
      } finally {
        await reader.cancel();
      }
    } finally {
      writeFileSync(`${late.home}/release-lookup`, "");
      await late.close();
    }
  });

  test("`bun server.ts` serves with a startup banner, and exits 2 without allowed logins", async () => {
    const refused = Bun.spawn([process.execPath, SERVER], { env: s.env({ TERN_AWUI_ALLOW: "", TERN_AWUI_PORT: "0" }), stdout: "pipe", stderr: "pipe" });
    expect(await refused.exited).toBe(2);
    expect(await new Response(refused.stderr).text()).toContain("TERN_AWUI_ALLOW must list");
    const dev = Bun.spawn([process.execPath, SERVER], { env: s.env({ TERN_AWUI_DEV: "1", TERN_AWUI_PORT: "0" }), stdout: "pipe", stderr: "inherit" });
    try {
      const reader = dev.stdout.getReader();
      let banner = "";
      while (!banner.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        banner += new TextDecoder().decode(value);
      }
      const url = /tern-mobile on (http:\/\/127\.0\.0\.1:\d+) \(dev: no auth\)/.exec(banner)?.[1];
      expect(url).toBeString();
      expect((await fetch(`${url}/api/state`)).status).toBe(200);
    } finally {
      dev.kill();
      await dev.exited;
    }
  });
});

describe("startup with damaged config files", () => {
  const s = new Sandbox();
  afterAll(() => s.close());
  const config = `${s.home}/.config/tern-mobile`;
  const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: "key", auth: "auth" } });
  const saved = () => JSON.parse(readFileSync(`${config}/push.json`, "utf8")).map((x: { endpoint: string }) => x.endpoint);

  test("an empty push.json starts with no subscriptions instead of stopping the server", async () => {
    await s.start();
    expect((await s.post("/api/push/subscribe", subscription("https://push.test/before"))).status).toBe(200);
    await s.stop();
    writeFileSync(`${config}/push.json`, "");
    await s.start();
    expect((await s.post("/api/push/subscribe", subscription("https://push.test/after"))).status).toBe(200);
    expect(saved()).toEqual(["https://push.test/after"]);
    await s.stop();
  });

  test("unreadable VAPID keys are replaced, privately, and the subscriptions made for the old ones dropped", async () => {
    await s.start();
    const old = await (await s.get("/api/push/key")).json();
    await s.stop();
    for (const broken of ["", '{"publicKey":"short","privateKey":"short"}']) {
      writeFileSync(`${config}/vapid.json`, broken);
      await s.start();
      const key = await (await s.get("/api/push/key")).json();
      expect(key).not.toEqual(old);
      expect(saved()).toEqual([]);
      if (process.platform !== "win32") expect(statSync(`${config}/vapid.json`).mode & 0o777).toBe(0o600);
      // The new keys load as they are on the next start.
      await s.stop();
      await s.start();
      expect(await (await s.get("/api/push/key")).json()).toEqual(key);
      await s.stop();
    }
  });
});

describe("static app", () => {
  const s = new Sandbox();
  const dist = mkdtempSync(`${tmpdir()}/tern-awui-dist-`);
  afterAll(async () => {
    await s.close();
    rmSync(dist, { recursive: true, force: true });
  });

  test("an unbuilt checkout says so; a built one serves its files and falls back to index.html", async () => {
    s.dist = `${dist}/`;
    await s.start();
    const unbuilt = await s.get("/");
    expect(unbuilt.status).toBe(404);
    expect(await unbuilt.text()).toContain("bun run build");
    writeFileSync(`${dist}/index.html`, "<!doctype html>app");
    writeFileSync(`${dist}/app.js`, "console.log(1)");
    writeFileSync(`${dist}/symbols.woff2`, "font");
    const index = await s.get("/");
    expect(await index.text()).toBe("<!doctype html>app");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await (await s.get("/app.js")).text()).toBe("console.log(1)");
    // Client-side routes get the app.
    expect(await (await s.get("/some/route")).text()).toBe("<!doctype html>app");
    expect((await s.get("/symbols.woff2")).headers.get("cache-control")).toBe("max-age=604800");
    const escape = await s.get("/x..y");
    expect(escape.status).toBe(400);
    expect(await escape.text()).toBe("bad path");
  });
});

describe("web push", () => {
  const s = new Sandbox();
  const sent: { endpoint: string; payload: Record<string, unknown>; options: RequestOptions }[] = [];
  /** Endpoints answering with an HTTP error, by status. */
  const failures: Record<string, number> = { "https://push.test/gone": 410, "https://push.test/missing": 404, "https://push.test/flaky": 500 };
  let ext: Extension;
  beforeAll(async () => {
    s.sendNotification = async (sub: PushSubscription, payload: string, options: RequestOptions) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
      const statusCode = failures[sub.endpoint];
      if (statusCode) throw Object.assign(new Error("push service error"), { statusCode });
      return {};
    };
    await s.start();
    for (const endpoint of ["https://push.test/ok", ...Object.keys(failures)])
      expect((await s.post("/api/push/subscribe", { endpoint, keys: { p256dh: "key", auth: "auth" } })).status).toBe(200);
    ext = new Extension(s, "1");
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "working session");
  });
  afterAll(() => s.close());

  test("a session waiting on the user notifies every phone with its question; dropped subscriptions are pruned", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      ext.report({ status: "blocked" });
      await until(() => sent.length === 4, "four push attempts");
      const vapid = JSON.parse(readFileSync(`${s.home}/.config/tern-mobile/vapid.json`, "utf8"));
      for (const push of sent) {
        expect(push.payload).toEqual({ title: "MOBILE: Build phone UI", body: "Needs you · Choose", block: "1", badge: 1 });
        expect(push.options).toMatchObject({ TTL: 900, urgency: "high", vapidDetails: { publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
      }
      // 404/410: the browser dropped the subscription. Other failures may be temporary.
      const saved = () => JSON.parse(readFileSync(`${s.home}/.config/tern-mobile/push.json`, "utf8")).map((x: { endpoint: string }) => x.endpoint);
      await until(() => saved().length === 2, "pruned subscriptions");
      expect(saved()).toEqual(["https://push.test/ok", "https://push.test/flaky"]);
      expect(errors).toHaveBeenCalledWith("push failed", 500);
    } finally {
      errors.mockRestore();
    }
  });

  test("a finished turn notifies once it settles; a quick follow-up turn postpones it", async () => {
    sent.length = 0;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const leaf = s.transcript.say("**Done** with `build` _now_", 5000);
      writeFileSync(s.transcriptPath, s.transcript.text());
      ext.report({ status: "working" });
      await until(async () => item(await s.state(), 1).status === "working", "working again");
      // This integration checks the platform's settle/cancel timer with real WebSocket traffic;
      // advancing a global fake clock would also advance the socket/stream polling deadlines.
      ext.report({ status: "idle", leaf });
      await Bun.sleep(300);
      ext.report({ status: "working" });
      await Bun.sleep(300);
      ext.report({ status: "idle" });
      const started = Date.now();
      await until(() => sent.length === 2, "done pushes", 4500);
      // Settling restarted at the second idle.
      expect(Date.now() - started).toBeGreaterThan(2500);
      expect(sent.map((p) => p.endpoint)).toEqual(["https://push.test/ok", "https://push.test/flaky"]);
      expect(sent[0].payload).toEqual({ title: "MOBILE: Build phone UI", body: "Finished · Done with build now", block: "1", badge: 1 });
      expect(sent).toHaveLength(2);
      expect(item(await s.state(), 1).unseen).toBe("done");
    } finally {
      errors.mockRestore();
    }
  }, 8000);
});

test("a late push rejection cannot overwrite subscriptions saved by a restarted server", async () => {
  const s = new Sandbox();
  const delivery = Promise.withResolvers<unknown>();
  const attempted = Promise.withResolvers<void>();
  s.sendNotification = () => {
    attempted.resolve();
    return delivery.promise;
  };
  const original = { endpoint: "https://push.test/original", keys: { p256dh: "key", auth: "auth" } };
  const replacement = { ...original, endpoint: "https://push.test/replacement" };
  try {
    await s.start();
    await s.post("/api/push/subscribe", original);
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "original bridge");
    ext.report({ status: "blocked" });
    await attempted.promise;
    await s.stop();
    await s.start();
    await s.post("/api/push/unsubscribe", original);
    await s.post("/api/push/subscribe", replacement);
    delivery.reject({ statusCode: 410 });
    // The server attached its rejection handler before this one; it runs before this await resumes.
    await delivery.promise.catch(() => {});
    expect(JSON.parse(readFileSync(`${s.home}/.config/tern-mobile/push.json`, "utf8"))).toEqual([replacement]);
  } finally {
    delivery.resolve({});
    await s.close();
  }
});

describe("omp without history.db or a readable config", () => {
  const s = new Sandbox();
  afterAll(() => s.close());

  test("recaps appear once history.db exists with its table, without a restart", async () => {
    rmSync(`${s.home}/.omp/agent/history.db`);
    // Config output that isn't JSON: no roles, and the list still builds.
    writeFileSync(`${s.home}/bin/omp`, "#!/bin/bash\necho 'omp: unknown command'\n");
    await s.start();
    const ext = new Extension(s, "1");
    await ext.connect();
    const row = await until(async () => {
      const state = await s.state();
      return item(state, 1).agent ? state : null;
    }, "agent row");
    expect(obj(item(row, 1).agent)).toMatchObject({ lastPrompt: "Which route?", recap: "", recapStale: false });
    expect(row.roles).toEqual([]);
    expect((await s.action(1, "model", { role: "smart" })).status).toBe(400);
    const db = new Database(`${s.home}/.omp/agent/history.db`);
    db.run("CREATE TABLE unrelated (x)");
    ext.report({ model: "test/no-recaps-table" });
    const withoutTable = await until(async () => {
      const state = await s.state();
      return obj(item(state, 1).live).model === "test/no-recaps-table" ? state : null;
    }, "state with missing recaps table");
    expect(obj(item(withoutTable, 1).agent).recap).toBe("");
    db.run("CREATE TABLE session_recaps (id INTEGER PRIMARY KEY, session_id TEXT, recap TEXT, created_at INTEGER)");
    db.run("INSERT INTO session_recaps VALUES (1, ?, 'Late recap', 1)", [s.session]);
    db.close();
    await until(async () => {
      s.signal();
      return obj(item(await s.state(), 1).agent).recap === "Late recap";
    }, "late recap");
  });

  test("a session whose transcript can't be found shows a bare row", async () => {
    const ext = new Extension(s, "4");
    ext.snapshot.sessionId = "no-such-session";
    await ext.connect();
    const agent = await until(async () => item(await s.state(), 4).agent, "unknown session row");
    expect(agent).toEqual({ sessionId: "no-such-session", lastPrompt: "", recap: "", recapStale: false, lastActivity: 0, subagents: 0 });
  });
});

describe("endpoint and stream edges", () => {
  const s = new Sandbox();
  const notes = `${s.home}/.local/state/tern/notes`;
  beforeAll(async () => {
    writeFileSync(`${s.home}/big.txt`, "x".repeat(512 * 1024 + 10));
    mkdirSync(`${s.home}/folder`);
    writeFileSync(`${notes}/0bad.md`, "secret");
    addBlock(s, { id: 5, cwd: s.home, file: `${s.home}/big.txt` });
    addBlock(s, { id: 6, cwd: s.home, file: `${s.home}/gone.md` });
    addBlock(s, { id: 7, cwd: s.home, file: `${s.home}/folder` });
    addBlock(s, { id: 9, cwd: s.home, file: "note:0bad" });
    // A relative path is not a document.
    addBlock(s, { id: 10, cwd: s.home, file: "relative.md", title: "rel" });
    await s.start();
  });
  afterAll(() => s.close());

  test("documents are clipped at 512 KiB; missing files, folders and relative paths show no text", async () => {
    const big = new Events();
    await big.open(s, "?block=5");
    const doc = obj(await big.take("doc"));
    expect(doc).toMatchObject({ markdown: false, missing: false, clipped: true });
    expect(String(doc.text)).toHaveLength(512 * 1024);
    big.close();
    for (const [block, want] of [[6, { text: "", markdown: true, missing: true, clipped: false }], [7, { text: "", markdown: false, missing: false, clipped: false }]] as const) {
      const events = new Events();
      await events.open(s, `?block=${block}`);
      expect(await events.take("doc")).toEqual(want);
      events.close();
    }
    // The missing file appears: the open screen picks it up.
    const late = new Events();
    await late.open(s, "?block=6");
    await late.take("doc");
    writeFileSync(`${s.home}/gone.md`, "# Back");
    expect(await late.take("doc")).toEqual({ text: "# Back", markdown: true, missing: false, clipped: false });
    late.close();
    expect(item(await s.state(), 10).doc).toBeNull();
  });

  test("untitled file blocks are named after their file with a file-type icon; notes are called Note", async () => {
    const state = await s.state();
    const md = item(state, 6), txt = item(state, 5), note = item(state, 9);
    expect([md.title, txt.title, note.title]).toEqual(["gone.md", "big.txt", "Note"]);
    expect(new Set([md.icon, txt.icon, note.icon]).size).toBe(3);
    expect([md.icon, txt.icon, note.icon].every((i) => typeof i === "string" && i.length > 0)).toBe(true);
    // A title Tern set still wins.
    expect(item(state, 10).title).toBe("rel");
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable document reports an error on the stream, which recovers once it is readable", async () => {
    chmodSync(`${notes}/0bad.md`, 0);
    const events = new Events();
    await events.open(s, "?block=9");
    expect(String(obj(await events.take("error")).message)).toContain("EACCES");
    chmodSync(`${notes}/0bad.md`, 0o644);
    expect(obj(await events.take("doc")).text).toBe("secret");
    events.close();
  });

  test("an omp pane outside the chat view streams the last screenful of its surface text", async () => {
    writeFileSync(`${s.home}/surfaces`, `${Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")}\n\n  \n`);
    const ext = new Extension(s, "1");
    await ext.connect();
    await until(async () => item(await s.state(), 1).live, "bridged pane");
    const events = new Events();
    await events.open(s, "?block=1&view=screen");
    const screen = obj(await events.take("screen"));
    expect(screen.html).toBe(false);
    const lines = String(screen.text).split("\n");
    expect(lines).toHaveLength(160);
    expect([lines[0], lines.at(-1)]).toEqual(["line 41", "line 200"]);
    events.close();
    ext.ws.close();
    await until(async () => item(await s.state(), 1).live === null, "pane 1 unbridged");
    rmSync(`${s.home}/surfaces`);
  });

  test("bridge-only commands on a pane without omp are refused before reaching tern", async () => {
    s.clearCalls();
    for (const [action, body] of [["complete", { text: "/he" }], ["completion", { value: "/help" }], ["btw", { text: "why?" }], ["thinking", { level: "high" }], ["tier", { tier: "priority" }], ["models", {}], ["model", { spec: "test/x" }], ["draft", { text: "x" }]] as const) {
      const r = await s.action(2, action, body);
      expect([action, r.status]).toEqual([action, 409]);
      expect(await r.json()).toEqual({ error: "no bridge" });
    }
    expect(s.calls()).toEqual([]);
  });

  test("unknown routes are 404; a new tab's unreadable reply still succeeds; tern failures surface", async () => {
    expect((await s.get("/api/nothing")).status).toBe(404);
    expect((await s.post("/api/nothing")).status).toBe(404);
    expect((await s.post("/api/blocks/2/explode")).status).toBe(404);
    writeFileSync(`${s.home}/new-out`, "Opened a tab");
    expect(await (await s.post("/api/new", { cwd: `${s.home}/beta` })).json()).toEqual({ ok: true });
    rmSync(`${s.home}/new-out`);
    writeFileSync(`${s.home}/fail`, "tern: daemon not running\n");
    const failed = await s.post("/api/new", { cwd: `${s.home}/beta` });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "tern: daemon not running" });
    rmSync(`${s.home}/fail`);
    // A silent nonzero exit still fails, naming the subcommand.
    writeFileSync(`${s.home}/exit`, "3");
    const focus = await s.action(2, "focus");
    expect(await focus.json()).toEqual({ error: "tern focus exited 3" });
    const close = await s.action(2, "close");
    expect(close.status).toBe(502);
    rmSync(`${s.home}/exit`);
    expect((await s.post("/api/new", { cwd: `${s.home}/big.txt` })).status).toBe(400);
  });

  test("silent bridges fail each command within the reply deadline, without submitting partial drafts", async () => {
    const ext = new Extension(s, "1");
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "bridge ready");
    ext.silent = true;
    s.clearCalls();
    const commands: [string, Record<string, unknown>, string][] = [
      ["submit", { text: "never acknowledged" }, "omp did not take the draft"],
      ["submit", { text: "later", followUp: true }, "omp did not take the message"],
      ["complete", { text: "/he" }, "omp did not answer"],
      ["completion", { value: "/help" }, "omp did not apply it"],
      ["models", {}, "omp did not answer"],
      ["model", { spec: "test/fast" }, "omp did not answer"],
      ["thinking", { level: "high" }, "omp did not answer"],
      ["tier", { tier: "priority" }, "omp did not answer"],
      ["abort", {}, "omp did not answer"],
      ["btw", { text: "why?" }, "omp did not answer"],
    ];
    await Promise.all(commands.map(async ([action, body, error]) => {
      const response = await s.action(1, action, body);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error });
    }));
    expect(s.calls()).toEqual([]); // No Enter after an unacknowledged draft.
    const timedOut = await ext.take("model");
    ext.send({ t: "reply", seq: timedOut.seq, error: "late error" });
    ext.silent = false;
    expect(await (await s.action(1, "model", { spec: "test/recovered" })).json()).toEqual({ ok: true });
    expect(obj(item(await s.state(), 1).live).model).toBe("test/recovered");
    ext.ws.close();
    await until(async () => item(await s.state(), 1).live === null, "bridge closed");
  }, 5000);

  test("bridge messages that aren't JSON or name no pane are ignored; the connection keeps working", async () => {
    const ext = new Extension(s, "4");
    await ext.connect();
    await until(async () => item(await s.state(), 4).status === "working", "bridged pane 4");
    ext.ws.send("not json");
    ext.send({ t: "state", pane: "../1", status: "blocked" });
    ext.send({ t: "reply", seq: 987654 });
    ext.send({ t: "live", text: "stray" });
    ext.report({ model: "test/after-garbage" });
    await until(async () => obj(item(await s.state(), 4).live).model === "test/after-garbage", "state after garbage");
    expect(item(await s.state(), 1).status).toBeNull();
    ext.ws.close();
  });
});

test("malformed or non-object POST bodies never send terminal input", async () => {
  const s = new Sandbox();
  try {
    await s.start();
    for (const body of [undefined, "{broken", "", "null", "[]", '"text"']) {
      const response = await fetch(`${s.base}/api/blocks/2/submit`, {
        method: "POST", headers: { ...s.headers, "x-tern-mobile": "1", "content-type": "application/json" }, body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "expected a JSON object" });
    }
    expect(s.calls()).toEqual([]);
  } finally {
    await s.close();
  }
});

test("the browser's bodyless catalog request and no-argument actions remain valid", async () => {
  const s = new Sandbox();
  try {
    await s.start();
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "bridge ready");
    const headers = { ...s.headers, "x-tern-mobile": "1" };
    // This is the model picker's real fetch shape: no JSON header and no body.
    const models = await fetch(`${s.base}/api/blocks/1/models`, { method: "POST", headers });
    expect(models.status).toBe(200);
    expect(arr(obj(await models.json()).models)).toHaveLength(1);
    for (const [block, action] of [[2, "focus"], [1, "abort"], [2, "abort"], [2, "close"]] as const)
      expect((await fetch(`${s.base}/api/blocks/${block}/${action}`, { method: "POST", headers })).status).toBe(200);
    expect((await ext.take("abort")).t).toBe("abort");
    expect(s.calls()).toEqual([["focus", "2"], ["send", "2", "keys", "Escape"], ["close", "2"]]);
    s.clearCalls();
    for (const action of ["models", "focus", "abort", "close"]) {
      const response = await fetch(`${s.base}/api/blocks/1/${action}`, { method: "POST", headers, body: "{broken" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "expected a JSON object" });
    }
    expect(s.calls()).toEqual([]);
  } finally {
    await s.close();
  }
});

test("bridge errors reach every command response and never submit a rejected draft or cache a failed catalog", async () => {
  const s = new Sandbox();
  try {
    await s.start();
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "bridge ready");
    const original = ext.ws.onmessage;
    ext.ws.onmessage = (event) => {
      const msg = obj(JSON.parse(String(event.data)));
      if (msg.t !== "watch") ext.send({ t: "reply", seq: msg.seq, error: "command refused" });
    };
    for (const [action, body] of [
      ["submit", { text: "rejected draft" }], ["submit", { text: "later", followUp: true }],
      ["draft", { text: "rejected" }], ["abort", {}], ["btw", { text: "why?" }],
      ["models", {}], ["model", { spec: "test/fast" }], ["thinking", { level: "high" }],
      ["tier", { tier: "priority" }], ["complete", { text: "/he" }], ["completion", { value: "/help" }],
    ] as const) {
      const response = await s.action(1, action, body);
      expect([action, response.status]).toEqual([action, 502]);
      expect(await response.json()).toEqual({ error: "command refused" });
    }
    expect(s.calls()).toEqual([]);
    ext.ws.onmessage = original;
    expect(arr(obj(await (await s.action(1, "models")).json()).models)).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test("a replacement bridge clears the previous live text and queue and ignores its late side answers", async () => {
  const s = new Sandbox();
  try {
    await s.start();
    const old = new Extension(s);
    await old.connect();
    await until(async () => item(await s.state(), 1).live, "old bridge");
    const events = new Events();
    await events.open(s, "?block=1");
    await events.take("chat");
    await old.take("watch");
    old.send({ t: "live", text: "old live", done: false });
    await events.take("live", (data) => obj(data).text === "old live");
    old.report({ queued: ["old queued"] });
    await events.take("queued", (data) => arr(data).length === 1);
    const fresh = new Extension(s, "1", "test/replacement");
    await fresh.connect();
    await events.take("state", (state) => obj(item(state, 1).live).model === "test/replacement");
    expect(await events.take("live")).toEqual({ text: "", done: false });
    expect(await events.take("queued")).toEqual([]);
    expect((await old.take("watch")).on).toBe(false);
    expect((await fresh.take("watch")).on).toBe(true);
    old.send({ t: "btw", id: "previous-question", text: "stale answer", done: true });
    const closed = new Promise<void>((resolve) => old.ws.addEventListener("close", () => resolve()));
    old.ws.close();
    await closed;
    fresh.report({ model: "test/after-old-close" });
    await events.take("state", (state) => obj(item(state, 1).live).model === "test/after-old-close");
    expect(events.events.filter((event) => event.event === "btw")).toEqual([]);
  } finally {
    await s.close();
  }
});

test("closing the last pane clears its badge, but an invalid Tern list cannot clear unseen updates", async () => {
  const s = new Sandbox();
  try {
    await s.start();
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "working");
    ext.report({ status: "blocked" });
    await until(async () => item(await s.state(), 1).unseen === "blocked", "blocked badge");
    s.tree = {};
    s.saveTree();
    s.signal();
    const failed = await until(async () => {
      const state = await s.state();
      return arr(state.projects).length === 0 ? state : null;
    }, "invalid list");
    expect(failed.badge).toBe(1);
    const events = new Events();
    await events.open(s);
    await events.take("state");
    s.tree = { sessions: [] };
    s.saveTree();
    s.signal();
    expect(obj(await events.take("state", (state) => obj(state).badge === 0)).projects).toEqual([]);
  } finally {
    await s.close();
  }
});

test("equal-size transcript replacements refresh both the parent chat and subagent chat", async () => {
  const s = new Sandbox();
  try {
    const dir = s.transcriptPath.replace(/\.jsonl$/, "");
    mkdirSync(dir);
    const sub = new Transcript("helper");
    sub.user("old", 1000);
    const subPath = `${dir}/Helper.jsonl`;
    writeFileSync(subPath, sub.text());
    await s.start();
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).agent, "agent");
    for (const [path, query, before, after] of [
      [s.transcriptPath, "?block=1", "Fixed", "Other"],
      [subPath, "?block=1&sub=Helper", "old", "new"],
    ]) {
      const events = new Events();
      await events.open(s, query);
      await events.take("chat");
      writeFileSync(`${path}.new`, readFileSync(path, "utf8").replace(before, after));
      renameSync(`${path}.new`, path);
      const chat = await events.take("chat", (data) => arr(obj(data).entries).some((entry) => obj(entry).text === after));
      expect(arr(obj(chat).entries).some((entry) => obj(entry).text === before)).toBe(false);
      events.close();
    }
  } finally {
    await s.close();
  }
});

test("a stale push rejection cannot delete a replacement subscription at the same endpoint", async () => {
  const s = new Sandbox();
  const delivery = Promise.withResolvers<unknown>();
  const attempted = Promise.withResolvers<void>();
  s.sendNotification = () => { attempted.resolve(); return delivery.promise; };
  const original = { endpoint: "https://push.test/device", keys: { p256dh: "old-key", auth: "old-auth" } };
  const replacement = { ...original, keys: { p256dh: "new-key", auth: "new-auth" } };
  try {
    await s.start();
    await s.post("/api/push/subscribe", original);
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "working");
    ext.report({ status: "blocked" });
    await attempted.promise;
    await s.post("/api/push/subscribe", replacement);
    delivery.reject({ statusCode: 410 });
    await delivery.promise.catch(() => {});
    expect(JSON.parse(readFileSync(`${s.home}/.config/tern-mobile/push.json`, "utf8"))).toEqual([replacement]);
  } finally {
    delivery.resolve({});
    await s.close();
  }
});

test("a bridge replacement cancels the previous session's finish timer and working reconnects clear old badges", async () => {
  const s = new Sandbox();
  const sent: string[] = [];
  s.sendNotification = async (_sub, payload) => { sent.push(payload); };
  const timers = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  try {
    await s.start();
    await s.post("/api/push/subscribe", { endpoint: "https://push.test/device", keys: { p256dh: "key", auth: "auth" } });
    const old = new Extension(s);
    await old.connect();
    await until(async () => item(await s.state(), 1).status === "working", "working");
    old.report({ status: "idle" });
    await until(async () => item(await s.state(), 1).status === "idle", "idle");
    const scheduled = timers.mock.results[timers.mock.calls.findIndex((call) => call[1] === 3000)];
    if (scheduled?.type !== "return") throw new Error("finish timer was not scheduled");
    const settleTimer = scheduled.value;
    const fresh = new Extension(s, "1", "test/new-session");
    Object.assign(fresh.snapshot, { status: "idle", sessionId: "new-session" });
    await fresh.connect();
    await until(async () => obj(item(await s.state(), 1).live).model === "test/new-session", "replacement");
    expect(cleared.mock.calls).toContainEqual([settleTimer]);
    expect(sent).toEqual([]);
    expect(item(await s.state(), 1).unseen).toBeNull();
    fresh.report({ status: "blocked" });
    await until(async () => item(await s.state(), 1).unseen === "blocked", "blocked");
    const working = new Extension(s, "1", "test/working-reconnect");
    await working.connect();
    await until(async () => obj(item(await s.state(), 1).live).model === "test/working-reconnect", "working reconnect");
    expect(item(await s.state(), 1).unseen).toBeNull();
  } finally {
    timers.mockRestore();
    cleared.mockRestore();
    await s.close();
  }
});

test("terminal edits erase all changed characters in bounded key batches before replacing text", async () => {
  const s = new Sandbox();
  try {
    await s.start();
    expect((await s.action(2, "type", { back: 1201, text: "replacement" })).status).toBe(200);
    const calls = s.calls();
    expect(calls.filter((call) => call[2] === "keys").map((call) => call.length - 3)).toEqual([500, 500, 201]);
    expect(calls.at(-1)).toEqual(["send", "2", "text", "replacement"]);
    s.clearCalls();
    writeFileSync(`${s.home}/fail`, "terminal failed");
    expect((await s.action(2, "type", { back: 600, text: "do not type" })).status).toBe(502);
    expect(s.calls()).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test.skipIf(process.getuid?.() === 0)("an unreadable session cannot break the block list or leave an unhandled push rejection", async () => {
  const s = new Sandbox();
  s.sendNotification = async () => {};
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    chmodSync(s.transcriptPath, 0);
    await s.start();
    await s.post("/api/push/subscribe", { endpoint: "https://push.test/device", keys: { p256dh: "key", auth: "auth" } });
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "unreadable session still listed");
    expect(obj(item(await s.state(), 1).agent).lastPrompt).toBe("");
    ext.report({ status: "blocked" });
    await until(() => errors.mock.calls.some(([message, error]) => message === "push failed" && String(error).includes("EACCES")), "reported push read error");
    expect((await s.get("/api/push/key")).status).toBe(200);
    chmodSync(s.transcriptPath, 0o600);
    s.signal();
    await until(async () => obj(item(await s.state(), 1).agent).lastPrompt === "Which route?", "readable session recovers");
  } finally {
    errors.mockRestore();
    chmodSync(s.transcriptPath, 0o600);
    await s.close();
  }
});

test("a bridge can connect before the sessions folder exists and pick up its transcript later", async () => {
  const s = new Sandbox();
  try {
    rmSync(`${s.home}/.omp/agent/sessions`, { recursive: true });
    await s.start();
    const ext = new Extension(s);
    await ext.connect();
    await until(async () => item(await s.state(), 1).status === "working", "session without folder");
    expect(obj(item(await s.state(), 1).agent).lastPrompt).toBe("");
    mkdirSync(`${s.home}/.omp/agent/sessions/project`, { recursive: true });
    writeFileSync(s.transcriptPath, s.transcript.text());
    s.signal();
    await until(async () => obj(item(await s.state(), 1).agent).lastPrompt === "Which route?", "late session transcript");
  } finally {
    await s.close();
  }
});
