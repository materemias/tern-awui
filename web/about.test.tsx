import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Net, settle } from "./fakes";
import pkg from "../package.json";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Preact and the component must bind to the registered browser globals, not Bun's initial globals.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { About, COMPANION_INFO } = await import("./about");

const net = new Net();
let root: HTMLElement;
let closed: number;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  closed = 0;
  net.install();
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
});

async function mount() {
  await act(() => render(<About onClose={() => closed++} />, root));
  await act(() => settle());
}
const status = (id: string) => root.querySelector(`.about-companion[data-id="${id}"] .about-status`);

describe("About", () => {
  test("shows the version and repository, then each companion with its status and install link", async () => {
    net.reply = () => Response.json({ companions: [{ id: "omp-stretch", installed: true }, { id: "codexbar-agentview", installed: false }, { id: "omp-compact", installed: true }] });
    await mount();
    expect(net.calls.map((c) => c.url)).toEqual(["/api/companions"]);
    expect(root.querySelector(".about-version")?.textContent).toBe(pkg.version);
    expect(root.querySelector<HTMLAnchorElement>(".about-app a")?.href).toBe("https://github.com/materemias/tern-awui");
    expect([...root.querySelectorAll(".about-companion")].map((li) => li.getAttribute("data-id"))).toEqual(["omp-stretch", "codexbar-agentview", "omp-compact"]);
    expect(status("omp-stretch")?.textContent).toBe("Installed");
    expect(status("codexbar-agentview")?.textContent).toBe("Not found");
    expect(status("codexbar-agentview")?.getAttribute("title")).toBe("Not found on the desktop");
    const install = [...root.querySelectorAll<HTMLAnchorElement>(".about-install")];
    expect(install.map((a) => a.href)).toEqual(Object.values(COMPANION_INFO).map((c) => c.install));
    // Every link and button says what it does on hover.
    for (const el of root.querySelectorAll("a, button")) expect(el.getAttribute("title")).toBeTruthy();
  });

  test("a failed check says so and shows no status", async () => {
    net.reply = () => Response.json({ error: "not found" }, { status: 404 });
    await mount();
    expect(root.textContent).toContain("Couldn't check what the desktop has installed.");
    expect(root.querySelector(".about-status")).toBeNull();
    expect(root.querySelectorAll(".about-companion").length).toBe(3);
  });

  test("Escape, × and a tap beside the sheet close it; a tap inside doesn't", async () => {
    net.reply = () => Response.json({ companions: [] });
    await mount();
    expect(status("omp-stretch")).toBeNull();
    await act(() => void (root.querySelector(".about-sheet") as HTMLElement).click());
    expect(closed).toBe(0);
    await act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(() => void (root.querySelector(".about-close") as HTMLElement).click());
    await act(() => void (root.querySelector(".about-backdrop") as HTMLElement).click());
    expect(closed).toBe(3);
  });
});
