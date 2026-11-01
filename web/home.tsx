// The session list: projects with their rows, the filter, the bell, and the new-omp sheet.
import { useEffect, useMemo, useState } from "preact/hooks";
import { post, postJson, type Closed, type Item } from "./api";
import { keepsTool, matchesWords, parseSearch } from "../lib/search";
import { age, folderLabel, isOld, jobsSummary, listProjects, parseStoredList, rowText, toggled } from "./lib";
import { Dot, PiMark } from "./parts";
import { ExtensionBanner } from "./extension";
import { useExitGuard, useNow, useStream } from "./hooks";
import { PUSH_LABEL, permissionHelp, type PushState } from "./push";

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

function Row({ item, now, selected }: { item: Item; now: number; selected?: boolean }) {
  const state = item.status ?? undefined;
  const { sub, recap, stale } = rowText(item, now);
  return (
    <a
      class={`row st-${state ?? "shell"}${item.doc ? " doc-row" : ""}${stale ? " stale" : ""}${item.unseen ? ` unseen-${item.unseen}` : ""}${selected ? " selected" : ""}`}
      href={`#/b/${item.block}`}
    >
      <Dot state={state} />
      <div class="row-main">
        <Title item={item} />
        <div class={`row-sub${recap ? " recap" : ""}`}>{sub}</div>
        {item.live?.jobs.length ? <div class="row-jobs">{jobsSummary(item.live.jobs)}</div> : null}
      </div>
      {/* Like Tern's tab icon: an unseen update colors the row's icon; rows without one get a dot. */}
      {item.unseen && !iconOf(item) && <span class={`new-dot new-${item.unseen}`} title="New since you last looked" />}
      {item.live?.mismatch && (
        <span class="ext-mark" title={`Runs ${item.live.mismatch === "newer" ? "a newer" : "an older"} tern-mobile extension: open it for the fix`}>
          !
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
  const { sub, stale } = rowText(item, now);
  const glyph = railGlyph(item);
  return (
    <a
      class={`rail-item st-${state ?? "shell"}${stale ? " stale" : ""}${item.unseen ? ` unseen-${item.unseen}` : ""}${selected ? " selected" : ""}`}
      href={`#/b/${item.block}`}
      title={sub ? `${item.title}\n${sub}` : item.title}
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

const SHEET_TAB_KEY = "tern-mobile:new-sheet-tab";
/** Typing pauses this long before the Closed tab asks the server to search. */
const SEARCH_DELAY_MS = 300;
/** Claude Code and Codex rows: the tool's name, its mark and colour. */
const OTHER_AGENTS: Record<Exclude<Closed["agent"], "omp">, { name: string; icon: Icon }> = {
  claude: { name: "Claude Code", icon: { glyph: "✳", pi: false, cls: "agent-claude" } },
  codex: { name: "Codex", icon: { glyph: "›_", pi: false, cls: "agent-codex" } },
};

/**
 * The new-omp sheet. Folder: where a new omp can open (open blocks and past omp sessions, newest
 * first). Closed: omp sessions no pane runs now, which a tap resumes in a new tab. Both filter as
 * you type; Closed also asks the server, which searches every omp session and Claude Code's and
 * Codex's too. The tab last used is remembered on this device.
 */
function NewSheet({
  open,
  now,
  onPick,
  onResume,
  onClose,
}: {
  open: Set<string>;
  now: number;
  onPick: (dir: string) => void;
  onResume: (s: Closed) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"folder" | "closed">(() => (localStorage.getItem(SHEET_TAB_KEY) === "closed" ? "closed" : "folder"));
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
  function show(next: "folder" | "closed") {
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
  // Until the server answers, the loaded rows (all omp's) filter as you type, tool names as the server reads them.
  const searched = query && found?.q === query ? found : null;
  const local = parseSearch(q);
  const shownClosed =
    searched?.sessions ??
    (keepsTool(local.tools, "omp") ? (closed ?? []).filter((s) => matchesWords(local.rest, `${s.tag ?? ""} ${s.title} ${s.prompt} ${s.recap} ${s.cwd}`)) : []);
  const list = tab === "folder" ? projects : closed;
  const count =
    tab === "folder" ? (projects ? `${shownProjects.length} projects` : "loading")
    : query ? (searched ? (searched.error ? "search failed" : `${shownClosed.length} found`) : "searching")
    : closed ? `${shownClosed.length} closed`
    : closedError ? ""
    : "loading";
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet tall" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <div class="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "folder"} class={tab === "folder" ? "on" : ""} onClick={() => show("folder")}>
              New omp in…
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
          placeholder={tab === "folder" ? "Filter projects" : "Search sessions, Claude Code and Codex too"}
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
          {tab === "closed" &&
            shownClosed.map((s) => {
              const other = s.agent === "omp" ? null : OTHER_AGENTS[s.agent];
              // Untitled sessions go by their last prompt; omp's π stands in for a missing icon.
              const icon = other?.icon ?? (s.icon ? { glyph: s.icon, pi: false } : { glyph: "π", pi: true });
              return (
                <div key={`${s.agent}:${s.id}`} class="closed-row">
                  <button class="closed-main" onClick={() => onResume(s)} title={`Resume in a new tab in ${s.cwd}`}>
                    <TitleRow icon={icon} tag={s.tag} title={s.title || s.prompt || "Untitled session"} />
                    {(s.recap || (s.title && s.prompt)) && <div class={`row-sub${s.recap ? " recap" : ""}`}>{s.recap || s.prompt}</div>}
                    <div class="row-sub closed-meta">
                      <span class="closed-project">{folderLabel(s.cwd, home).name}</span>
                      {other && <span class={icon.cls}> · {other.name}</span>} · {age(s.at, now)}
                    </div>
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
 * to a column of session icons; `onRail` toggles that (desktop only).
 */
export function Home({
  push,
  wide = false,
  selected = null,
  rail = false,
  onRail,
}: {
  /** The bell's state and toggle, owned by the app so recovery runs on every screen. */
  push: [PushState, () => void];
  wide?: boolean;
  selected?: string | null;
  rail?: boolean;
  onRail?: () => void;
}) {
  const { state, online } = useStream(null, "chat");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(15_000);
  // The rail has no filter field, so a filter typed before minimizing doesn't hide its sessions.
  const needle = rail ? "" : q.trim().toLowerCase();
  // Hiding sessions untouched for a day, remembered on this device. Working, waiting, unseen and
  // open sessions always stay; so do blocks without a time (shells, notes) and filter matches.
  const [hideOld, setHideOld] = useState(storedHideOld);
  function toggleOld() {
    localStorage.setItem(HIDE_OLD_KEY, hideOld ? "off" : "on");
    setHideOld(!hideOld);
  }
  const oldCount = state ? state.projects.reduce((n, p) => n + p.items.filter((i) => isOld(i, now, selected)).length, 0) : 0;
  // Sessions whose omp runs another extension build than the server's (rows marked with !).
  const outdated = state ? state.projects.reduce((n, p) => n + p.items.filter((i) => i.live?.mismatch).length, 0) : 0;
  const projects = useMemo(
    () => (state ? listProjects(state.projects, needle, hideOld, now, selected) : []),
    [state, needle, hideOld, now, selected],
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

  /**
   * Starts an omp (`/api/new`) or resumes one (`/api/closed/resume`), then opens its block; `key`
   * marks what is busy meanwhile. A resume the server wants confirmed goes again with `force`.
   */
  async function launch(url: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const r = await postJson(url, body);
      const data: { block?: string; error?: string; confirm?: boolean } = await r.json().catch(() => ({}));
      if (data.block) location.hash = `#/b/${data.block}`;
      else if (data.confirm) {
        if (confirm(`${data.error ?? ""} Open it anyway?`)) await launch(url, { ...body, force: true }, key);
      } else if (data.error) alert(data.error);
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(null);
    }
  }

  const sheet = picker && (
    <NewSheet
      open={new Set(state?.projects.flatMap((p) => p.items.map((i) => i.cwd)) ?? [])}
      now={now}
      onClose={() => setPicker(false)}
      onPick={(dir) => {
        setPicker(false);
        void launch("/api/new", { cwd: dir }, dir);
      }}
      onResume={(s) => {
        setPicker(false);
        void launch("/api/closed/resume", { id: s.id, agent: s.agent }, s.id);
      }}
    />
  );

  if (rail) {
    const blocked = state?.counts.blocked ?? 0;
    return (
      <div class="screen side-rail">
        <header class="rail-head">
          <BrandToggle expand onClick={onRail} />
          <span class={`net ${online ? "on" : "off"}`} title={online ? "Connected" : "Offline"} />
          {blocked > 0 && <span class="c-blocked small" title={`${blocked} blocked`}>{blocked}</span>}
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
                p.items.map((i) => <Row key={i.block} item={i} now={now} selected={i.block === selected} />)}
            </section>
          );
        })}
      </main>
      {sheet}
      {exitHint && <div class="toast">Press back again to exit</div>}
    </div>
  );
}
