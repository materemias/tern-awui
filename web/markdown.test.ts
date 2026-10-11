import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { drawCharts } from "./charts";

// happy-dom differs from browsers in two places DOMPurify depends on; both are patched to the
// spec's behavior (and restored afterwards), so the sanitizer runs here as it does in Chrome.
GlobalRegistrator.register({ url: "http://localhost/" });
const nodeName = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
// The class that defines it for every document, parsed ones included (the global `Document` is a subclass).
let docProto: Document = Object.getPrototypeOf(document);
while (!Object.hasOwn(docProto, "createNodeIterator")) docProto = Object.getPrototypeOf(docProto);
const createNodeIterator = docProto.createNodeIterator;
afterAll(async () => {
  Object.defineProperty(Node.prototype, "nodeName", nodeName);
  docProto.createNodeIterator = createNodeIterator;
  await GlobalRegistrator.unregister();
});
// 1. DOMPurify reads names through `Node.prototype`'s nodeName getter; happy-dom returns "" there
// and overrides it per subclass, so every tag would read as unknown and be dropped.
Object.defineProperty(Node.prototype, "nodeName", {
  configurable: true,
  get(this: Node) {
    for (let p = Object.getPrototypeOf(this); p && p !== Node.prototype; p = Object.getPrototypeOf(p)) {
      const get = Object.getOwnPropertyDescriptor(p, "nodeName")?.get;
      if (get) return get.call(this);
    }
    return "";
  },
});
// 2. happy-dom's NodeIterator is a TreeWalker: removing the node it stands on loses its place, so
// everything after a removed element would go unchecked. A browser's steps back to the node
// before the removed one; this does the same (DOMPurify passes no filter).
function following(n: Node, root: Node): Node | null {
  if (n.firstChild) return n.firstChild;
  for (let c: Node | null = n; c && c !== root; c = c.parentNode) if (c.nextSibling) return c.nextSibling;
  return null;
}
function preceding(n: Node, root: Node): Node | null {
  if (n === root) return null;
  let p = n.previousSibling;
  if (!p) return n.parentNode;
  while (p.lastChild) p = p.lastChild;
  return p;
}
docProto.createNodeIterator = function (root: Node, whatToShow = 0xffffffff) {
  let ref: Node | null = null;
  let before: Node | null = null;
  const shown = (n: Node) => (whatToShow >> (n.nodeType - 1)) & 1;
  return {
    nextNode() {
      let n = ref === null ? root : root.contains(ref) ? following(ref, root) : before && following(before, root);
      while (n && !shown(n)) n = following(n, root);
      if (n) [ref, before] = [n, preceding(n, root)];
      return n;
    },
  } as NodeIterator;
};
// Dynamic on purpose: DOMPurify binds to the window present when it loads (without one it
// returns input unsanitized), and static imports would load it before the DOM above exists.
const { renderMarkdown, screenHtml } = await import("./markdown");

/** Rendered markdown as a live DOM tree, as <Markdown> mounts it. */
function dom(md: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(md);
  return root;
}
const hrefs = (root: HTMLElement) => [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));
/** Every attribute anywhere in the tree, for handler and scheme checks. */
const attrs = (root: HTMLElement) => [...root.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => [a.name, a.value]));

describe("links", () => {
  test("keeps https, mailto, relative and fragment links", () => {
    const root = dom("[a](https://example.com/x?y=1) [b](mailto:me@example.com) [c](docs/readme.md) [d](/abs/path) [e](#top) [f](../up)");
    expect(hrefs(root)).toEqual(["https://example.com/x?y=1", "mailto:me@example.com", "docs/readme.md", "/abs/path", "#top", "../up"]);
  });

  test.each([
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](<javascript:alert(1)>)",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox)",
    "<javascript:alert(1)>",
  ])("drops the href of %s", (md) => {
    const root = dom(md);
    for (const href of hrefs(root)) expect(href ?? "").not.toMatch(/^\s*(javascript|data|vbscript):/i);
    expect(attrs(root).some(([, v]) => /javascript:|data:text/i.test(v))).toBe(false);
  });

  test("images keep https sources, lose script ones", () => {
    const root = dom("![a](https://example.com/a.png) ![b](javascript:alert(1))");
    expect([...root.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["https://example.com/a.png", null]);
  });
});

describe("raw HTML", () => {
  test("is shown as text, never parsed", () => {
    const root = dom('Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script> <b>bold</b>');
    expect(root.querySelector("img, script, b")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain("<script>alert(2)</script>");
  });

  test("an HTML block is text too", () => {
    const root = dom('<div onclick="alert(1)">\n<iframe src="https://evil.example"></iframe>\n</div>');
    expect(root.querySelector("div, iframe")).toBeNull();
    expect(root.textContent).toContain("<iframe");
  });
});

describe("figures", () => {
  test("svg fences draw inline: shapes and attributes stay, scripts and handlers go", () => {
    // The script sits last: happy-dom's parser swallows everything after a <script> inside svg.
    const root = dom(
      [
        "```svg",
        '<svg viewBox="0 0 10 10" width="100">',
        '<rect x="1" y="2" width="3" height="4" fill="currentColor" class="box" onclick="alert(1)"/>',
        '<a href="javascript:alert(1)"><text x="5" y="5" font-family="system-ui" onmouseover="alert(1)">t</text></a>',
        '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>',
        "<script>alert(1)</script></svg>",
        "```",
      ].join("\n"),
    );
    const fig = root.querySelector(".figure")!;
    expect(fig.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 10 10");
    const rect = fig.querySelector("rect")!;
    expect(["x", "y", "width", "height", "fill", "class"].map((a) => rect.getAttribute(a))).toEqual(["1", "2", "3", "4", "currentColor", "box"]);
    expect(fig.querySelector("text")!.getAttribute("font-family")).toBe("system-ui");
    const tags = new Set([...root.querySelectorAll("*")].map((e) => e.localName.toLowerCase()));
    for (const bad of ["script", "iframe", "foreignobject"]) expect(tags.has(bad)).toBe(false);
    expect(attrs(root).filter(([n, v]) => n.startsWith("on") || /javascript:/i.test(v))).toEqual([]);
  });

  test("mermaid fences become an escaped source carrier for the diagram", () => {
    // (No `-->` arrows: happy-dom's parser garbles that text, browsers don't.)
    const root = dom("```mermaid\ngraph TD\n  A --- B{a < b & c}\n  B --- <script>x</script>\n```");
    const slot = root.querySelector(".figure.mermaid-src")!;
    expect(slot.querySelector("pre")!.textContent).toBe("graph TD\n  A --- B{a < b & c}\n  B --- <script>x</script>");
    expect(root.querySelector("script")).toBeNull();
  });
});

describe("code fences", () => {
  test("name their language and escape their content", () => {
    const root = dom("```ts\nconst a = <T>(x: T) => x && '<b>';\n```");
    const pre = root.querySelector("pre")!;
    expect(pre.dataset.lang).toBe("ts");
    expect(pre.querySelector("code")!.textContent).toBe("const a = <T>(x: T) => x && '<b>';");
    expect(pre.querySelector("b")).toBeNull();
  });

  test("an unusual language name is left off, so it can't break out of the attribute", () => {
    const root = dom('```a"onmouseover="alert(1)\nx\n```');
    const pre = root.querySelector("pre")!;
    expect(pre.hasAttribute("data-lang")).toBe(false);
    expect(attrs(root).some(([n]) => n.startsWith("on"))).toBe(false);
    expect(dom("```\nx\n```").querySelector("pre")!.hasAttribute("data-lang")).toBe(false);
    expect(dom("```c++\nx\n```").querySelector("pre")!.dataset.lang).toBe("c++");
  });
});

describe("text", () => {
  test("a single newline breaks the line, GFM tables render", () => {
    expect(dom("one\ntwo").querySelector("br")).not.toBeNull();
    const root = dom("| Option | Time |\n|---|---|\n| A | 1 s |\n| B | 2 s |\n| C | 4 s |\n| D | 3 s |");
    expect(root.querySelectorAll("thead th").length).toBe(2);
    expect(root.querySelectorAll("tbody tr").length).toBe(4);
    // The chart reads the table exactly as markdown renders it.
    drawCharts(root);
    expect(root.querySelector(".chart-val.best")!.textContent).toBe("1 s");
  });
});

describe("screenHtml", () => {
  test("keeps Tern's colored spans and drops everything else", () => {
    const html = screenHtml(
      '<pre><span style="color:#f00" class="x" onclick="alert(1)">red</span><b>b</b><a href="https://x">link</a><script>alert(1)</script><img src=x onerror=alert(1)></pre>',
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    const span = root.querySelector("pre > span")!;
    expect(span.getAttribute("style")).toBe("color:#f00");
    expect(span.hasAttribute("class") || span.hasAttribute("onclick")).toBe(false);
    expect(root.querySelector("b")!.textContent).toBe("b");
    expect(root.querySelector("a, script, img")).toBeNull();
    // A link's text survives as plain text.
    expect(root.textContent).toBe("redblink");
  });
});
