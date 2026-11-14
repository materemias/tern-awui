import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { ChangedFiles } = await import("./changed-files");

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const texts = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent);

describe("ChangedFiles", () => {
  test("up to three files show open with totals and per-file counts", () => {
    render(<ChangedFiles block="b1" files={[{ path: "lib/a.ts", added: 4, removed: 1 }, { path: "README.md", added: 2, removed: null }]} />, root);
    expect(root.querySelector(".cf-head")!.textContent).toBe("2 changed files+6−1›");
    expect(texts(".cf-name")).toEqual(["a.ts", "README.md"]);
    expect(texts(".cf-dir")).toEqual(["lib"]);
    expect(texts(".cf-row .cf-counts")).toEqual(["+4−1", "+2"]);
  });

  test("more than three files start collapsed and open on a tap", async () => {
    const files = ["a", "b", "c", "d"].map((p) => ({ path: p, added: null, removed: null }));
    render(<ChangedFiles block="b1" files={files} />, root);
    expect(root.querySelector(".cf-list")).toBeNull();
    expect(root.querySelector(".cf-head .cf-counts")!.textContent).toBe("");
    await act(() => void (root.querySelector(".cf-head") as HTMLElement).click());
    expect(texts(".cf-name")).toEqual(["a", "b", "c", "d"]);
  });
});
