// Builders for omp transcript lines, shaped like ~/.omp/agent/sessions/*/*_<id>.jsonl rows.

type Row = Record<string, unknown>;
type Part = Record<string, unknown>;

export const T0 = Date.parse("2026-10-09T13:45:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A session transcript written row by row: each row's parentId is the previous row's id unless
 * `parent` says otherwise (a rewind branches from an earlier entry).
 */
export class Transcript {
  rows: Row[] = [];
  private n = 0;
  last = "";

  constructor(sessionId = "sess", cwd = "/tmp/proj") {
    this.rows.push({ type: "title", v: 1, title: "Test session", source: "auto" });
    this.rows.push({ type: "session", version: 3, id: sessionId, timestamp: iso(T0), cwd });
    this.entry({ type: "model_change", model: "anthropic/claude-test" }, 0);
  }

  private entry(fields: Row, at: number, parent = this.last): string {
    const id = `e${String(++this.n).padStart(3, "0")}`;
    // omp writes `type` first; the list's fast scan relies on it.
    this.rows.push({ type: fields.type, id, parentId: parent || null, timestamp: iso(T0 + at), ...fields });
    this.last = id;
    return id;
  }

  user(content: string | Part[], at: number, parent?: string): string {
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return this.entry({ type: "message", message: { role: "user", content: parts, timestamp: T0 + at } }, at, parent);
  }

  assistant(parts: Part[], at: number, opts: { stop?: string; model?: string; parent?: string } = {}): string {
    const message = { role: "assistant", content: parts, model: opts.model ?? "claude-test", stopReason: opts.stop ?? "stop", timestamp: T0 + at };
    return this.entry({ type: "message", message }, at, opts.parent);
  }

  say(text: string, at: number): string {
    return this.assistant([{ type: "text", text }], at);
  }

  result(toolCallId: string, toolName: string, at: number, opts: { content?: Part[] | string; isError?: boolean; details?: Row } = {}): string {
    const content = typeof opts.content === "string" ? [{ type: "text", text: opts.content }] : (opts.content ?? [{ type: "text", text: "ok" }]);
    const message = { role: "toolResult", toolCallId, toolName, content, isError: opts.isError ?? false, details: opts.details ?? {}, timestamp: T0 + at };
    return this.entry({ type: "message", message }, at);
  }

  advisor(notes: Row[], at: number): string {
    return this.entry({ type: "custom_message", customType: "advisor", content: "<advisory/>", display: true, details: { notes } }, at);
  }

  ttsr(rules: string[], at: number): string {
    return this.entry({ type: "ttsr_injection", injectedRules: rules }, at);
  }

  developer(content: string, at: number): string {
    return this.entry({ type: "message", message: { role: "developer", content: [{ type: "text", text: content }], timestamp: T0 + at } }, at);
  }

  custom(at: number): string {
    return this.entry({ type: "custom", customType: "plannotator", data: { phase: "idle" } }, at);
  }

  lines(): string[] {
    return this.rows.map((r) => JSON.stringify(r));
  }

  text(): string {
    return this.lines().join("\n") + "\n";
  }
}

export const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
export const text = (t: string) => ({ type: "text", text: t });
export const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
export const HASH = "07d2bb33fe28771f36752c70b9bcd5ef98dc14508798b1f479c22b25bd4c69e1";
/** A valid 1×1 PNG, used for route bytes and real browser decoding. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
