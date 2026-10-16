// Chat pieces with their own behavior: image thumbnails, todo lists, and prompts with actions.
import { useState } from "preact/hooks";
import { post, type ChatEntry, type Img, type TodoPhase } from "./api";
import { clock, todoSummary } from "./lib";

/** A short buzz confirming a tap that reached the desktop (Android; iOS ignores it). */
export function buzz(ms = 12) {
  navigator.vibrate?.(ms);
}

/** A status dot: working, blocked, idle; a shell without one. */
export function Dot({ state }: { state: string | undefined }) {
  return <span class={`dot dot-${state ?? "shell"}`} />;
}

export function Thumbs({ images }: { images: Img[] }) {
  const [open, setOpen] = useState<Img | null>(null);
  return (
    <div class="thumbs" onClick={(e) => e.stopPropagation()}>
      {images.map((i, n) => (
        <img key={n} class="thumb" src={i.src} loading="lazy" alt="" onClick={() => setOpen(i)} />
      ))}
      {open && (
        <div class="lightbox" onClick={() => setOpen(null)}>
          <img src={open.src} alt="" />
        </div>
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
}: {
  entry: Extract<ChatEntry, { role: "user" }>;
  block: string;
  rewind: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(entry.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
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
        {entry.text}
        {entry.images.length > 0 && <Thumbs images={entry.images} />}
      </span>
      <div class="user-acts" onClick={(ev) => ev.stopPropagation()}>
        <span class="muted">{clock(entry.ts)}</span>
        {entry.text && (
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {entry.id && canRewind && (
          <button type="button" onClick={rewind}>
            Rewind
          </button>
        )}
      </div>
    </div>
  );
}
