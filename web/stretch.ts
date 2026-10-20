// Stretchtext replies (pro-vi/cc-stretch, MIT; ported from the omp `stretch.ts` extension's core):
// an agent writes `{{short|long}}`, the chat shows the short form as a link, and a tap grows the
// long form in its place. Keys and block ids match the extension's, so the phone and the Tern pane
// open the same stretches. Code spans and fences are copied as written: braces in code are text.

export type Segment = string | Stretch;

export type Stretch = {
  /** Short form plus parents' (`cache › key`); repeated sibling short forms take `~2`, `~3`. */
  key: string;
  short: string;
  /** Undefined when no `|` was written: then there is nothing to open. */
  long: Segment[] | undefined;
  /** False when the closing braces never arrived (aborted reply). */
  isClosed: boolean;
};

type Frame = { stretch: Stretch; siblings: Map<string, number> };

const KEY_SEPARATOR = " › ";

function isOpenable(stretch: Stretch): boolean {
  return stretch.isClosed && stretch.long !== undefined;
}

/** Openable with a one-line short form: the only stretches the reader can open. */
export function isLinkable(stretch: Stretch): boolean {
  return isOpenable(stretch) && !stretch.short.includes("\n");
}

/** Where the code span opening at `i` ends: past the next run of as many backticks, or at the text's end. */
function codeSpanEnd(text: string, i: number): number {
  const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
  const end = text.indexOf(run, i + run.length);
  return end === -1 ? text.length : end + run.length;
}

export function parse(text: string): Segment[] {
  const root: Segment[] = [];
  const stack: Frame[] = [];
  const rootSiblings = new Map<string, number>();

  const write = (chunk: string) => {
    const frame = stack.at(-1);
    if (frame && frame.stretch.long === undefined) {
      frame.stretch.short += chunk;
      return;
    }
    const segments = frame?.stretch.long ?? root;
    const last = segments.at(-1);
    if (typeof last === "string") segments[segments.length - 1] = last + chunk;
    else segments.push(chunk);
  };

  let i = 0;
  while (i < text.length) {
    const frame = stack.at(-1);
    const isInShort = frame !== undefined && frame.stretch.long === undefined;

    const fenceStop = i === 0 || text[i - 1] === "\n" ? fenceEnd(text, i) : undefined;
    if (fenceStop !== undefined) {
      write(text.slice(i, fenceStop));
      i = fenceStop;
      continue;
    }
    if (text[i] === "`") {
      const stop = codeSpanEnd(text, i);
      write(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (text.startsWith("{{", i) && !isInShort) {
      const stretch: Stretch = { key: "", short: "", long: undefined, isClosed: false };
      (frame?.stretch.long ?? root).push(stretch);
      stack.push({ stretch, siblings: new Map() });
      i += 2;
      continue;
    }
    if (isInShort && text[i] === "|") {
      frame.stretch.key = keyOf(frame.stretch.short, stack.at(-2), rootSiblings);
      frame.stretch.long = [];
      i += 1;
      continue;
    }
    if (frame && text.startsWith("}}", i)) {
      frame.stretch.isClosed = true;
      stack.pop();
      i += 2;
      continue;
    }
    write(text[i] ?? "");
    i += 1;
  }
  return root;
}

function keyOf(short: string, parent: Frame | undefined, rootSiblings: Map<string, number>): string {
  const name = short.trim();
  const siblings = parent?.siblings ?? rootSiblings;
  const seen = (siblings.get(name) ?? 0) + 1;
  siblings.set(name, seen);
  const own = seen === 1 ? name : `${name}~${seen}`;
  return parent ? `${parent.stretch.key}${KEY_SEPARATOR}${own}` : own;
}

/** Where a fenced code block opening at `start` ends (past its closing line), or undefined when no fence opens there. */
function fenceEnd(text: string, start: number): number | undefined {
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? text.length : end;
  };
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(start, lineEnd(start)))?.[1];
  if (opening === undefined) return undefined;
  for (let at = lineEnd(start) + 1; at < text.length; at = lineEnd(at) + 1) {
    const line = text.slice(at, lineEnd(at)).trim();
    if (line.length >= opening.length && [...line].every(c => c === opening[0])) {
      return Math.min(lineEnd(at) + 1, text.length);
    }
  }
  return text.length;
}

/** Every stretch, outermost first, in the order the reply writes them. */
export function stretches(segments: Segment[]): Stretch[] {
  return segments.flatMap(segment =>
    typeof segment === "string" ? [] : [segment, ...stretches(segment.long ?? [])],
  );
}

/** The reply with every stretch drawn as its long form. */
export function writeOpen(parts: Segment[]): string {
  return parts
    .map(part => (typeof part === "string" ? part : part.long === undefined ? part.short : writeOpen(part.long)))
    .join("");
}

/**
 * A reply still streaming: every stretch as its short form, so neither raw markup nor a half-written
 * long form shows. Links appear once the reply is final.
 */
function streamingView(parts: Segment[]): string {
  return parts.map(part => (typeof part === "string" ? part : part.short)).join("");
}

// ---------------------------------------------------------------------------
// Growth: the short form's words are anchors that never move; new words arrive around them.

type Token = { kind: "word" | "space"; text: string } | { kind: "nested"; stretch: Stretch };
type Atom = string | Stretch;
type Side = "before" | "between" | "after";

/** The long form at `progress` (0 = anchors only, 1 = all). `draw` writes a nested stretch. */
export function grow(short: string, long: Segment[], progress: number, draw: (nested: Stretch) => string): string {
  const tokens = tokenize(long);
  const anchors = anchorsOf(short, tokens);
  const shown = (atoms: Atom[]) => atoms.map(atom => (typeof atom === "string" ? atom : draw(atom))).join("");

  let out = "";
  let run: Atom[] = [];
  let hasAnchorBefore = false;
  const flush = (hasAnchorAfter: boolean) => {
    if (run.length === 0) return;
    const side: Side = !hasAnchorBefore ? (hasAnchorAfter ? "before" : "after") : hasAnchorAfter ? "between" : "after";
    out += shown(reveal(run, side, progress));
    run = [];
  };

  tokens.forEach((token, i) => {
    if (anchors.has(i) && token.kind !== "space") {
      flush(true);
      out += token.kind === "nested" ? draw(token.stretch) : token.text;
      hasAnchorBefore = true;
      return;
    }
    run.push(token.kind === "nested" ? token.stretch : token.text);
  });
  flush(false);
  return out;
}

/** How many words and nested stretches a growth adds, to pace it. */
export function lengthOf(long: Segment[]): number {
  return tokenize(long).filter(token => token.kind !== "space").length;
}

const isSpaceAtom = (atom: Atom | undefined) => typeof atom === "string" && /^\s+$/.test(atom);

function reveal(run: Atom[], side: Side, progress: number): Atom[] {
  if (side === "between" && run.length > 1 && isSpaceAtom(run[0]) && isSpaceAtom(run.at(-1))) {
    const middle = reveal(run.slice(1, -1), side, progress);
    return middle.length === 0 ? [run[0] ?? " "] : [run[0] ?? " ", ...middle, run.at(-1) ?? " "];
  }
  if (side === "between" && isSpaceAtom(run[0])) return [run[0] ?? " ", ...reveal(run.slice(1), side, progress)];
  const count = Math.round(run.length * Math.min(1, Math.max(0, progress)));
  if (side === "after") return run.slice(0, count);
  if (side === "before") return run.slice(run.length - count);
  const left = run.slice(0, Math.ceil(count / 2));
  const right = run.slice(run.length - Math.floor(count / 2));
  if (left.length + right.length === run.length) return [...left, ...right];
  if (isSpaceAtom(left.at(-1)) && isSpaceAtom(right[0])) return [...left, ...right.slice(1)];
  if (!isSpaceAtom(left.at(-1)) && !isSpaceAtom(right[0]) && left.length > 0 && right.length > 0) {
    return [...left, " ", ...right];
  }
  return [...left, ...right];
}

function tokenize(long: Segment[]): Token[] {
  return long.flatMap((part): Token[] =>
    typeof part === "string"
      ? part
          .split(/(\s+)/)
          .filter(text => text !== "")
          .map(text => ({ kind: /^\s+$/.test(text) ? "space" : "word", text }))
      : [{ kind: "nested", stretch: part }],
  );
}

/** Token indexes of the long form carrying the short form's words, in order (longest common subsequence). */
function anchorsOf(short: string, tokens: Token[]): Set<number> {
  const want = short.split(/\s+/).map(bare).filter(word => word !== "");
  const have: { token: number; word: string }[] = [];
  tokens.forEach((token, i) => {
    const words =
      token.kind === "word" ? [token.text] : token.kind === "nested" ? token.stretch.short.split(/\s+/) : [];
    for (const word of words.map(bare).filter(w => w !== "")) have.push({ token: i, word });
  });

  const lengths = Array.from({ length: want.length + 1 }, () => new Array<number>(have.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = have.length - 1; j >= 0; j--) {
      const row = lengths[i]!;
      const below = lengths[i + 1]!;
      row[j] = want[i] === have[j]?.word ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const anchors = new Set<number>();
  for (let i = 0, j = 0; i < want.length && j < have.length; ) {
    if (want[i] === have[j]?.word) {
      anchors.add(have[j]!.token);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  // Punctuation standing on its own right after an anchor belongs to that anchor.
  let last = -1;
  tokens.forEach((token, i) => {
    if (token.kind === "space") return;
    if (token.kind === "word" && bare(token.text) === "" && anchors.has(last)) anchors.add(i);
    last = i;
  });
  return anchors;
}

/** A word without surrounding punctuation or markdown marks, lowercased, so `cache.` meets `**cache**`. */
function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// In-chat view: each closed stretch is a markdown link, each open one its long form then a « link.

type LinkOp = "open" | "close";

type LinkView = {
  href: (op: LinkOp, index: number) => string;
  isOpen: (key: string) => boolean;
  /** A stretch drawn part-way open, `index` into the block's `stretches()`. */
  growing?: { index: number; progress: number };
};

/** Markdown for one text block. Link indexes point into `stretches(parts)`. */
export function linkedMarkdown(parts: Segment[], view: LinkView): string {
  const all = stretches(parts);
  const draw = (segments: Segment[]): string => segments.map(drawOne).join("");
  const drawOne = (part: Segment): string => {
    if (typeof part === "string") return part;
    // Not openable (multi-line short form, or cut off by an abort): drawn open, so nothing hides.
    if (!isLinkable(part) || part.long === undefined) {
      return part.long === undefined || part.long.length === 0 ? part.short : draw(part.long);
    }
    const index = all.indexOf(part);
    if (!view.isOpen(part.key)) return `[${labelOf(part.short)}](${view.href("open", index)})`;
    const body =
      view.growing?.index === index ? grow(part.short, part.long, view.growing.progress, drawOne) : draw(part.long);
    const trailing = /\s*$/.exec(body)?.[0] ?? "";
    const text = body.slice(0, body.length - trailing.length);
    // After a closing code fence or a table row, an inline « would break the block: give it a paragraph.
    const lastLine = text.slice(text.lastIndexOf("\n") + 1);
    const gap = /^\s*(`{3,}|~{3,}|\|)/.test(lastLine) ? "\n\n" : " ";
    return `${text}${gap}[«](${view.href("close", index)})${trailing}`;
  };
  return draw(parts);
}

/**
 * A short form as link text: outside code spans, a markdown link inside it becomes `text (target)`
 * and brackets and backslashes are escaped. Code spans are kept as written, where an escape would show.
 */
function labelOf(short: string): string {
  const plain = (text: string) =>
    text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)").replace(/([[\]\\])/g, "\\$1");
  let label = "";
  let from = 0;
  for (let at = short.indexOf("`"); at !== -1; at = short.indexOf("`", from)) {
    const stop = codeSpanEnd(short, at);
    label += plain(short.slice(from, at)) + short.slice(at, stop);
    from = stop;
  }
  return label + plain(short.slice(from));
}


// ---------------------------------------------------------------------------
// tern-awui helpers.

/** Agent text with every stretch drawn open, for views without links (side answers). */
export function openText(text: string): string {
  return text.includes("{{") ? writeOpen(parse(text)) : text;
}

/** A reply still being written: short forms only, so neither markup nor a half long form shows. */
export function liveText(text: string): string {
  return text.includes("{{") ? streamingView(parse(text)) : text;
}

/** A block's open keys after opening or closing `key`; closing also closes the stretches nested in it. */
export function withOpen(keys: readonly string[], key: string, open: boolean): string[] {
  if (open) return keys.includes(key) ? [...keys] : [...keys, key];
  return keys.filter((k) => k !== key && !k.startsWith(key + KEY_SEPARATOR));
}
