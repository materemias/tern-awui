import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { sleep } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/", width: 412, height: 800 });
afterAll(() => GlobalRegistrator.unregister());

// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { SwipeNav } = await import("./swipe");

const buzzes: number[] = [];
let root: HTMLElement;
beforeEach(() => {
  buzzes.length = 0;
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => buzzes.push(ms) });
  root = document.createElement("div");
  document.body.append(root);
});

const siblings = () => ({ items: ["a", "b", "c", "d", "e", "f"].map((s) => ({ href: `#/${s}`, label: s })), index: 0 });

async function mount() {
  await act(() => render(<SwipeNav siblings={siblings}><p>page</p></SwipeNav>, root));
  const box = root.querySelector<HTMLElement>(".swipe")!;
  // happy-dom lays nothing out: the wrapper fills the 800 px screen, as `100dvh` does on a phone.
  box.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 412, width: 412, height: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
  let t = 0;
  const touch = (type: string, x: number, y: number) =>
    act(() => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      const touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
      Object.defineProperties(e, { touches: { value: touches }, timeStamp: { value: (t += 16) } });
      root.querySelector("p")!.dispatchEvent(e);
    });
  return touch;
}

test("a wheel opened by a sideways thumb swipe low on the screen stays still until the finger leaves the bottom edge", async () => {
  const touch = await mount();
  // Sideways along the bottom, then a small drift down: the wheel opens with the finger in the bottom zone.
  await touch("touchstart", 300, 740);
  for (const x of [280, 240, 200, 180]) await touch("touchmove", x, 740);
  await touch("touchmove", 180, 770);
  expect(root.querySelector(".swipe-wheel")).not.toBeNull();

  // Held there, nothing steps and nothing buzzes.
  await act(() => sleep(700));
  expect(buzzes).toEqual([]);
  expect(root.querySelector(".swipe-count")?.textContent).toBe("2 / 6");
  expect(root.querySelector(".swipe-edge.down.on")).toBeNull();

  // Out of the zone and back: holding at the edge steps again.
  await touch("touchmove", 180, 600);
  await touch("touchmove", 180, 770);
  expect(root.querySelector(".swipe-edge.down.on")).not.toBeNull();
  const before = buzzes.length;
  await act(() => sleep(300));
  expect(buzzes.length).toBeGreaterThan(before);
  await touch("touchend", 0, 0);
});
