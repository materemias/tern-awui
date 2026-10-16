import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Item } from "./api";
import { FakeEventSource, item, live, Net, settle, state } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Preact and the component must bind to the registered browser globals, not Bun's initial globals.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { Home, railGlyph } = await import("./home");

const net = new Net();
let root: HTMLElement;
let confirmed: boolean;
let prompts: string[];
let alerts: string[];
const restore: (() => void)[] = [];
function property(target: object, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
}
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  localStorage.clear();
  history.replaceState(null, "", "/");
  confirmed = true;
  prompts = [];
  alerts = [];
  net.install();
  FakeEventSource.all = [];
  property(globalThis, "EventSource", FakeEventSource);
  property(globalThis, "confirm", (message: string) => { prompts.push(message); return confirmed; });
  property(globalThis, "alert", (message: string) => alerts.push(message));
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
  for (const undo of restore.splice(0).reverse()) undo();
});
async function mount(items?: Item[], selected: string | null = null, wide = true) {
  await act(() => render(<Home wide={wide} selected={selected} />, root));
  if (items) await act(() => { FakeEventSource.last.open(); FakeEventSource.last.emit("state", state(items)); });
  await act(() => settle());
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => { (el as HTMLElement).click(); await settle(); });
}
async function input(selector: string, value: string) {
  await act(() => {
    const el = root.querySelector<HTMLInputElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function row(block: string) { return root.querySelector<HTMLAnchorElement>(`.row[href="#/b/${block}"]`); }
function pushBrowser(permission: NotificationPermission = "default") {
  const subscription = {
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({ endpoint: "https://push.invalid/device" }),
    unsubscribe: async () => true,
  };
  let subscribed = false;
  property(window, "PushManager", class {});
  property(globalThis, "Notification", { permission, requestPermission: async () => "granted" });
  property(navigator, "serviceWorker", { ready: Promise.resolve({ pushManager: {
    getSubscription: async () => subscribed ? subscription : null,
    subscribe: async () => { subscribed = true; return subscription; },
  } }) });
}

describe("Home", () => {
  test("connects to the list stream, renders counts and updates connectivity", async () => {
    await mount();
    expect(root.textContent).toContain("Connecting…");
    expect(FakeEventSource.last.url).toBe("/api/stream");
    expect(root.querySelector(".net.off")).not.toBeNull();
    await act(() => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit("state", state([item()], { counts: { blocked: 2, working: 3, idle: 4 } }));
    });
    expect(root.querySelector(".net.on")).not.toBeNull();
    expect([...root.querySelectorAll(".counts > span")].map((c) => [c.textContent, c.getAttribute("title")])).toEqual([["2", "2 blocked"], ["3", "3 working"], ["4", "4 idle"]]);
    expect(row("5")?.querySelector(".pi")?.textContent).toBe("π");
    await act(() => FakeEventSource.last.fail());
    expect(root.querySelector(".net.off")).not.toBeNull();
  });

  test("persists collapse state, shows active counts and temporarily opens filter matches", async () => {
    localStorage.setItem("tern-mobile:collapsed-projects", '["app"]');
    await mount([item({ status: "working" }), item({ block: "6", status: "blocked" })]);
    expect(root.querySelector("section.shut .group-hot")?.textContent).toBe("2 active");
    expect(row("5")).toBeNull();
    await input(".search input", "login");
    expect(root.querySelector("section.shut")).toBeNull();
    expect(row("5")).not.toBeNull();
    expect(localStorage.getItem("tern-mobile:collapsed-projects")).toBe('["app"]');
    await input(".search input", "");
    expect(row("5")).toBeNull();
    await click(root.querySelector("h2"));
    expect(row("5")).not.toBeNull();
    expect(localStorage.getItem("tern-mobile:collapsed-projects")).toBe("[]");
    await click(root.querySelector("h2"));
    expect(localStorage.getItem("tern-mobile:collapsed-projects")).toBe('["app"]');
    await act(() => render(null, root));
    await mount([item()]);
    expect(root.querySelector("section.shut")).not.toBeNull();
  });

  test("hide-old persists, exempts active, unseen, selected and timeless rows, and filtering restores old matches", async () => {
    const since = Date.now() - 2 * 86400000;
    await mount([
      item({ block: "old", title: "Ancient entry", since }),
      item({ block: "working", status: "working", since }),
      item({ block: "blocked", status: "blocked", since }),
      item({ block: "unseen", unseen: "done", since }),
      item({ block: "selected", since }),
      item({ block: "shell", agent: null, live: null, status: null, since: 0 }),
      item({ block: "recent", since: Date.now() }),
    ], "selected");
    expect(root.querySelectorAll(".row").length).toBe(7);
    await click(root.querySelector('[aria-label="Hide sessions older than a day"]'));
    expect(row("old")).toBeNull();
    expect(root.querySelectorAll(".row").length).toBe(6);
    expect(row("selected")?.classList.contains("selected")).toBe(true);
    expect(root.querySelector('[aria-label="Show 1 sessions older than a day"] .hidden-count')?.textContent).toBe("1");
    expect(localStorage.getItem("tern-mobile:hide-old")).toBe("on");
    await input(".search input", "Ancient entry");
    expect(root.querySelectorAll(".row").length).toBe(1);
    expect(row("old")).not.toBeNull();
    await input(".search input", "");
    await click(root.querySelector('[aria-label="Show 1 sessions older than a day"]'));
    expect(row("old")).not.toBeNull();
    expect(localStorage.getItem("tern-mobile:hide-old")).toBe("off");
    await act(() => render(null, root));
    localStorage.setItem("tern-mobile:hide-old", "on");
    await mount([item({ since })]);
    expect(root.querySelector(".row")).toBeNull();
  });

  test("unseen states color icon rows, iconless shells get dots, and jobs and mismatches remain visible", async () => {
    await mount([
      item({ block: "glyph", icon: "★", tag: "review", unseen: "done", live: live({ mismatch: "older", jobs: [
        { id: "a", type: "task", label: "Review", agent: "review", since: 0 },
        { id: "b", type: "eval", label: "Check", agent: "check", since: 0 },
        { id: "c", type: "bash", label: "Build", agent: "", since: 0 },
      ] }) }),
      item({ block: "pi", unseen: "blocked", status: "blocked", live: live({ mismatch: "newer" }) }),
      item({ block: "plain", unseen: "done", agent: null, live: null, status: null }),
      item({ block: "hot", status: "working" }),
    ]);
    expect(row("glyph")?.classList.contains("unseen-done")).toBe(true);
    expect(row("glyph")?.querySelector(".nf")?.textContent).toBe("★");
    expect(row("glyph")?.querySelector(".tag")?.textContent).toBe("review");
    expect(row("glyph")?.querySelector(".new-dot")).toBeNull();
    expect(row("glyph")?.querySelector(".row-jobs")?.textContent).toBe("2 subagents · 1 background job");
    expect(row("glyph")?.querySelector(".ext-mark")?.getAttribute("title")).toContain("an older");
    expect(row("pi")?.classList.contains("unseen-blocked")).toBe(true);
    expect(row("pi")?.querySelector(".nf.pi")?.textContent).toBe("π");
    expect(row("pi")?.querySelector(".age-blocked")).not.toBeNull();
    expect(row("pi")?.querySelector(".ext-mark")?.getAttribute("title")).toContain("a newer");
    expect(row("plain")?.querySelector(".new-dot.new-done")?.getAttribute("title")).toBe("New since you last looked");
    expect(row("plain")?.querySelector(".nf")).toBeNull();
    expect(row("plain")?.querySelector(".age")?.textContent).toBe("");
    expect(row("hot")?.querySelector(".age-hot")).not.toBeNull();
    expect(root.querySelector(".ext-chip")?.getAttribute("title")).toStartWith("2 sessions run");
    await act(() => FakeEventSource.last.emit("state", state([item({ live: live({ mismatch: "older" }) })])));
    expect(root.querySelector(".ext-chip")?.getAttribute("title")).toStartWith("1 session runs");
  });

  test("project creation confirms, disables while pending, navigates on success and reports server errors", async () => {
    await mount([item()]);
    const add = root.querySelector("h2 button")!;
    confirmed = false;
    await click(add);
    expect(prompts).toEqual(["Start a new omp in app?"]);
    expect(net.to("/api/new")).toEqual([]);
    expect(root.querySelector("section.shut")).toBeNull();
    confirmed = true;
    const pending = Promise.withResolvers<Response>();
    net.reply = () => pending.promise;
    await click(add);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(net.calls.at(-1)).toEqual({ url: "/api/new", method: "POST", body: { cwd: "/w/app" }, headers: { "content-type": "application/json", "x-tern-mobile": "1" } });
    await act(async () => { pending.resolve(Response.json({ block: "new" })); await settle(); });
    expect(location.hash).toBe("#/b/new");
    expect((add as HTMLButtonElement).disabled).toBe(false);
    net.reply = () => Response.json({ error: "Could not start omp" }, { status: 500 });
    await click(add);
    expect(alerts).toEqual(["Could not start omp"]);
    net.reply = () => new Response("not json", { status: 502 });
    await click(add);
    expect((add as HTMLButtonElement).disabled).toBe(false);
    expect(alerts.length).toBe(1);
  });

  test("a failed new-session request reports the error and re-enables creation", async () => {
    await mount([item()]);
    const add = root.querySelector<HTMLButtonElement>("h2 button")!;
    net.reply = () => Promise.reject(new TypeError("Failed to fetch"));
    await click(add);
    expect(add.disabled).toBe(false);
    expect(alerts).toEqual(["TypeError: Failed to fetch"]);
    expect(location.hash).toBe("");
    net.reply = () => Response.json({ block: "6" });
    await click(add);
    expect(net.to("/api/new")).toEqual([{ cwd: "/w/app" }, { cwd: "/w/app" }]);
    expect(location.hash).toBe("#/b/6");
  });

  test("new-project sheet loads and filters folders, marks open folders and creates without confirmation", async () => {
    const pending = Promise.withResolvers<Response>();
    net.reply = (c) => c.url === "/api/projects" ? pending.promise : Response.json({ block: "picked" });
    await mount([item({ cwd: "/home/u/code/app" })]);
    await click(root.querySelector('[aria-label="New omp in a project"]'));
    expect(root.querySelector(".sheet-head")?.textContent).toContain("loading");
    await act(async () => { pending.resolve(Response.json({ projects: ["/home/u/code/app", "/home/u/code/other"], home: "/home/u" })); await settle(); });
    expect(root.querySelector(".sheet-head")?.textContent).toContain("2 projects");
    expect(root.querySelector(".sheet-row .c-working")?.textContent).toBe("open · ");
    expect(root.querySelector(".sheet-row")?.textContent).toContain("~/code");
    await click(root.querySelector(".sheet-head"));
    expect(root.querySelector(".sheet")).not.toBeNull();
    await input(".sheet-filter", "other code");
    expect(root.querySelectorAll(".sheet-row").length).toBe(1);
    await click(root.querySelector(".sheet-row"));
    expect(root.querySelector(".sheet")).toBeNull();
    expect(net.to("/api/new")).toEqual([{ cwd: "/home/u/code/other" }]);
    expect(prompts).toEqual([]);
    expect(location.hash).toBe("#/b/picked");
  });

  test("project-list failures and missing fields leave an empty closable sheet", async () => {
    await mount([]);
    net.reply = () => Promise.reject(new Error("offline"));
    await click(root.querySelector('[aria-label="New omp in a project"]'));
    await act(() => settle());
    expect(root.querySelector(".sheet-head")?.textContent).toContain("0 projects");
    await click(root.querySelector(".sheet-backdrop"));
    expect(root.querySelector(".sheet")).toBeNull();
    net.reply = () => Response.json({});
    await click(root.querySelector('[aria-label="New omp in a project"]'));
    await act(() => settle());
    expect(root.querySelector(".sheet-head")?.textContent).toContain("0 projects");
  });

  test("bell renders off, pending and on states and submits subscriptions through its real hook", async () => {
    pushBrowser();
    const pending = Promise.withResolvers<Response>();
    net.reply = (c) => c.url === "/api/push/key" ? Response.json({ key: "AQID" }) : c.url === "/api/push/subscribe" ? pending.promise : Response.json({ ok: true });
    await mount([]);
    const off = root.querySelector<HTMLButtonElement>('[aria-label="Notifications off"]');
    expect(off?.querySelectorAll("path").length).toBe(2);
    await click(off);
    expect(root.querySelector<HTMLButtonElement>(".push-pending")?.disabled).toBe(true);
    await act(async () => { pending.resolve(Response.json({ ok: true })); await settle(); });
    expect(root.querySelector(".push-on.on circle")).not.toBeNull();
    expect(net.to("/api/push/subscribe")).toEqual([{ endpoint: "https://push.invalid/device" }]);
    await click(root.querySelector('[aria-label="Notifications on"]'));
    expect(root.querySelector(".push-off")).not.toBeNull();
    expect(net.to("/api/push/unsubscribe")).toEqual([{ endpoint: "https://push.invalid/device" }]);
  });

  test("denied bell explains browser settings without attempting to subscribe", async () => {
    pushBrowser("denied");
    await mount([]);
    await click(root.querySelector('[aria-label="Notifications blocked in site settings"]'));
    expect(alerts).toEqual(["Notifications are blocked: allow them in the site settings."]);
    expect(net.calls).toEqual([]);
  });

  test("phone back guard displays its exit hint", async () => {
    await mount([], null, false);
    history.replaceState(null, "", "/");
    await act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(root.querySelector(".toast")?.textContent).toBe("Press back again to exit");
  });
});

describe("sidebar rail", () => {
  async function mountRail(items: Item[], selected: string | null = null, onRail = () => {}) {
    await act(() => render(<Home wide rail onRail={onRail} selected={selected} />, root));
    await act(() => { FakeEventSource.last.open(); FakeEventSource.last.emit("state", state(items)); });
    await act(() => settle());
  }
  const railItem = (block: string) => root.querySelector<HTMLAnchorElement>(`.rail-item[href="#/b/${block}"]`);

  test("a session shows its own icon, else its tag, else two letters of its title", () => {
    expect(railGlyph(item({ icon: "\uf121", tag: "PR" }))).toEqual({ text: "\uf121", nf: true });
    expect(railGlyph(item({ tag: "REVIEW" }))).toEqual({ text: "REV", nf: false });
    expect(railGlyph(item({ title: "fix the login" }))).toEqual({ text: "FT", nf: false });
    expect(railGlyph(item({ title: "— deploy —" }))).toEqual({ text: "DE", nf: false });
    expect(railGlyph(item({ title: "" }))).toEqual({ text: "?", nf: false });
  });

  test("each session links to itself with its status, unseen mark, selection and full text as tooltip", async () => {
    await mountRail([item({ status: "blocked", unseen: "blocked" }), item({ block: "6", title: "Other", status: "working" })], "6");
    expect(railItem("5")?.className).toContain("st-blocked");
    expect(railItem("5")?.querySelector(".new-dot.new-blocked")).not.toBeNull();
    expect(railItem("5")?.title).toStartWith("Fix login\n");
    expect(railItem("6")?.className).toContain("selected");
    expect(railItem("5")?.className).not.toContain("selected");
    expect(row("5")).toBeNull();
  });

  test("a filter typed in the full list doesn't hide sessions on the rail", async () => {
    const items = [item(), item({ block: "6", title: "Other", agent: null, live: null })];
    await mount(items);
    await input(".search input", "login");
    expect(row("6")).toBeNull();
    await act(() => render(<Home wide rail selected={null} />, root));
    expect(railItem("6")).not.toBeNull();
  });

  test("collapsed projects keep only their label with the active count; the label toggles them", async () => {
    localStorage.setItem("tern-mobile:collapsed-projects", '["app"]');
    await mountRail([item({ status: "working" })]);
    expect(railItem("5")).toBeNull();
    expect(root.querySelector(".rail-project .group-hot")?.textContent).toBe("1");
    await click(root.querySelector(".rail-project"));
    expect(railItem("5")).not.toBeNull();
    expect(localStorage.getItem("tern-mobile:collapsed-projects")).toBe("[]");
  });

  test("the toggle in either layout asks to switch", async () => {
    let toggles = 0;
    await mountRail([item()], null, () => toggles++);
    await click(root.querySelector('[aria-label="Expand the session list"]'));
    await act(() => render(<Home wide onRail={() => toggles++} selected={null} />, root));
    await click(root.querySelector('[aria-label="Minimize the session list"]'));
    expect(toggles).toBe(2);
  });
});
