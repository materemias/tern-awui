// Chat pieces with their own behavior: image thumbnails, todo lists, and prompts with actions.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { post, type ChatEntry, type Img, type TodoPhase } from "./api";
import { clock, todoSummary } from "./lib";

/** A short buzz confirming a tap that reached the desktop (Android; iOS ignores it). */
export function buzz(ms = 12) {
  navigator.vibrate?.(ms);
}

/** Copy: puts `text` on the clipboard and says so for a moment. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button type="button" onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** A status dot: working, blocked, idle; a shell without one. */
export function Dot({ state }: { state: string | undefined }) {
  return <span class={`dot dot-${state ?? "shell"}`} />;
}

/**
 * omp's π from its welcome screen: twelve by five terminal cells (1:2), the left leg's foot shaded.
 * Inside an `.omp-play` element it finishes the foot, stomps it and wiggles on hover (style.css).
 * `plus` puts a plus before it, as on the "+ omp" buttons.
 */
export function PiMark({ plus = false }: { plus?: boolean }) {
  const x = plus ? 9 : 0;
  return (
    <svg class="omp-logo" viewBox={`0 0 ${x + 12} 10`} aria-hidden="true">
      {plus && <path d="M0 4.2h6v1.6H0ZM2.2 2h1.6v6H2.2Z" fill="currentColor" />}
      <path d={`M${x} 0h12v2H${x}ZM${x + 3} 2h2v4h-2ZM${x + 7} 2h2v8h-2Z`} fill="currentColor" />
      <path class="omp-foot" d={`M${x + 3} 6h2v2h-2Z`} fill="currentColor" opacity=".4" />
    </svg>
  );
}

/**
 * Image thumbnails. A tap opens the full-screen view on `gallery`, every image of the turn, so
 * the others are a swipe (touch) or ‹ › and the arrow keys (desktop) away. The view is a history
 * entry holding the image's src: back closes it and stays in the session, forward reopens it.
 */
export function Thumbs({ images, gallery = images }: { images: Img[]; gallery?: Img[] }) {
  // The open image by src: the chat is rebuilt on every update, so objects and positions change.
  const [open, setOpen] = useState<string | null>(null);
  const start = open === null ? -1 : gallery.findIndex((g) => g.src === open);
  const shown = useRef(false);
  shown.current = open !== null;
  const close = () => {
    setOpen(null);
    if (typeof history.state?.lightbox === "string") history.back();
  };
  useEffect(() => {
    const onPop = () => {
      const src = history.state?.lightbox;
      setOpen(typeof src === "string" && images.some((i) => i.src === src) ? src : null);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [images]);
  // The open image left the turn (the transcript was rewound or rewritten): close, not show another.
  useEffect(() => {
    if (open !== null && start < 0) close();
  }, [open, start]);
  // Gone while open: take the view's history entry back off, or the next back would do nothing.
  useEffect(
    () => () => {
      if (shown.current && typeof history.state?.lightbox === "string") history.back();
    },
    [],
  );
  const show = (i: Img) => {
    history.pushState({ lightbox: i.src }, "");
    setOpen(i.src);
  };
  return (
    <div class="thumbs" onClick={(e) => e.stopPropagation()}>
      {images.map((i, n) => (
        <img key={n} class="thumb" src={i.src} loading="lazy" alt="" onClick={() => show(i)} />
      ))}
      {start >= 0 && <Lightbox images={gallery} start={start} close={close} />}
    </div>
  );
}

/** The full-screen view: one image per page in a snapping strip; a tap on it closes. */
function Lightbox({ images, start, close }: { images: Img[]; start: number; close: () => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(start);
  // The page shown or being scrolled to, ahead of the render: a quick second key press reads it.
  const page = useRef(start);
  // Where a ‹ › or arrow-key scroll is heading: the pages it passes on the way don't count.
  const target = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = strip.current;
    if (el) el.scrollLeft = start * el.clientWidth;
  }, []);
  const move = (by: number) => {
    const n = Math.min(images.length - 1, Math.max(0, page.current + by));
    page.current = target.current = n;
    setAt(n);
    const el = strip.current;
    // `?.`: happy-dom, the test DOM, has no scrollTo.
    el?.scrollTo?.({ left: n * el.clientWidth, behavior: "smooth" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [images.length]);
  const onScroll = () => {
    const el = strip.current;
    if (!el?.clientWidth) return;
    const p = Math.round(el.scrollLeft / el.clientWidth);
    if (target.current !== null) {
      if (p !== target.current) return;
      target.current = null;
    }
    page.current = p;
    setAt(p);
  };
  // A swipe or a trackpad scroll takes over from a scroll still heading somewhere.
  const takeOver = () => void (target.current = null);
  const step = (by: number) => (e: MouseEvent) => {
    e.stopPropagation();
    move(by);
  };
  return (
    <div class="lightbox" onClick={close}>
      <div class="lightbox-strip" ref={strip} onScroll={onScroll} onPointerDown={takeOver} onWheel={takeOver}>
        {images.map((i, n) => (
          <div key={n} class="lightbox-page">
            <img src={i.src} alt="" />
          </div>
        ))}
      </div>
      {images.length > 1 && (
        <>
          <button type="button" class="lightbox-nav prev" aria-label="Previous image" disabled={at === 0} onClick={step(-1)}>
            ‹
          </button>
          <button type="button" class="lightbox-nav next" aria-label="Next image" disabled={at === images.length - 1} onClick={step(1)}>
            ›
          </button>
          <div class="lightbox-count">
            {at + 1} / {images.length}
          </div>
        </>
      )}
    </div>
  );
}

const TODO_MARK: Record<string, string> = { completed: "✓", in_progress: "▸", blocked: "!", pending: "○" };

/**
 * omp's todo list as a `todo` call left it. The newest one in the chat shows every task; older
 * ones show one progress line (tap for the list), so a long session isn't a wall of checklists.
 */
export function Todo({ phases, full }: { phases: TodoPhase[]; full: boolean }) {
  // Follows `full` (a newer list collapses this one) until the user taps it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? full;
  const { done, total, blocked, current } = todoSummary(phases);
  return (
    <div
      class="todo"
      onClick={(e) => {
        e.stopPropagation();
        setToggled(!open);
      }}
    >
      <div class="todo-head">
        <span class="todo-count">
          {done}/{total}
        </span>
        {blocked > 0 && <span class="todo-blocked">{blocked} blocked</span>}
        <span class="todo-current">{current}</span>
      </div>
      {open &&
        phases.map((p, i) => (
          <div key={i} class="todo-phase">
            {phases.length > 1 && <div class="todo-phase-name">{p.name}</div>}
            {p.tasks.map((t, j) => (
              <div key={j} class={`todo-task st-${t.status}`}>
                <span class="todo-mark">{TODO_MARK[t.status] ?? "·"}</span>
                <span>
                  {t.content}
                  {t.blocker && <span class="todo-blocker"> — {t.blocker}</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * A prompt, with omp's per-prompt actions: time, Copy, and Rewind (back to before this prompt,
 * its text returning to the composer). They show on hover, or on a tap where there's no hover.
 * `rewind`: the session's omp can rewind (its extension registers the command).
 */
export function UserMsg({
  entry,
  block,
  rewind: canRewind,
  gallery,
}: {
  entry: Extract<ChatEntry, { role: "user" }>;
  block: string;
  rewind: boolean;
  gallery?: Img[];
}) {
  const [open, setOpen] = useState(false);
  async function rewind() {
    if (!confirm("Rewind to before this prompt? Later turns leave the conversation (omp keeps them as a branch) and the prompt returns to the composer."))
      return;
    const err = await post(`/api/blocks/${block}/rewind`, { entry: entry.id });
    if (err) alert(`Rewind failed: ${err}`);
  }
  return (
    <div class={`msg user${open ? " acts-open" : ""}`} onClick={() => setOpen(!open)}>
      <span class="user-mark">›</span>
      <span class="user-text">
        {entry.images.length > 0 && <Thumbs images={entry.images} gallery={gallery} />}
        {entry.text}
      </span>
      <div class="user-acts" onClick={(ev) => ev.stopPropagation()}>
        <span class="muted">{clock(entry.ts)}</span>
        {entry.text && <CopyButton text={entry.text} />}
        {entry.id && canRewind && (
          <button type="button" onClick={rewind}>
            Rewind
          </button>
        )}
      </div>
    </div>
  );
}
