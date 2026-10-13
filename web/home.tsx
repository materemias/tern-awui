// The session list: projects with their rows, the filter, the bell, and the new-omp sheet.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Item } from "./api";
import { age, folderLabel, isOld, jobsSummary, listProjects, matchesWords, parseCollapsed, rowText, toggled } from "./lib";
import { Dot } from "./parts";
import { ExtensionBanner } from "./extension";
import { useExitGuard, useNow, useStream } from "./hooks";
import { PUSH_LABEL, usePush } from "./push";

/** The row's icon: the title's Nerd Font glyph, else Tern's π fallback for an omp not yet titled. */
function iconOf(item: Item): { glyph: string; pi: boolean } | null {
  if (item.icon) return { glyph: item.icon, pi: false };
  return item.agent || item.live ? { glyph: "π", pi: true } : null;
}

export function Title({ item }: { item: Item }) {
  const icon = iconOf(item);
  return (
    <div class="row-title">
      {icon && <span class={`nf${icon.pi ? " pi" : ""}`}>{icon.glyph}</span>}
      {item.tag && <span class="tag">{item.tag}</span>}
      <span class="title">{item.title}</span>
    </div>
  );
}

function Row({ item, now, selected }: { item: Item; now: number; selected?: boolean }) {
  const state = item.status ?? undefined;
  const { sub, recap, stale } = rowText(item, now);
  return (
    <a
      class={`row st-${state ?? "shell"}${stale ? " stale" : ""}${item.unseen ? ` unseen-${item.unseen}` : ""}${selected ? " selected" : ""}`}
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

/** The folders a new omp can open in (open blocks and past omp sessions, newest first), filtered as you type. */
function ProjectSheet({ open, onPick, onClose }: { open: Set<string>; onPick: (dir: string) => void; onClose: () => void }) {
  const [projects, setProjects] = useState<string[] | null>(null);
  const [home, setHome] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d: { projects?: string[]; home?: string }) => {
        setProjects(d.projects ?? []);
        setHome(d.home ?? "");
      })
      .catch(() => setProjects([]));
  }, []);
  const shown = (projects ?? []).filter((p) => matchesWords(q, p));
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet tall" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <span>New omp in…</span>
          <span class="muted small">{projects ? `${shown.length} projects` : "loading"}</span>
        </div>
        <input class="sheet-filter" type="search" autoFocus placeholder="Filter projects" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <div class="sheet-list">
          {shown.map((p) => {
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
        </div>
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "tern-mobile:collapsed-projects";
const HIDE_OLD_KEY = "tern-mobile:hide-old";

/** The session list. `wide`: shown beside the open session, which `selected` marks. */
export function Home({ wide = false, selected = null }: { wide?: boolean; selected?: string | null }) {
  const { state, online } = useStream(null, "chat");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(15_000);
  const needle = q.trim().toLowerCase();
  // Hiding sessions untouched for a day, remembered on this device. Working, waiting, unseen and
  // open sessions always stay; so do blocks without a time (shells, notes) and filter matches.
  const [hideOld, setHideOld] = useState(() => localStorage.getItem(HIDE_OLD_KEY) === "on");
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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => parseCollapsed(localStorage.getItem(COLLAPSED_KEY)));
  function toggleProject(name: string) {
    setCollapsed((prev) => {
      const next = toggled(prev, name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }
  const [push, togglePush] = usePush();
  // Only the phone's single-pane list guards against leaving on back.
  const exitHint = useExitGuard(!wide);

  async function newAgent(cwd: string, project: string, ask = true) {
    if (ask && !confirm(`Start a new omp in ${project}?`)) return;
    setBusy(project);
    try {
      const r = await fetch("/api/new", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tern-mobile": "1" },
        body: JSON.stringify({ cwd }),
      });
      const data: { block?: string; error?: string } = await r.json().catch(() => ({}));
      if (data.block) location.hash = `#/b/${data.block}`;
      else if (data.error) alert(data.error);
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="screen">
      <header class="bar">
        <span class="brand">tern</span>
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
            {state.counts.blocked > 0 && <span class="c-blocked">{state.counts.blocked} blocked</span>}
            <span class="c-working">{state.counts.working ?? 0} working</span>
            <span class="muted">{state.counts.idle ?? 0} idle</span>
          </span>
        )}
        {push !== "unsupported" && (
          <button
            class={`icon-btn push-${push}${push === "on" ? " on" : ""}`}
            disabled={push === "pending"}
            onClick={() => (push === "denied" ? alert("Notifications are blocked: allow them in the site settings.") : togglePush())}
            aria-label={PUSH_LABEL[push]}
            title={PUSH_LABEL[push]}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13L5 13.5ZM8.5 17a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              {(push === "off" || push === "denied") && <path d="M3.5 3.5 16.5 16.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />}
              {push === "on" && <circle cx="15" cy="5" r="2.6" fill="var(--working)" stroke="none" />}
            </svg>
          </button>
        )}
        <button
          class={`icon-btn${hideOld ? " on" : ""}`}
          onClick={toggleOld}
          aria-label={hideOld ? `Show ${oldCount} sessions older than a day` : "Hide sessions older than a day"}
          title={hideOld ? `Show ${oldCount} sessions older than a day` : "Hide sessions older than a day"}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M10 6.5V10l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            {hideOld && <path d="M3.5 3.5 16.5 16.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />}
          </svg>
          {hideOld && oldCount > 0 && <span class="icon-count">{oldCount}</span>}
        </button>
        <button class="ghost" onClick={() => setPicker(true)} aria-label="New omp in a project">
          + omp
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
                  class="ghost"
                  disabled={busy === p.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    void newAgent(p.items[0].cwd, p.name);
                  }}
                >
                  + omp
                </button>
              </h2>
              {!shut &&
                p.items.map((i) => <Row key={i.block} item={i} now={now} selected={i.block === selected} />)}
            </section>
          );
        })}
      </main>
      {picker && (
        <ProjectSheet
          open={new Set(state?.projects.flatMap((p) => p.items.map((i) => i.cwd)) ?? [])}
          onClose={() => setPicker(false)}
          onPick={(dir) => {
            setPicker(false);
            void newAgent(dir, dir, false);
          }}
        />
      )}
      {exitHint && <div class="toast">Press back again to exit</div>}
    </div>
  );
}
