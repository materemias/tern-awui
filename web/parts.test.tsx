import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { Todo, UserMsg } = await import("./parts");

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await act(() => void (el as HTMLElement).click());
};
const texts = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent);

describe("Todo", () => {
  const phases = [
    { name: "Build", tasks: [{ content: "parse", status: "completed" }, { content: "render", status: "in_progress" }] },
    { name: "Ship", tasks: [{ content: "deploy", status: "blocked", blocker: "no creds" }] },
  ];

  test("the newest list shows every task under its phase", async () => {
    await act(() => render(<Todo phases={phases} full />, root));
    expect(root.querySelector(".todo-count")!.textContent).toBe("1/3");
    expect(root.querySelector(".todo-blocked")!.textContent).toBe("1 blocked");
    expect(root.querySelector(".todo-current")!.textContent).toBe("render");
    expect(texts(".todo-phase-name")).toEqual(["Build", "Ship"]);
    expect(texts(".todo-mark")).toEqual(["✓", "▸", "!"]);
    expect(root.querySelector(".todo-blocker")!.textContent).toBe(" — no creds");
  });

  test("an older list is one line; a tap opens it and a second closes it", async () => {
    await act(() => render(<Todo phases={phases} full={false} />, root));
    expect(root.querySelectorAll(".todo-task").length).toBe(0);
    expect(root.querySelector(".todo-count")!.textContent).toBe("1/3");
    await click(root.querySelector(".todo"));
    expect(root.querySelectorAll(".todo-task").length).toBe(3);
    await click(root.querySelector(".todo"));
    expect(root.querySelectorAll(".todo-task").length).toBe(0);
  });

  test("follows a newer list collapsing it, until the user taps", async () => {
    await act(() => render(<Todo phases={phases} full />, root));
    await act(() => render(<Todo phases={phases} full={false} />, root));
    expect(root.querySelectorAll(".todo-task").length).toBe(0);
    await click(root.querySelector(".todo"));
    // Opened by hand: it stays open whatever `full` says next.
    await act(() => render(<Todo phases={phases} full />, root));
    await act(() => render(<Todo phases={phases} full={false} />, root));
    expect(root.querySelectorAll(".todo-task").length).toBe(3);
  });

  test("one phase shows no heading", async () => {
    await act(() => render(<Todo phases={[phases[0]]} full />, root));
    expect(root.querySelector(".todo-phase-name")).toBeNull();
  });

  test("a tap doesn't reach the tool line around it", async () => {
    let outer = 0;
    await act(() =>
      render(
        <div onClick={() => outer++}>
          <Todo phases={phases} full={false} />
        </div>,
        root,
      ),
    );
    await click(root.querySelector(".todo"));
    expect(outer).toBe(0);
  });
});

describe("UserMsg", () => {
  const entry = { role: "user" as const, id: "e17", text: "fix the login", images: [], ts: new Date(2026, 0, 1, 14, 3).getTime() };
  const requests: { url: string; init: RequestInit }[] = [];
  let reply: () => Response;
  let confirmed: boolean;
  const alerts: string[] = [];
  const copied: string[] = [];
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    requests.length = 0;
    alerts.length = 0;
    copied.length = 0;
    confirmed = true;
    reply = () => Response.json({ ok: true });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return reply();
    }) as typeof fetch;
    window.confirm = () => confirmed;
    window.alert = (m?: string) => void alerts.push(String(m));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  const button = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

  test("shows the prompt's time in 24-hour form and both actions", async () => {
    await act(() => render(<UserMsg entry={entry} block="5" rewind />, root));
    expect(root.querySelector(".user-text")!.textContent).toBe("fix the login");
    expect(root.querySelector(".user-acts .muted")!.textContent).toBe("14:03");
    expect(texts(".user-acts button")).toEqual(["Copy", "Rewind"]);
  });

  test("a tap on the prompt opens its actions; tapping an action keeps them", async () => {
    await act(() => render(<UserMsg entry={entry} block="5" rewind />, root));
    const msg = root.querySelector(".msg.user")!;
    expect(msg.classList.contains("acts-open")).toBe(false);
    await click(msg);
    expect(msg.classList.contains("acts-open")).toBe(true);
    await click(button("Copy"));
    expect(msg.classList.contains("acts-open")).toBe(true);
  });

  test("Copy puts the prompt on the clipboard and says so", async () => {
    await act(() => render(<UserMsg entry={entry} block="5" rewind />, root));
    await click(button("Copy"));
    expect(copied).toEqual(["fix the login"]);
    expect(button("Copied")).not.toBeNull();
  });

  test("Rewind, confirmed, asks the server to rewind to this entry", async () => {
    await act(() => render(<UserMsg entry={entry} block="5" rewind />, root));
    await click(button("Rewind"));
    expect(requests.map((r) => [r.url, r.init.method, JSON.parse(String(r.init.body))])).toEqual([
      ["/api/blocks/5/rewind", "POST", { entry: "e17" }],
    ]);
    // The server only accepts POSTs carrying the app's header.
    expect(new Headers(requests[0].init.headers).get("x-tern-mobile")).toBe("1");
    expect(alerts).toEqual([]);
  });

  test("Rewind, cancelled, sends nothing", async () => {
    confirmed = false;
    await act(() => render(<UserMsg entry={entry} block="5" rewind />, root));
    await click(button("Rewind"));
    expect(requests).toEqual([]);
  });

  test("a refused rewind shows the server's reason", async () => {
    reply = () => Response.json({ error: "session is working" }, { status: 409 });
    await act(() => render(<UserMsg entry={entry} block="5" rewind />, root));
    await click(button("Rewind"));
    // The post resolves over several ticks (fetch, then the error body).
    for (let i = 0; i < 50 && !alerts.length; i++) await Bun.sleep(2);
    expect(alerts).toEqual(["Rewind failed: session is working"]);
  });

  test("no text: no Copy; no entry id: no Rewind", async () => {
    await act(() => render(<UserMsg entry={{ ...entry, text: "", id: "" }} block="5" rewind />, root));
    expect(texts(".user-acts button")).toEqual([]);
  });

  test("an omp that can't rewind gets no Rewind, Copy stays", async () => {
    await act(() => render(<UserMsg entry={entry} block="5" rewind={false} />, root));
    expect(texts(".user-acts button")).toEqual(["Copy"]);
  });
});
