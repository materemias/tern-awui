// omp transcripts (~/.omp/agent/sessions/*/*_<id>.jsonl): what the phone shows of a session.

import { closeSync, constants, fstatSync, lstatSync, openSync, statSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { extname, isAbsolute } from "node:path";
import { marked } from "marked";
import { arr, num, obj, str, type Obj } from "./json";

/** Only the tail of a transcript is read: older entries never reach the phone. */
export const CHAT_TAIL_BYTES = 4 * 1024 * 1024;

export type ToolCall = { name: string; intent: string; error?: boolean };
/** omp's todo list after a `todo` call: phases of tasks (pending, in_progress, completed, blocked…). */
export type TodoPhase = { name: string; tasks: { content: string; status: string; blocker?: string }[] };
export type AskQuestion = {
  question: string;
  options: { label: string; description: string }[];
  multi: boolean;
  recommended: number;
};
/**
 * An image the session saw, as a URL for <img>: omp keeps most bytes in ~/.omp/agent/blobs/<hash>
 * (served by /api/blob), and small ones inline in the transcript (sent as a data: URL).
 */
export type Img = { src: string };
export const INLINE_IMAGE_CHARS = 256 * 1024;
export type ChatEntry =
  | { role: "user"; id: string; text: string; images: Img[]; ts: number }
  | { role: "assistant"; text: string; imageSources?: Record<string, string>; ts: number }
  | { role: "tools"; calls: ToolCall[]; images: Img[]; todo: TodoPhase[] | null; ts: number }
  | AskEntry
  | { role: "turn"; ms: number; model: string; ts: number }
  | { role: "advisor"; notes: AdvisorNote[]; ts: number };
export type AskEntry = { role: "ask"; id: string; questions: AskQuestion[]; answer: string | null; ts: number };
/** A note from omp's advisor model: `Key:`/`Evidence:`/`Impact:`/`Fix:` lines. */
export type AdvisorNote = { advisor: string; severity: string; note: string };

// `title` is eval's intent; `code` (its first line) only when a call carries nothing better.
const INTENT_KEYS = ["i", "title", "command", "path", "pattern", "query", "url", "description", "code"];

/** What a subagent hands back with `yield` when it is text (`data.result`, or `data` itself); "" otherwise. */
export function yieldText(args: Obj): string {
  const data = args.data;
  return (typeof data === "string" ? data : str(obj(data).result)).trim();
}

/** A tool call's one-line intent from its arguments ("" when it carries none), at most 160 chars. */
export function callIntent(args: Obj): string {
  const key = INTENT_KEYS.find((k) => typeof args[k] === "string");
  return key ? str(args[key]).trim().split("\n")[0].slice(0, 160) : "";
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map(obj)
    .filter((p) => p.type === "text")
    .map((p) => str(p.text))
    .join("\n");
}

export const IMAGE_MIMES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true };

export function imagesOf(content: unknown): Img[] {
  return arr(content)
    .map(obj)
    .filter((p) => p.type === "image" && IMAGE_MIMES[str(p.mimeType)] === true)
    .map((p) => {
      const data = str(p.data);
      const mime = str(p.mimeType);
      const hash = /^blob:sha256:([0-9a-f]{64})$/.exec(data)?.[1];
      if (hash) return { src: `/api/blob/${hash}?type=${encodeURIComponent(mime)}` };
      const inline = data.length <= INLINE_IMAGE_CHARS && /^[A-Za-z0-9+/]+=*$/.test(data);
      return { src: inline ? `data:${mime};base64,${data}` : "" };
    })
    .filter((i) => i.src);
}

const LOCAL_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const LOCAL_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const LOCAL_IMAGE_CACHE_ENTRIES = 128;
const LOCAL_IMAGE_REFERENCES = 4096;
const IMAGE_EXTENSIONS: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
type ImageReference = { stamp: string; hash: string; type: string };
type CachedImage = { type: string; bytes: Uint8Array<ArrayBuffer> };
const imageStamp = (st: Stats) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

/** Check raster signatures, not just a filename that could contain HTML or an SVG. */
function rasterMime(bytes: Uint8Array<ArrayBuffer>): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452 && view.getUint32(16) > 0 && view.getUint32(20) > 0) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (bytes.length >= 10 && view.getUint32(0) === 0x47494638 && (view.getUint16(4) === 0x3761 || view.getUint16(4) === 0x3961) &&
    view.getUint16(6, true) > 0 && view.getUint16(8, true) > 0) return "image/gif";
  if (bytes.length >= 16 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250 &&
    view.getUint32(4, true) + 8 === bytes.length) return "image/webp";
  return "";
}

/**
 * Only image references in an authorized transcript enter this bounded, server-scoped cache.
 * The blob route serves these snapshots, never a request-supplied filesystem path.
 */
export class TranscriptImages {
  private references = new Map<string, ImageReference>();
  private images = new Map<string, CachedImage>();
  private pending = new Map<string, Promise<string | null>>();
  private bytes = 0;

  private remember(hash: string, image: CachedImage) {
    const previous = this.images.get(hash);
    if (previous) {
      this.images.delete(hash);
      this.bytes -= previous.bytes.byteLength;
    }
    while (this.images.size >= LOCAL_IMAGE_CACHE_ENTRIES || this.bytes + image.bytes.byteLength > LOCAL_IMAGE_CACHE_BYTES) {
      const oldest = this.images.entries().next().value;
      if (!oldest) break;
      this.bytes -= oldest[1].bytes.byteLength;
      this.images.delete(oldest[0]);
    }
    this.images.set(hash, image);
    this.bytes += image.bytes.byteLength;
  }

  async get(hash: string): Promise<CachedImage | undefined> {
    const cached = this.images.get(hash);
    if (cached) {
      this.images.delete(hash);
      this.images.set(hash, cached);
      return cached;
    }
    // A cache miss may reload only a path previously validated from assistant image markdown.
    for (const [path, reference] of this.references) {
      if (reference.hash !== hash) continue;
      const loaded = await this.read(path, reference.stamp, reference.type);
      if (!loaded || loaded.hash !== hash) continue;
      this.remember(hash, loaded.image);
      return loaded.image;
    }
  }

  private async read(path: string, stamp: string, type: string): Promise<{ hash: string; image: CachedImage } | null> {
    let fd: number | undefined;
    try {
      const current = lstatSync(path);
      if (!current.isFile() || imageStamp(current) !== stamp) return null;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || imageStamp(opened) !== stamp) return null;
      const bytes = new Uint8Array(await Bun.file(fd).slice(0, LOCAL_IMAGE_MAX_BYTES + 1).arrayBuffer());
      if (bytes.length !== opened.size || imageStamp(fstatSync(fd)) !== stamp || rasterMime(bytes) !== type) return null;
      return { hash: createHash("sha256").update(bytes).digest("hex"), image: { type, bytes } };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private async source(path: string): Promise<string | null> {
    const type = IMAGE_EXTENSIONS[extname(path).toLowerCase()];
    if (!isAbsolute(path) || path.startsWith("//") || /[\0-\x1f]/.test(path) || !type) return null;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size === 0 || st.size > LOCAL_IMAGE_MAX_BYTES) return null;
      const stamp = imageStamp(st);
      let reference = this.references.get(path);
      if (reference?.stamp !== stamp) {
        const loaded = await this.read(path, stamp, type);
        if (!loaded) return null;
        reference = { stamp, hash: loaded.hash, type };
        this.remember(loaded.hash, loaded.image);
      }
      this.references.delete(path);
      if (this.references.size >= LOCAL_IMAGE_REFERENCES) {
        const oldest = this.references.keys().next().value;
        if (oldest !== undefined) this.references.delete(oldest);
      }
      this.references.set(path, reference);
      return `/api/blob/${reference.hash}?type=${encodeURIComponent(type)}`;
    } catch {
      // Missing, unreadable and unsupported files keep their original visibly broken reference.
      return null;
    }
  }

  async attach(chat: { entries: ChatEntry[] }): Promise<{ entries: ChatEntry[] }> {
    for (const entry of chat.entries) {
      if (entry.role !== "assistant" || !entry.text.includes("!")) continue;
      delete entry.imageSources;
      const paths = new Set<string>();
      marked.walkTokens(marked.lexer(entry.text), (token) => {
        if (token.type === "image" && isAbsolute(token.href)) paths.add(token.href);
      });
      const sources: Record<string, string> = {};
      for (const path of paths) {
        let work = this.pending.get(path);
        if (!work) {
          work = this.source(path);
          this.pending.set(path, work);
        }
        const src = await work;
        if (this.pending.get(path) === work) this.pending.delete(path);
        if (src) sources[path] = src;
      }
      if (Object.keys(sources).length) entry.imageSources = sources;
    }
    // A single oversized transcript must not emit hashes already evicted from the authority index.
    for (const entry of chat.entries) {
      if (entry.role !== "assistant" || !entry.imageSources) continue;
      for (const path of Object.keys(entry.imageSources)) {
        const reference = this.references.get(path);
        if (!reference || entry.imageSources[path] !== `/api/blob/${reference.hash}?type=${encodeURIComponent(reference.type)}`)
          delete entry.imageSources[path];
      }
      if (!Object.keys(entry.imageSources).length) delete entry.imageSources;
    }
    return chat;
  }
}

/** The last `tailBytes` of a transcript as lines; a tail that starts mid-line drops that line. */
async function tailLines(path: string, tailBytes: number): Promise<string[]> {
  const file = Bun.file(path);
  const size = file.size;
  const start = Math.max(0, size - tailBytes);
  // Include the preceding byte: splitting then drops either an empty line or the partial row.
  const lines = (await file.slice(Math.max(0, start - 1), size).text()).split("\n");
  if (start > 0) lines.shift(); // partial line
  return lines;
}

/**
 * The chat on a session's active path, newest `limit` entries. `leaf` is the session's current
 * leaf as its bridge reports it ("" when unknown, "-" when rewound past the first prompt).
 */
export async function readChatFile(path: string, leaf: string, limit: number, tailBytes = CHAT_TAIL_BYTES): Promise<{ entries: ChatEntry[] }> {
  return parseChat(await tailLines(path, tailBytes), leaf, limit);
}

export function parseChat(lines: string[], leaf: string, limit: number): { entries: ChatEntry[] } {
  const entries: ChatEntry[] = [];
  const callsById = new Map<string, ToolCall>();
  const groupByCall = new Map<string, Extract<ChatEntry, { role: "tools" }>>();
  const asksById = new Map<string, AskEntry>();
  // The file is a tree: a rewind leaves the abandoned path in place and continues from an
  // earlier entry. Only the active path shows, walked back from the leaf: the session's own
  // (its bridge knows it, even before anything is appended after a rewind), else the last line.
  const rows = lines.flatMap((line) => {
    try {
      return [obj(JSON.parse(line))];
    } catch {
      return [];
    }
  });
  const parentOf = new Map(rows.filter((r) => str(r.id)).map((r) => [str(r.id), str(r.parentId)]));
  // `-`: rewound past the first prompt, nothing is on the path. Older extensions send no leaf.
  let id = leaf === "-" ? "" : leaf || str(rows.findLast((r) => parentOf.has(str(r.id)))?.id);
  const active = new Set<string>();
  for (; parentOf.has(id) && !active.has(id); id = parentOf.get(id) ?? "") active.add(id);
  // A turn runs from a user prompt to the assistant message that stops without calling tools.
  let turnStart: number | null = null;
  for (const row of rows) {
    const advisor = row.type === "custom_message" && row.customType === "advisor";
    if ((!advisor && row.type !== "message") || !active.has(str(row.id))) continue;
    const msg = obj(row.message);
    const ts = Date.parse(str(row.timestamp)) || num(msg.timestamp);
    if (advisor) {
      const notes = arr(obj(row.details).notes)
        .map(obj)
        .map((n) => ({ advisor: str(n.advisor), severity: str(n.severity, "note"), note: str(n.note).trim() }))
        .filter((n) => n.note);
      if (notes.length) entries.push({ role: "advisor", notes, ts });
      continue;
    }
    if (msg.role === "user") {
      const text = textOf(msg.content).trim();
      const images = imagesOf(msg.content);
      if (text || images.length) entries.push({ role: "user", id: str(row.id), text, images, ts });
      turnStart = ts;
    } else if (msg.role === "assistant") {
      for (const part of arr(msg.content).map(obj)) {
        if (part.type === "text" && str(part.text).trim()) entries.push({ role: "assistant", text: str(part.text), ts });
        if (part.type !== "toolCall") continue;
        const args = obj(part.arguments);
        if (part.name === "ask" && Array.isArray(args.questions)) {
          const questions = arr(args.questions).map(obj).map((q) => ({
            question: str(q.question),
            multi: q.multi === true,
            recommended: num(q.recommended),
            options: arr(q.options).map((o) => ({ label: str(obj(o).label, str(o)), description: str(obj(o).description) })),
          }));
          const ask = { role: "ask" as const, id: str(part.id), questions, answer: null, ts };
          asksById.set(ask.id, ask);
          entries.push(ask);
          continue;
        }
        // A subagent's final answer: its parent reads it, so the chat shows it as the reply.
        const result = part.name === "yield" ? yieldText(args) : "";
        if (result) {
          entries.push({ role: "assistant", text: result, ts });
          continue;
        }
        const call: ToolCall = { name: str(part.name), intent: callIntent(args) };
        callsById.set(str(part.id), call);
        const last = entries[entries.length - 1];
        const group = last?.role === "tools" ? last : { role: "tools" as const, calls: [], images: [], todo: null, ts };
        if (group !== last) entries.push(group);
        group.calls.push(call);
        groupByCall.set(str(part.id), group);
      }
      if (turnStart !== null && msg.stopReason !== "toolUse") {
        entries.push({ role: "turn", ms: ts - turnStart, model: str(msg.model), ts });
        turnStart = null;
      }
    } else if (msg.role === "toolResult") {
      const ask = asksById.get(str(msg.toolCallId));
      if (ask) ask.answer = textOf(msg.content).trim() || "answered";
      const call = callsById.get(str(msg.toolCallId));
      if (call && msg.isError === true) call.error = true;
      const group = groupByCall.get(str(msg.toolCallId));
      group?.images.push(...imagesOf(msg.content));
      // The list as this call left it; a group keeps the newest.
      const phases = arr(obj(msg.details).phases).map(obj);
      if (group && msg.toolName === "todo" && phases.length)
        group.todo = phases.map((p) => ({
          name: str(p.name),
          tasks: arr(p.tasks)
            .map(obj)
            .map((t) => ({ content: str(t.content), status: str(t.status, "pending"), ...(t.blocker ? { blocker: str(t.blocker) } : {}) })),
        }));
    }
  }
  return { entries: entries.slice(-limit) };
}

/** What the list shows of a transcript, scanned from where the previous scan stopped. */
export type Facts = { offset: number; lastPrompt: string; lastTurn: number; lastActivity: number };
const factFiles = new WeakMap<Facts, Stats>();
const NEWLINE = 0x0a;

/**
 * Scans from `prev` without mutating it: concurrent readers may share the cached snapshot.
 * Starts over on the tail if the file was replaced, shrank, or changed without growing.
 */
export async function scanFacts(path: string, prev: Facts | undefined, tailBytes = CHAT_TAIL_BYTES): Promise<Facts> {
  const file = Bun.file(path);
  const st = statSync(path, { throwIfNoEntry: false });
  const size = st?.size ?? 0;
  const previous = prev && factFiles.get(prev);
  const fresh = !previous || !st || st.dev !== previous.dev || st.ino !== previous.ino ||
    size < previous.size || (size === previous.size && st.mtimeMs !== previous.mtimeMs);
  const facts = !prev || fresh ? { offset: Math.max(0, size - tailBytes), lastPrompt: "", lastTurn: 0, lastActivity: 0 } : { ...prev };
  if (size > facts.offset) {
    const start = fresh && facts.offset > 0 ? facts.offset - 1 : facts.offset;
    const bytes = new Uint8Array(await file.slice(start, size).arrayBuffer());
    const end = bytes.lastIndexOf(NEWLINE) + 1; // a line still being written waits for the next scan
    const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");
    if (start < facts.offset) lines.shift(); // discard the preceding byte or partial row
    for (const line of lines) {
      if (!line.startsWith('{"type":"message"')) continue;
      let row: Obj;
      try {
        row = obj(JSON.parse(line));
      } catch {
        continue;
      }
      const msg = obj(row.message);
      const ts = Date.parse(str(row.timestamp)) || num(msg.timestamp);
      facts.lastActivity = Math.max(facts.lastActivity, ts);
      if (msg.role !== "user") continue;
      // Any prompt starts a turn (an image-only one too); only text replaces the shown prompt.
      facts.lastTurn = ts;
      const text = textOf(msg.content).replace(/\s+/g, " ").trim();
      if (text) facts.lastPrompt = text.slice(0, 300);
    }
    facts.offset = Math.max(facts.offset, start + end);
  }
  if (st) factFiles.set(facts, st);
  return facts;
}

/** A recap written before the session's last turn describes an earlier exchange. */
export function recapStale(recap: { createdAt: number } | undefined, lastTurn: number): boolean {
  // `created_at` holds whole seconds, so it may trail the turn by one.
  return !!recap && (recap.createdAt + 1) * 1000 < lastTurn;
}
