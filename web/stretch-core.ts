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
  /** Offset of the closing `}}` in the parsed text, when closed: where a deepen answer goes in. */
  end?: number;
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
      frame.stretch.end = i;
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

export type LinkOp = "open" | "close" | "deepen";

export type LinkView = {
  href: (op: LinkOp, index: number) => string;
  isOpen: (key: string) => boolean;
  /** A stretch drawn part-way open, by key: an index would move when a ✦ answer is spliced in before it. */
  growing?: { key: string; progress: number };
  /** Draws the deepen control (✦) after each open innermost stretch; absent when deepening is unavailable. */
  deepen?: { progress: (key: string) => DeepenProgress | undefined };
};

/** Markdown for one text block. Link indexes point into `stretches(parts)`. */
export function linkedMarkdown(parts: Segment[], view: LinkView): string {
  const all = stretches(parts);
  /** Every « drawn so far: a stretch whose text already ends in one shares it instead of adding its own. */
  const closers: string[] = [];
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
    const isGrowing = view.growing?.key === part.key;
    const body = isGrowing ? grow(part.short, part.long, view.growing!.progress, drawOne) : draw(part.long);
    const trailing = /\s*$/.exec(body)?.[0] ?? "";
    // ✦ waits until the stretch has grown open, and until everything inside it is open: a press quotes
    // the whole long form. A stretch ending where an inner one does shares that one's ✦ « below.
    const isGrown = (key: string) => view.isOpen(key) && view.growing?.key !== key;
    const isLeaf = view.deepen !== undefined && !isGrowing && canDeepen(part, isGrown);
    const press = isLeaf ? view.deepen!.progress(part.key) : undefined;
    const streamed = press === undefined ? "" : press.partial.trim().replace(LEADING_DEEPEN, "");
    const text = arriving(body.slice(0, body.length - trailing.length), streamed);
    // Stretches ending on the same word share the innermost «: each click closes one level and the
    // next « takes its place, instead of a row of closers stacking up.
    if (closers.some(c => text.endsWith(c))) return `${text}${trailing}`;
    // After a closing code fence or a table row, an inline « would break the block: give it a paragraph.
    const gap = endsInBlock(text) ? "\n\n" : " ";
    const close = `[«](${view.href("close", index)})`;
    closers.push(close);
    // ✦ stands before the «: "more here", then the way back.
    const control = !isLeaf ? "" : press ? `${waiting(press.elapsedMs, streamed)} ` : `[${DEEPEN}](${view.href("deepen", index)}) `;
    return `${text}${gap}${control}${close}${trailing}`;
  };
  return draw(parts);
}

/** A ✦ press still running: how long it has run and the answer streamed so far. */
export type DeepenProgress = { elapsedMs: number; partial: string };

const TWINKLE = ["✧", "✦", "✶", "✷", "✸", "✷", "✶", "✦"];
/**
 * How often a running press redraws: once a second, with the seconds count. Each redraw replaces
 * the reply's links, and a click whose press and release straddle one is lost.
 */
export const TWINKLE_MS = 1000;

/** The running control: a twinkling star, with the seconds waited until the first words arrive. */
function waiting(elapsedMs: number, streamed: string): string {
  const glyph = TWINKLE[Math.floor(elapsedMs / TWINKLE_MS) % TWINKLE.length]!;
  return streamed === "" ? `${glyph} ${Math.floor(elapsedMs / 1000)}s` : glyph;
}

/** `section` with the answer streamed so far after it, where the finished answer will stand. */
function arriving(section: string, streamed: string): string {
  const shown = streamed === "" ? "" : streamingView(parse(streamed)).trimEnd();
  if (shown === "") return section;
  return `${section}${endsInBlock(section) ? "\n\n" : " "}${DEEPEN} ${shown}`;
}

/** A GFM table's delimiter row, such as `--- | :---:` or `| --- |`: leading and trailing pipes optional. */
const TABLE_DELIMITER = /^[ \t]*(?=[^\n]*\|)\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * Whether `text` ends in a code fence or a table, which inline text after it would join or break.
 * A table runs to the next blank line, so it is its last paragraph holding a delimiter row.
 */
function endsInBlock(text: string): boolean {
  const trimmed = text.trimEnd();
  if (/^[ \t]*(`{3,}|~{3,}|\|)/.test(trimmed.slice(trimmed.lastIndexOf("\n") + 1))) return true;
  const paragraph = trimmed.split(/\n[ \t]*\n/).pop() ?? "";
  return paragraph.split("\n").some(line => TABLE_DELIMITER.test(line));
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

// ---------------------------------------------------------------------------
// Deepen: a press on ✦ asks the model, outside the transcript, for more on one fully open stretch.
// Its answer is kept apart from the reply and spliced in as one more stretch, `{{✦|✦ answer}}`, at
// the end of that stretch's long form, so the keys of everything written before it never change.

export const DEEPEN = "✦";
/** A ✦ the model put before its answer: the splice adds its own. */
const LEADING_DEEPEN = new RegExp(`^${DEEPEN}\\s*`);

/** An open stretch can be deepened once every stretch inside it is open too, so a press quotes what the reader sees. */
export function canDeepen(stretch: Stretch & { long: Segment[] }, isOpen: (key: string) => boolean): boolean {
  return stretches(stretch.long).every(s => !isLinkable(s) || isOpen(s.key));
}

/** Longest answer kept; a longer one is refused rather than cut mid-markup. */
const DEEPEN_MAX_CHARS = 2000;

export type DeepenAnswer = { key: string; text: string };

/** `text` with each answer spliced into the stretch it deepens; answers to answers go in after their parent. */
export function withAnswers(text: string, answers: readonly DeepenAnswer[]): string {
  let out = text;
  let left = [...answers];
  while (left.length > 0) {
    const all = stretches(parse(out));
    const ready = left.flatMap(answer => {
      const at = all.find(s => s.key === answer.key && isLinkable(s))?.end;
      return at === undefined ? [] : [{ answer, at }];
    });
    if (ready.length === 0) break;
    // Last offset first, so splicing one never moves the next one's offset.
    for (const { answer, at } of ready.sort((a, b) => b.at - a.at)) {
      const before = out.slice(0, at);
      // After a fence or table row the answer needs its own paragraph, or it joins the block.
      const head = endsInBlock(before) ? `${before.trimEnd()}\n\n` : /\s$/.test(before) ? before : `${before} `;
      out = `${head}{{${DEEPEN}|${DEEPEN} ${answer.text}}}${out.slice(at)}`;
    }
    left = left.filter(answer => !ready.some(r => r.answer === answer));
  }
  return out;
}

/** The side question a ✦ press asks: `section` as the reader sees it, under its parents' short forms. */
export function deepenPrompt(section: string, parents: string[]): string {
  const under = parents.length === 0 ? "" : `\n\nIt sits under: ${parents.map(p => `"${p.trim()}"`).join(" › ")}.`;
  return `The reader pressed ✦ to ask for more depth on one part of your last reply. The part, as they see it:

<section>
${section.trim()}
</section>${under}

Write only the text that comes next inside that part: it must read on directly after the part's last word. One to three sentences in the stretchtext format of your replies, with stretches for further depth. Do not repeat the part, and add no preamble.`;
}

/** A checked ✦ answer: its text, the key of the stretch it became, and the stretches written inside it. */
export type Spliced = { text: string; key: string; nested: Stretch[] };

/**
 * The model's `reply` as an answer to the stretch `key` of `block` (which already holds `answers`),
 * or undefined when it is empty, too long, or would not stay inside its own stretch once spliced in:
 * a stray `}}`, an unclosed fence or a lone backtick pairing with later code would otherwise close
 * or swallow the stretches around it, and the answer is saved with the session.
 */
export function spliceAnswer(block: string, answers: readonly DeepenAnswer[], key: string, reply: string): Spliced | undefined {
  const text = reply.trim().replace(LEADING_DEEPEN, "");
  if (text === "" || text.length > DEEPEN_MAX_CHARS) return undefined;
  const before = new Map(stretches(parse(withAnswers(block, answers))).map(s => [s.key, s.isClosed]));
  const after = stretches(parse(withAnswers(block, [...answers, { key, text }])));
  if ([...before].some(([k, isClosed]) => after.find(s => s.key === k)?.isClosed !== isClosed)) return undefined;
  const prefix = key + KEY_SEPARATOR;
  const added = after.filter(s => !before.has(s.key));
  const own = added.find(s => s.short === DEEPEN && s.key.startsWith(prefix) && !s.key.slice(prefix.length).includes(KEY_SEPARATOR));
  const alone = parse(`${DEEPEN} ${text}`);
  if (own?.long === undefined || !own.isClosed || writeOpen(own.long) !== writeOpen(alone)) return undefined;
  if (added.length !== 1 + stretches(alone).length || added.some(s => !s.isClosed)) return undefined;
  return { text, key: own.key, nested: added.filter(s => s !== own) };
}

/** Marks a read note that reported ✦ answers: a rebuilt session counts only those as told. */
export const DEEPEN_REPORTED = "Stretchtext: the reader pressed ✦ for more depth";

/** The note that tells the model, on the next prompt, what it added outside the transcript. */
export function deepenNote(added: { section: string; text: string }[]): string | undefined {
  if (added.length === 0) return undefined;
  const tail = (section: string) => `…${section.trim().split(/\s+/).slice(-8).join(" ")}`;
  // Whole answers (spliceAnswer caps them): the note is the model's only copy.
  const each = added.map(a => `after "${tail(a.section)}" you added "${a.text}"`).join("; ");
  return `${DEEPEN_REPORTED}, and you answered outside the transcript: ${each}.`;
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
