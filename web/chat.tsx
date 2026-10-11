// The chat renderer, shared by sessions and their subagents: markdown (charts, mermaid), advisor
// notes, tool lines, ask cards and prompts.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Mermaid } from "mermaid";
import { drawCharts } from "./charts";
import { post, type AdvisorNote, type Ask, type ChatEntry, type Img, type TodoPhase, type ToolCall } from "./api";
import { askAnswers, askReady, clock, duration, langOf, parseAdvisorNote, prettyModel, type AskPick } from "./lib";
import { renderMarkdown } from "./markdown";
import { buzz, Thumbs, Todo, UserMsg } from "./parts";

let mermaidReady: Promise<Mermaid> | null = null;
const mermaidSvgs = new Map<string, string | null>();
let mermaidSeq = 0;

/** Draws the mermaid placeholders under `root`; the library (~1 MB) loads on first use. */
async function drawMermaid(root: HTMLElement) {
  const slots = [...root.querySelectorAll<HTMLElement>(".mermaid-src")];
  if (!slots.length) return;
  mermaidReady ??= import("mermaid").then(({ default: m }) => {
    // strict: labels are sanitized and click handlers off; the source is agent text.
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: "system-ui, sans-serif" });
    return m;
  });
  const mermaid = await mermaidReady;
  for (const slot of slots) {
    const src = slot.textContent ?? "";
    if (!mermaidSvgs.has(src)) {
      const id = `mmd${++mermaidSeq}`;
      const svg = await mermaid.render(id, src).then((r) => r.svg, () => null);
      document.getElementById(`d${id}`)?.remove(); // a failed render leaves its scratch node
      mermaidSvgs.set(src, svg);
    }
    if (!slot.isConnected || !slot.classList.contains("mermaid-src")) continue;
    const svg = mermaidSvgs.get(src);
    // A diagram that doesn't parse keeps showing its source.
    slot.classList.remove("mermaid-src");
    if (svg) slot.innerHTML = svg;
  }
}

export function Markdown({ text, class: cls }: { text: string; class: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const lang = useMemo(() => langOf(text), [text]);
  useEffect(() => {
    if (!ref.current) return;
    drawCharts(ref.current);
    void drawMermaid(ref.current);
  }, [html]);
  return <div ref={ref} class={cls} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** omp's advisor notes: severity, then `Key:`, `Evidence:`, `Impact:`, `Fix:` lines; tap to expand. */
function AdvisorCard({ notes }: { notes: AdvisorNote[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="advisor" onClick={() => setOpen(!open)}>
      <div class="advisor-head">
        <span class="chev">{open ? "▾" : "▸"}</span>
        <span>Advisor</span>
        <span class="muted">
          {notes.length} note{notes.length > 1 ? "s" : ""}
        </span>
      </div>
      {notes.map((n, i) => {
        const { key, lines } = parseAdvisorNote(n.note);
        return (
          <div key={i} class="advisor-note">
            <div class="advisor-line">
              <span class={`sev sev-${n.severity}`}>{n.severity}</span>
              <span class="advisor-key">{key}</span>
            </div>
            {open && (
              <div class="advisor-body">
                {lines.map((l, j) =>
                  l.label ? (
                    <p key={j}>
                      <b>{l.label}:</b> {l.text}
                    </p>
                  ) : (
                    <p key={j}>{l.text}</p>
                  ),
                )}
                <div class="muted small">{n.advisor}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Tools({ calls, images, todo, latestTodo }: { calls: ToolCall[]; images: Img[]; todo: TodoPhase[] | null; latestTodo: boolean }) {
  const [open, setOpen] = useState(false);
  const errors = calls.filter((c) => c.error).length;
  const last = calls[calls.length - 1];
  return (
    <div class="tools" onClick={() => setOpen(!open)}>
      <div class="tools-head">
        <span class="chev">{open ? "▾" : "▸"}</span>
        <span>
          {calls.length} tool{calls.length > 1 ? "s" : ""}
        </span>
        {errors > 0 && <span class="err">· {errors} failed</span>}
        <span class="tools-last">{last.intent || last.name}</span>
      </div>
      {open && (
        <ul>
          {calls.map((c, n) => (
            <li key={n} class={c.error ? "err" : ""}>
              <span class="tool-name">{c.name}</span> {c.intent}
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && <Thumbs images={images} />}
      {todo && <Todo phases={todo} full={latestTodo} />}
    </div>
  );
}

/** An open ask: tap to answer, like omp's own dialog. One single-choice question sends on tap. */
function AskCard({ ask, block, pending }: { ask: Ask; block: string; pending: boolean }) {
  const [picks, setPicks] = useState<AskPick[]>(() =>
    ask.questions.map(() => ({ option: null, picks: [], other: "", otherOpen: false })),
  );
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ask.answer !== null || !pending) {
    return (
      <div class="ask done">
        {ask.questions.map((q, k) => (
          <div key={k} class="ask-q">{q.question}</div>
        ))}
        <div class="ask-answer">{ask.answer ?? "not answered"}</div>
      </div>
    );
  }

  const instant = ask.questions.length === 1 && !ask.questions[0].multi;
  const ready = askReady(ask.questions, picks);

  async function send(next: AskPick[]) {
    setSending(true);
    const answers = askAnswers(next);
    const err = await post(`/api/blocks/${block}/answer`, { id: ask.id, answers });
    setSending(false);
    setError(err);
    if (!err) {
      buzz();
      setSent(true);
    }
  }

  function update(i: number, change: Partial<AskPick>, submitNow = false) {
    const next = picks.map((p, k) => (k === i ? { ...p, ...change } : p));
    setPicks(next);
    if (submitNow) void send(next);
  }

  return (
    <div class={`ask${sent ? " sent" : ""}`}>
      {ask.questions.map((q, i) => {
        const p = picks[i];
        return (
          <div key={i} class="ask-block">
            <div class="ask-q">{q.question}</div>
            {q.multi && <div class="muted small">Pick any</div>}
            <div class="opts">
              {q.options.map((o, j) => {
                const on = q.multi ? p.picks.includes(j) : p.option === j && !p.otherOpen;
                return (
                  <button
                    key={j}
                    class={`opt${on ? " on" : ""}`}
                    disabled={sending || sent}
                    onClick={() =>
                      q.multi
                        ? update(i, { picks: on ? p.picks.filter((x) => x !== j) : [...p.picks, j] })
                        : update(i, { option: j, otherOpen: false }, instant)
                    }
                  >
                    <span class={`mark${q.multi ? " box" : ""}`} />
                    <span class="opt-text">
                      <span class="opt-label">
                        {o.label}
                        {q.recommended === j && <span class="rec">recommended</span>}
                      </span>
                      {o.description && <span class="opt-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              <button
                class={`opt${p.otherOpen ? " on" : ""}`}
                disabled={sending || sent}
                onClick={() => update(i, { otherOpen: !p.otherOpen, option: null })}
              >
                <span class={`mark${q.multi ? " box" : ""}`} />
                <span class="opt-text">
                  <span class="opt-label">Other…</span>
                  <span class="opt-desc">Type your own answer</span>
                </span>
              </button>
              {p.otherOpen && (
                <input
                  class="other-input"
                  autoFocus
                  placeholder="Your answer"
                  value={p.other}
                  onInput={(e) => update(i, { other: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ready) void send(picks);
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
      {error && <div class="err small">{error}</div>}
      {sent ? (
        <div class="muted small">Sent, waiting for omp…</div>
      ) : (
        (!instant || picks[0].otherOpen) && (
          <button class="primary" disabled={!ready || sending} onClick={() => send(picks)}>
            {sending ? "Sending…" : "Send answer"}
          </button>
        )
      )}
    </div>
  );
}

/**
 * `rewind`: the session's omp can rewind to a prompt. `readOnly` (a subagent's transcript): no
 * prompt actions and no answerable asks.
 */
export function Chat({ entries, block, rewind, readOnly = false }: { entries: ChatEntry[]; block: string; rewind: boolean; readOnly?: boolean }) {
  // An ask is open only while nothing was said after it.
  const lastTalk = entries.findLastIndex((e) => e.role === "user" || e.role === "assistant");
  const latestTodo = entries.findLastIndex((e) => e.role === "tools" && e.todo !== null);
  return (
    <>
      {entries.map((e, n) => {
        if (e.role === "user") return <UserMsg key={n} entry={e} block={block} rewind={rewind} readOnly={readOnly} />;
        if (e.role === "turn")
          return (
            <div key={n} class="turn">
              {duration(e.ms)}
              {e.model && ` · ${prettyModel(e.model)}`}
              {` · ${clock(e.ts)}`}
            </div>
          );
        if (e.role === "assistant") return <Markdown key={n} class="msg assistant md" text={e.text} />;
        if (e.role === "advisor") return <AdvisorCard key={n} notes={e.notes} />;
        if (e.role === "tools")
          return <Tools key={n} calls={e.calls} images={e.images} todo={e.todo} latestTodo={n === latestTodo} />;
        return <AskCard key={e.id} ask={e} block={block} pending={!readOnly && n > lastTalk} />;
      })}
    </>
  );
}

