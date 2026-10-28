import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CatalogModel, Live, Role } from "./api";
import { live, Net, settle } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Preact and the component must bind to the registered browser globals, not Bun's initial globals.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { ModelSheet } = await import("./models");
const { post } = await import("./api");

const recentKey = "tern-mobile:recent-models";
const net = new Net();
let root: HTMLElement;
let closed: number;
let cycled: number;
const catalog: CatalogModel[] = [
  { p: "zeta", id: "slow", name: "Slow Model", r: false, ctx: 0, in: 0, out: 0, img: false },
  { p: "alpha", id: "fast", name: "Fast Model", r: true, ctx: 200000, in: 3, out: 15, img: true },
  { p: "alpha", id: "other", name: "Other Model", r: false, ctx: 32000, in: 0, out: 0, img: false },
];
const roles: Role[] = [{ role: "default", spec: "alpha/fast:high" }, { role: "review", spec: "zeta/slow" }];
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  localStorage.clear();
  closed = cycled = 0;
  net.install();
  net.reply = (c) => Response.json(c.url.endsWith("/models") ? { models: catalog } : { ok: true });
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
});
async function mount(current: Live | null = live({ model: "alpha/fast" }), bridged = true, entries = roles) {
  await act(async () => {
    render(<ModelSheet block="7" current={current} bridged={bridged} roles={entries}
      send={(path, body) => post(`/api/blocks/7/${path}`, body)} onClose={() => closed++} onCycle={() => cycled++} />, root);
    await settle();
  });
  await act(() => settle());
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => { (el as HTMLElement).click(); await settle(); });
}
function button(label: string) {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}
async function search(value: string) {
  await act(() => {
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ModelSheet", () => {
  test("orders roles, recent and alphabetical providers; expands one provider and marks the current model", async () => {
    localStorage.setItem(recentKey, JSON.stringify(["gone/missing", "alpha/fast"]));
    await mount();
    expect(net.calls[0]).toEqual({ url: "/api/blocks/7/models", method: "POST", body: undefined, headers: { "x-tern-mobile": "1" } });
    expect([...root.querySelectorAll(".mp-section")].map((e) => e.textContent)).toEqual(["Roles · Ctrl+P", "Recent", "All models"]);
    expect(root.querySelector(".mp-row.on .mp-role")?.textContent).toBe("default");
    expect(root.querySelector(".mp-row.on .mp-facts")?.textContent).toBe("alpha/fast · High");
    const providers = [...root.querySelectorAll(".mp-provider")];
    expect(providers.map((p) => p.children[1].textContent)).toEqual(["alpha", "zeta"]);
    expect(providers[0].querySelector(".mp-check")?.textContent).toBe("●");
    await click(providers[0]);
    expect(providers[0].parentElement?.querySelectorAll(".mp-row").length).toBe(2);
    const selected = providers[0].parentElement?.querySelector(".mp-row.on");
    expect(selected?.querySelector(".mp-name")?.textContent).toBe("Fast Model");
    expect(selected?.querySelector(".mp-facts")?.textContent).toBe("alpha · 200k · $3·15 · reasoning · vision");
    await click(providers[1]);
    expect(providers[0].parentElement?.querySelector(".mp-row")).toBeNull();
    expect(providers[1].parentElement?.querySelector(".mp-facts")?.textContent).toBe("zeta");
    await click(providers[1]);
    expect(providers[1].parentElement?.querySelector(".mp-row")).toBeNull();
    expect(closed).toBe(0);
  });

  test("search ranks whole-name matches before identifiers and split words, hides providers and limits results", async () => {
    net.reply = () => Response.json({ models: [
      { ...catalog[0], id: "red-fox", name: "Red clever fox" },
      { ...catalog[0], id: "red fox", name: "Identifier match" },
      { ...catalog[0], id: "named", name: "Red Fox" },
      ...Array.from({ length: 81 }, (_, n) => ({ ...catalog[0], id: `bulk-${n}`, name: `Bulk ${n}` })),
    ] });
    await mount();
    await search(" RED FOX ");
    expect([...root.querySelectorAll(".mp-name")].map((e) => e.textContent)).toEqual(["Red Fox", "Identifier match", "Red clever fox"]);
    expect(root.querySelector(".mp-section")?.textContent).toBe("3 models");
    expect(root.querySelector(".mp-provider")).toBeNull();
    await search("bulk");
    expect(root.querySelector(".mp-section")?.textContent).toBe("80 of 81 models");
    expect(root.querySelectorAll(".mp-row").length).toBe(80);
    await search("not a real model");
    expect(root.querySelector(".mp-row")).toBeNull();
    await search("review");
    expect(root.querySelector(".mp-role")?.textContent).toBe("review");
  });

  test("effort and priority segments submit their values without closing, including unknown labels", async () => {
    await mount(live({ model: "alpha/fast", levels: ["off", "minimal", "high", "custom"], thinking: "high", tiers: ["", "flex", "priority", "special"], tier: "priority" }));
    expect(button("High")?.className).toBe("on");
    expect(button("Fast")?.className).toBe("on");
    expect(button("Fast")?.title).toBe("priority serving, costs more");
    await click(button("Off"));
    await click(button("Min"));
    await click(button("custom"));
    await click(button("Standard"));
    await click(button("Flex"));
    await click(button("special"));
    expect(net.to("/api/blocks/7/thinking")).toEqual([{ level: "off" }, { level: "minimal" }, { level: "custom" }]);
    expect(net.to("/api/blocks/7/tier")).toEqual([{ tier: "" }, { tier: "flex" }, { tier: "special" }]);
    expect(closed).toBe(0);
  });

  test("model picks preserve recents and stay open on error; persist and close only after success", async () => {
    localStorage.setItem(recentKey, JSON.stringify(["zeta/slow"]));
    await mount();
    await search("Fast Model");
    const pick = root.querySelector(".mp-row")!;
    net.reply = () => Response.json({ error: "busy" }, { status: 409 });
    await click(pick);
    expect(closed).toBe(0);
    expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual(["zeta/slow"]);
    const pending = Promise.withResolvers<Response>();
    net.reply = () => pending.promise;
    await click(pick);
    expect(closed).toBe(0);
    expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual(["zeta/slow"]);
    await act(async () => { pending.resolve(Response.json({ ok: true })); await settle(); });
    expect(net.to("/api/blocks/7/model")).toEqual([{ spec: "alpha/fast" }, { spec: "alpha/fast" }]);
    expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual(["alpha/fast", "zeta/slow"]);
    expect(closed).toBe(1);
  });

  test("without catalog capability roles still work, and failed role picks do not close or write recents", async () => {
    await mount(live({ levels: ["off"], caps: { models: false, tiers: false, jobs: false, queue: false, rewind: false, btw: false, complete: false, levels: false, voice: false } }));
    expect(net.calls).toEqual([]);
    expect(root.textContent).toContain("This omp can't list models; roles still work");
    expect(root.querySelector(".mp-opt")).toBeNull();
    net.reply = () => Response.json({ error: "not ready" }, { status: 503 });
    await click(root.querySelector(".mp-row"));
    expect(closed).toBe(0);
    net.reply = () => Response.json({ ok: true });
    await click(root.querySelector(".mp-row"));
    expect(net.to("/api/blocks/7/model")).toEqual([{ role: "default" }, { role: "default" }]);
    expect(closed).toBe(1);
    expect(localStorage.getItem(recentKey)).toBeNull();
  });

  test("unbridged sessions offer cycling, and sheet clicks, Escape, backdrop and Close have distinct behavior", async () => {
    await mount(null, false);
    expect(net.calls).toEqual([]);
    expect(root.querySelector(".mp-title")?.textContent).toBe("Model");
    expect(root.textContent).toContain("only cycling works");
    await click(root.querySelector(".sheet-row"));
    expect(cycled).toBe(1);
    expect(closed).toBe(0);
    await click(root.querySelector(".mp-head"));
    await act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); });
    expect(closed).toBe(0);
    await act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await click(root.querySelector(".sheet-backdrop"));
    await click(root.querySelector('[aria-label="Close"]'));
    expect(closed).toBe(3);
    await act(() => render(null, root));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(3);
  });

  test("shows loading and server, empty-response and network catalog errors", async () => {
    const pending = Promise.withResolvers<Response>();
    net.reply = () => pending.promise;
    await mount();
    expect(root.textContent).toContain("Loading models…");
    await act(async () => { pending.resolve(Response.json({ error: "catalog unavailable" })); await settle(); });
    expect(root.textContent).toContain("Models: catalog unavailable");
    await act(() => render(null, root));
    net.reply = () => Response.json({});
    await mount();
    expect(root.textContent).toContain("Models: no models");
    await act(() => render(null, root));
    net.reply = () => Promise.reject(new Error("offline"));
    await mount();
    expect(root.textContent).toContain("Models: Error: offline");
  });
});
