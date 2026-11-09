// The chat renderer, shared by sessions and their subagents: markdown (charts, mermaid), advisor
// notes, tool lines, ask cards and prompts.
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Mermaid } from "mermaid";
import { drawCharts } from "./charts";
import { post, type AdvisorNote, type Ask, type AskField, type ChatEntry, type Img, type TodoPhase, type ToolCall } from "./api";
import { clock, duration, langOf, parseAdvisorNote, prettyModel, tokensShort } from "./lib";
import { askFormHtml, FORM_NAME_PREFIX, renderMarkdown } from "./markdown";
import { highlightFences } from "./highlight";
import { buzz, CopyButton, Thumbs, Todo, UserMsg } from "./parts";
import {
  DEEPEN,
  isLinkable,
  lengthOf,
  linkedMarkdown,
  parse,
  stretches,
  TWINKLE_MS,
  withAnswers,
  writeOpen,
  type DeepenAnswer,
  type Segment,
  type Stretch,
} from "./stretch-core";
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

/**
 * Copy on each code block and quote under `root`. The button's label is CSS (`::after`), so a
 * quote's `innerText` doesn't carry it. A code block goes in a card that holds the button still
 * while the code scrolls sideways; mermaid and svg figures get none.
 */
function addCopyButtons(root: HTMLElement) {
  const button = () => Object.assign(document.createElement("button"), { type: "button", className: "block-copy", ariaLabel: "Copy" });
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.closest(".figure")) continue;
    const card = document.createElement("div");
    card.className = "code-card";
    pre.replaceWith(card);
    card.append(pre, button());
  }
  for (const quote of root.querySelectorAll("blockquote")) quote.prepend(button());
}

/** A tap on a block's Copy: its text goes on the clipboard, and the button says so for a moment. */
function copyBlock(e: MouseEvent): boolean {
  const button = (e.target as Element | null)?.closest?.(".block-copy");
  const block = button?.parentElement;
  if (!button || !block) return false;
  const text = block.classList.contains("code-card") ? (block.querySelector("pre")?.textContent ?? "").replace(/\n+$/, "") : block.innerText.trim();
  void navigator.clipboard.writeText(text).then(() => {
    button.classList.add("copied");
    setTimeout(() => button.classList.remove("copied"), 1200);
  });
  return true;
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
  // Each `chat` event parses a fresh `imageSources` object: compare its content, not its identity.
  const sources = imageSources && JSON.stringify(imageSources);
  const html = useMemo(() => renderMarkdown(text, imageSources), [text, sources]);
  const lang = useMemo(() => langOf(text), [text]);
  useEffect(() => {
    if (!ref.current) return;
    addCopyButtons(ref.current);
    drawCharts(ref.current);
    if (mermaid) drawMermaid(ref.current).catch(() => {});
    if (highlight) highlightFences(ref.current).catch(() => {});
  }, [html]);
  return (
    <div ref={ref} class={cls} lang={lang} onClick={(e) => copyBlock(e) || onClick?.(e)} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/**
 * Stretchtext state of the session on screen: open keys per reply block, and `off` when the omp
 * session turned stretches off (`/stretch off`). `set` opens or closes one, in the Tern pane too
 * when its omp runs stretch.ts. Without a provider (subagents) each reply keeps its own state.
 * ✦ (stretch.ts asking its model for more): `answers` are spliced into their replies, `running`
 * presses twinkle with the answer streaming in, and `press`, when the pane can take one, asks.
 */
export type StretchSync = {
  open: Record<string, string[]>;
  off: boolean;
  set(block: string, key: string, open: boolean): void;
  answers?: Record<string, DeepenAnswer[]>;
  running?: Record<string, { key: string; seconds: number; partial: string }[]>;
  press?(block: string, key: string): void;
};
export const StretchContext = createContext<StretchSync | null>(null);

/** A growth's pace: about 45 ms per added word, at most 700 ms, as in the Tern pane. */
const GROW_MS_PER_WORD = 45;
const GROW_MAX_MS = 700;
const STRETCH_HREF = /^#stretch\/(open|close|deepen)\/(\d+)$/;
const NO_ANSWERS: DeepenAnswer[] = [];
const NO_PRESSES: { key: string; seconds: number; partial: string }[] = [];

/** An assistant reply; with stretches, short forms are links that grow their long form in place. */
function Reply({ entry }: { entry: Extract<ChatEntry, { role: "assistant" }> }) {
  const sync = useContext(StretchContext);
  const answers = (entry.block && sync?.answers?.[entry.block]) || NO_ANSWERS;
  // ✦ answers the pane's model gave, each spliced in at the end of the stretch it continues.
  const source = useMemo(() => (answers.length ? withAnswers(entry.text, answers) : entry.text), [entry.text, answers]);
  const parts = useMemo(() => (source.includes("{{") ? parse(source) : null), [source]);
  const all = useMemo(() => (parts ? stretches(parts) : []), [parts]);
  // Copy takes the whole reply: every stretch drawn open, without its markup.
  const copyText = useMemo(() => (parts ? writeOpen(parts) : source), [parts, source]);
  return (
    <ReplyActs text={copyText}>
      {!parts || !all.some(isLinkable) ? (
        <Markdown class="msg assistant md" text={entry.text} imageSources={entry.imageSources} />
      ) : (
        <StretchReply entry={entry} parts={parts} all={all} />
      )}
    </ReplyActs>
  );
}

/**
 * A reply with its Copy action, over its bottom right end: on hover, or after a tap on touch
 * screens. Taps on links (stretches open there) and ones ending a text selection don't toggle it.
 */
function ReplyActs({ text, children }: { text: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest?.("a, button, img")) return;
    if (getSelection()?.toString()) return;
    setOpen(!open);
  };
  return (
    <div class={`reply${open ? " acts-open" : ""}`} onClick={onClick}>
      {children}
      {text && (
        <div class="reply-acts" onClick={(ev) => ev.stopPropagation()}>
          <CopyButton text={text} />
        </div>
      )}
    </div>
  );
}

function StretchReply({ entry, parts, all }: { entry: Extract<ChatEntry, { role: "assistant" }>; parts: Segment[]; all: Stretch[] }) {
  const sync = useContext(StretchContext);
  const shared = sync && entry.block ? { sync, block: entry.block } : null;
  const [local, setLocal] = useState<string[]>([]);
  const keys = shared ? (shared.sync.open[shared.block] ?? []) : local;
  const open = useMemo(() => new Set(keys), [keys.join("\0")]);
  const [growing, setGrowing] = useState<{ key: string; progress: number } | undefined>(undefined);

  // A stretch opened here or in the Tern pane grows in; one open on arrival is simply there. A ✦
  // answer opens without growing: its text already streamed in.
  const before = useRef(open);
  useLayoutEffect(() => {
    const opened = all.find((s) => open.has(s.key) && !before.current.has(s.key) && isLinkable(s) && s.short !== DEEPEN);
    before.current = open;
    const duration = opened === undefined ? 0 : Math.min(GROW_MAX_MS, GROW_MS_PER_WORD * lengthOf(opened.long ?? []));
    if (!opened || duration <= 0 || matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setGrowing(undefined);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setGrowing(progress < 1 ? { key: opened.key, progress } : undefined);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setGrowing({ key: opened.key, progress: 0 });
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Presses the pane is running for this reply: the ✦ twinkles locally, with seconds counted from
  // when this page first saw the press (the pane reports whole seconds).
  const presses = (shared && shared.sync.running?.[shared.block]) || NO_PRESSES;
  const started = useRef(new Map<string, number>());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    for (const key of started.current.keys()) if (!presses.some((p) => p.key === key)) started.current.delete(key);
    for (const p of presses) if (!started.current.has(p.key)) started.current.set(p.key, Date.now() - p.seconds * 1000);
    if (presses.length === 0) return;
    const timer = setInterval(() => setFrame((f) => f + 1), TWINKLE_MS);
    return () => clearInterval(timer);
  }, [presses]);
  const press = shared?.sync.press;
  const off = sync?.off === true;
  const text = useMemo(() => {
    if (off) return writeOpen(parts);
    const deepen = press && {
      progress: (key: string) => {
        const p = presses.find((r) => r.key === key);
        if (!p) return undefined;
        return { elapsedMs: Date.now() - (started.current.get(key) ?? Date.now() - p.seconds * 1000), partial: p.partial };
      },
    };
    return linkedMarkdown(parts, { href: (op, i) => `#stretch/${op}/${i}`, isOpen: (k) => open.has(k), growing, deepen });
  }, [parts, open, growing, off, press, presses, frame]);
  const onClick = (e: MouseEvent) => {
    const link = (e.target as Element | null)?.closest?.("a[href^='#stretch/']");
    if (!link) return;
    // The href is a marker, not a route: never let it reach the hash router.
    e.preventDefault();
    const [, op, i] = STRETCH_HREF.exec(link.getAttribute("href") ?? "") ?? [];
    const stretch = all[Number(i)];
    if (!op || !stretch) return;
    if (op === "deepen") {
      if (shared && press) press(shared.block, stretch.key);
    } else if (shared) shared.sync.set(shared.block, stretch.key, op === "open");
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

function Tools({
  calls,
  images,
  gallery,
  todo,
  latestTodo,
}: {
  calls: ToolCall[];
  images: Img[];
  gallery: Img[];
  todo: TodoPhase[] | null;
  latestTodo: boolean;
}) {
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
      {images.length > 0 && <Thumbs images={images} gallery={gallery} />}
      {todo && <Todo phases={todo} full={latestTodo} />}
    </div>
  );
}

/** The form's answer as the server's `answer` endpoint takes it: values by field name, Other's text apart. */
function formAnswer(form: HTMLFormElement, fields: AskField[]) {
  const data = new FormData(form);
  // No prototype: a field may be called `__proto__`.
  const values: Record<string, string | string[]> = Object.create(null);
  const other: Record<string, string> = Object.create(null);
  const typed = [...form.querySelectorAll<HTMLInputElement>("input[data-other]")];
  for (const f of fields) {
    if (!f.name) continue;
    const got = data.getAll(FORM_NAME_PREFIX + f.name).filter((v): v is string => typeof v === "string");
    if (f.kind === "choice" && f.multi) values[f.name] = got;
    else if (got.length) values[f.name] = got[0];
    const text = typed.find((i) => i.dataset.other === f.name)?.value.trim();
    if (text) other[f.name] = text;
  }
  return { values, other };
}

/** The radios or boxes of a group, by field name. */
function groupInputs(form: HTMLFormElement, name: string): HTMLInputElement[] {
  return [...form.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]")].filter((i) => i.name === FORM_NAME_PREFIX + name);
}

/**
 * An open ask: omp's HTML form with the phone's own controls, plus the "Other" text omp gives a
 * radio or checkbox group. A form that is one radio group sends on the first tap.
 */
function AskCard({ ask, block, pending }: { ask: Ask; block: string; pending: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const submitted = useRef(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = ask.answer === null && pending;
  const named = ask.fields.filter((f) => f.name);
  const lone = named.length === 1 ? named[0] : undefined;
  const instant = lone?.kind === "choice" && !lone.multi && !lone.select;
  // Rendered once per ask: Preact never diffs this node, so the injected form keeps its state.
  const formBody = useMemo(() => <div ref={body} class="ask-body" />, [ask.id]);

  useLayoutEffect(() => {
    const el = body.current;
    const form = formRef.current;
    if (!el || !form) return;
    el.replaceChildren(askFormHtml(ask.html));
    for (const f of ask.fields) {
      if (f.kind !== "choice" || f.select) continue;
      const group = groupInputs(form, f.name);
      const last = group[group.length - 1];
      if (!last) continue;
      for (const input of group) input.dataset.required = String(input.required);
      // Required boxes go group-level (see `checkGroups`).
      if (f.multi) for (const input of group) input.required = false;
      if (!f.other) continue;
      const other = document.createElement("input");
      other.className = "other-input";
      other.placeholder = "Other: type your own";
      other.dataset.other = f.name;
      other.setAttribute("aria-label", `${f.question}: other`);
      (last.closest("label") ?? last).after(other);
    }
  }, [ask.id, open]);

  if (!open) {
    return (
      <div class="ask done">
        {ask.answer === null && <div class="ask-q">{ask.question}</div>}
        <div class="ask-answer">{ask.answer ?? "not answered"}</div>
      </div>
    );
  }

  /**
   * A required box group, as in omp, needs one box or Other's text, not every box. Rechecked on
   * every input too: the browser checks validity before a submit reaches `send`.
   */
  function checkGroups(form: HTMLFormElement) {
    for (const f of ask.fields) {
      if (f.kind !== "choice" || !f.multi || f.select) continue;
      const group = groupInputs(form, f.name);
      const typed = [...form.querySelectorAll<HTMLInputElement>("input[data-other]")].some((i) => i.dataset.other === f.name && i.value.trim());
      const missing = group.some((i) => i.dataset.required === "true") && !typed && !group.some((i) => i.checked);
      group[0]?.setCustomValidity(missing ? "Pick at least one" : "");
    }
  }

  async function send() {
    const form = formRef.current;
    if (!form || submitted.current) return;
    checkGroups(form);
    if (!form.reportValidity()) return;
    submitted.current = true;
    // Read before the fieldset locks: a disabled fieldset's controls aren't in FormData.
    const answer = { id: ask.id, ...formAnswer(form, ask.fields) };
    setSending(true);
    const err = await post(`/api/blocks/${block}/answer`, answer);
    setSending(false);
    setError(err);
    if (err) submitted.current = false;
    else {
      buzz();
      setSent(true);
    }
  }

  // As in omp: Other's text answers a radio group in place of its options, and a picked radio drops
  // it. Emptying the text brings back the form's own pick, which omp still holds.
  function onInput(e: Event) {
    const form = formRef.current;
    if (form) checkGroups(form);
    const t = e.target as HTMLInputElement;
    const field = ask.fields.find((f) => f.name === t.dataset.other);
    if (!form || field?.kind !== "choice" || field.multi) return;
    const typed = t.value.trim() !== "";
    for (const input of groupInputs(form, field.name)) {
      input.checked = !typed && input.defaultChecked;
      input.required = !typed && input.dataset.required === "true";
    }
  }
  // A click, not a change: tapping the radio the model preselected must send too.
  function onClick(e: Event) {
    const form = formRef.current;
    const t = e.target as HTMLInputElement;
    if (!form || t.tagName !== "INPUT" || t.type !== "radio" || !t.checked) return;
    const name = t.name.slice(FORM_NAME_PREFIX.length);
    const other = [...form.querySelectorAll<HTMLInputElement>("input[data-other]")].find((i) => i.dataset.other === name);
    if (other?.value) {
      other.value = "";
      for (const input of groupInputs(form, name)) input.required = input.dataset.required === "true";
    }
    if (instant) void send();
  }

  return (
    <form
      ref={formRef}
      class={`ask${sent ? " sent" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onInput={onInput}
      onClick={onClick}
    >
      <fieldset class="ask-form" disabled={sending || sent}>
        {formBody}
      </fieldset>
      {error && <div class="err small">{error}</div>}
      {sent ? (
        <div class="muted small">Sent, waiting for omp…</div>
      ) : (
        <button class="primary" type="submit" disabled={sending}>
          {sending ? "Sending…" : "Send answer"}
        </button>
      )}
    </form>
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
  // Every image of a turn (a prompt and the screenshots after it), so the full-screen view pages
  // through them all. A turn's entries share one array, still filling as the walk goes on.
  const galleries = useMemo(() => {
    let turn: Img[] = [];
    return entries.map((e) => {
      if (e.role === "user") turn = [];
      if (e.role === "user" || e.role === "tools") turn.push(...e.images);
      return turn;
    });
  }, [entries]);
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
                {e.images.length > 0 && <Thumbs images={e.images} gallery={galleries[n]} />}
                <Markdown class="md" text={openText(e.text)} />
              </div>
            </div>
          ) : (
            <UserMsg key={n} entry={e} block={block} rewind={rewind} gallery={galleries[n]} />
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
        if (e.role === "cacheMiss")
          return (
            <div key={n} class="cache-miss" title={`Prompt cache rebuilt · ${clock(e.ts)}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
                <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
              </svg>
              Cache miss · {tokensShort(e.tokens)} tokens
            </div>
          );
        if (e.role === "tools")
          return <Tools key={n} calls={e.calls} images={e.images} gallery={galleries[n]} todo={e.todo} latestTodo={n === latestTodo} />;
        return <AskCard key={e.id} ask={e} block={block} pending={!readOnly && n > lastTalk} />;
      })}
    </>
  );
}

