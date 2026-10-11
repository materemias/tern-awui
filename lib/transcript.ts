// omp transcripts (~/.omp/agent/sessions/*/*_<id>.jsonl): what the phone shows of a session.

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
  | { role: "assistant"; text: string; ts: number }
  | { role: "tools"; calls: ToolCall[]; images: Img[]; todo: TodoPhase[] | null; ts: number }
  | AskEntry
  | { role: "turn"; ms: number; model: string; ts: number }
  | { role: "advisor"; notes: AdvisorNote[]; ts: number };
export type AskEntry = { role: "ask"; id: string; questions: AskQuestion[]; answer: string | null; ts: number };
/** A note from omp's advisor model: `Key:`/`Evidence:`/`Impact:`/`Fix:` lines. */
export type AdvisorNote = { advisor: string; severity: string; note: string };

// `title` is eval's intent; `code` (its first line) only when a call carries nothing better.
const INTENT_KEYS = ["i", "title", "command", "path", "pattern", "query", "url", "description", "code"];

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

/** The last `tailBytes` of a transcript as lines; a tail that starts mid-line drops that line. */
async function tailLines(path: string, tailBytes: number): Promise<string[]> {
  const file = Bun.file(path);
  const size = file.size;
  const start = Math.max(0, size - tailBytes);
  const lines = (await file.slice(start, size).text()).split("\n");
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
  let id = leaf === "-" ? "" : parentOf.has(leaf) ? leaf : str(rows.findLast((r) => parentOf.has(str(r.id)))?.id);
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
        const key = INTENT_KEYS.find((k) => typeof args[k] === "string");
        const intent = key ? str(args[key]).trim().split("\n")[0] : "";
        const call: ToolCall = { name: str(part.name), intent: intent.slice(0, 160) };
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
const NEWLINE = 0x0a;

/**
 * Brings `prev` (the previous scan of this file, updated in place) up to the file's end; starts
 * over on the tail when there is none or the file shrank (rewritten).
 */
export async function scanFacts(path: string, prev: Facts | undefined, tailBytes = CHAT_TAIL_BYTES): Promise<Facts> {
  const file = Bun.file(path);
  const size = file.size;
  const fresh = !prev || size < prev.offset;
  const facts = !prev || fresh ? { offset: Math.max(0, size - tailBytes), lastPrompt: "", lastTurn: 0, lastActivity: 0 } : prev;
  if (size > facts.offset) {
    const bytes = new Uint8Array(await file.slice(facts.offset, size).arrayBuffer());
    const end = bytes.lastIndexOf(NEWLINE) + 1; // a line still being written waits for the next scan
    const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");
    if (fresh && facts.offset > 0) lines.shift(); // the tail starts mid-line
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
    facts.offset += end;
  }
  return facts;
}

/** A recap written before the session's last turn describes an earlier exchange. */
export function recapStale(recap: { createdAt: number } | undefined, lastTurn: number): boolean {
  // `created_at` holds whole seconds, so it may trail the turn by one.
  return !!recap && (recap.createdAt + 1) * 1000 < lastTurn;
}
