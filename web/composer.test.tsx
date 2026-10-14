import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentProps } from "preact";
import type { Btw, Caps } from "./api";
import { item, live, Net, settle, specDom, type Call } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
const restoreDom = specDom();
// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { Composer } = await import("./composer");

type Props = ComponentProps<typeof Composer>;
const net = new Net();
const buzzes: number[] = [];
const previews: { url: string; blob: Blob }[] = [];
const revoked: string[] = [];
const restores: (() => void)[] = [];
let root: HTMLElement;
let props: Props;

function replace(target: object, key: PropertyKey, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  // happy-dom's window owns separate timer methods; drive both clocks with Bun's timers.
  replace(window, "setTimeout", globalThis.setTimeout);
  replace(window, "clearTimeout", globalThis.clearTimeout);
  root = document.createElement("div");
  document.body.append(root);
  net.install();
  buzzes.length = 0;
  previews.length = 0;
  revoked.length = 0;
  replace(navigator, "vibrate", (ms: number) => void buzzes.push(ms));
  replace(URL, "createObjectURL", (blob: Blob) => {
    const url = `blob:composer-${previews.length + 1}`;
    previews.push({ url, blob });
    return url;
  });
  replace(URL, "revokeObjectURL", (url: string) => void revoked.push(url));
  props = {
    block: "5",
    item: item(),
    draft: { live: true, text: "" },
    roles: [],
    btw: null,
    setBtw: (btw) => {
      props = { ...props, btw };
      render(<Composer {...props} />, root);
    },
  };
});
afterEach(() => {
  render(null, root);
  root.remove();
  for (const restore of restores.splice(0).reverse()) restore();
  jest.useRealTimers();
  net.restore();
});
afterAll(async () => {
  restoreDom();
  await GlobalRegistrator.unregister();
});

const flush = () => act(() => settle());
async function show(over: Partial<Props> = {}) {
  props = { ...props, ...over };
  await act(() => render(<Composer {...props} />, root));
  await flush();
}
function node(selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function area(): HTMLTextAreaElement {
  const found = root.querySelector("textarea");
  if (!found) throw new Error("Missing composer textarea");
  return found;
}
function button(label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(target: HTMLElement) {
  await act(() => target.click());
  await flush();
}
async function input(text: string) {
  await act(() => {
    area().value = text;
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}
async function press(key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  await act(() => void area().dispatchEvent(event));
  await flush();
  return event;
}
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await settle();
  });
  await flush();
}
async function release(pending: { resolve: (response: Response) => void }, response = Response.json({ ok: true })) {
  await act(async () => {
    pending.resolve(response);
    await settle();
  });
  await flush();
}
const calls = (path: string) => net.to(`/api/blocks/5/${path}`);
const image = (text = "PNG", type = "image/png") => new File([text], "paste", { type });
async function paste(files: File[], text = "") {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  if (text) data.items.add(text, "text/plain");
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  await act(() => void area().dispatchEvent(event));
  await flush();
  return event;
}
const noCaps: Caps = { models: false, tiers: false, jobs: false, queue: false, rewind: false, btw: false, complete: false, levels: false };
const suggestions = (prefix = "/he", value = "/help") => ({ prefix, items: [{ value, label: value, description: "Command help" }] });

function historyReply(c: Call, history?: Response | Promise<Response>): Response | Promise<Response> {
  if (c.method === "GET" && c.url.endsWith("/btw-history")) return history ?? Response.json({ records: [] });
  if (c.method === "POST" && c.url.endsWith("/complete")) {
    if (!c.body || typeof c.body !== "object" || !("text" in c.body) || typeof c.body.text !== "string") throw new Error("Missing completion text");
    return Response.json({ prefix: c.body.text, items: [] });
  }
  return Response.json({ ok: true });
}

async function offer(text = "/he") {
  net.reply = (c) => Response.json(c.url.endsWith("/complete") ? suggestions(text) : { ok: true });
  await input(text);
  await advance(120);
  expect(node(".hint-label").textContent).toBe("/help");
}

describe("draft mirroring and submission", () => {
  test("adopts desktop drafts without echoing them and waits for a quiet phone before reconciling", async () => {
    await show({ draft: { live: true, text: "desktop" } });
    expect(area().value).toBe("desktop");
    expect(node(".sync").title).toBe("Draft mirrors the desktop editor");
    expect(calls("draft")).toEqual([]);
    await input("phone");
    await show({ draft: { live: true, text: "desktop changed" } });
    await advance(799);
    expect(area().value).toBe("phone");
    await advance(1);
    expect(area().value).toBe("desktop changed");
    expect(calls("draft")).toEqual([{ text: "phone" }]);
  });

  test("coalesces edits behind one pending draft and does not adopt a remote echo while it is busy", async () => {
    const first = Promise.withResolvers<Response>();
    net.reply = () => first.promise;
    await show();
    await input("a");
    await input("ab");
    await input("abc");
    await show({ draft: { live: true, text: "remote" } });
    await advance(1000);
    expect(area().value).toBe("abc");
    expect(calls("draft")).toEqual([{ text: "a" }]);
    net.reply = () => Response.json({ ok: true });
    await release(first);
    expect(calls("draft")).toEqual([{ text: "a" }, { text: "abc" }]);
    expect(area().value).toBe("remote");
  });

  test("settles the in-flight draft before send, drops queued drafts, and never refills the sent prompt", async () => {
    const first = Promise.withResolvers<Response>();
    net.reply = (c) => c.url.endsWith("/draft") ? first.promise : Response.json({ ok: true });
    await show();
    await input("first");
    await input("final prompt");
    await show({ draft: { live: true, text: "first" } });
    await click(button("Send"));
    expect(button("Send").disabled).toBe(true);
    expect(calls("submit")).toEqual([]);
    await release(first);
    await advance(50);
    expect(net.calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/blocks/5/draft", { text: "first" }],
      ["/api/blocks/5/submit", { text: "final prompt" }],
    ]);
    expect(area().value).toBe("");
    expect(button("Send").disabled).toBe(false);
    await advance(1000);
    expect(area().value).toBe("");
    expect(calls("draft")).toEqual([{ text: "first" }]);
  });

  test.each(["prompt", "image", "btw", "history"])("keeps the next draft typed during a pending %s send and mirrors it afterward", async (kind) => {
    await show();
    let original = "first";
    if (kind === "btw") original = "/btw first";
    if (kind === "history") original = "/btw";
    await input(original);
    if (kind === "image") await paste([image("pixels")]);
    const pending = Promise.withResolvers<Response>();
    let path = "submit";
    if (kind === "btw") path = "btw";
    if (kind === "history") path = "btw-history";
    net.reply = (c) => c.url.endsWith(`/${path}`) ? pending.promise : historyReply(c);
    await click(button("Send"));
    await input("next");
    await input("next prompt");
    expect(calls("draft")).toEqual([{ text: original }]);
    await show({ draft: { live: true, text: original } });
    await advance(1000);
    expect(area().value).toBe("next prompt");
    let response: unknown = { ok: true };
    if (kind === "btw") response = { id: "side-1" };
    if (kind === "history") response = { records: [] };
    await release(pending, Response.json(response));
    expect(area().value).toBe("next prompt");
    expect(calls("draft")).toEqual([{ text: original }, { text: "next prompt" }]);
    expect(net.calls.at(-1)?.url).toBe("/api/blocks/5/draft");
    if (kind === "image") expect(root.querySelector(".pasted")).toBeNull();
    await advance(1000);
    expect(area().value).toBe("next prompt");
  });

  test("flushes edits made while a rejected send was pending", async () => {
    await show();
    await input("first");
    const pending = Promise.withResolvers<Response>();
    net.reply = (c) => c.url.endsWith("/submit") ? pending.promise : Response.json({ ok: true });
    await click(button("Send"));
    await input("corrected");
    expect(calls("draft")).toEqual([{ text: "first" }]);
    await release(pending, Response.json({ error: "rejected" }, { status: 409 }));
    expect(area().value).toBe("corrected");
    expect(calls("draft")).toEqual([{ text: "first" }, { text: "corrected" }]);
    expect(node(".error").textContent).toBe("rejected");
  });

  test("two submit events while settling produce one request, including while that request is pending", async () => {
    const draft = Promise.withResolvers<Response>();
    const submit = Promise.withResolvers<Response>();
    net.reply = (c) => c.url.endsWith("/draft") ? draft.promise : submit.promise;
    await show();
    await input("only once");
    await act(() => {
      for (let i = 0; i < 2; i++) node("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await release(draft);
    await advance(50);
    expect(calls("submit")).toEqual([{ text: "only once" }]);
    await act(() => void node("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await release(submit);
    expect(calls("submit")).toHaveLength(1);
    expect(area().value).toBe("");
  });

  test("a draft that cannot settle times out without sending and can be retried when it lands", async () => {
    const draft = Promise.withResolvers<Response>();
    net.reply = (c) => c.url.endsWith("/draft") ? draft.promise : Response.json({ ok: true });
    await show();
    await input("keep this");
    await click(button("Send"));
    // Each iteration resumes an awaited poll before the next timer can be scheduled.
    for (let i = 0; i < 60; i++) await advance(50);
    expect(node(".error").textContent).toBe("Draft still syncing; send again");
    expect(calls("submit")).toEqual([]);
    expect(area().value).toBe("keep this");
    expect(button("Send").disabled).toBe(false);
    await release(draft);
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "keep this" }]);
    expect(root.querySelector(".error")).toBeNull();
  });

  test("draft errors are visible and dismissible; a failed send retains the text for retry", async () => {
    net.reply = () => Response.json({ error: "bridge unavailable" }, { status: 503 });
    await show();
    await input("  preserve me  ");
    expect(node(".error").textContent).toBe("bridge unavailable");
    await click(node(".error"));
    expect(root.querySelector(".error")).toBeNull();
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "preserve me" }]);
    expect(area().value).toBe("  preserve me  ");
    expect(button("Send").disabled).toBe(false);
    net.reply = () => Response.json({ ok: true });
    await click(button("Send"));
    expect(area().value).toBe("");
    expect(root.querySelector(".error")).toBeNull();
  });

  test("an unbridged agent keeps a local draft and still submits", async () => {
    await show({ item: item({ live: null }), draft: { live: false, text: "not live" } });
    expect(area().value).toBe("");
    expect(root.querySelector(".sync")).toBeNull();
    await input("offline editor");
    expect(calls("draft")).toEqual([]);
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "offline editor" }]);
  });
});

describe("pasted images", () => {
  test("previews original image bytes, discards accompanying text, and revokes only the removed preview", async () => {
    await show();
    expect((await paste([image("one"), image("two")], "image.png")).defaultPrevented).toBe(true);
    expect([...root.querySelectorAll(".pasted img")].map((el) => el.getAttribute("src"))).toEqual(["blob:composer-1", "blob:composer-2"]);
    expect(area().value).toBe("");
    expect(previews.map((p) => p.blob.type)).toEqual(["image/png", "image/png"]);
    await click(button("Remove image"));
    expect(revoked).toEqual(["blob:composer-1"]);
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(1);
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "", images: [{ data: btoa("two"), mimeType: "image/png" }], followUp: false }]);
    expect(revoked).toEqual(["blob:composer-1", "blob:composer-2"]);
    expect(root.querySelector(".pasted")).toBeNull();
  });

  test("plain text and non-image files keep the browser's default paste behavior", async () => {
    await show();
    expect((await paste([], "some text")).defaultPrevented).toBe(false);
    expect((await paste([new File(["text"], "notes.txt", { type: "text/plain" })])).defaultPrevented).toBe(false);
    expect(root.querySelector(".pasted")).toBeNull();
    expect(net.calls).toEqual([]);
  });

  test("accepts at most eight images, reports a full tray, and makes room when one is removed", async () => {
    await show();
    await paste(Array.from({ length: 10 }, (_, i) => image(String(i))));
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(8);
    expect(previews).toHaveLength(8);
    await paste([image("ninth")]);
    expect(node(".error").textContent).toBe("at most 8 images");
    expect(previews).toHaveLength(8);
    await click(button("Remove image"));
    await paste([image("replacement")]);
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(8);
    expect(previews).toHaveLength(9);
  });

  test("failed image sends retain previews and text; a retry sends the same bytes", async () => {
    await show();
    await input("look here");
    await paste([image("pixels")]);
    net.reply = () => Response.json({ error: "upload rejected" }, { status: 413 });
    await click(button("Send"));
    expect(node(".error").textContent).toBe("upload rejected");
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(1);
    expect(area().value).toBe("look here");
    expect(revoked).toEqual([]);
    net.reply = () => Response.json({ ok: true });
    await click(button("Send"));
    const payload = { text: "look here", images: [{ data: btoa("pixels"), mimeType: "image/png" }], followUp: false };
    expect(calls("submit")).toEqual([payload, payload]);
    expect(root.querySelector(".pasted")).toBeNull();
  });

  test("images pasted during an upload survive it and go out only with the next send", async () => {
    const upload = Promise.withResolvers<Response>();
    await show();
    await paste([image("first")]);
    net.reply = () => upload.promise;
    await click(button("Send"));
    expect(button("Send").disabled).toBe(true);
    await paste([image("next")]);
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(2);
    await release(upload);
    expect([...root.querySelectorAll(".pasted img")].map((el) => el.getAttribute("src"))).toEqual(["blob:composer-2"]);
    expect(revoked).toEqual(["blob:composer-1"]);
    net.reply = () => Response.json({ ok: true });
    await click(button("Send"));
    expect(calls("submit")).toEqual([
      { text: "", images: [{ data: btoa("first"), mimeType: "image/png" }], followUp: false },
      { text: "", images: [{ data: btoa("next"), mimeType: "image/png" }], followUp: false },
    ]);
  });

  test("converts unsupported image formats to a bounded JPEG before preview and submission", async () => {
    const draws: number[][] = [];
    const encodings: ImageEncodeOptions[] = [];
    let closed = false;
    const bitmap: ImageBitmap = { width: 4096, height: 2048, close: () => { closed = true; } };
    replace(globalThis, "createImageBitmap", async () => bitmap);
    replace(globalThis, "OffscreenCanvas", class {
      constructor(readonly width: number, readonly height: number) {}
      getContext(kind: string) {
        expect(kind).toBe("2d");
        return { drawImage: (source: ImageBitmap, ...coordinates: number[]) => {
          expect(source).toBe(bitmap);
          draws.push(coordinates);
        } };
      }
      async convertToBlob(options: ImageEncodeOptions) {
        encodings.push(options);
        return new Blob(["jpeg bytes"], { type: "image/jpeg" });
      }
    });
    await show();
    await paste([image("unencoded", "image/bmp")]);
    expect(draws).toEqual([[0, 0, 2048, 1024]]);
    expect(closed).toBe(true);
    expect(encodings).toEqual([{ type: "image/jpeg", quality: 0.88 }]);
    expect(previews[0]?.blob.type).toBe("image/jpeg");
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "", images: [{ data: btoa("jpeg bytes"), mimeType: "image/jpeg" }], followUp: false }]);
  });

  test("an unreadable image reports an error without disturbing existing attachments", async () => {
    await show();
    await paste([image("good")]);
    replace(globalThis, "createImageBitmap", async () => { throw new Error("bad image"); });
    await paste([image("broken", "image/bmp")]);
    expect(node(".error").textContent).toBe("could not read the image");
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(1);
    expect(revoked).toEqual([]);
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "", images: [{ data: btoa("good"), mimeType: "image/png" }], followUp: false }]);
  });

  test("the attach button picks images into the same tray, skips other files, and is absent in shells", async () => {
    await show();
    const picker = node('input[type="file"]') as HTMLInputElement;
    expect(picker.accept).toBe("image/*");
    let opened = 0;
    picker.click = () => void opened++;
    await click(button("Attach image"));
    expect(opened).toBe(1);
    replace(picker, "files", [image("camera", "image/jpeg"), new File(["x"], "notes.txt", { type: "text/plain" })]);
    await act(() => void picker.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(picker.value).toBe("");
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(1);
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "", images: [{ data: btoa("camera"), mimeType: "image/jpeg" }], followUp: false }]);
    await show({ item: item({ agent: null, live: null, status: null }), draft: null });
    expect(root.querySelector('input[type="file"]')).toBeNull();
    expect([...root.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Attach image")).toBe(false);
  });
});

describe("follow-ups and side questions", () => {
  test.each(["Enter", "q"])("Ctrl+%s queues a follow-up while working", async (key) => {
    await show({ item: item({ status: "working" }) });
    await input("  after the turn  ");
    expect(area().placeholder).toBe("Steer the agent…");
    expect((await press(key, { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(calls("submit")).toEqual([{ text: "after the turn", followUp: true }]);
    expect(area().value).toBe("");
  });

  test("the follow-up button preserves attached images and ordinary Send steers instead", async () => {
    await show({ item: item({ status: "working" }) });
    await input("later");
    await paste([image()]);
    await click(button("Send after this turn"));
    expect(calls("submit")).toEqual([{ text: "later", images: [{ data: btoa("PNG"), mimeType: "image/png" }], followUp: true }]);
    await input("now");
    await click(button("Send"));
    expect(calls("submit")[1]).toEqual({ text: "now" });
  });

  test("Shift+Enter is left to the editor and Ctrl+Q does nothing while idle", async () => {
    await show();
    await input("multiline");
    expect((await press("Enter", { shiftKey: true })).defaultPrevented).toBe(false);
    expect((await press("q", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(calls("submit")).toEqual([]);
    expect(area().value).toBe("multiline");
  });

  test("a successful btw opens a streaming card, clears the desktop draft, renders the answer, and dismisses", async () => {
    net.reply = (c) => Response.json(c.url.endsWith("/btw") ? { id: "side-1" } : { ok: true });
    await show();
    await input(" /btw why this approach? ");
    await click(button("Send"));
    expect(calls("btw")).toEqual([{ text: "why this approach?" }]);
    expect(calls("submit")).toEqual([]);
    expect(calls("draft")).toEqual([{ text: " /btw why this approach? " }, { text: "" }]);
    expect(area().value).toBe("");
    expect(node(".btw.streaming .btw-q").textContent).toBe("why this approach?");
    expect(node(".btw .muted").textContent).toBe("thinking…");
    await show({ btw: { id: "side-1", question: "why this approach?", text: "Because **it works**.", done: true, error: "" } });
    expect(root.querySelector(".btw.streaming")).toBeNull();
    expect(node(".btw-a strong").textContent).toBe("it works");
    await click(button("Dismiss"));
    expect(root.querySelector(".btw")).toBeNull();
    expect(props.btw).toBeNull();
  });

  test.each(["server", "offline", "invalid"])("a %s btw failure keeps the question available to retry", async (failure) => {
    await show();
    await input("/btw why?");
    net.reply = () => {
      if (failure === "offline") return Promise.reject(new Error("network"));
      if (failure === "invalid") return new Response("not json");
      return Response.json({ error: "side turn unavailable" }, { status: 502 });
    };
    await click(button("Send"));
    expect(node(".error").textContent).toBe(failure === "offline" ? "offline" : failure === "invalid" ? "btw failed" : "side turn unavailable");
    expect(area().value).toBe("/btw why?");
    expect(root.querySelector(".btw")).toBeNull();
    expect(button("Send").disabled).toBe(false);
  });

  test("streaming side-question errors replace the answer and can be dismissed", async () => {
    const btw: Btw = { id: "side-2", question: "why?", text: "partial answer", done: true, error: "provider failed" };
    await show({ btw });
    expect(node(".btw .err").textContent).toBe("provider failed");
    expect(root.querySelector(".btw-a")).toBeNull();
    await click(button("Dismiss"));
    expect(root.querySelector(".btw")).toBeNull();
  });

  test("unsupported side turns send /btw as a regular prompt", async () => {
    await show({ item: item({ live: live({ caps: noCaps }) }) });
    await input("/btw ordinary prompt");
    await click(button("Send"));
    expect(calls("btw")).toEqual([]);
    expect(calls("submit")).toEqual([{ text: "/btw ordinary prompt" }]);
  });

  test("an explicit follow-up is not intercepted as a side turn", async () => {
    await show({ item: item({ status: "working" }) });
    await input("/btw later question");
    await press("q", { ctrlKey: true });
    expect(calls("btw")).toEqual([]);
    expect(calls("submit")).toEqual([{ text: "/btw later question", followUp: true }]);
  });
});

describe("saved btw history", () => {
  test.each(["/btw", "  /btw \t\n "])("bare %s opens an empty history sheet, clears exactly one draft, and never submits", async (command) => {
    net.reply = historyReply;
    await show({ item: item({ status: "working", live: live({ caps: noCaps }) }) });
    await input(command);
    await click(button("Send after this turn"));
    expect(root.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Btw history");
    expect(root.textContent).toContain("No saved btw questions.");
    expect(net.calls.filter((c) => c.url.endsWith("/btw-history")).map((c) => c.method)).toEqual(["GET"]);
    expect(calls("btw")).toEqual([]);
    expect(calls("submit")).toEqual([]);
    expect(calls("draft")).toEqual([{ text: command }, { text: "", expectedSessionId: "s", expectedText: command }]);
    expect(area().value).toBe("");
    await click(button("Close history"));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  test.each(["server", "offline", "invalid"])("a %s history failure keeps the command and can be retried", async (failure) => {
    await show();
    await input("/btw");
    net.reply = (c) => {
      if (c.method !== "GET" || !c.url.endsWith("/btw-history")) return historyReply(c);
      if (failure === "offline") return Promise.reject(new Error("network"));
      if (failure === "invalid") return new Response("not json");
      return Response.json({ error: "history unavailable" }, { status: 503 });
    };
    await click(button("Send"));
    expect(area().value).toBe("/btw");
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    const errors: Record<string, string> = {
      offline: "offline",
      server: "history unavailable",
      invalid: "Could not load btw history; send again to retry",
    };
    expect(node(".error").textContent).toBe(errors[failure]);
    expect(calls("draft")).toEqual([{ text: "/btw" }]);
    expect(calls("submit")).toEqual([]);
    expect(calls("btw")).toEqual([]);
    net.reply = historyReply;
    await click(button("Send"));
    expect(root.querySelector(".error")).toBeNull();
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(area().value).toBe("");
  });

  test("opening history leaves attached images ready for the next prompt", async () => {
    net.reply = historyReply;
    await show();
    await input("/btw");
    await paste([image()]);
    await click(button("Send"));
    expect(root.querySelectorAll(".pasted-item")).toHaveLength(1);
    expect(revoked).toEqual([]);
    expect(calls("submit")).toEqual([]);
    await click(button("Close history"));
    await input("next");
    await click(button("Send"));
    expect(calls("submit")).toEqual([{ text: "next", images: [{ data: btoa("PNG"), mimeType: "image/png" }], followUp: false }]);
  });

  test("an old block's delayed history cannot open in a different session", async () => {
    const pending = Promise.withResolvers<Response>();
    net.reply = (c) => historyReply(c, pending.promise);
    await show();
    await input("/btw");
    await click(button("Send"));
    await show({ block: "6", draft: { live: true, text: "" } });
    await release(pending, Response.json({ records: [] }));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(calls("draft")).toEqual([{ text: "/btw" }]);
    expect(net.to("/api/blocks/6/draft")).toEqual([]);
  });

  test("a delayed old session's history cannot clear or open in its replacement on the same block", async () => {
    const pending = Promise.withResolvers<Response>();
    net.reply = (c) => historyReply(c, pending.promise);
    await show();
    await input("/btw");
    await click(button("Send"));
    const replacement = item();
    if (!replacement.agent) throw new Error("Missing agent fixture");
    replacement.agent.sessionId = "replacement";
    await show({ item: replacement, draft: { live: true, text: "New session draft" } });
    await release(pending, Response.json({ records: [] }));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(calls("draft")).toEqual([{ text: "/btw" }]);
    await advance(800);
    expect(area().value).toBe("New session draft");
  });

  test("an already open history sheet closes when the same block starts a new session", async () => {
    net.reply = historyReply;
    await show();
    await input("/btw");
    await click(button("Send"));
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    const replacement = item();
    if (!replacement.agent) throw new Error("Missing agent fixture");
    replacement.agent.sessionId = "replacement";
    await show({ item: replacement });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  test("a newer desktop draft received during history loading is retained without an empty push", async () => {
    const pending = Promise.withResolvers<Response>();
    net.reply = (c) => historyReply(c, pending.promise);
    await show();
    await input("/btw");
    await click(button("Send"));
    await show({ draft: { live: true, text: "New desktop prompt" } });
    await release(pending, Response.json({ records: [] }));
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(calls("draft")).toEqual([{ text: "/btw" }]);
    await advance(800);
    expect(area().value).toBe("New desktop prompt");
  });
});

describe("completion", () => {
  test("debounces suggestions and applies the selected completion to both the draft and focused editor", async () => {
    await show();
    net.reply = (c) => Response.json(c.url.endsWith("/complete") ? suggestions() : c.url.endsWith("/completion") ? { text: "/help " } : { ok: true });
    await input("/h");
    await advance(119);
    expect(calls("complete")).toEqual([]);
    await input("/he");
    await advance(120);
    expect(calls("complete")).toEqual([{ text: "/he" }]);
    expect(node(".hints").getAttribute("role")).toBe("listbox");
    expect(node(".hint-desc").textContent).toBe("Command help");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    node(".hint").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await click(node(".hint"));
    expect(calls("completion")).toEqual([{ text: "/he", value: "/help", label: "/help", prefix: "/he" }]);
    expect(area().value).toBe("/help ");
    expect(document.activeElement).toBe(area());
    expect(root.querySelector(".hints")).toBeNull();
    expect(buzzes).toContain(8);
  });

  test("completion waits until a pending submit has mirrored the next draft", async () => {
    await show();
    await input("first");
    const submit = Promise.withResolvers<Response>();
    net.reply = (c) => c.url.endsWith("/submit") ? submit.promise
      : Response.json(c.url.endsWith("/complete") ? suggestions() : c.url.endsWith("/completion") ? { text: "/help " } : { ok: true });
    await click(button("Send"));
    await input("/he");
    await advance(120);
    expect((node(".hint") as HTMLButtonElement).disabled).toBe(true);
    await click(node(".hint"));
    expect(calls("completion")).toEqual([]);
    expect(calls("draft")).toEqual([{ text: "first" }]);
    await release(submit);
    expect(calls("draft")).toEqual([{ text: "first" }, { text: "/he" }]);
    await click(node(".hint"));
    expect(calls("completion")).toEqual([{ text: "/he", value: "/help", label: "/help", prefix: "/he" }]);
    expect(area().value).toBe("/help ");
  });

  test.each([false, true])("an in-flight completion cannot overtake submit or newer typing (%s)", async (editNext) => {
    await show();
    await offer();
    const completion = Promise.withResolvers<Response>();
    const submit = Promise.withResolvers<Response>();
    net.reply = (c) => c.url.endsWith("/completion") ? completion.promise
      : c.url.endsWith("/submit") ? submit.promise : Response.json({ ok: true });
    await click(node(".hint"));
    await click(button("Send"));
    if (editNext) await input("next prompt");
    await release(completion, Response.json({ text: "/help " }));
    await advance(50);
    expect(calls("draft")).toEqual([{ text: "/he" }]);
    expect(calls("submit")).toEqual([{ text: "/he" }]);
    expect(area().value).toBe(editNext ? "next prompt" : "/he");
    await release(submit);
    expect(area().value).toBe(editNext ? "next prompt" : "");
    expect(calls("draft")).toEqual(editNext ? [{ text: "/he" }, { text: "next prompt" }] : [{ text: "/he" }]);
  });

  test("an older suggestions response cannot replace the latest token's suggestions", async () => {
    const old = Promise.withResolvers<Response>();
    await show();
    net.reply = (c) => c.url.endsWith("/complete")
      ? calls("complete").length === 1 ? old.promise : Response.json(suggestions("@new", "@new.ts"))
      : Response.json({ ok: true });
    await input("/old");
    await advance(120);
    await input("@new");
    await advance(120);
    expect(node(".hint-label").textContent).toBe("@new.ts");
    await release(old, Response.json(suggestions("/old", "/old-command")));
    expect(node(".hint-label").textContent).toBe("@new.ts");
    await input("finished token ");
    expect(root.querySelector(".hints")).toBeNull();
  });

  test("a suggestion waits for the mirrored draft before it applies", async () => {
    const draft = Promise.withResolvers<Response>();
    await show();
    net.reply = (c) => c.url.endsWith("/draft") ? draft.promise
      : Response.json(c.url.endsWith("/complete") ? suggestions() : { text: "/help " });
    await input("/he");
    await advance(120);
    await click(node(".hint"));
    expect(calls("completion")).toEqual([]);
    await release(draft);
    await advance(50);
    expect(calls("completion")).toEqual([{ text: "/he", value: "/help", label: "/help", prefix: "/he" }]);
    expect(area().value).toBe("/help ");
  });

  test("typing during an apply wins over its response and the latest text is mirrored afterward", async () => {
    const completion = Promise.withResolvers<Response>();
    await show();
    await offer();
    net.reply = (c) => c.url.endsWith("/completion") ? completion.promise : Response.json({ ok: true });
    await click(node(".hint"));
    await input("my newer text");
    await input("my newest text");
    expect(calls("draft")).toEqual([{ text: "/he" }]);
    await release(completion, Response.json({ text: "/help " }));
    expect(area().value).toBe("my newest text");
    expect(calls("draft")).toEqual([{ text: "/he" }, { text: "my newest text" }]);
  });

  test.each(["server", "offline", "invalid"])("a %s completion error does not replace the typed token", async (failure) => {
    await show();
    await offer();
    net.reply = () => {
      if (failure === "offline") return Promise.reject(new Error("offline"));
      if (failure === "invalid") return new Response("invalid");
      return Response.json({ error: "completion rejected" }, { status: 409 });
    };
    await click(node(".hint"));
    expect(area().value).toBe("/he");
    expect(node(".error").textContent).toBe(failure === "offline" ? "offline" : failure === "invalid" ? "completion failed" : "completion rejected");
  });

  test("an apply that cannot settle the draft times out without sending a completion", async () => {
    const draft = Promise.withResolvers<Response>();
    await show();
    net.reply = (c) => c.url.endsWith("/draft") ? draft.promise : Response.json(suggestions());
    await input("/he");
    await advance(120);
    await click(node(".hint"));
    for (let i = 0; i < 60; i++) await advance(50);
    expect(calls("completion")).toEqual([]);
    expect(node(".error").textContent).toBe("Draft still syncing; tap the suggestion again");
    expect(area().value).toBe("/he");
    await release(draft);
  });

  test.each(["empty", "http", "invalid", "offline"])("%s suggestion responses leave no suggestion list", async (failure) => {
    await show();
    net.reply = (c) => {
      if (!c.url.endsWith("/complete")) return Response.json({ ok: true });
      if (failure === "offline") return Promise.reject(new Error("offline"));
      if (failure === "invalid") return new Response("invalid");
      if (failure === "http") return new Response("unavailable", { status: 503 });
      return Response.json({ prefix: "/he", items: [] });
    };
    await input("/he");
    await advance(120);
    expect(calls("complete")).toEqual([{ text: "/he" }]);
    expect(root.querySelector(".hints")).toBeNull();
    expect(root.querySelector(".error")).toBeNull();
  });

  test("remote tokens and unsupported extensions do not request suggestions", async () => {
    await show({ draft: { live: true, text: "/remote" } });
    await advance(120);
    expect(calls("complete")).toEqual([]);
    await show({ item: item({ live: live({ caps: noCaps }) }) });
    await input("/typed");
    await advance(120);
    expect(calls("complete")).toEqual([]);
  });
});

describe("terminal typing and key bar", () => {
  const shell = () => show({ item: item({ agent: null, live: null, status: null }), draft: null });

  test("serializes unicode-aware Backspace diffs and sends a soft-keyboard newline after the final text", async () => {
    const first = Promise.withResolvers<Response>();
    net.reply = () => first.promise;
    await shell();
    expect(area().placeholder).toBe("Type into the terminal");
    expect(area().getAttribute("autocapitalize")).toBe("off");
    expect(area().getAttribute("autocorrect")).toBe("off");
    expect(root.querySelector(".pick")).toBeNull();
    expect(root.querySelector(".keys")).not.toBeNull();
    await input("echo 😀");
    await input("echo x");
    await input("echo xy\nignored");
    expect(calls("type")).toEqual([{ back: 0, text: "echo 😀" }]);
    expect(calls("keys")).toEqual([]);
    net.reply = () => Response.json({ ok: true });
    await release(first);
    expect(net.calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/blocks/5/type", { back: 0, text: "echo 😀" }],
      ["/api/blocks/5/type", { back: 1, text: "x" }],
      ["/api/blocks/5/type", { back: 0, text: "y" }],
      ["/api/blocks/5/keys", { keys: ["Enter"] }],
    ]);
    expect(area().value).toBe("");
    await input("next");
    expect(calls("type")[3]).toEqual({ back: 0, text: "next" });
    expect(calls("draft")).toEqual([]);
    expect(calls("submit")).toEqual([]);
  });

  test("unchanged input writes nothing and Send presses Enter even on an empty terminal line", async () => {
    await shell();
    await input("pwd");
    await input("pwd");
    expect(calls("type")).toEqual([{ back: 0, text: "pwd" }]);
    await click(button("Send"));
    await click(button("Send"));
    expect(calls("keys")).toEqual([{ keys: ["Enter"] }, { keys: ["Enter"] }]);
    expect(area().value).toBe("");
    expect(calls("submit")).toEqual([]);
    expect((await paste([image()])).defaultPrevented).toBe(false);
  });

  test("every terminal key-bar button sends its actual key chord and starts a fresh local line", async () => {
    await shell();
    await input("discard local line");
    for (const label of ["Esc", "^C", "↑", "↓", "⏎", "Tab", "⇧Tab", "Space"]) await click(button(label));
    expect(calls("keys")).toEqual([
      { keys: ["Escape"] }, { keys: ["ctrl+c"] }, { keys: ["Up"] }, { keys: ["Down"] },
      { keys: ["Enter"] }, { keys: ["Tab"] }, { keys: ["shift+Tab"] }, { keys: ["space"] },
    ]);
    expect(area().value).toBe("");
    await input("new");
    expect(calls("type")[1]).toEqual({ back: 0, text: "new" });
    await click(button("Keys"));
    expect(root.querySelector(".keys")).toBeNull();
  });

  test("a failed terminal write is shown but does not break subsequent queued input", async () => {
    await shell();
    net.reply = () => Response.json({ error: "pane closed" }, { status: 404 });
    await input("a");
    expect(node(".error").textContent).toBe("pane closed");
    net.reply = () => Response.json({ ok: true });
    await input("ab");
    expect(calls("type")).toEqual([{ back: 0, text: "a" }, { back: 0, text: "b" }]);
  });

  test("an agent key bar preserves its draft, disables keys while sending, and toggles Raw/Chat", async () => {
    let toggled = 0;
    const toggle = () => { toggled++; };
    await show({ raw: { on: false, toggle } });
    expect(root.querySelector(".keys")).toBeNull();
    await input("keep my draft");
    await click(button("Keys"));
    await click(button("Raw"));
    expect(toggled).toBe(1);
    await show({ raw: { on: true, toggle } });
    expect(button("Chat").className).toBe("on");
    const pending = Promise.withResolvers<Response>();
    net.reply = () => pending.promise;
    await click(button("^C"));
    expect(button("Esc").disabled).toBe(true);
    expect(button("Send").disabled).toBe(true);
    await release(pending);
    expect(calls("keys")).toEqual([{ keys: ["ctrl+c"] }]);
    expect(area().value).toBe("keep my draft");
    expect(button("Esc").disabled).toBe(false);
  });
});

describe("stop, context and model controls", () => {
  test("an empty working agent stops, a failed abort can be retried, and typing changes Stop into Send", async () => {
    await show({ item: item({ status: "working" }) });
    expect(root.querySelector('[aria-label="Send"]')).toBeNull();
    net.reply = () => Response.json({ error: "abort failed" }, { status: 500 });
    await click(button("Stop"));
    expect(calls("abort")).toEqual([{}]);
    expect(node(".error").textContent).toBe("abort failed");
    expect(buzzes).not.toContain(30);
    net.reply = () => Response.json({ ok: true });
    await click(button("Stop"));
    expect(buzzes).toContain(30);
    expect(root.querySelector(".error")).toBeNull();
    await input("steer");
    expect(root.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(button("Send")).toBeDefined();
    expect(button("Send after this turn")).toBeDefined();
  });

  test("context usage shows its window and compaction marker while clamping the fill", async () => {
    await show({ item: item({ live: live({ context: { tokens: 150000, window: 200000, percent: 75, compactAt: 82.4 } }) }) });
    expect(node(".ctx").title).toBe("75% of the context window · 150k tokens");
    expect(node(".ctx-fill").style.width).toBe("75%");
    expect(node(".ctx-mark").style.left).toBe("82.4%");
    expect(node(".ctx-mark").title).toBe("auto-compacts at 82%");
    expect(node(".ctx-window").textContent).toBe("200k");
    await show({ item: item({ live: live({ context: { tokens: 220000, window: 200000, percent: 110, compactAt: null } }) }) });
    expect(node(".ctx").classList.contains("ctx-over")).toBe(true);
    expect(node(".ctx-fill").style.width).toBe("100%");
    expect(node(".ctx-pct").textContent).toBe("110%");
    expect(root.querySelector(".ctx-mark")).toBeNull();
    await show({ item: item({ live: live({ context: { tokens: 0, window: 200000, percent: 0, compactAt: null } }) }) });
    expect(node(".ctx-fill").style.width).toBe("1%");
  });

  test("opens and closes the real model popup and passes its selection to the session endpoint", async () => {
    net.reply = (c) => Response.json(c.url.endsWith("/models") ? { models: [] } : { ok: true });
    await show({
      item: item({ live: live({ tier: "priority" }) }),
      roles: [{ role: "fast", spec: "openai/gpt-5:low" }],
    });
    expect(node(".pick").textContent).toBe("Opus 5.5highfast");
    await click(node(".pick"));
    expect(root.querySelector(".sheet.mp")).not.toBeNull();
    expect(calls("models")).toEqual([undefined]);
    await click(button("Close"));
    expect(root.querySelector(".sheet")).toBeNull();
    await click(node(".pick"));
    await click(node(".mp-row"));
    expect(calls("model")).toEqual([{ role: "fast" }]);
    expect(root.querySelector(".sheet")).toBeNull();
  });

  test("unbridged model cycling sends Ctrl+P and closes the popup", async () => {
    await show({ item: item({ live: null }), draft: null });
    expect(node(".pick").textContent).toBe("Model");
    await click(node(".pick"));
    await click(node(".sheet-row"));
    expect(calls("keys")).toEqual([{ keys: ["ctrl+p"] }]);
    expect(calls("models")).toEqual([]);
    expect(root.querySelector(".sheet")).toBeNull();
  });
});
