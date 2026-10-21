// Stretchtext for omp: pure parsing, growth and layout, no omp imports.
// parse/grow/GUIDE are ported from pro-vi/cc-stretch (MIT, https://github.com/pro-vi/cc-stretch).
//
// A reply is markdown in which `{{short|long}}` marks a stretch: the reader sees `short`, and
// opening it puts `long` in its place. `long` may hold further stretches. Code spans and fences are
// copied as written, so braces in code never open a stretch.

/** How heavily stretches are used: `light` keeps a sentence or two per paragraph in view, `dense` one clause. */
export type Level = "light" | "dense";
export type Mode = Level | "off";

const SHORTEST: Record<Level, string> = {
  light: "- At its shortest, the reply answers on its own, a sentence or two per paragraph or list item.",
  dense:
    "- At its shortest, each paragraph or list item shows only its gist, one short clause; everything else in it goes into its stretch. Each short form states that gist itself, never a label such as \"Details.\" or \"Limits.\"",
};

export function guideFor(level: Level): string {
  return GUIDE_TEMPLATE.replace("{{shortest}}", SHORTEST[level]);
}

const GUIDE_TEMPLATE = `# Stretchtext replies

The reader's screen draws each stretch \`{{short|long}}\` in your reply as its short form. Opening one puts the long form in its place and the text reads on; nothing moves to a separate section. So write every reply to read complete at its shortest, with depth where each stretch stands:

{{shortest}} Anything the reader must decide or do stays outside every stretch.
- Keep the structure the reply would have without stretches: separate topics go in their own paragraphs, parallel items in a list, code in code blocks, each paragraph or list item with its own stretches. Never fold a whole reply into one paragraph of stretches.
- Stretch list items, not whole lists.
- The long form keeps every word of the short form, in the same order, and grows around them: words added before, between and after the ones the reader already saw. On screen those words stay where they are while the new ones open up around them, so the reader never loses their place. Example: "{{The build fails on a stale cache.|The CI build fails, about one run in five, on a stale dependency cache keyed only by \`package.json\`.}}"
- The long form must read correctly in the short form's place: a phrase stretches into a clause, a sentence into a paragraph, a paragraph into several. A long form may hold blank lines, list items and code blocks wherever the full text needs them.
- Stretches nest: a long form may hold further stretches, each a further level of depth.
- The short form is plain inline text on one line. Never put a stretch inside a code span, a code block, a table or a heading.
- If other instructions require a closing block, such as a status block, make it the reply's last stretch, its short form a one-line gist of the block.
- A reply that is already short needs no stretches.
- A side question wrapped in \`<btw>\` is answered in plain text, without stretches: its view shows markup as written and cannot open it.

With each of the reader's messages you are told which stretches they opened. Do not assume they read a long form they did not open; if it matters to what they asked, say it again.`;

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

type Frame = { stretch: Stretch; siblings: Set<string> };

export const KEY_SEPARATOR = " › ";

export function isOpenable(stretch: Stretch): boolean {
  return stretch.isClosed && stretch.long !== undefined;
}

/** Openable with a one-line short form: the only stretches the reader can open. */
export function isLinkable(stretch: Stretch): stretch is Stretch & { long: Segment[] } {
  return isOpenable(stretch) && !stretch.short.includes("\n");
}

/**
 * Where the code span opening at `i` ends: past the next run of exactly as many backticks. Without
 * one the backticks are literal text, so the span ends right after them.
 */
export function codeSpanEnd(text: string, i: number): number {
  const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
  const closing = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
  closing.lastIndex = i + run.length;
  const match = closing.exec(text);
  return match === null ? i + run.length : match.index + run.length;
}

export function parse(text: string): Segment[] {
  const root: Segment[] = [];
  const stack: Frame[] = [];
  const rootSiblings = new Set<string>();

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
      stack.push({ stretch, siblings: new Set() });
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

/**
 * The short form plus its parents' keys. A repeated sibling takes the first free `~2`, `~3`, so a
 * written `a~2` never shares a key, and the separator is replaced in names so a prefix is always a parent.
 */
function keyOf(short: string, parent: Frame | undefined, rootSiblings: Set<string>): string {
  const name = short.trim().replaceAll(KEY_SEPARATOR, " > ");
  const siblings = parent?.siblings ?? rootSiblings;
  let own = name;
  for (let n = 2; siblings.has(own); n++) own = `${name}~${n}`;
  siblings.add(own);
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
    // A long form may close right after its fence (```}} and on): those braces stay outside the code.
    const close = /^([ \t]*)(`+|~+)(?:(\}\}).*|[ \t]*)$/.exec(text.slice(at, lineEnd(at)));
    if (close && close[2]!.length >= opening.length && close[2]![0] === opening[0]) {
      return close[3] ? at + close[1]!.length + close[2]!.length : Math.min(lineEnd(at) + 1, text.length);
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
  return parts.map(part => {
    if (typeof part === "string") return part;
    return part.long === undefined ? literalPlaceholder(part) : endLine(writeOpen(part.long));
  }).join("");
}

/**
 * A reply still streaming: stretches show their short forms, while completed no-pipe placeholders
 * stay literal. Neither incomplete markup nor half-written long forms show; links wait until final.
 */
export function streamingView(parts: Segment[]): string {
  return parts.map(part => {
    if (typeof part === "string") return part;
    return part.long === undefined && part.isClosed ? literalPlaceholder(part) : part.short;
  }).join("");
}

/** A long form that closed on its code fence's line (```}}) gets a line break, so text after it is not on the fence line. */
function endLine(text: string): string {
  return /^[ \t]*(`{3,}|~{3,})[ \t]*$/.test(text.slice(text.lastIndexOf("\n") + 1)) ? `${text}\n` : text;
}

function literalPlaceholder(part: Stretch): string {
  return `{{${part.short}${part.isClosed ? "}}" : ""}`;
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

export type LinkOp = "open" | "close";

export type LinkView = {
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
    if (!isLinkable(part)) {
      if (part.long === undefined) return literalPlaceholder(part);
      return part.long.length === 0 ? part.short : endLine(draw(part.long));
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

/** The note sent with the reader's next message: which stretches of the last reply they opened. */
export function readNote(written: { id: string; short: string }[], opened: ReadonlySet<string>): string | undefined {
  if (written.length === 0) return undefined;
  const quote = (list: { short: string }[]) => list.map(s => `"${s.short.trim()}"`).join(", ");
  const yes = written.filter(s => opened.has(s.id));
  const no = written.filter(s => !opened.has(s.id));
  if (yes.length === 0) {
    return "Stretchtext: the reader opened no stretch of your last reply; they read only its short forms.";
  }
  return `Stretchtext: since your last reply the reader opened ${quote(yes)}${no.length > 0 ? `; they did not open ${quote(no)}` : ""}`;
}

const ALL_GUIDES = [guideFor("light"), guideFor("dense")];
const SWITCH_NOTE: Record<Level, string> = {
  light: "Stretchtext is now light: at its shortest, a sentence or two per paragraph or list item.",
  dense: "Stretchtext is now dense: at its shortest, each paragraph or list item shows only its gist, one short clause.",
};

/** Pure prompt edits; the caller owns pending reads and consumes the mode-change notification. */
export function promptTransition(
  systemPrompt: string[],
  mode: Mode,
  switched: Mode | undefined,
  written: { id: string; short: string }[],
  opened: ReadonlySet<string>,
): { systemPrompt: string[] | undefined; content: string | undefined } {
  const others = systemPrompt.filter(part => !ALL_GUIDES.includes(part));
  if (mode === "off") {
    return {
      systemPrompt: others.length === systemPrompt.length ? undefined : others,
      content: switched === "off"
        ? "Stretchtext is now off: write plain replies, without {{short|long}} markup."
        : undefined,
    };
  }
  const guide = guideFor(mode);
  const note = readNote(written, opened);
  const unchanged = systemPrompt.includes(guide) && others.length === systemPrompt.length - 1;
  return {
    systemPrompt: unchanged ? undefined : [...others, guide],
    content: switched === undefined ? note : `${SWITCH_NOTE[mode]}${note === undefined ? "" : ` ${note}`}`,
  };
}
