// The session list: projects with their rows, the filter, the bell, and the new-omp sheet.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { launchAgent, post, type Closed, type Item } from "./api";
import { keepsTool, matchesWords, parseSearch } from "../lib/search";
import { age, folderLabel, isOld, jobsSummary, launchTarget, listProjects, onList, parseStoredList, pickedTernSession, rowText, storedTernSession, TERN_SESSION_KEY, toggled } from "./lib";
import { buzz, Dot, PiMark } from "./parts";
import { ExtensionBanner } from "./extension";
import { goBack, useExitGuard, useNow, useStream } from "./hooks";
import { PUSH_LABEL, permissionHelp, type PushState } from "./push";
import { WaitingIcon, WaitingPopup, WaitingStrip } from "./waiting";

/** The row's icon: the title's Nerd Font glyph, else Tern's π fallback for an omp not yet titled. */
function iconOf(item: Item): { glyph: string; pi: boolean } | null {
  if (item.icon) return { glyph: item.icon, pi: false };
  return item.agent || item.live ? { glyph: "π", pi: true } : null;
}

export function Title({ item }: { item: Item }) {
  return <TitleRow icon={iconOf(item)} tag={item.tag} title={item.title} />;
}

/** A row's icon: a glyph from the symbols font; `pi` marks omp's π, `cls` adds a class (an agent's colour). */
type Icon = { glyph: string; pi: boolean; cls?: string };

function TitleRow({ icon, tag, title }: { icon: Icon | null; tag: string | null; title: string }) {
  return (
    <div class="row-title">
      {icon && <span class={`nf${icon.pi ? " pi" : ""}${icon.cls ? ` ${icon.cls}` : ""}`}>{icon.glyph}</span>}
      {tag && <span class="tag">{tag}</span>}
      <span class="title">{title}</span>
    </div>
  );
}

/** How long a finger rests on a row before its peek opens, how far it may drift meanwhile, and how long a mouse hovers. */
const PRESS_MS = 450;
const PRESS_SLOP = 8;
const HOVER_MS = 600;

/**
 * A row's peek gesture: a long press (touch) or a resting mouse calls `show`; leaving with the
 * mouse calls `hide`. A long press swallows the tap that ends it and the browser's link menu.
 */
function usePeekGesture(show: (el: HTMLElement) => void, hide: () => void) {
  const g = useRef({ timer: 0, x: 0, y: 0, touch: false, fired: false });
  const clear = () => clearTimeout(g.current.timer);
  const handlers = {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType === "mouse") return;
      const el = e.currentTarget as HTMLElement;
      clear();
      g.current = { x: e.clientX, y: e.clientY, touch: true, fired: false, timer: 0 };
      g.current.timer = window.setTimeout(() => {
        g.current.fired = true;
        buzz();
        show(el);
      }, PRESS_MS);
    },
    onPointerMove(e: PointerEvent) {
      if (g.current.touch && Math.hypot(e.clientX - g.current.x, e.clientY - g.current.y) > PRESS_SLOP) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerEnter(e: PointerEvent) {
      if (e.pointerType !== "mouse") return;
      const el = e.currentTarget as HTMLElement;
      g.current.touch = false;
      clear();
      g.current.timer = window.setTimeout(() => show(el), HOVER_MS);
    },
    onPointerLeave(e: PointerEvent) {
      if (e.pointerType !== "mouse") return;
      clear();
      hide();
    },
    onContextMenu(e: Event) {
      if (g.current.touch) e.preventDefault();
    },
  };
  /** True once when the click ending a long press arrives: it must not open the row. */
  function swallow(): boolean {
    const fired = g.current.fired;
    g.current.fired = false;
    return fired;
  }
  return { handlers, swallow };
}

/** A row's peek: the session and the row's box, which it opens beside. */
export type PeekAt = { item: Item; top: number; bottom: number; left: number; width: number };

/**
 * A session row. Its second line shows only while it works or asks something; `onPeek` gets the
 * rest on a long press or hover (null: close).
 */
function Row({ item, now, selected, onPeek }: { item: Item; now: number; selected?: boolean; onPeek?: (at: PeekAt | null) => void }) {
  const state = item.status ?? undefined;
  const { status, stale } = rowText(item, now);
  const { handlers, swallow } = usePeekGesture(
    (el) => {
      const r = el.getBoundingClientRect();
      onPeek?.({ item, top: r.top, bottom: r.bottom, left: r.left, width: r.width });
    },
    () => onPeek?.(null),
  );
  return (
    <a
      class={`row st-${state ?? "shell"}${item.doc ? " doc-row" : ""}${stale ? " stale" : ""}${item.unseen ? ` unseen-${item.unseen}` : ""}${selected ? " selected" : ""}`}
      href={`#/b/${item.block}`}
      {...(onPeek ? handlers : {})}
      onClick={(e) => {
        if (onPeek && swallow()) return e.preventDefault();
        onPeek?.(null);
      }}
    >
      <Dot state={state} />
      <div class="row-main">
        <Title item={item} />
        {status && <div class={`row-sub row-status st-${state}`}>{status}</div>}
        {item.live?.jobs.length ? <div class="row-jobs">{jobsSummary(item.live.jobs)}</div> : null}
      </div>
      {/* Like Tern's tab icon: an unseen update colors the row's icon; rows without one get a dot. */}
      {item.unseen && !iconOf(item) && <span class={`new-dot new-${item.unseen}`} title="New since you last looked" />}
      {item.live?.mismatch && (
        <span class="ext-mark" title={`Runs ${item.live.mismatch === "newer" ? "a newer" : "an older"} tern-mobile extension: open it for the fix`}>
          !
        </span>
      )}
      {/* On the list a parked pane shows only while it needs you (onList): say why it is out of Tern's tabs. */}
      {item.parked && (
        <span class="parked-mark" title="Parked in Tern: open it to unpark">
          P
        </span>
      )}
      <span class={`age${state === "working" ? " age-hot" : state === "blocked" ? " age-blocked" : ""}`}>
        {item.status ? age(item.since, now) : ""}
      </span>
    </a>
  );
}

/** What a rail button shows: the title's own icon, else the block's tag, else the title's first two letters (π alone can't tell omps apart). */
export function railGlyph(item: Item): { text: string; nf: boolean } {
  if (item.icon) return { text: item.icon, nf: true };
  if (item.tag) return { text: item.tag.slice(0, 3), nf: false };
  const letters = item.title.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  const text = letters.length > 1 ? letters[0][0] + letters[1][0] : (letters[0] ?? "?").slice(0, 2);
  return { text: text.toUpperCase(), nf: false };
}

/** A session on the minimized sidebar: its glyph in a ring colored by status, the unseen dot, and the row's text as the tooltip. */
function RailItem({ item, now, selected }: { item: Item; now: number; selected: boolean }) {
  const state = item.status ?? undefined;
  const { status, peek, stale } = rowText(item, now);
  const glyph = railGlyph(item);
  return (
    <a
      class={`rail-item st-${state ?? "shell"}${stale ? " stale" : ""}${item.unseen ? ` unseen-${item.unseen}` : ""}${selected ? " selected" : ""}`}
      href={`#/b/${item.block}`}
      title={[item.title, status, peek].filter(Boolean).join("\n")}
      aria-label={item.title}
    >
      <span class={`rail-glyph${glyph.nf ? " nf" : ""}`}>{glyph.text}</span>
      {item.unseen && <span class={`new-dot new-${item.unseen}`} />}
    </a>
  );
}

/**
 * The desktop sidebar's minimize/expand button. Minimize is the word "tern" that folds into « on
 * hover; Expand, on the rail, is » that unfolds into "tern": the same animation played backwards.
 */
function BrandToggle({ expand = false, onClick }: { expand?: boolean; onClick?: () => void }) {
  const label = expand ? "Expand the session list" : "Minimize the session list";
  return (
    <button class={`brand brand-toggle${expand ? " expand" : ""}`} onClick={onClick} aria-label={label} title={`${label} (Ctrl+\\)`}>
      <span class="brand-text" aria-hidden="true">
        {[..."tern"].map((c, i) => (
          <span key={i} style={`--i:${i}`}>
            {c}
          </span>
        ))}
      </span>
      <svg class="brand-arrow" viewBox="0 0 20 20" aria-hidden="true">
        {expand ? (
          <>
            <path d="M4.5 5.5 9 10l-4.5 4.5" />
            <path d="M9.5 5.5 14 10l-4.5 4.5" />
          </>
        ) : (
          <>
            <path d="M10.5 5.5 6 10l4.5 4.5" />
            <path d="M15.5 5.5 11 10l4.5 4.5" />
          </>
        )}
      </svg>
    </button>
  );
}

function PushButton({ push: [push, togglePush] }: { push: [PushState, () => void] }) {
  if (push === "unsupported") return null;
  return (
    <button
      class={`icon-btn push-${push}${push === "on" ? " on" : ""}`}
      disabled={push === "pending"}
      onClick={() => (push === "denied" ? alert(permissionHelp("denied")) : togglePush())}
      aria-label={PUSH_LABEL[push]}
      title={PUSH_LABEL[push]}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13L5 13.5ZM8.5 17a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        {(push === "off" || push === "denied" || push === "stopped") && <path d="M3.5 3.5 16.5 16.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />}
        {push === "on" && <circle cx="15" cy="5" r="2.6" fill="var(--working)" stroke="none" />}
      </svg>
    </button>
  );
}

/**
 * What a row keeps out of the list, beside it: omp's recap or the last prompt (a file's folder, a
 * shell's cwd), then where it runs. Any touch elsewhere, a scroll or Escape closes it.
 */
function Peek({ at, now, onClose }: { at: PeekAt; now: number; onClose: () => void }) {
  const { item } = at;
  const { peek } = rowText(item, now);
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // The finger that opened it lifts after this: only a new touch closes.
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const where = [item.project, item.branch, item.live?.model].filter(Boolean).join(" · ");
  // Below the row, unless the screen's lower part has no room: then above it.
  const below = at.bottom < window.innerHeight * 0.6;
  const style = {
    left: `${at.left + 12}px`,
    width: `${Math.min(at.width - 24, 420)}px`,
    ...(below ? { top: `${at.bottom - 4}px` } : { bottom: `${window.innerHeight - at.top - 4}px` }),
  };
  return (
    <div class={`peek ${below ? "below" : "above"}`} style={style} role="tooltip">
      <p class={item.agent?.recap && item.status === "idle" ? "peek-recap" : ""}>{peek}</p>
      {where && <div class="peek-where">{where}</div>}
    </div>
  );
}

const SHEET_TAB_KEY = "tern-mobile:new-sheet-tab";
type SheetTab = "folder" | "parked" | "closed";
/** Typing pauses this long before the Closed tab asks the server to search. */
const SEARCH_DELAY_MS = 300;
/** Claude Code and Codex rows: the tool's name, its mark and colour. */
const OTHER_AGENTS: Record<Exclude<Closed["agent"], "omp">, { name: string; icon: Icon }> = {
  claude: { name: "Claude Code", icon: { glyph: "✳", pi: false, cls: "agent-claude" } },
  codex: { name: "Codex", icon: { glyph: "›_", pi: false, cls: "agent-codex" } },
};

/**
 * A pane in the sheet's Parked tab: its project first (titles alone don't tell sessions apart), the
 * title, how long it has sat there, and what it was last told or did. A tap runs `onPick`; `onDrop`
 * adds a close button.
 */
function ParkedRow({ item, now, onPick, onDrop }: { item: Item; now: number; onPick: (item: Item) => void; onDrop?: (item: Item) => void }) {
  const icon = iconOf(item);
  const { status, peek } = rowText(item, now);
  const state = item.status ?? undefined;
  return (
    <div class={`closed-row parked-row st-${state ?? "shell"}`}>
      <button class="closed-main" onClick={() => onPick(item)} title={onDrop ? "Open it here" : "Bring it back into a tab of its own and open it"}>
        <span class="prow-top">
          <Dot state={state} />
          <span class="wname">
            <span class="wname-project">{item.project}</span>
            {icon && <span class={`nf${icon.pi ? " pi" : ""}`}>{icon.glyph}</span>}
            {item.tag && <span class="tag">{item.tag}</span>}
            <span class="wname-title">{item.title}</span>
          </span>
          <span class="age">{item.status ? age(item.since, now) : ""}</span>
        </span>
        {/* A pane without an omp transcript says only where it runs: home as ~, as a shell prompt does. */}
        <span class="row-sub prow-sub">{status || peek.replace(/^(\/home|\/Users)\/[^/\\]+(?=$|\/)/, "~")}</span>
      </button>
      {onDrop && (
        <button class="icon-btn closed-dismiss" aria-label="Close" title="Close it: ends its program" onClick={() => onDrop(item)}>
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The new-omp sheet. Folder: where a new omp can open (open blocks and past omp sessions, newest
 * first). Parked: panes parked in Tern, which a tap unparks into a tab of their own, then those left
 * from a Tern session that has closed (`stranded`), which Tern can't bring back: a tap opens one
 * here, × closes it. Closed: omp sessions no pane runs now, which a tap resumes in a new tab. All
 * filter as you type; Closed also asks the server, which searches every omp session and Claude
 * Code's and Codex's too. The tab last used is remembered on this device.
 */
function NewSheet({
  open,
  parked,
  stranded,
  now,
  onPick,
  onUnpark,
  onResume,
  onClose,
}: {
  open: Set<string>;
  parked: Item[];
  stranded: Item[];
  now: number;
  onPick: (dir: string) => void;
  onUnpark: (item: Item) => void;
  onResume: (s: Closed) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SheetTab>(() => {
    const stored = localStorage.getItem(SHEET_TAB_KEY);
    return stored === "closed" || stored === "parked" ? stored : "folder";
  });
  const [projects, setProjects] = useState<string[] | null>(null);
  const [closed, setClosed] = useState<Closed[] | null>(null);
  const [closedError, setClosedError] = useState("");
  /** The server's answer to the last search, with the words it was for. */
  const [found, setFound] = useState<{ q: string; sessions: Closed[] | null; error?: string } | null>(null);
  const [home, setHome] = useState("");
  const [q, setQ] = useState("");
  const query = q.trim();
  // Each list is fetched when its tab first shows: the sheet opens on the tab used last.
  useEffect(() => {
    if (tab !== "folder" || projects) return;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d: { projects?: string[]; home?: string }) => {
        setProjects(d.projects ?? []);
        setHome(d.home ?? "");
      })
      .catch(() => setProjects([]));
  }, [tab, projects]);
  useEffect(() => {
    if (tab !== "closed" || closed || closedError) return;
    fetch("/api/closed")
      .then(async (r) => {
        const d: { sessions?: Closed[]; home?: string; error?: string } = await r.json().catch(() => ({}));
        if (!r.ok || !d.sessions) throw new Error(d.error ?? `HTTP ${r.status}`);
        setClosed(d.sessions);
        setHome(d.home ?? "");
      })
      .catch((err: unknown) => setClosedError(err instanceof Error ? err.message : String(err)));
  }, [tab, closed, closedError]);
  useEffect(() => {
    if (tab !== "closed" || !query) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/closed?q=${encodeURIComponent(query)}`, { signal: abort.signal })
        .then(async (r) => {
          const d: { sessions?: Closed[]; home?: string; error?: string } = await r.json().catch(() => ({}));
          if (!r.ok || !d.sessions) throw new Error(d.error ?? `HTTP ${r.status}`);
          setFound({ q: query, sessions: d.sessions });
          setHome(d.home ?? "");
        })
        .catch((err: unknown) => {
          if (!abort.signal.aborted) setFound({ q: query, sessions: null, error: err instanceof Error ? err.message : String(err) });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [tab, query]);
  function show(next: SheetTab) {
    localStorage.setItem(SHEET_TAB_KEY, next);
    setTab(next);
    // Tapping Closed after a failed load tries again.
    setClosedError("");
  }
  async function dismiss(s: Closed) {
    const other = (c: Closed) => c.agent !== s.agent || c.id !== s.id;
    // A row found by a search may be past the loaded list: it goes back only where it was.
    const inClosed = !!closed?.some((c) => !other(c));
    const inFound = !!found?.sessions?.some((c) => !other(c));
    setClosed((list) => list?.filter(other) ?? null);
    setFound((f) => f && { ...f, sessions: f.sessions?.filter(other) ?? null });
    const err = await post("/api/closed/dismiss", { id: s.id });
    if (!err) return;
    // Not recorded: the row comes back where it was.
    const back = (list: Closed[] | null) => list && [...list, s].sort((a, b) => b.at - a.at);
    if (inClosed) setClosed(back);
    if (inFound) setFound((f) => f && { ...f, sessions: back(f.sessions) });
    alert(err);
  }
  const shownProjects = (projects ?? []).filter((p) => matchesWords(q, p));
  const parkedText = (i: Item) => `${i.project} ${i.tag ?? ""} ${i.title} ${i.agent?.lastPrompt ?? ""} ${i.cwd}`;
  const newest = (a: Item, b: Item) => b.since - a.since;
  const shownParked = parked.filter((i) => matchesWords(q, parkedText(i))).sort(newest);
  const shownStranded = stranded.filter((i) => matchesWords(q, parkedText(i))).sort(newest);
  async function drop(i: Item) {
    if (!confirm(`Close “${i.title}”?\n\nIts program ends. Tern can't bring it back into a tab, as its Tern session has closed.`)) return;
    const err = await post(`/api/blocks/${i.block}/close`, {});
    if (err) alert(`Close failed: ${err}`);
  }
  // Until the server answers, the loaded rows (all omp's) filter as you type, tool names as the server reads them.
  const searched = query && found?.q === query ? found : null;
  const local = parseSearch(q);
  const shownClosed =
    searched?.sessions ??
    (keepsTool(local.tools, "omp") ? (closed ?? []).filter((s) => matchesWords(local.rest, `${s.tag ?? ""} ${s.title} ${s.prompt} ${s.recap} ${s.cwd}`)) : []);
  const list = tab === "folder" ? projects : closed;
  const count =
    tab === "folder" ? (projects ? `${shownProjects.length} projects` : "loading")
    : tab === "parked" ? `${shownParked.length} parked`
    : query ? (searched ? (searched.error ? "search failed" : `${shownClosed.length} found`) : "searching")
    : closed ? `${shownClosed.length} closed`
    : closedError ? ""
    : "loading";
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet tall new-sheet" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <div class="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "folder"} class={tab === "folder" ? "on" : ""} onClick={() => show("folder")}>
              New
            </button>
            <button type="button" role="tab" aria-selected={tab === "parked"} class={tab === "parked" ? "on" : ""} onClick={() => show("parked")}>
              Parked
            </button>
            <button type="button" role="tab" aria-selected={tab === "closed"} class={tab === "closed" ? "on" : ""} onClick={() => show("closed")}>
              Closed
            </button>
          </div>
          <span class="muted small">{count}</span>
        </div>
        <input
          class="sheet-filter"
          type="search"
          autoFocus
          placeholder={tab === "folder" ? "Filter projects" : tab === "parked" ? "Filter parked panes" : "Search sessions, Claude Code and Codex too"}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <div class="sheet-list">
          {tab === "folder" &&
            shownProjects.map((p) => {
              const { name, parent } = folderLabel(p, home);
              return (
                <button key={p} class="sheet-row" onClick={() => onPick(p)}>
                  <span class="role">{name}</span>
                  <span class="muted small">
                    {open.has(p) && <span class="c-working">open · </span>}
                    {parent}
                  </span>
                </button>
              );
            })}
          {tab === "parked" && shownParked.map((i) => <ParkedRow key={i.block} item={i} now={now} onPick={onUnpark} />)}
          {tab === "parked" && shownStranded.length > 0 && (
            <>
              <h4 class="sheet-sec">From a closed Tern session</h4>
              <p class="sheet-sec-note">Tern can't bring these back into a tab. Open one to read it here, or close it.</p>
              {shownStranded.map((i) => (
                <ParkedRow key={i.block} item={i} now={now} onPick={() => (location.hash = `#/b/${i.block}`)} onDrop={(x) => void drop(x)} />
              ))}
            </>
          )}
          {tab === "parked" && parked.length + stranded.length === 0 && <div class="empty">Nothing is parked. Park a pane from its top bar.</div>}
          {tab === "closed" &&
            shownClosed.map((s) => {
              const other = s.agent === "omp" ? null : OTHER_AGENTS[s.agent];
              // Untitled sessions go by their last prompt; omp's π stands in for a missing icon.
              const icon = other?.icon ?? (s.icon ? { glyph: s.icon, pi: false } : { glyph: "π", pi: true });
              return (
                <div key={`${s.agent}:${s.id}`} class="closed-row parked-row">
                  <button class="closed-main" onClick={() => onResume(s)} title={`Resume${other ? ` in ${other.name}` : ""} in a new tab in ${s.cwd}`}>
                    {/* Project first, as in the Parked tab and the Waiting popup; the tool shows by its icon. */}
                    <span class="prow-top">
                      <span class="wname">
                        <span class="wname-project">{folderLabel(s.cwd, home).name}</span>
                        <span class={`nf${icon.pi ? " pi" : ""}${icon.cls ? ` ${icon.cls}` : ""}`} title={other?.name}>
                          {icon.glyph}
                        </span>
                        {s.tag && <span class="tag">{s.tag}</span>}
                        <span class="wname-title">{s.title || s.prompt || "Untitled session"}</span>
                      </span>
                      <span class="age">{age(s.at, now)}</span>
                    </span>
                    {(s.recap || (s.title && s.prompt)) && <span class={`row-sub closed-sub${s.recap ? " recap" : ""}`}>{s.recap || s.prompt}</span>}
                  </button>
                  <button class="icon-btn closed-dismiss" aria-label="Dismiss" title="Dismiss: hide it from this list" onClick={() => void dismiss(s)}>
                    ×
                  </button>
                </div>
              );
            })}
          {tab === "closed" && !query && list?.length === 0 && <div class="empty">No closed sessions.</div>}
          {tab === "closed" && searched?.sessions?.length === 0 && <div class="empty">No session matches.</div>}
          {tab === "closed" && searched?.error && <div class="empty">Couldn't search ({searched.error}).</div>}
          {tab === "closed" && closedError && <div class="empty">Couldn't load closed sessions ({closedError}). Tap Closed to try again.</div>}
        </div>
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "tern-mobile:collapsed-projects";
const HIDE_OLD_KEY = "tern-mobile:hide-old";

/** Whether this device's list hides sessions older than a day. */
export const storedHideOld = () => localStorage.getItem(HIDE_OLD_KEY) === "on";
/** The projects this device's list keeps folded. */
export const storedCollapsed = () => new Set(parseStoredList(localStorage.getItem(COLLAPSED_KEY)));

/**
 * The session list. `wide`: shown beside the open session, which `selected` marks. `rail`: minimized
 * to a column of session icons; `onRail` toggles that (desktop only). `waitingOpen`: the Waiting
 * popup shows over it (`#/waiting`).
 */
export function Home({
  push,
  wide = false,
  selected = null,
  rail = false,
  onRail,
  waitingOpen = false,
  waitingCard = null,
}: {
  /** The bell's state and toggle, owned by the app so recovery runs on every screen. */
  push: [PushState, () => void];
  wide?: boolean;
  selected?: string | null;
  rail?: boolean;
  onRail?: () => void;
  waitingOpen?: boolean;
  /** The Waiting popup's open session (its row id); null on its list. */
  waitingCard?: string | null;
}) {
  const { state, waiting, online } = useStream(null, "chat");
  const [q, setQ] = useState("");
  // The Tern session chips scroll sideways when they don't fit: a faded edge says more are there,
  // and the picked one is scrolled into view.
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipEdges, setChipEdges] = useState("");
  const chipCount = state?.ternSessions.length ?? 0;
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    el.querySelector(".tern-session.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const check = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setChipEdges(`${left ? " more-left" : ""}${right ? " more-right" : ""}`);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const resize = new ResizeObserver(check);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      resize.disconnect();
    };
  }, [chipCount, rail]);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(15_000);
  // The row whose peek is open (a long press or hover); null while none is.
  const [peek, setPeek] = useState<PeekAt | null>(null);
  const closePeek = useCallback(() => setPeek(null), []);
  // The rail has no filter field, so a filter typed before minimizing doesn't hide its sessions.
  const needle = rail ? "" : q.trim().toLowerCase();
  // Hiding sessions untouched for a day, remembered on this device. Working, waiting, unseen and
  // open sessions always stay; so do blocks without a time (shells, notes) and filter matches.
  const [hideOld, setHideOld] = useState(storedHideOld);
  function toggleOld() {
    localStorage.setItem(HIDE_OLD_KEY, hideOld ? "off" : "on");
    setHideOld(!hideOld);
  }
  const items = state ? state.projects.flatMap((p) => p.items) : [];
  const oldCount = items.filter((i) => onList(i) && isOld(i, now, selected)).length;
  // Sessions whose omp runs another extension build than the server's (rows marked with !).
  const outdated = items.filter((i) => onList(i) && i.live?.mismatch).length;
  // The Tern session the chips picked, remembered on this device; All (null) once Tern closes it.
  // The rail has no chips, so it lists every session.
  const [storedSession, setStoredSession] = useState(storedTernSession);
  const ternSessions = state?.ternSessions ?? [];
  const ternSession = rail ? null : pickedTernSession(ternSessions, storedSession);
  function pickSession(name: string | null) {
    if (name) localStorage.setItem(TERN_SESSION_KEY, name);
    else localStorage.removeItem(TERN_SESSION_KEY);
    setStoredSession(name);
  }
  // Launches read the stored pick (launchTarget), so a closed session is forgotten, not just hidden.
  // An empty list (Tern unreadable) proves nothing.
  const sessionGone = storedSession !== null && ternSessions.length > 0 && !ternSessions.some((s) => s.name === storedSession);
  useEffect(() => {
    if (sessionGone) pickSession(null);
  }, [sessionGone]);
  const projects = useMemo(
    () => (state ? listProjects(state.projects, needle, hideOld, now, selected, ternSession) : []),
    [state, needle, hideOld, now, selected, ternSession],
  );

  const [picker, setPicker] = useState(false);
  // Collapsed projects, remembered on this device.
  const [collapsed, setCollapsed] = useState<Set<string>>(storedCollapsed);
  function toggleProject(name: string) {
    setCollapsed((prev) => {
      const next = toggled(prev, name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }
  // Only the phone's single-pane list guards against leaving on back.
  const exitHint = useExitGuard(!wide);

  /** Starts or resumes an omp and opens it; `key` marks what is busy meanwhile. */
  async function launch(url: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    await launchAgent(url, body);
    setBusy(null);
  }

  const sheet = picker && (
    <NewSheet
      open={new Set(items.map((i) => i.cwd))}
      parked={items.filter((i) => i.parked && !i.stranded)}
      stranded={items.filter((i) => i.stranded)}
      now={now}
      onClose={() => setPicker(false)}
      onPick={(dir) => {
        setPicker(false);
        void launch("/api/new", { cwd: dir }, dir);
      }}
      onUnpark={async (i) => {
        setPicker(false);
        const from = location.hash;
        const err = await post(`/api/blocks/${i.block}/unpark`, launchTarget());
        if (err) alert(`Unpark failed: ${err}`);
        // A slow Tern: opening something else meanwhile wins over this jump.
        else if (location.hash === from) location.hash = `#/b/${i.block}`;
      }}
      onResume={(s) => {
        setPicker(false);
        void launch("/api/closed/resume", { id: s.id, agent: s.agent }, s.id);
      }}
    />
  );
  // Every block, whatever the list filters: a card opens the session running it.
  const waitingPopup = waitingOpen && (
    <WaitingPopup waiting={waiting} card={waitingCard} items={state ? state.projects.flatMap((p) => p.items) : []} onClose={() => goBack({ view: "waiting" })} />
  );

  if (rail) {
    const blocked = state?.counts.blocked ?? 0;
    return (
      <div class="screen side-rail">
        <header class="rail-head">
          <BrandToggle expand onClick={onRail} />
          <span class={`net ${online ? "on" : "off"}`} title={online ? "Connected" : "Offline"} />
          {blocked > 0 && <span class="c-blocked small" title={`${blocked} blocked`}>{blocked}</span>}
          <WaitingIcon waiting={waiting} />
          <PushButton push={push} />
        </header>
        <nav class="list rail-list">
          {projects.map((p) => {
            const shut = collapsed.has(p.name);
            const hot = p.items.filter((i) => i.status === "working" || i.status === "blocked").length;
            return (
              <section key={p.name} class="rail-group">
                <button class="rail-project" onClick={() => toggleProject(p.name)} title={`${p.name} · ${p.items.length}${shut ? " (collapsed)" : ""}`}>
                  {p.name.slice(0, 4)}
                  {shut && hot > 0 && <span class="group-hot">{hot}</span>}
                </button>
                {!shut && p.items.map((i) => <RailItem key={i.block} item={i} now={now} selected={i.block === selected} />)}
              </section>
            );
          })}
        </nav>
        <button class="ghost rail-new" onClick={() => setPicker(true)} aria-label="New omp in a project" title="New omp in a project">
          +
        </button>
        {sheet}
        {waitingPopup}
      </div>
    );
  }

  return (
    <div class="screen">
      <header class="bar list-bar">
        {/* On the desktop the brand is the minimize button: on hover its letters fold away to the left and « slides in, in the same box. */}
        {onRail ? (
          <BrandToggle onClick={onRail} />
        ) : (
          <span class="brand">tern</span>
        )}
        <span class={`net ${online ? "on" : "off"}`} />
        <span class="spacer" />
        {state && (
          <span class="counts">
            {outdated > 0 && (
              <span
                class="ext-chip"
                title={`${outdated === 1 ? "1 session runs" : `${outdated} sessions run`} another tern-mobile extension than the server (marked !)`}
              >
                <b>!</b>
                {outdated}
              </span>
            )}
            {/* A status dot (as on the rows) and a number; the word shows on hover (and is the accessible name). */}
            {(
              [
                ["blocked", "c-blocked", state.counts.blocked ?? 0],
                ["working", "c-working", state.counts.working ?? 0],
                ["idle", "muted", state.counts.idle ?? 0],
              ] as const
            )
              .filter(([status, , n]) => status !== "blocked" || n > 0)
              .map(([status, cls, n]) => (
                <span key={status} class={`count ${cls}`} title={`${n} ${status}`} aria-label={`${n} ${status}`}>
                  <Dot state={status} />
                  {n}
                </span>
              ))}
          </span>
        )}
        <PushButton push={push} />
        <button
          class={`icon-btn hide-old${hideOld ? " on" : ""}`}
          onClick={toggleOld}
          aria-label={hideOld ? `Show ${oldCount} sessions older than a day` : "Hide sessions older than a day"}
          title={hideOld ? `Show ${oldCount} sessions older than a day` : "Hide sessions older than a day"}
        >
          {/* An open eye; while hiding, the button is lit and the hidden count sits beside it. */}
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
          {hideOld && oldCount > 0 && <span class="hidden-count">{oldCount}</span>}
        </button>
        <button class="new-omp omp-play" onClick={() => setPicker(true)} aria-label="New omp in a project" title="New omp in a project">
          <PiMark plus />
        </button>
      </header>
      <div class="search">
        <input
          type="search"
          placeholder="Filter by title, prompt or project"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </div>
      {/* The Tern session chips (only with more than one session) and the Waiting pill share a row. */}
      {ternSessions.length > 1 ? (
        <div class="list-tools">
          <div class={`tern-sessions${chipEdges}`} ref={chipsRef} role="group" aria-label="Tern session">
            {[{ id: "", name: "All", shown: false }, ...ternSessions].map((s) => {
              const value = s.id ? s.name : null;
              return (
                <button
                  key={s.id}
                  class={`tern-session${ternSession === value ? " on" : ""}${s.shown ? " shown" : ""}`}
                  aria-pressed={ternSession === value}
                  title={s.shown ? `${s.name}, shown on the desktop` : s.name}
                  onClick={() => pickSession(value)}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
          <WaitingStrip waiting={waiting} compact />
        </div>
      ) : (
        <WaitingStrip waiting={waiting} />
      )}
      <main class="list">
        {!state && <div class="empty">Connecting…</div>}
        {state && <ExtensionBanner install={state.extension} />}
        {projects.map((p) => {
          // A filter shows its matches even in collapsed projects.
          const shut = collapsed.has(p.name) && !needle;
          const hot = p.items.filter((i) => i.status === "working" || i.status === "blocked").length;
          return (
            <section key={p.name} class={shut ? "shut" : ""}>
              <h2 class="group-head" onClick={() => toggleProject(p.name)}>
                <span class="chev">{shut ? "▸" : "▾"}</span>
                <span>{p.name}</span>
                <span class="muted">{p.items.length}</span>
                {shut && hot > 0 && <span class="group-hot">{hot} active</span>}
                <span class="spacer" />
                <button
                  class="new-omp omp-play"
                  aria-label={`New omp in ${p.name}`}
                  title={`New omp in ${p.name}`}
                  disabled={busy === p.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    void launch("/api/new", { cwd: p.items[0].cwd }, p.name);
                  }}
                >
                  <PiMark plus />
                </button>
              </h2>
              {!shut &&
                p.items.map((i) => <Row key={i.block} item={i} now={now} selected={i.block === selected} onPeek={setPeek} />)}
            </section>
          );
        })}
      </main>
      {peek && <Peek at={peek} now={now} onClose={closePeek} />}
      {sheet}
      {waitingPopup}
      {exitHint && <div class="toast">Press back again to exit</div>}
    </div>
  );
}
