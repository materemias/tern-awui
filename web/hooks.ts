// The app's hooks: the clock, the route and back navigation, the layout, and the server stream.
import { useEffect, useState } from "preact/hooks";
import type { Btw, ChatEntry, ContextUse, Doc, Item, Run, State, StretchState, Subagent } from "./api";
import { backStep, parseRoute, trackOrigin, type Route } from "./lib";
import { applyStatePatch } from "../lib/state-patch";

/** The app icon counts updates not seen yet: finished turns and waits on you. */
function setBadge(count: number) {
  if (!("setAppBadge" in navigator)) return;
  void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

declare const __TERN_AWUI_BUILD__: string | undefined;
/** The build this page runs (build.ts); "" outside a build (tests), which never reloads. */
const BUILD = typeof __TERN_AWUI_BUILD__ === "string" ? __TERN_AWUI_BUILD__ : "";
let reloading: number | undefined;
/**
 * The server serves another build (`bun run build` ran): reload into it, once the composer holds
 * no unsent text or images, so nothing typed is lost.
 */
function reloadInto(build: string) {
  if (!BUILD || !build || build === BUILD || reloading !== undefined) return;
  const tryReload = () => {
    const typing = [...document.querySelectorAll("textarea")].some((t) => t.value.trim()) || document.querySelector(".pasted-item");
    if (typing) return;
    clearInterval(reloading);
    location.reload();
  };
  reloading = window.setInterval(tryReload, 2000);
  tryReload();
}

export type Draft = { live: boolean; text: string };
export type View = "chat" | "screen" | "subagents";

/** The clock, ticking every `intervalMs` while the page is visible; a hidden page's timer stops, and it catches up on return. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let t: number | undefined;
    const sync = () => {
      clearInterval(t);
      t = undefined;
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      t = window.setInterval(() => setNow(Date.now()), intervalMs);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [intervalMs]);
  return now;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = (e: HashChangeEvent) => {
      trackOrigin(origins, new URL(e.oldURL).hash, location.hash);
      setRoute(parseRoute(location.hash));
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** The screen each screen was entered from, so ‹ can pop history instead of stacking (see `backStep`). */
export const origins = new Map<string, string>();

/** Leaves `route` for the screen above it without stacking a history entry that back would reopen. */
export function goBack(route: Route) {
  const { target, pop } = backStep(origins, route);
  if (pop) history.back();
  else location.replace(target);
}

/**
 * The list keeps a guard entry on top of its history entry. The first back gesture pops only
 * the guard: it is pushed again and a hint shows. A second back within EXIT_WINDOW_MS leaves.
 */
const EXIT_WINDOW_MS = 2000;
export function useExitGuard(enabled: boolean): boolean {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    if (history.state?.guard !== true) history.pushState({ guard: true }, "");
    let armedUntil = 0;
    let timer: number | undefined;
    const onPop = () => {
      if (parseRoute(location.hash).view !== "list" || history.state?.guard === true) return;
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
export function useWide(): boolean {
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

/**
 * One SSE connection: always the block list, plus the open block's chat or screen and draft, its
 * subagent list (`view` "subagents"), or one subagent's chat (`sub`).
 */
export function useStream(block: string | null, view: View, sub: string | null = null) {
  const [state, setState] = useState<State | null>(null);
  const [chat, setChat] = useState<ChatEntry[] | null>(null);
  const [subagents, setSubagents] = useState<Subagent[] | null>(null);
  const [btw, setBtw] = useState<Btw | null>(null);
  const [screen, setScreen] = useState<{ text: string; html: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  /** The assistant message omp is writing now; kept after it ends until the transcript has it. */
  const [live, setLive] = useState<string | null>(null);
  /** Prompts omp holds for the running turn: steers, or follow-ups for after it ends. */
  const [queued, setQueued] = useState<{ text: string; followUp: boolean }[]>([]);
  /** The running turn as omp's working row shows it: its start and the current tool's intent. */
  const [run, setRun] = useState<Run | null>(null);
  /** The session's context gauge, sent on its own as omp updates it (every 2 s while it works). */
  const [context, setContext] = useState<ContextUse | null>(null);
  /** The pane's open stretches as its omp (stretch.ts) reports them; null when it reports none. */
  const [stretch, setStretch] = useState<StretchState | null>(null);
  const [online, setOnline] = useState(false);
  // The gauge belongs to the block: switching chat and Raw on one block keeps it until the new stream resends it.
  useEffect(() => setContext(null), [block]);
  useEffect(() => {
    setChat(null);
    setSubagents(null);
    setScreen(null);
    setLive(null);
    setQueued([]);
    setStretch(null);
    setRun(null);
    const qs = block ? `?block=${block}&view=${view}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}` : "";
    let es: EventSource | null = null;
    let liveEnded = false;
    let liveTimer: number | undefined;
    // A failed HTTP response (502 while the server restarts) closes EventSource for good.
    let retryTimer: number | undefined;
    let retryMs = 1000;
    const open = () => {
      // Live text and the queue may have moved on while hidden; the stream resends what's current.
      setLive(null);
      setQueued([]);
      const src = new EventSource(`/api/stream${qs}`);
      es = src;
      src.onopen = () => {
        // Native reconnects also need a fresh snapshot: empty live text and queues aren't resent.
        clearTimeout(liveTimer);
        retryMs = 1000;
        liveEnded = false;
        setLive(null);
        setQueued([]);
        setOnline(true);
      };
      src.onerror = () => {
        setOnline(false);
        if (src.readyState !== EventSource.CLOSED || es !== src || document.visibilityState !== "visible") return;
        clearTimeout(retryTimer);
        retryTimer = window.setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
      // The first `state` is the whole list; after it the stream sends `patch`: changed rows and the order.
      let current: State | null = null;
      const take = (s: State) => {
        current = s;
        setState(s);
        setBadge(s.badge);
        reloadInto(s.app);
      };
      src.addEventListener("state", (e) => take(JSON.parse(e.data)));
      src.addEventListener("patch", (e) => {
        const next = current && applyStatePatch<State, Item>(current, JSON.parse(e.data));
        if (next) return take(next);
        // A patch for a list this page doesn't hold: reconnect for a full copy.
        src.close();
        if (es === src) open();
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
      src.addEventListener("run", (e) => setRun(JSON.parse(e.data)));
      src.addEventListener("context", (e) => setContext(JSON.parse(e.data)));
      src.addEventListener("stretch", (e) => setStretch(JSON.parse(e.data)));
      src.addEventListener("doc", (e) => setDoc(JSON.parse(e.data)));
      src.addEventListener("subagents", (e) => setSubagents(JSON.parse(e.data)));
    };
    const close = () => {
      clearTimeout(retryTimer);
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
      else if (!es || es.readyState === EventSource.CLOSED) {
        clearTimeout(retryTimer);
        open();
      }
    };
    if (document.visibilityState === "visible") open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      es?.close();
      clearTimeout(liveTimer);
      clearTimeout(retryTimer);
      clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [block, view, sub]);
  return { state, chat, subagents, live, queued, run, context, btw, setBtw, screen, draft, doc, online, stretch };
}
