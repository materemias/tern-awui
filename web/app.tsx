import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Mermaid } from "mermaid";
import { drawCharts } from "./charts";
import { checkPaired, post, type AdvisorNote, type Ask, type Btw, type CatalogModel, type ChatEntry, type Doc, type Img, type Item, type Job, type Live, type Role, type State, type TodoPhase, type ToolCall } from "./api";
import {
  age,
  askAnswers,
  askReady,
  btwQuestion,
  can,
  clock,
  composerKey,
  ctxShort,
  currentRole,
  duration,
  extensionOutdated,
  fitEdge,
  folderLabel,
  isAgentJob,
  isOld,
  jobsSummary,
  langOf,
  lineEdit,
  listProjects,
  matchesWords,
  needsReencode,
  parseAdvisorNote,
  parseCollapsed,
  parseRecent,
  prettyModel,
  priceShort,
  rowText,
  searchModels,
  toggled,
  tokensShort,
  vapidBytes,
  withRecent,
  type AskPick,
} from "./lib";
import { renderMarkdown, screenHtml } from "./markdown";
import { buzz, Thumbs, Todo, UserMsg } from "./parts";

/** The session's running background jobs under the transcript: names only, no drill-down. */
function JobsStrip({ jobs, now }: { jobs: Job[]; now: number }) {
  if (!jobs.length) return null;
  return (
    <div class="jobs">
      {jobs.map((j) => (
        <div key={j.id} class={`job${isAgentJob(j) ? " job-agent" : ""}`}>
          <span class="job-mark">{isAgentJob(j) ? "⑂" : "⧗"}</span>
          <span class="job-name">{j.agent || j.id}</span>
          {j.label && j.label !== (j.agent || j.id) && <span class="job-label">{j.label}</span>}
          <span class="job-age">{age(j.since, now)}</span>
        </div>
      ))}
    </div>
  );
}

/** The app icon counts updates not seen yet: finished turns and waits on you. */
function setBadge(count: number) {
  if (!("setAppBadge" in navigator)) return;
  void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

type Draft = { live: boolean; text: string };
type View = "chat" | "screen";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function useRoute(): string | null {
  const read = () => /^#\/b\/(\d+)$/.exec(location.hash)?.[1] ?? null;
  const [block, setBlock] = useState(read);
  useEffect(() => {
    const on = () => setBlock(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return block;
}

const SESSION_HASH = /^#\/b\/\d+$/;
/** True when the open session was entered from the list, so going back is a history pop. */
let cameFromList = false;
addEventListener("hashchange", (e: HashChangeEvent) => {
  cameFromList = !SESSION_HASH.test(new URL(e.oldURL).hash) && SESSION_HASH.test(location.hash);
});

/** Returns to the list without stacking a list entry above the session (back would reopen it). */
function backToList() {
  if (cameFromList) history.back();
  else location.replace("#/");
}

/**
 * The list keeps a guard entry on top of its history entry. The first back gesture pops only
 * the guard: it is pushed again and a hint shows. A second back within EXIT_WINDOW_MS leaves.
 */
const EXIT_WINDOW_MS = 2000;
function useExitGuard(enabled: boolean): boolean {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    if (history.state?.guard !== true) history.pushState({ guard: true }, "");
    let armedUntil = 0;
    let timer: number | undefined;
    const onPop = () => {
      if (SESSION_HASH.test(location.hash) || history.state?.guard === true) return;
      if (Date.now() < armedUntil) {
        history.back();
        return;
      }
      armedUntil = Date.now() + EXIT_WINDOW_MS;
      history.pushState({ guard: true }, "");
      setHint(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setHint(false), EXIT_WINDOW_MS);
    };
    addEventListener("popstate", onPop);
    return () => {
      removeEventListener("popstate", onPop);
      clearTimeout(timer);
    };
  }, [enabled]);
  return hint;
}

/** Wide screens (a desktop browser) get the list beside the open session; phones keep one pane. */
const WIDE = "(min-width: 1000px)";
function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** How long a hidden app keeps its stream, so a quick app switch doesn't reconnect. */
const HIDDEN_GRACE_MS = 10_000;

/** One SSE connection: always the block list, plus chat or screen and the draft for the open block. */
function useStream(block: string | null, view: View) {
  const [state, setState] = useState<State | null>(null);
  const [chat, setChat] = useState<ChatEntry[] | null>(null);
  const [btw, setBtw] = useState<Btw | null>(null);
  const [screen, setScreen] = useState<{ text: string; html: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  /** The assistant message omp is writing now; kept after it ends until the transcript has it. */
  const [live, setLive] = useState<string | null>(null);
  /** Prompts omp holds for the running turn: steers, or follow-ups for after it ends. */
  const [queued, setQueued] = useState<{ text: string; followUp: boolean }[]>([]);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    setChat(null);
    setScreen(null);
    setLive(null);
    setQueued([]);
    const qs = block ? `?block=${block}&view=${view}` : "";
    let es: EventSource | null = null;
    let liveEnded = false;
    let liveTimer: number | undefined;
    const open = () => {
      // Live text and the queue may have moved on while hidden; the stream resends what's current.
      setLive(null);
      setQueued([]);
      const src = new EventSource(`/api/stream${qs}`);
      es = src;
      src.onopen = () => setOnline(true);
      src.onerror = () => setOnline(false);
      src.addEventListener("state", (e) => {
        const s: State = JSON.parse(e.data);
        setState(s);
        setBadge(s.badge);
      });
      src.addEventListener("chat", (e) => {
        setChat(JSON.parse(e.data)?.entries ?? []);
        // The finished message is in the transcript now: it replaces the live copy without a gap.
        if (liveEnded) setLive(null);
      });
      src.addEventListener("live", (e) => {
        const d: { text: string; done: boolean } = JSON.parse(e.data);
        clearTimeout(liveTimer);
        liveEnded = d.done;
        if (!d.done) return setLive(d.text);
        // Normally the transcript write follows at once; don't keep a stale copy if it doesn't.
        liveTimer = window.setTimeout(() => setLive(null), 3000);
      });
      src.addEventListener("btw", (e) => {
        const d: Omit<Btw, "question"> = JSON.parse(e.data);
        setBtw((b) => (b && b.id === d.id ? { ...b, ...d } : b));
      });
      src.addEventListener("screen", (e) => setScreen(JSON.parse(e.data)));
      src.addEventListener("draft", (e) => setDraft(JSON.parse(e.data)));
      src.addEventListener("queued", (e) => setQueued(JSON.parse(e.data)));
      src.addEventListener("doc", (e) => setDoc(JSON.parse(e.data)));
    };
    const close = () => {
      es?.close();
      es = null;
      setOnline(false);
    };
    // A hidden app (switched away, screen off, tab in the background) holds no stream: no data
    // flows, the server stops live text for it, and its sessions count as unseen again, so
    // notifications and badges work for them. A short grace keeps quick app switches cheap.
    let hideTimer: number | undefined;
    const onVisibility = () => {
      clearTimeout(hideTimer);
      if (document.visibilityState === "hidden") hideTimer = window.setTimeout(close, HIDDEN_GRACE_MS);
      else if (!es || es.readyState === EventSource.CLOSED) open();
    };
    if (document.visibilityState === "visible") open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      es?.close();
      clearTimeout(liveTimer);
      clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [block, view]);
  return { state, chat, live, queued, btw, setBtw, screen, draft, doc, online };
}

// ---------- pieces ----------

function Dot({ state }: { state: string | undefined }) {
  return <span class={`dot dot-${state ?? "shell"}`} />;
}

/** The row's icon: the title's Nerd Font glyph, else Tern's π fallback for an omp not yet titled. */
function iconOf(item: Item): { glyph: string; pi: boolean } | null {
  if (item.icon) return { glyph: item.icon, pi: false };
  return item.agent || item.live ? { glyph: "π", pi: true } : null;
}

function Title({ item }: { item: Item }) {
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

/**
 * `off`: no subscription; `pending`: checking, asking for permission, or (re)subscribing and
 * waiting for the server to store it; `on`: the server confirmed this device's subscription.
 */
type PushState = "unsupported" | "denied" | "off" | "pending" | "on";
/** The user's choice on this device; survives app updates, reloads and dropped subscriptions. */
const PUSH_WANTED_KEY = "tern-mobile:push";

/** This device's subscription for the server's current key: kept, renewed or created. */
async function ensureSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const { key }: { key: string } = await (await fetch("/api/push/key")).json();
  const want = vapidBytes(key);
  let sub = await reg.pushManager.getSubscription();
  const have = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  // A subscription made for another server key would never receive a push.
  if (sub && (!have || have.length !== want.length || have.some((b, i) => b !== want[i]))) {
    await sub.unsubscribe();
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
}

const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "Notifications unsupported",
  denied: "Notifications blocked in site settings",
  off: "Notifications off",
  pending: "Notifications: connecting…",
  on: "Notifications on",
};

/** The service worker, or an error if it isn't active within 10 s (registration failed). */
function workerReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker not active")), 10_000)),
  ]);
}

/** Push notifications for finished and blocked sessions; on/off per device. */
function usePush(): [PushState, () => void] {
  const [state, setState] = useState<PushState>("pending");
  const offState = (): PushState => (Notification.permission === "denied" ? "denied" : "off");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState("unsupported");
    void (async () => {
      try {
        const reg = await workerReady();
        const sub = await reg.pushManager.getSubscription();
        // Turned on here before: keep it on. The browser can drop a subscription (app update,
        // storage cleanup) while the permission stays granted, so make a new one silently.
        const choice = localStorage.getItem(PUSH_WANTED_KEY);
        const wanted = choice === "on" || (sub !== null && choice === null);
        if (!wanted || Notification.permission !== "granted") return setState(offState());
        const now = await ensureSubscription(reg);
        // The server may have lost or pruned it: on only once it has it again.
        const err = await post("/api/push/subscribe", now.toJSON());
        if (err) throw new Error(err);
        localStorage.setItem(PUSH_WANTED_KEY, "on");
        setState("on");
      } catch {
        // Any failure leaves the bell tappable, so a tap can retry.
        setState(offState());
      }
    })();
  }, []);
  async function toggle() {
    if (state === "unsupported" || state === "pending") return;
    const wasOn = state === "on";
    setState("pending");
    try {
      const reg = await workerReady();
      if (wasOn) {
        localStorage.setItem(PUSH_WANTED_KEY, "off");
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await post("/api/push/unsubscribe", sub.toJSON());
          await sub.unsubscribe();
        }
        return setState("off");
      }
      if ((await Notification.requestPermission()) !== "granted") return setState(offState());
      const sub = await ensureSubscription(reg);
      const err = await post("/api/push/subscribe", sub.toJSON());
      if (err) throw new Error(err);
      localStorage.setItem(PUSH_WANTED_KEY, "on");
      setState("on");
    } catch (e) {
      alert(`Notifications failed: ${e}`);
      // Turning off already cleared the choice; the server drops a dead subscription on its own.
      setState(wasOn ? "off" : offState());
    }
  }
  return [state, toggle];
}

const COLLAPSED_KEY = "tern-mobile:collapsed-projects";
const HIDE_OLD_KEY = "tern-mobile:hide-old";

/** The session list. `wide`: shown beside the open session, which `selected` marks. */
function Home({ wide = false, selected = null }: { wide?: boolean; selected?: string | null }) {
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
    const r = await fetch("/api/new", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tern-mobile": "1" },
      body: JSON.stringify({ cwd }),
    });
    const data: { block?: string; error?: string } = await r.json().catch(() => ({}));
    setBusy(null);
    if (data.block) location.hash = `#/b/${data.block}`;
    else if (data.error) alert(data.error);
  }

  return (
    <div class="screen">
      <header class="bar">
        <span class="brand">tern</span>
        <span class={`net ${online ? "on" : "off"}`} />
        <span class="spacer" />
        {state && (
          <span class="counts">
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

function Markdown({ text, class: cls }: { text: string; class: string }) {
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

/** `rewind`: the session's omp can rewind to a prompt. */
function Chat({ entries, block, rewind }: { entries: ChatEntry[]; block: string; rewind: boolean }) {
  // An ask is open only while nothing was said after it.
  const lastTalk = entries.findLastIndex((e) => e.role === "user" || e.role === "assistant");
  const latestTodo = entries.findLastIndex((e) => e.role === "tools" && e.todo !== null);
  return (
    <>
      {entries.map((e, n) => {
        if (e.role === "user") return <UserMsg key={n} entry={e} block={block} rewind={rewind} />;
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
        return <AskCard key={e.id} ask={e} block={block} pending={n > lastTalk} />;
      })}
    </>
  );
}

const KEY_BAR: [string, string[]][] = [
  ["Esc", ["Escape"]],
  ["^C", ["ctrl+c"]],
  ["↑", ["Up"]],
  ["↓", ["Down"]],
  ["⏎", ["Enter"]],
  ["Tab", ["Tab"]],
  ["⇧Tab", ["shift+Tab"]],
  ["Space", ["space"]],
];

const RECENT_MODELS_KEY = "tern-mobile:recent-models";
const SEARCH_MAX = 80;
const EFFORT_LABEL: Record<string, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
const TIER_LABEL: Record<string, [string, string]> = {
  "": ["Standard", ""],
  flex: ["Flex", "cheaper, slower"],
  priority: ["Fast", "priority serving, costs more"],
};

function ModelRow({ m, current, onPick }: { m: CatalogModel; current: boolean; onPick: () => void }) {
  const facts = [m.p, m.ctx ? ctxShort(m.ctx) : "", priceShort(m), m.r ? "reasoning" : "", m.img ? "vision" : ""].filter(Boolean);
  return (
    <button type="button" class={`mp-row${current ? " on" : ""}`} onClick={onPick}>
      <span class="mp-main">
        <span class="mp-name">{m.name}</span>
        <span class="mp-facts">{facts.join(" · ")}</span>
      </span>
      {current && <span class="mp-check">✓</span>}
    </button>
  );
}

/**
 * The model picker: effort and priority for the current model, omp's Ctrl+P roles first, then
 * recent picks and every model omp has credentials for, by provider or by search.
 */
function ModelSheet({
  block,
  roles,
  current,
  bridged,
  send,
  onCycle,
  onClose,
}: {
  block: string;
  roles: Role[];
  current: Live | null;
  bridged: boolean;
  send: (path: string, body: unknown) => Promise<string | null>;
  onCycle: () => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  // An omp without the catalog API still applies roles; it just can't list every model.
  const listable = can(current, "models");
  useEffect(() => {
    if (!bridged || !listable) return;
    void fetch(`/api/blocks/${block}/models`, { method: "POST", headers: { "x-tern-mobile": "1" } })
      .then((r) => r.json())
      .then((d: { models?: CatalogModel[]; error?: string }) => (d.models ? setModels(d.models) : setLoadError(d.error ?? "no models")))
      .catch((e) => setLoadError(String(e)));
  }, [block, bridged, listable]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const model = current?.model ?? "";
  const thinking = current?.thinking ?? "";
  const role = currentRole(roles, model, thinking);
  const needle = q.trim().toLowerCase();
  const byKey = useMemo(() => new Map((models ?? []).map((m) => [`${m.p}/${m.id}`, m])), [models]);
  const providers = useMemo(() => {
    const groups = new Map<string, CatalogModel[]>();
    for (const m of models ?? []) groups.set(m.p, [...(groups.get(m.p) ?? []), m]);
    return [...groups].sort((x, y) => x[0].localeCompare(y[0]));
  }, [models]);
  const found = searchModels(models ?? [], q);
  const recent = parseRecent(localStorage.getItem(RECENT_MODELS_KEY))
    .map((k) => byKey.get(k))
    .filter((m): m is CatalogModel => !!m);

  async function pick(spec: string) {
    const err = await send("model", { spec });
    if (err) return;
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(withRecent(parseRecent(localStorage.getItem(RECENT_MODELS_KEY)), spec)));
    onClose();
  }
  async function pickRole(r: string) {
    if (!(await send("model", { role: r }))) onClose();
  }
  const levels = current?.levels.filter((l) => l !== "off" || current.levels.length > 1) ?? [];
  const row = (m: CatalogModel) => <ModelRow key={`${m.p}/${m.id}`} m={m} current={`${m.p}/${m.id}` === model} onPick={() => pick(`${m.p}/${m.id}`)} />;

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet mp" onClick={(e) => e.stopPropagation()}>
        <div class="mp-head">
          <span class="mp-title">{prettyModel(model) || "Model"}</span>
          <span class="muted small">{model}</span>
          <span class="spacer" />
          <button type="button" class="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!bridged ? (
          <>
            <div class="muted small sheet-note">
              This session started before the tern-mobile extension, so only cycling works. Restart it to pick directly.
            </div>
            <button class="sheet-row" onClick={onCycle}>
              <span class="role">Next model</span>
              <span class="muted small">Ctrl+P</span>
            </button>
          </>
        ) : (
          <>
            {levels.length > 1 && (
              <div class="mp-opt">
                <span class="mp-label">Effort</span>
                <div class="seg">
                  {levels.map((l) => (
                    <button key={l} type="button" class={l === thinking ? "on" : ""} onClick={() => void send("thinking", { level: l })}>
                      {EFFORT_LABEL[l] ?? l}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(current?.tiers.length ?? 0) > 1 && (
              <div class="mp-opt">
                <span class="mp-label">Priority</span>
                <div class="seg">
                  {current!.tiers.map((t) => (
                    <button
                      key={t}
                      type="button"
                      class={t === current!.tier ? "on" : ""}
                      title={TIER_LABEL[t]?.[1] ?? ""}
                      onClick={() => void send("tier", { tier: t })}
                    >
                      {TIER_LABEL[t]?.[0] ?? t}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input class="sheet-filter" type="search" placeholder="Search models" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
            <div class="sheet-list">
              {roles.some((r) => !needle || matchesWords(needle, `${r.role} ${r.spec}`)) && <div class="mp-section">Roles · Ctrl+P</div>}
              {roles
                .filter((r) => !needle || matchesWords(needle, `${r.role} ${r.spec}`))
                .map((r) => {
                  const [spec, level] = r.spec.split(/:(?=[a-z]+$)/);
                  return (
                    <button key={r.role} type="button" class={`mp-row${r.role === role ? " on" : ""}`} onClick={() => pickRole(r.role)}>
                      <span class="mp-main">
                        <span class="mp-name">
                          <span class="mp-role">{r.role}</span> {byKey.get(spec)?.name ?? prettyModel(spec)}
                        </span>
                        <span class="mp-facts">{[spec, level && (EFFORT_LABEL[level] ?? level)].filter(Boolean).join(" · ")}</span>
                      </span>
                      {r.role === role && <span class="mp-check">✓</span>}
                    </button>
                  );
                })}
              {!listable ? (
                <div class="muted small sheet-note">This omp can't list models; roles still work</div>
              ) : (
                <>
                  {!models && <div class="muted small sheet-note">{loadError ? `Models: ${loadError}` : "Loading models…"}</div>}
                  {needle ? (
                    <>
                      {found.length > 0 && <div class="mp-section">{found.length > SEARCH_MAX ? `${SEARCH_MAX} of ${found.length}` : found.length} models</div>}
                      {found.slice(0, SEARCH_MAX).map(row)}
                    </>
                  ) : (
                    <>
                      {recent.length > 0 && <div class="mp-section">Recent</div>}
                      {recent.map(row)}
                      {providers.length > 0 && <div class="mp-section">All models</div>}
                      {providers.map(([p, list]) => (
                        <div key={p}>
                          <button type="button" class="mp-provider" onClick={() => setOpenProvider(openProvider === p ? null : p)}>
                            <span class="chev">{openProvider === p ? "▾" : "▸"}</span>
                            <span>{p}</span>
                            <span class="muted">{list.length}</span>
                            {model.startsWith(`${p}/`) && <span class="mp-check">●</span>}
                          </button>
                          {openProvider === p && list.map(row)}
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** omp's autocomplete for the composer text: suggestions and the token they replace. */
type Hints = { prefix: string; items: { value: string; label: string; description: string }[] };
/** Text ending in a token omp completes: `/command`, `/skill:name`, `@path`. */
const COMPLETABLE = /(^|\s)[/@][^\s]*$/;

/** A pasted image ready to send: base64 bytes, their type, and an object URL for the preview. */
type PastedImage = { data: string; mimeType: string; url: string };
const MAX_PASTED = 8;

async function pastedImage(file: File): Promise<PastedImage> {
  let blob: Blob = file;
  if (needsReencode(file.type, file.size)) {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitEdge(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), mimeType: blob.type, url: URL.createObjectURL(blob) };
}

/**
 * The prompt. With the omp bridge connected it mirrors the session's editor both ways:
 * every keystroke here becomes the desktop draft, and desktop typing shows up here.
 * `raw` (omp only) puts a Raw/Chat switch in the key bar for the pane's raw screen text.
 */
function Composer({
  block,
  item,
  draft,
  roles,
  raw,
  btw,
  setBtw,
}: {
  block: string;
  item: Item | undefined;
  draft: Draft | null;
  roles: Role[];
  raw?: { on: boolean; toggle: () => void };
  /** The open side question (`/btw …`) and its streaming answer. */
  btw: Btw | null;
  setBtw: (b: Btw | null) => void;
}) {
  const [text, setText] = useState("");
  /** The composer text now, for async work that must not act on an older value. */
  const textRef = useRef(text);
  textRef.current = text;
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Images pasted into the prompt; they go out with the next send. */
  const [pasted, setPasted] = useState<PastedImage[]>([]);
  // Shells (no agent) open with the key bar shown: fzf and history need the arrows and Enter.
  const [keysOpen, setKeysOpen] = useState<boolean | null>(null);
  const [sheet, setSheet] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const lastEdit = useRef(0);
  const outbox = useRef<{ busy: boolean; next: string | null }>({ busy: false, next: null });
  const submitting = useRef(false);
  // Terminals: what the phone has typed onto the shell's line, and one queue for every write.
  const typed = useRef("");
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const remote = useRef<string | null>(null);
  const reconcileTimer = useRef<number | undefined>(undefined);
  const live = draft?.live === true;
  const [hints, setHints] = useState<Hints | null>(null);
  const hintSeq = useRef(0);

  // omp's own autocomplete while the phone types a /command, /skill:… or @path token.
  const completable = can(item?.live, "complete");
  useEffect(() => {
    const seq = ++hintSeq.current;
    if (!live || !completable || !COMPLETABLE.test(text) || Date.now() - lastEdit.current > 1000) return setHints(null);
    const timer = window.setTimeout(async () => {
      const r = await fetch(`/api/blocks/${block}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tern-mobile": "1" },
        body: JSON.stringify({ text }),
      }).catch(() => null);
      const data: Hints | null = r?.ok ? await r.json().catch(() => null) : null;
      if (seq === hintSeq.current) setHints(data?.items.length ? data : null);
    }, 120);
    return () => clearTimeout(timer);
  }, [text, live, completable]);

  async function pick(item: Hints["items"][number]) {
    if (!hints) return;
    const prefix = hints.prefix;
    hintSeq.current++;
    setHints(null);
    // Applying shares the draft queue: omp must hold exactly the text the completion is for.
    if (!(await draftSettled())) return setError("Draft still syncing; tap the suggestion again");
    const box = outbox.current;
    const sent = textRef.current;
    box.busy = true;
    const r = await fetch(`/api/blocks/${block}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tern-mobile": "1" },
      body: JSON.stringify({ text: sent, value: item.value, label: item.label, prefix }),
    }).catch(() => null);
    const data: { text?: string; error?: string } = r ? await r.json().catch(() => ({})) : { error: "offline" };
    box.busy = false;
    box.next = null;
    // Typing while the request ran wins over its result: resend what the phone holds now.
    if (textRef.current !== sent) return void pushDraft(textRef.current);
    if (typeof data.text !== "string") return setError(data.error ?? "completion failed");
    lastEdit.current = Date.now();
    buzz(8);
    textRef.current = data.text;
    setText(data.text);
    area.current?.focus();
  }

  // Adopt the desktop's newest draft once the phone's own edits have settled: while the phone
  // types or a push is in flight, the echo may be stale, so it waits rather than being dropped.
  function reconcile() {
    clearTimeout(reconcileTimer.current);
    const wanted = remote.current;
    if (wanted === null) return;
    const quiet = 800 - (Date.now() - lastEdit.current);
    if (outbox.current.busy || quiet > 0) {
      reconcileTimer.current = window.setTimeout(reconcile, Math.max(quiet, 100));
      return;
    }
    remote.current = null;
    setText((t) => (t === wanted ? t : wanted));
  }
  useEffect(() => {
    if (!draft?.live) return;
    remote.current = draft.text;
    reconcile();
  }, [draft]);
  useEffect(() => () => clearTimeout(reconcileTimer.current), []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  async function pushDraft(value: string) {
    const box = outbox.current;
    if (box.busy) {
      box.next = value;
      return;
    }
    box.busy = true;
    let current: string | null = value;
    while (current !== null) {
      box.next = null;
      const err = await post(`/api/blocks/${block}/draft`, { text: current });
      if (err) setError(err);
      current = box.next;
    }
    box.busy = false;
    reconcile();
  }

  /** Waits up to ~3 s for draft pushes to finish; false if they are still running. */
  async function draftSettled(): Promise<boolean> {
    const box = outbox.current;
    for (let i = 0; box.busy && i < 60; i++) await new Promise((r) => setTimeout(r, 50));
    return !box.busy;
  }

  async function send(path: string, body: unknown) {
    setSending(true);
    const err = await post(`/api/blocks/${block}/${path}`, body);
    setSending(false);
    setError(err);
    return err;
  }

  const a = item?.agent;
  const terminal = !!item && !a && !item.live;

  /** Runs terminal writes in order, so keystrokes never overtake each other. */
  function queue(path: string, body: unknown): Promise<string | null> {
    const next = chain.current.then(() => post(`/api/blocks/${block}/${path}`, body));
    chain.current = next;
    void next.then((err) => err && setError(err));
    return next;
  }

  /** Mirrors the composer onto the shell's prompt: Backspace what changed, type the rest. */
  function typeInto(value: string) {
    const edit = lineEdit(typed.current, value);
    typed.current = value;
    if (edit.back || edit.text) void queue("type", edit);
  }

  function terminalKeys(keys: string[]) {
    // Anything but plain movement changes the line under the phone: start fresh.
    typed.current = "";
    setText("");
    return queue("keys", { keys });
  }

  /** `followUp`: omp holds the prompt until the running turn ends (its Ctrl+Q), rather than steering. */
  async function submit(e: Event, followUp = false) {
    e.preventDefault();
    if (terminal) {
      buzz();
      await terminalKeys(["Enter"]);
      return;
    }
    // One send at a time: a second tap while the draft settles would post the prompt twice.
    if (submitting.current) return;
    submitting.current = true;
    setSending(true);
    try {
      await submitPrompt(followUp);
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  async function submitPrompt(followUp: boolean) {
    // A draft push still queued would reach omp after the send and refill its editor (and from
    // there this composer) with the sent text: drop it, since the send carries the final text,
    // and let the one in flight land first.
    outbox.current.next = null;
    if (!(await draftSettled())) return setError("Draft still syncing; send again");
    const question = btwQuestion(text);
    // An omp without side turns gets `/btw …` as a normal prompt.
    if (question && live && can(item?.live, "btw") && !pasted.length && !followUp) {
      // A side question answered on the phone; the desktop draft is cleared like a sent prompt.
      setSending(true);
      const r = await fetch(`/api/blocks/${block}/btw`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tern-mobile": "1" },
        body: JSON.stringify({ text: question }),
      }).catch(() => null);
      const data: { id?: string; error?: string } = r ? await r.json().catch(() => ({})) : { error: "offline" };
      setSending(false);
      if (!data.id) return setError(data.error ?? "btw failed");
      buzz();
      setBtw({ id: data.id, question, text: "", done: false, error: "" });
      lastEdit.current = Date.now();
      remote.current = null;
      textRef.current = "";
      setText("");
      void pushDraft("");
      return;
    }
    if (pasted.length) {
      const sent = pasted;
      const images = sent.map(({ data, mimeType }) => ({ data, mimeType }));
      if (await send("submit", { text: text.trim(), images, followUp })) return;
      buzz();
      for (const p of sent) URL.revokeObjectURL(p.url);
      // Images pasted while this one was uploading stay for the next send.
      setPasted((now) => now.filter((p) => !sent.includes(p)));
      lastEdit.current = Date.now();
      remote.current = null;
      textRef.current = "";
      setText("");
      return;
    }
    if (!(await send("submit", followUp ? { text: text.trim(), followUp } : { text: text.trim() }))) {
      buzz();
      lastEdit.current = Date.now();
      // An echo of the draft from before the send must not come back once it settles.
      remote.current = null;
      textRef.current = "";
      setText("");
    }
  }

  async function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (!files.length) return;
    // Text pasted alongside an image (some apps add a file name) is dropped with it.
    e.preventDefault();
    const room = MAX_PASTED - pasted.length;
    if (room <= 0) return setError(`at most ${MAX_PASTED} images`);
    const next = await Promise.all(files.slice(0, room).map(pastedImage)).catch(() => null);
    if (!next) return setError("could not read the pasted image");
    setPasted((p) => [...p, ...next]);
  }

  function unpaste(index: number) {
    URL.revokeObjectURL(pasted[index].url);
    setPasted((p) => p.filter((_, i) => i !== index));
  }

  async function stop() {
    if (!(await send("abort", {}))) buzz(30);
  }

  const model = item?.live?.model ?? "";
  const thinking = item?.live?.thinking ?? "";
  const role = currentRole(roles, model, thinking);
  const working = item?.status === "working";
  const keysShown = keysOpen ?? terminal;
  const empty = text.trim() === "" && !pasted.length;
  // While the agent runs and nothing is typed, the send button stops the turn instead.
  const stoppable = working && empty && !terminal && !!a;
  const context = item?.live?.context ?? null;

  return (
    <div class="composer-wrap">
      {keysShown && (
        <div class="keys">
          {raw && (
            <button class={raw.on ? "on" : ""} onClick={raw.toggle}>
              {raw.on ? "Chat" : "Raw"}
            </button>
          )}
          {KEY_BAR.map(([label, keys]) => (
            <button
              key={label}
              disabled={sending}
              onClick={() => {
                buzz(8);
                void (terminal ? terminalKeys(keys) : send("keys", { keys }));
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div class="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {btw && (
        <div class={`btw${btw.done ? "" : " streaming"}`}>
          <div class="btw-head">
            <span class="btw-tag">btw</span>
            <span class="btw-q">{btw.question}</span>
            <button class="btw-x" onClick={() => setBtw(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
          {btw.error ? (
            <div class="err small">{btw.error}</div>
          ) : btw.text ? (
            <Markdown class="md btw-a" text={btw.text} />
          ) : (
            <div class="muted small">thinking…</div>
          )}
        </div>
      )}
      {hints && (
        <div class="hints" role="listbox">
          {hints.items.map((h) => (
            <button key={`${h.value}\u0000${h.label}`} class="hint" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
              <span class="hint-label">{h.label}</span>
              {h.description && <span class="hint-desc">{h.description}</span>}
            </button>
          ))}
        </div>
      )}
      <form class="composer" onSubmit={submit}>
        {context && (
          // Context-window use drawn as the composer's top border, like omp's own composer:
          // the used part in accent, the percent riding just past it, the window at the right end.
          <div class={`ctx${context.percent > 100 ? " ctx-over" : ""}`} title={`${context.percent}% of the context window · ${tokensShort(context.tokens)} tokens`}>
            <div class="ctx-scale">
              <div class="ctx-fill" style={{ width: `${Math.max(1, Math.min(context.percent, 100))}%` }} />
              {context.compactAt !== null && (
                <span class="ctx-mark" style={{ left: `${context.compactAt}%` }} title={`auto-compacts at ${Math.round(context.compactAt)}%`} />
              )}
              <span class="ctx-label ctx-pct" style={{ left: `min(${Math.min(context.percent, 100)}%, calc(100% - 4.5ch))` }}>
                {context.percent}%
              </span>
            </div>
            <span class="ctx-label ctx-window">{tokensShort(context.window)}</span>
          </div>
        )}
        {pasted.length > 0 && (
          <div class="pasted">
            {pasted.map((p, i) => (
              <div key={p.url} class="pasted-item">
                <img src={p.url} alt="" />
                <button type="button" onClick={() => unpaste(i)} aria-label="Remove image">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          placeholder={
            terminal ? "Type into the terminal" : working ? "Steer the agent…" : "Ask for changes or send a follow-up"
          }
          autoCapitalize={terminal ? "off" : undefined}
          autoCorrect={terminal ? "off" : undefined}
          spellcheck={!terminal}
          value={text}
          onInput={(e) => {
            let value = e.currentTarget.value;
            if (terminal) {
              // A soft keyboard's Enter arrives as a newline: type up to it, then press Enter.
              const nl = value.indexOf("\n");
              if (nl >= 0) value = value.slice(0, nl);
              setText(value);
              typeInto(value);
              if (nl >= 0) void terminalKeys(["Enter"]);
              return;
            }
            lastEdit.current = Date.now();
            textRef.current = value;
            setText(value);
            if (live) void pushDraft(value);
          }}
          onPaste={terminal || !a ? undefined : onPaste}
          onKeyDown={(e) => {
            const action = composerKey(e, { working, live, terminal, touch: "ontouchstart" in window });
            if (action) void submit(e, action === "followUp");
          }}
        />
        <div class="composer-foot">
          {a && (
            <button type="button" class="pick" onClick={() => setSheet(true)}>
              <span>{prettyModel(model) || role || "Model"}</span>
              {thinking && <span class="pick-sub">{EFFORT_LABEL[thinking]?.toLowerCase() ?? thinking}</span>}
              {item?.live?.tier && <span class="pick-sub pick-tier">{TIER_LABEL[item.live.tier]?.[0].toLowerCase() ?? item.live.tier}</span>}
              <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          )}
          {live && <span class="sync" title="Draft mirrors the desktop editor" />}
          <span class="spacer" />
          <button
            type="button"
            class={`icon-btn${keysShown ? " on" : ""}`}
            onClick={() => setKeysOpen(!keysShown)}
            aria-label="Keys"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="5" width="15" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path d="M5.5 8h1M9.5 8h1M13.5 8h1M6.5 12h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
          {working && live && !empty && !terminal && (
            <button
              class="icon-btn follow"
              type="button"
              disabled={sending}
              onClick={(e) => submit(e, true)}
              title="Send after this turn (follow-up, Ctrl+Enter)"
              aria-label="Send after this turn"
            >
              →
            </button>
          )}
          {stoppable ? (
            <button class="send stop" type="button" disabled={sending} onClick={stop} aria-label="Stop">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button class={`send${empty && !terminal ? " idle" : ""}`} type="submit" disabled={sending} aria-label="Send">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </form>
      {sheet && (
        <ModelSheet
          block={block}
          roles={roles}
          current={item?.live ?? null}
          bridged={live}
          send={send}
          onClose={() => setSheet(false)}
          onCycle={async () => {
            setSheet(false);
            await send("keys", { keys: ["ctrl+p"] });
          }}
        />
      )}
    </div>
  );
}

function Session({ block }: { block: string }) {
  const [view, setView] = useState<View>("chat");
  // The server answers a chat request for a non-omp block with its screen.
  const { state, chat, live, queued, btw, setBtw, screen, draft, doc, online } = useStream(block, view);
  const item = state?.projects.flatMap((p) => p.items).find((i) => i.block === block);
  const isOmp = !!item?.agent;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const now = useNow(5000);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat, live, queued, screen, view]);

  const a = item?.agent;
  const shownState = item?.status ?? undefined;
  const working = shownState === "working";
  return (
    <div class="screen">
      <header class="bar session-bar">
        <a
          class="back"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            backToList();
          }}
        >
          ‹
        </a>
        <div class="session-title">
          {item ? <Title item={item} /> : <div class="row-title">{block}</div>}
          <div class="row-meta">
            <Dot state={shownState} />
            <span>{shownState ?? (item?.doc ? "note" : "shell")}</span>
            {item?.status && <span class="muted">{age(item.since, now)}</span>}
            {item && <span class="muted">{item.project}</span>}
            {item?.branch && (
              <span class="branch" title="git branch">
                {"\u{e0a0}"} {item.branch}
              </span>
            )}
            {!online && <span class="c-blocked">offline</span>}
          </div>
          {extensionOutdated(item?.live) && <div class="muted small">extension outdated — restart this omp</div>}
        </div>
        <button class="ghost" title="Show this pane on the desktop" onClick={() => post(`/api/blocks/${block}/focus`, {})}>
          ⌖
        </button>
        {item && (
          <button
            class="ghost danger"
            title="Close this block"
            aria-label="Close this block"
            onClick={async () => {
              const name = `${item.tag ? `${item.tag}: ` : ""}${item.title}`;
              const warn = working ? "\n\nIt is working right now; the running turn stops." : shownState === "blocked" ? "\n\nIt is waiting on you." : "";
              if (!confirm(`Close “${name}”?\n\nThis closes it in Tern on the desktop too.${warn}`)) return;
              const err = await post(`/api/blocks/${block}/close`, {});
              if (err) alert(`Close failed: ${err}`);
              else backToList();
            }}
          >
            ✕
          </button>
        )}
      </header>
      <div
        class="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {isOmp && view === "screen" && (
          <button class="raw-note" onClick={() => setView("chat")}>
            Raw screen · back to chat
          </button>
        )}
        {state && !item && <div class="empty">This block is gone.</div>}
        {item?.doc ? (
          doc ? (
            doc.missing ? (
              <div class="empty">The file is gone.</div>
            ) : doc.markdown ? (
              <Markdown class="msg md doc" text={doc.text} />
            ) : (
              <pre class="term">{doc.text}</pre>
            )
          ) : (
            <div class="empty">Loading…</div>
          )
        ) : chat && view === "chat" ? (
          <>
            <Chat entries={chat} block={block} rewind={can(item?.live, "rewind")} />
            {live && <Markdown class="msg assistant md live" text={live} />}
            {queued.map((q, i) => (
              <div key={i} class="queued" title={q.followUp ? "Sent once the running turn ends" : "Steers the running turn"}>
                <span class="queued-mark">{q.followUp ? "→" : "↳"}</span>
                <span class="queued-text">{q.text}</span>
              </div>
            ))}
          </>
        ) : screen != null ? (
          screen.html ? (
            // Tern's colored capture: <pre> and styled <span>s; scripts and links are stripped.
            <div class="term" dangerouslySetInnerHTML={{ __html: screenHtml(screen.text) }} />
          ) : (
            <pre class="term">{screen.text}</pre>
          )
        ) : (
          <div class="empty">Loading…</div>
        )}
        {doc?.clipped && <div class="muted small">Showing the first 512 KB.</div>}
        {working && <div class="working">working · {item ? age(item.since, now) : ""}</div>}
        {item?.live && <JobsStrip jobs={item.live.jobs} now={now} />}
      </div>
      {!item?.doc && (
        <Composer
          block={block}
          item={item}
          draft={draft}
          roles={state?.roles ?? []}
          btw={btw}
          setBtw={setBtw}
          raw={isOmp ? { on: view === "screen", toggle: () => setView(view === "screen" ? "chat" : "screen") } : undefined}
        />
      )}
    </div>
  );
}

/** This browser's pairing: null while unknown, false once the server says "not paired". */
function usePaired(): boolean | null {
  const [paired, setPaired] = useState<boolean | null>(null);
  useEffect(() => {
    // Recheck on return to the app: the pairing link may have been opened in the meantime.
    const check = () => document.visibilityState === "visible" && void checkPaired().then(setPaired);
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
  return paired;
}

function NotPaired() {
  return (
    <div class="empty">
      <p>
        Not paired: open the pairing link from the installer on this device. On the desktop, <code>bun server.ts pair</code> in the
        tern-awui folder prints its path.
      </p>
    </div>
  );
}

function App() {
  const block = useRoute();
  const wide = useWide();
  const paired = usePaired();
  if (paired === false) return <NotPaired />;
  if (!wide) return block ? <Session key={block} block={block} /> : <Home />;
  return (
    <div class="desk">
      <aside class="desk-side">
        <Home wide selected={block} />
      </aside>
      <main class="desk-main">
        {block ? <Session key={block} block={block} /> : <div class="empty desk-empty">Pick a session on the left.</div>}
      </main>
    </div>
  );
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
  // A tapped notification while the app is open: jump to its session.
  navigator.serviceWorker.addEventListener("message", (e) => {
    const url: unknown = e.data?.open;
    if (typeof url === "string") location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "#/";
  });
}

render(<App />, document.getElementById("app") as HTMLElement);
