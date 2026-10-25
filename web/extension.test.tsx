import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Install, Item, Live } from "./api";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { ExtensionBanner, ExtensionNotice } = await import("./extension");

let root: HTMLElement;
const requests: { url: string; body: unknown }[] = [];
const copied: string[] = [];
let confirmed: boolean;
let reply: () => Response;
const realFetch = globalThis.fetch;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  requests.length = 0;
  copied.length = 0;
  confirmed = true;
  reply = () => Response.json({ ok: true });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return reply();
  }) as typeof fetch;
  window.confirm = () => confirmed;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
});
afterEach(() => {
  render(null, root);
  root.remove();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(() => void (el as HTMLElement).click());
};
const button = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label);
const install = (over: Partial<Install> = {}): Install => ({
  status: "ok",
  path: "/home/u/.omp/agent/extensions/tern-mobile.ts",
  target: "",
  repo: "/home/u/code/tern-awui",
  windows: false,
  ...over,
});
function item(live: Partial<Live> | null, status = "idle"): Item {
  return {
    block: "7",
    icon: null,
    tag: null,
    title: "omp",
    cwd: "/home/u/code/app",
    project: "app",
    branch: null,
    agent: { sessionId: "019a-c0de", lastPrompt: "", recap: "", recapStale: false, lastActivity: 0, subagents: 0 },
    live: live && { model: "m", thinking: "", levels: [], tiers: [], tier: "", context: null, jobs: [], protocol: 2, caps: null, build: "b", mismatch: null, restart: false, ...live },
    status,
    since: 0,
    starting: false,
    doc: null,
    unseen: null,
  };
}

describe("ExtensionBanner", () => {
  test("nothing while the installed file is this checkout's", async () => {
    await act(() => render(<ExtensionBanner install={install()} />, root));
    expect(root.innerHTML).toBe("");
  });

  test("a missing extension: what's wrong, the installer command for this checkout, and Copy", async () => {
    await act(() => render(<ExtensionBanner install={install({ status: "missing" })} />, root));
    expect(root.querySelector(".ext-banner p")!.textContent).toStartWith("No tern-mobile extension at /home/u/.omp/agent/extensions/tern-mobile.ts");
    expect(root.querySelector(".ext-banner code")!.textContent).toBe("cd /home/u/code/tern-awui && bun install.ts");
    expect(button("Reload")).toBeUndefined();
    await click(button("Copy"));
    expect(copied).toEqual(["cd /home/u/code/tern-awui && bun install.ts"]);
    expect(button("Copied")).toBeDefined();
  });

  test("a foreign link names where it points", async () => {
    await act(() => render(<ExtensionBanner install={install({ status: "foreign", target: "/elsewhere/tern-mobile.ts" })} />, root));
    expect(root.querySelector(".ext-banner p")!.textContent).toContain("links to /elsewhere/tern-mobile.ts, not this checkout");
  });
});

describe("ExtensionNotice", () => {
  test("nothing for a matching session or one without a bridge", async () => {
    await act(() => render(<ExtensionNotice item={item({})} install={install()} />, root));
    expect(root.innerHTML).toBe("");
    await act(() => render(<ExtensionNotice item={item(null)} install={install()} />, root));
    expect(root.innerHTML).toBe("");
  });

  test("an idle older session whose omp has /restart: Reload, after a confirm, submits /restart", async () => {
    await act(() => render(<ExtensionNotice item={item({ mismatch: "older", restart: true })} install={install()} />, root));
    expect(root.querySelector(".ext-session p")!.textContent).toContain("Reload restarts omp in this pane with /restart");
    expect(root.querySelector(".ext-session code")).toBeNull();
    confirmed = false;
    await click(button("Reload"));
    expect(requests).toEqual([]);
    confirmed = true;
    await click(button("Reload"));
    expect(requests).toEqual([{ url: "/api/blocks/7/submit", body: { text: "/restart" } }]);
  });

  test("a failed Reload says why", async () => {
    reply = () => Response.json({ error: "omp did not take the draft" }, { status: 502 });
    const alerted = new Promise<string>((resolve) => (window.alert = (m?: string) => resolve(String(m))));
    await act(() => render(<ExtensionNotice item={item({ mismatch: "older", restart: true })} install={install()} />, root));
    await click(button("Reload"));
    expect(await alerted).toBe("Reload failed: omp did not take the draft");
  });

  test("no Reload while the session works or waits, or when its omp lacks /restart", async () => {
    for (const status of ["working", "blocked"]) {
      await act(() => render(<ExtensionNotice item={item({ mismatch: "older", restart: true }, status)} install={install()} />, root));
      expect(root.querySelector(".ext-session p")!.textContent).toContain("(once it is idle)");
      expect(button("Reload")).toBeUndefined();
    }
    await act(() => render(<ExtensionNotice item={item({ mismatch: "older" })} install={install()} />, root));
    expect(button("Reload")).toBeUndefined();
    expect(root.querySelector(".ext-session p")!.textContent).toContain("Quit omp in this pane and start it again");
    expect(root.querySelector(".ext-session code")!.textContent).toBe("omp --resume 019a-c0de");
  });

  test("a newer extension than the server: the update command, no Reload", async () => {
    await act(() => render(<ExtensionNotice item={item({ mismatch: "newer", restart: true })} install={install()} />, root));
    expect(root.querySelector(".ext-session p")!.textContent).toBe("This omp runs a newer tern-mobile extension than the server. Update tern-awui:");
    expect(root.querySelector(".ext-session code")!.textContent).toBe("cd /home/u/code/tern-awui && git pull && bun install.ts");
    expect(button("Reload")).toBeUndefined();
  });
});
