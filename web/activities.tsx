// The Activities panel: why an omp session is busy and what is left, at a glance. It shows the
// session's newest todo list, its running background jobs and the way to its subagents. On a phone
// it slides in over the session from the right; on the desktop it docks beside the transcript.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatEntry, Item, TodoPhase } from "./api";
import { Todo } from "./parts";
import { JobRow, SubagentsLink } from "./subagents";

/** Whether the desktop's panel is open, remembered on this device. */
const OPEN_KEY = "tern-awui.activities";

/** The newest todo list in a chat, or null when it has none. */
export function latestTodo(chat: ChatEntry[] | null): TodoPhase[] | null {
  if (!chat) return null;
  for (let i = chat.length - 1; i >= 0; i--) {
    const e = chat[i];
    if (e.role === "tools" && e.todo) return e.todo;
  }
  return null;
}

/**
 * Whether the panel is open, and its setter. The desktop's state is remembered on this device, so
 * it stays open from one session to the next; a phone's starts closed with every session.
 */
export function useActivitiesOpen(wide: boolean): [boolean, (open: boolean) => void] {
  const [desk, setDesk] = useState(() => localStorage.getItem(OPEN_KEY) === "on");
  const [phone, setPhone] = useState(false);
  const set = (open: boolean) => {
    if (!wide) return setPhone(open);
    localStorage.setItem(OPEN_KEY, open ? "on" : "off");
    setDesk(open);
  };
  return [wide ? desk : phone, set];
}

/** The header's toggle: a checklist, with the running jobs' count while any run. */
export function ActivitiesButton({ open, jobs, onToggle }: { open: boolean; jobs: number; onToggle: () => void }) {
  return (
    <button class={`icon-btn acts-btn${open ? " on" : ""}`} title="Activities" aria-label="Activities" aria-expanded={open} onClick={onToggle}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 5.5 4.5 7 7.5 4M3 10.5 4.5 12l3-3M10 5.5h7M10 10.5h7M10 15.5h7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="5.25" cy="15.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
      {jobs > 0 && (
        <span class="acts-count" aria-hidden="true">
          {jobs}
        </span>
      )}
    </button>
  );
}

/**
 * The panel itself. `overlay`: a phone's sheet over the session, closed by its backdrop, × or
 * Escape, and by following one of its links; otherwise the desktop's docked column.
 */
export function Activities({
  block,
  item,
  todo,
  now,
  overlay,
  onClose,
}: {
  block: string;
  item: Item | undefined;
  todo: TodoPhase[] | null;
  now: number;
  overlay: boolean;
  onClose: () => void;
}) {
  const jobs = item?.live?.jobs ?? [];
  const subagents = item?.agent?.subagents ?? 0;
  const close = useRef(onClose);
  close.current = onClose;
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!overlay) return;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);
  // A link followed from the phone's sheet leaves it closed behind; the desktop's column stays.
  const leave = overlay ? onClose : undefined;
  return (
    <>
      {overlay && <div class="acts-backdrop" onClick={onClose} />}
      <div class={`acts ${overlay ? "overlay" : "docked"}`} role={overlay ? "dialog" : "complementary"} aria-modal={overlay || undefined} aria-label="Activities">
        <div class="acts-head">
          <span class="acts-title">Activities</span>
          <button ref={closeBtn} class="icon-btn" title="Close" aria-label="Close activities" onClick={onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <div class="acts-body">
          {!todo && !jobs.length && subagents <= 0 && <div class="muted small">Nothing running and no todo list.</div>}
          {todo && (
            <section class="acts-section">
              <h3 class="acts-label">Todo</h3>
              <Todo phases={todo} full />
            </section>
          )}
          {jobs.length > 0 && (
            <section class="acts-section">
              <h3 class="acts-label">Running</h3>
              <div class="jobs">
                {jobs.map((j) => (
                  <JobRow key={j.id} block={block} job={j} now={now} onOpen={leave} />
                ))}
              </div>
            </section>
          )}
          {subagents > 0 && (
            <section class="acts-section jobs">
              <SubagentsLink block={block} count={subagents} onOpen={leave} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
