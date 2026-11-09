import { describe, expect, test } from "bun:test";
import type { ChatEntry, Run, State } from "./api";
import { DemoServer, demoEventSource, type Clock } from "./demo-backend";
import { isOld } from "./lib";
import { ASK_FORM } from "./demo-fixtures";
import { parseAskForm } from "../lib/ask-form";

/** A clock the test moves by hand: timers run in time order as `advance` passes them. */
class ManualClock implements Clock {
  private t = 1_800_000_000_000;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  after(ms: number, fn: () => void) {
    const timer = { at: this.t + ms, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => void (this.timers = this.timers.filter((x) => x !== timer));
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

const post = (server: DemoServer, path: string, body: unknown) =>
  server.fetch(new URL(path, "http://demo.test"), { method: "POST", body: JSON.stringify(body) });

/** The stream's events the tests read, as the demo sends them. */
type Events = { state: State; chat: { entries: ChatEntry[] }; live: { text: string; done: boolean }; run: Run | null; draft: { live: boolean; text: string } };

/** Opens the app's stream for `block` through the demo's EventSource and records what it delivers. */
function open(server: DemoServer, clock: ManualClock, block: string) {
  const ES = demoEventSource(server);
  const es = new ES(`/api/stream?block=${block}&view=chat`);
  const events: { type: keyof Events; data: unknown }[] = [];
  for (const type of ["state", "chat", "live", "run", "draft"] as const) es.addEventListener(type, (e) => events.push({ type, data: JSON.parse(e.data) }));
  clock.advance(0);
  // The payloads come from the demo's own server, typed as it sends them; the assertions check them.
  const all = <K extends keyof Events>(type: K) => events.filter((e) => e.type === type).map((e) => e.data as Events[K]);
  return { all, last: <K extends keyof Events>(type: K) => all(type).at(-1)! };
}

describe("demo backend", () => {
  test("answers the app's state request with the sample sessions", async () => {
    const clock = new ManualClock();
    const server = new DemoServer(clock);
    const state: State = await (await server.fetch(new URL("http://demo.test/api/state"))).json();
    expect(state.projects.map((p) => p.name)).toEqual(["tern-awui", "api-server", "dotfiles"]);
    const items = state.projects.flatMap((p) => p.items);
    // Each row opens its own session: a shared block id would show another row's content.
    expect(new Set(items.map((i) => i.block)).size).toBe(items.length);
    expect(items.map((i) => i.status)).toEqual(["working", "blocked", null, "idle", "idle", "idle", "idle"]);
    expect(state.counts).toEqual({ working: 1, blocked: 1, idle: 4 });
    // The list's eye has something to hide: two sessions are older than a day.
    expect(items.filter((i) => isOld(i, clock.now(), null)).map((i) => i.title)).toEqual(["Fix the swipe wheel", "Tidy the zsh config"]);
  });

  test("a submitted prompt streams its reply as live text, then lands in the chat", async () => {
    const clock = new ManualClock();
    const server = new DemoServer(clock);
    const { all, last } = open(server, clock, "22");
    expect(last("chat").entries.at(-1)?.role).toBe("turn");

    const r = await post(server, "/api/blocks/22/submit", { text: "use bun:sqlite", images: [] });
    expect(r.ok).toBe(true);
    expect(last("chat").entries.at(-1)).toMatchObject({ role: "user", text: "use bun:sqlite" });
    expect(last("state").projects[1].items[1].status).toBe("working");

    clock.advance(60_000);
    const live = all("live");
    expect(live.length).toBeGreaterThan(3);
    // Each update grows the one before it, and the last is the finished reply.
    for (let i = 1; i < live.length - 1; i++) expect(live[i].text.startsWith(live[i - 1].text)).toBe(true);
    const done = live.at(-1)!;
    expect(done.done).toBe(true);
    expect(done.text).toContain("use bun:sqlite");
    const entries = last("chat").entries;
    expect(entries.findLast((e) => e.role === "assistant")).toMatchObject({ text: done.text });
    expect(last("run")).toBeNull();
    // Watched while it finished: the turn counts as seen.
    expect(last("state").projects[1].items[1]).toMatchObject({ status: "idle", unseen: null });
  });

  test("answering the open ask resolves it and starts a turn", async () => {
    const clock = new ManualClock();
    const server = new DemoServer(clock);
    const { last } = open(server, clock, "12");
    expect(await (await post(server, "/api/blocks/12/answer", { id: "ask-12", values: { push: "hand-rolled" }, other: {} })).json()).toEqual({ ok: true });
    expect(last("chat").entries.find((e) => e.role === "ask")).toMatchObject({ answer: "Which push library should the server use?: Hand-rolled" });
    clock.advance(60_000);
    expect(last("chat").entries.findLast((e) => e.role === "assistant")).toMatchObject({ text: expect.stringContaining("Hand-rolled") });
    // A second answer finds no open question.
    expect((await post(server, "/api/blocks/12/answer", { id: "ask-12", values: { push: "skip" }, other: {} })).status).toBe(409);
  });

  test("the demo's ask fields are what the server parses from its form", () => {
    expect(parseAskForm(ASK_FORM.html)).toEqual(ASK_FORM.fields);
  });

  test("a prompt waits for the open ask to be answered; images aren't taken", async () => {
    const clock = new ManualClock();
    const server = new DemoServer(clock);
    const { last } = open(server, clock, "12");
    const asked = await post(server, "/api/blocks/12/submit", { text: "never mind" });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toEqual({ error: "Answer the question first" });
    expect(last("chat").entries.findLast((e) => e.role === "user")?.text).not.toBe("never mind");
    // An image-only send is refused as an image send, not as an empty prompt.
    const image = await post(server, "/api/blocks/22/submit", { text: "", images: [{ data: "AAAA", mimeType: "image/png" }] });
    expect(image.status).toBe(409);
    expect(await image.json()).toEqual({ error: "Sending images isn't in the demo" });
  });
});
