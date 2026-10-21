// The chat renderer, shared by sessions and their subagents: markdown (charts, mermaid), advisor
// notes, tool lines, ask cards and prompts.
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Mermaid } from "mermaid";
import { drawCharts } from "./charts";
import { post, type AdvisorNote, type Ask, type ChatEntry, type Img, type TodoPhase, type ToolCall } from "./api";
import { askAnswers, askReady, clock, duration, langOf, parseAdvisorNote, prettyModel, type AskPick } from "./lib";
import { renderMarkdown } from "./markdown";
import { highlightFences } from "./highlight";
import { buzz, Thumbs, Todo, UserMsg } from "./parts";
import { isLinkable, lengthOf, linkedMarkdown, parse, stretches, writeOpen, type Segment, type Stretch } from "./stretch-core";
import { openText, withOpen } from "./stretch";

let mermaidReady: Promise<Mermaid> | null = null;
// Bounded: a long session renders many diagrams, and live edits of one make many sources.
const mermaidSvgs = new Map<string, string | null>();
const MERMAID_CACHE_MAX = 32;
let mermaidSeq = 0;

/** Draws the mermaid placeholders under `root`; the library (~1 MB) loads on first use. */
async function drawMermaid(root: HTMLElement) {
  const slots = [...root.querySelectorAll<HTMLElement>(".mermaid-src")];
  if (!slots.length) return;
  mermaidReady ??= import("mermaid").then(
    ({ default: m }) => {
      // strict: labels are sanitized and click handlers off; the source is agent text.
      m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: "system-ui, sans-serif" });
      return m;
    },
    (err) => {
      mermaidReady = null; // a failed load (offline) is retried next time
      throw err;
    },
  );
  const mermaid = await mermaidReady;
  for (const slot of slots) {
    const src = slot.textContent ?? "";
    if (!mermaidSvgs.has(src)) {
      const id = `mmd${++mermaidSeq}`;
      const svg = await mermaid.render(id, src).then((r) => r.svg, () => null);
      document.getElementById(`d${id}`)?.remove(); // a failed render leaves its scratch node
      mermaidSvgs.set(src, svg);
      // Maps iterate in insertion order: the first key is the oldest.
      if (mermaidSvgs.size > MERMAID_CACHE_MAX) mermaidSvgs.delete(mermaidSvgs.keys().next().value!);
    }
    if (!slot.isConnected || !slot.classList.contains("mermaid-src")) continue;
    const svg = mermaidSvgs.get(src);
    // A diagram that doesn't parse keeps showing its source.
    slot.classList.remove("mermaid-src");
    if (svg) slot.innerHTML = svg;
  }
}

export function Markdown({
  text,
  class: cls,
  imageSources,
  highlight,
  mermaid = true,
  onClick,
}: {
  text: string;
  class: string;
  imageSources?: Record<string, string>;
  /** Colors fenced code by its language (opened files; chat stays plain). */
  highlight?: boolean;
  /** Draws mermaid diagrams; live text keeps the source as code until its final render. */
  mermaid?: boolean;
  onClick?: (e: MouseEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text, imageSources), [text, imageSources]);
  const lang = useMemo(() => langOf(text), [text]);
  useEffect(() => {
    if (!ref.current) return;
    drawCharts(ref.current);
    if (mermaid) drawMermaid(ref.current).catch(() => {});
    if (highlight) highlightFences(ref.current).catch(() => {});
  }, [html]);
  return <div ref={ref} class={cls} lang={lang} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Stretchtext state of the session on screen: open keys per reply block, and `off` when the omp
 * session turned stretches off (`/stretch off`). `set` opens or closes one, in the Tern pane too
 * when its omp runs stretch.ts. Without a provider (subagents) each reply keeps its own state.
 */
export type StretchSync = { open: Record<string, string[]>; off: boolean; set(block: string, key: string, open: boolean): void };
export const StretchContext = createContext<StretchSync | null>(null);

/** A growth's pace: about 45 ms per added word, at most 700 ms, as in the Tern pane. */
const GROW_MS_PER_WORD = 45;
const GROW_MAX_MS = 700;
const STRETCH_HREF = /^#stretch\/(open|close)\/(\d+)$/;

/** An assistant reply; with stretches, short forms are links that grow their long form in place. */
function Reply({ entry }: { entry: Extract<ChatEntry, { role: "assistant" }> }) {
  const parts = useMemo(() => (entry.text.includes("{{") ? parse(entry.text) : null), [entry.text]);
  const all = useMemo(() => (parts ? stretches(parts) : []), [parts]);
  if (!parts || !all.some(isLinkable)) return <Markdown class="msg assistant md" text={entry.text} imageSources={entry.imageSources} />;
  return <StretchReply entry={entry} parts={parts} all={all} />;
}

function StretchReply({ entry, parts, all }: { entry: Extract<ChatEntry, { role: "assistant" }>; parts: Segment[]; all: Stretch[] }) {
  const sync = useContext(StretchContext);
  const shared = sync && entry.block ? { sync, block: entry.block } : null;
  const [local, setLocal] = useState<string[]>([]);
  const keys = shared ? (shared.sync.open[shared.block] ?? []) : local;
  const open = useMemo(() => new Set(keys), [keys.join("\0")]);
  const [growing, setGrowing] = useState<{ index: number; progress: number } | undefined>(undefined);

  // A stretch opened here or in the Tern pane grows in; one open on arrival is simply there.
  const before = useRef(open);
  useLayoutEffect(() => {
    const index = all.findIndex((s) => open.has(s.key) && !before.current.has(s.key) && isLinkable(s));
    before.current = open;
    const duration = index === -1 ? 0 : Math.min(GROW_MAX_MS, GROW_MS_PER_WORD * lengthOf(all[index]?.long ?? []));
    if (duration <= 0 || matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setGrowing(undefined);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setGrowing(progress < 1 ? { index, progress } : undefined);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setGrowing({ index, progress: 0 });
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const off = sync?.off === true;
  const text = useMemo(
    () => (off ? writeOpen(parts) : linkedMarkdown(parts, { href: (op, i) => `#stretch/${op}/${i}`, isOpen: (k) => open.has(k), growing })),
    [parts, open, growing, off],
  );
  const onClick = (e: MouseEvent) => {
    const link = (e.target as Element | null)?.closest?.("a[href^='#stretch/']");
    if (!link) return;
    // The href is a marker, not a route: never let it reach the hash router.
    e.preventDefault();
    const [, op, i] = STRETCH_HREF.exec(link.getAttribute("href") ?? "") ?? [];
    const stretch = all[Number(i)];
    if (!op || !stretch) return;
    if (shared) shared.sync.set(shared.block, stretch.key, op === "open");
    else setLocal((keys) => withOpen(keys, stretch.key, op === "open"));
  };
  return <Markdown class="msg assistant md stretchy" text={text} imageSources={entry.imageSources} onClick={onClick} />;
}

/**
 * omp's advisor notes, tap to expand. A note with a `Key:` line shows the key, then its labeled
 * lines (`Evidence:`, `Impact:`, `Fix:`) when open; a free-form note shows its own text as
 * markdown, two lines when folded.
 */
function AdvisorCard({ notes }: { notes: AdvisorNote[] }) {
  const [open, setOpen] = useState(false);
  return (
    // A link inside a note opens; it doesn't fold or unfold the notes.
    <div class="advisor" onClick={(e) => (e.target as Element).closest("a[href]") || setOpen(!open)}>
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
              {key !== null ? <span class="advisor-key">{key}</span> : <Markdown class={`md advisor-text${open ? "" : " clamp"}`} text={n.note} />}
            </div>
            {open && key === null && <div class="muted small advisor-by">{n.advisor}</div>}
            {open && key !== null && (
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

/** omp rules injected mid-turn, as quiet mono lines like Tern's (`• inject: name`, then the body's first line); tap for the whole rule. */
function RuleCard({ rules }: { rules: { name: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    // A link inside a rule opens; it doesn't fold the rules.
    <div class="rule" onClick={(e) => (e.target as Element).closest("a[href]") || setOpen(!open)}>
      {rules.map((r) => (
        <div key={r.name}>
          <div class="rule-line">
            • <span class="rule-tag">inject</span>: <span class="rule-name">{r.name}</span>
          </div>
          {r.text && (open ? <Markdown class="md rule-body" text={r.text} /> : <div class="rule-gist">{r.text.split("\n")[0].replace(/^#+\s*/, "")}</div>)}
        </div>
      ))}
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
  const submitted = useRef(false);
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
    if (submitted.current) return;
    submitted.current = true;
    setSending(true);
    const answers = askAnswers(next);
    const err = await post(`/api/blocks/${block}/answer`, { id: ask.id, answers });
    setSending(false);
    setError(err);
    if (err) submitted.current = false;
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
                  disabled={sending || sent}
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
        if (e.role === "user")
          return readOnly ? (
            // A subagent's prompts are written by the parent agent (task briefs, session updates):
            // Markdown with every stretch drawn open, as btw answers.
            <div key={n} class="msg user sub-prompt">
              <span class="user-mark">›</span>
              <div class="user-text">
                {e.images.length > 0 && <Thumbs images={e.images} />}
                <Markdown class="md" text={openText(e.text)} />
              </div>
            </div>
          ) : (
            <UserMsg key={n} entry={e} block={block} rewind={rewind} />
          );
        if (e.role === "turn")
          return (
            <div key={n} class="turn">
              {duration(e.ms)}
              {e.model && ` · ${prettyModel(e.model)}`}
              {` · ${clock(e.ts)}`}
            </div>
          );
        if (e.role === "assistant") return <Reply key={n} entry={e} />;
        if (e.role === "advisor") return <AdvisorCard key={n} notes={e.notes} />;
        if (e.role === "rule") return <RuleCard key={n} rules={e.rules} />;
        if (e.role === "recap")
          return (
            <div key={n} class="chat-recap" title={`omp's recap · ${clock(e.ts)}`}>
              <span class="chat-recap-mark">※</span>
              <Markdown class="md" text={e.text} />
            </div>
          );
        if (e.role === "tools")
          return <Tools key={n} calls={e.calls} images={e.images} todo={e.todo} latestTodo={n === latestTodo} />;
        return <AskCard key={e.id} ask={e} block={block} pending={!readOnly && n > lastTalk} />;
      })}
    </>
  );
}

