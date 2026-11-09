// omp's `ask` form (omp ≥ 18.18.3: the tool takes `{ html }`): the fields its terminal dialog
// walks, in its order, with their starting values. Mirrors pi-tui's html-form/parse.ts in what
// answering from the phone needs: which controls become fields, how radios and checkboxes group,
// which groups get a free-text "Other", and the question each field asks.
import { decodeHTML, decodeHTMLAttribute } from "entities";

export type AskOption = { value: string; label: string; checked: boolean; disabled: boolean };
/** `question`: what omp's answer summary calls the field (its label, the text before it, its legend or its name). */
export type AskField =
  | { kind: "text"; name: string; question: string; multiline: boolean; value: string }
  | { kind: "choice"; name: string; question: string; multi: boolean; select: boolean; other: boolean; options: AskOption[] };

type El = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = El | string;

const tags = (...names: string[]): Record<string, true> => Object.fromEntries(names.map((n) => [n, true]));
const VOID = tags("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr");
/** Elements whose content is text up to their end tag. */
const RAW = tags("script", "style", "textarea", "title");
/** Skipped with everything inside, as omp does. */
const SKIP = tags("button", "head", "iframe", "link", "meta", "noscript", "script", "style", "template", "title");
/** Elements that end the text block before them. */
const BLOCK = tags(
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figure", "figcaption", "footer",
  "header", "li", "main", "nav", "p", "section", "h1", "h2", "h3", "h4", "h5", "h6", "summary",
);
const CONTROL = tags("input", "select", "textarea");
const IGNORED_INPUTS = tags("button", "file", "image", "reset", "submit");

// An attribute follows whitespace, or directly a quoted value (`type="radio"name="x"`), as browsers allow.
const START = /<([a-zA-Z][\w:-]*)((?:(?:\s+|(?<=["']))[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const END = /<\/([a-zA-Z][\w:-]*)\s*>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A lenient HTML tree: enough for forms written by a model (unclosed options and list items included). */
function parseTree(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      top().children.push(decodeHTML(html.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeHTML(html.slice(i, lt)));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    END.lastIndex = i;
    const end = END.exec(html);
    if (end) {
      const tag = end[1].toLowerCase();
      const at = stack.findLastIndex((e) => e.tag === tag);
      if (at > 0) stack.length = at;
      i = END.lastIndex;
      continue;
    }
    START.lastIndex = i;
    const start = START.exec(html);
    if (!start) {
      top().children.push("<");
      i++;
      continue;
    }
    i = START.lastIndex;
    const tag = start[1].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of start[2].matchAll(ATTR)) {
      const name = a[1].toLowerCase();
      // Every HTML entity, as the browser decodes it: an option's value must match what the phone posts.
      if (!(name in attrs)) attrs[name] = decodeHTMLAttribute(a[2] ?? a[3] ?? a[4] ?? "");
    }
    // Implied end tags: an option ends at the next option or optgroup, a list item at the next item.
    if ((tag === "option" || tag === "optgroup") && top().tag === "option") stack.pop();
    if (tag === "optgroup" && top().tag === "optgroup") stack.pop();
    if (tag === "li" && top().tag === "li") stack.pop();
    const el: El = { tag, attrs, children: [] };
    top().children.push(el);
    if (RAW[tag] === true) {
      const close = html.slice(i).search(new RegExp(`</${tag}\\s*>`, "i"));
      const text = close === -1 ? html.slice(i) : html.slice(i, i + close);
      el.children.push(tag === "textarea" || tag === "title" ? decodeHTML(text) : text);
      i = close === -1 ? html.length : html.indexOf(">", i + close) + 1;
      continue;
    }
    if (VOID[tag] !== true && start[3] !== "/") stack.push(el);
  }
  return root;
}

function* elements(el: El): Generator<El> {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    yield c;
    yield* elements(c);
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** An element's visible text without its controls (omp's label text). */
function textOf(el: El): string {
  let out = "";
  const walk = (n: Node) => {
    if (typeof n === "string") {
      out += n;
      return;
    }
    if (SKIP[n.tag] === true || CONTROL[n.tag] === true || n.tag === "svg") return;
    if (n.tag === "br") out += "\n";
    else if (n.tag === "img") out += n.attrs.alt ?? "";
    if (BLOCK[n.tag] === true) out += " ";
    n.children.forEach(walk);
  };
  el.children.forEach(walk);
  return squash(out);
}

function hasControl(el: El): boolean {
  for (const e of elements(el)) if (CONTROL[e.tag] === true) return true;
  return false;
}

/** The fields of an ask form in the order omp's dialog walks them; hidden and button inputs aren't fields. */
export function parseAskForm(html: string): AskField[] {
  const tree = parseTree(html);
  const form = [...elements(tree)].find((e) => e.tag === "form") ?? tree;
  // `<label for>` names a control by id: the first such label of an existing control is its label.
  const ids = new Set<string>();
  for (const e of elements(form)) if (CONTROL[e.tag] === true && e.attrs.id) ids.add(e.attrs.id);
  const labelFor = new Map<string, El>();
  for (const e of elements(form)) {
    const id = e.attrs.for;
    if (e.tag === "label" && id && ids.has(id) && !labelFor.has(id)) labelFor.set(id, e);
  }

  const fields: AskField[] = [];
  const groups = new Map<string, Extract<AskField, { kind: "choice" }>>();
  const questions = new Map<AskField, { label: string; before: string; section: string }>();
  let section = "";
  let text = "";
  let before = "";
  let depth = 0;
  const flush = () => {
    const t = squash(text);
    text = "";
    if (t) before = t;
  };

  const ownLabel = (el: El) => {
    const by = el.attrs.id ? labelFor.get(el.attrs.id) : undefined;
    return by ? textOf(by) : squash(el.attrs["aria-label"] ?? el.attrs.title ?? "");
  };
  const add = (field: AskField, label: string) => {
    flush();
    fields.push(field);
    questions.set(field, { label, before, section });
    before = "";
  };
  const control = (el: El, outer: string | undefined) => {
    flush();
    const label = outer || ownLabel(el);
    const name = el.attrs.name ?? "";
    if (el.tag === "select") {
      const multi = "multiple" in el.attrs;
      const options = [...elements(el)]
        .filter((o) => o.tag === "option")
        .map((o) => {
          const t = textOf(o);
          return { value: o.attrs.value ?? t, label: t, checked: "selected" in o.attrs, disabled: "disabled" in o.attrs };
        });
      if (!multi && !options.some((o) => o.checked)) {
        const first = options.find((o) => !o.disabled);
        if (first) first.checked = true;
      }
      add({ kind: "choice", name, question: "", multi, select: true, other: false, options }, label);
      return;
    }
    if (el.tag === "textarea") {
      const value = (el.children[0] as string | undefined ?? "").replace(/^\r?\n/, "");
      add({ kind: "text", name, question: "", multiline: true, value }, label || name.replace(/[_-]+/g, " "));
      return;
    }
    const type = (el.attrs.type ?? "text").toLowerCase();
    if (IGNORED_INPUTS[type] === true || type === "hidden") return;
    if (type === "radio" || type === "checkbox") {
      const value = el.attrs.value ?? "on";
      const option = { value, label: label || (el.attrs.value ?? name), checked: "checked" in el.attrs, disabled: "disabled" in el.attrs };
      const key = `${type}\0${name}`;
      const group = groups.get(key);
      if (group) {
        group.options.push(option);
        return;
      }
      const field = { kind: "choice" as const, name, question: "", multi: type === "checkbox", select: false, other: false, options: [option] };
      groups.set(key, field);
      add(field, "");
      return;
    }
    add({ kind: "text", name, question: "", multiline: false, value: el.attrs.value ?? "" }, label || name.replace(/[_-]+/g, " "));
  };

  const walk = (n: Node) => {
    if (typeof n === "string") {
      text += n;
      return;
    }
    if (SKIP[n.tag] === true) return;
    if (CONTROL[n.tag] === true) {
      control(n, undefined);
      return;
    }
    switch (n.tag) {
      case "br":
        text += "\n";
        return;
      case "label": {
        // A `for` label already named its control; one that also wraps it still holds that control.
        if (n.attrs.for && labelFor.get(n.attrs.for) === n && !hasControl(n)) return;
        if (!hasControl(n)) break;
        const label = textOf(n);
        for (const c of elements(n)) if (CONTROL[c.tag] === true) control(c, label);
        return;
      }
      case "fieldset": {
        flush();
        const legend = n.children.find((c): c is El => typeof c !== "string" && c.tag === "legend");
        if (depth === 0) {
          section = legend ? textOf(legend) : "";
          before = "";
        } else if (legend) walk(legend);
        depth++;
        for (const c of n.children) if (c !== legend) walk(c);
        flush();
        depth--;
        if (depth === 0) {
          section = "";
          before = "";
        }
        return;
      }
      case "ul":
      case "ol":
      case "table":
        flush();
        if (hasControl(n)) break;
        before = "";
        return;
      case "pre":
      case "img":
      case "svg":
      case "hr":
        flush();
        // As omp: a rule, or a picture with nothing to show, adds no block between a caption and its field.
        if (n.tag !== "hr" && !(n.tag === "img" && !n.attrs.src)) before = "";
        return;
    }
    const block = BLOCK[n.tag] === true || n.tag === "legend";
    if (block) flush();
    n.children.forEach(walk);
    if (block) flush();
  };
  form.children.forEach(walk);

  for (const f of fields) {
    if (f.kind === "choice" && !f.select && f.options.length >= 2) f.other = !f.options.some((o) => /^\s*other\b/i.test(o.label));
    const q = questions.get(f)!;
    const lone = f.kind === "choice" && f.options.length === 1 ? f.options[0].label : "";
    f.question = squash(q.label || q.before || q.section || lone || f.name);
  }
  return fields;
}

/** How many places omp's dialog stops at in a field: rows of options (and Other), or one input. */
export function fieldStops(f: AskField): number {
  if (f.kind === "text") return 1;
  const enabled = f.options.filter((o) => !o.disabled).length;
  if (f.select && !f.multi) return enabled > 0 ? 1 : 0;
  return enabled + (f.other ? 1 : 0);
}
