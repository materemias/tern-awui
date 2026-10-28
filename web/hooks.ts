// The app's hooks: the clock, the route and back navigation, the layout, and the server stream.
import { useEffect, useState } from "preact/hooks";
import type { Btw, ChatEntry, ContextUse, Doc, Item, Run, State, StretchState, Subagent, Voice } from "./api";
import { backStep, parseRoute, trackOrigin, type Route } from "./lib";
import { applyStatePatch } from "../lib/state-patch";

/** The app icon counts updates not seen yet: finished turns and waits on you. */
function setBadge(count: number) {
  if (!("setAppBadge" in navigator)) return;
  void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

/** Parse only the dismissal fields; an incomplete or malformed snapshot cannot prove a notification was read. */
function parseUnseenNotificationTags(value: unknown): Set<string> | null {
  if (!value || typeof value !== "object" || !("badge" in value) || typeof value.badge !== "number"
    || !Number.isSafeInteger(value.badge) || value.badge < 0 || !("projects" in value) || !Array.isArray(value.projects)) return null;
  const unseen = new Set<string>();
  const projects: unknown[] = value.projects;
  for (const project of projects) {
    if (!project || typeof project !== "object" || !("items" in project) || !Array.isArray(project.items)) return null;
    const items: unknown[] = project.items;
    for (const item of items) {
      if (!item || typeof item !== "object" || !("block" in item) || typeof item.block !== "string" || !("unseen" in item)) return null;
      if (item.unseen !== null && item.unseen !== "done" && item.unseen !== "blocked") return null;
      if (item.unseen) unseen.add(`b${item.block}`);
    }
  }
  // Failed pane listings can omit rows without clearing their unread badge count.
  return value.badge === unseen.size ? unseen : null;
}

// Must stay in the entry bundle: build.ts fails if a lazy chunk holds the build id (chunks are cached as immutable).
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

/** Streams stay open while hidden as long as something holds them: a voice call needs its phase with the screen off. */
let holds = 0;
const holdReleased = new Set<() => void>();
/** Keeps the stream open while hidden until the returned release is called (once). */
export function holdStream(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    for (const fn of holdReleased) fn();
  };
}

/**
 * Keeps the screen on while `on` (Screen Wake Lock; nothing where the browser lacks it). The
 * browser drops the lock whenever the page hides, so it is taken again when the page comes back.
 */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !navigator.wakeLock) return;
    let lock: WakeLockSentinel | null = null;
    let taking = false;
    let done = false;
    const take = async () => {
      if (done || taking || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      taking = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (done) void next.release().catch(() => {});
        else lock = next;
      } catch {
        // Refused (battery saver, no permission): the call goes on with the screen's own timeout.
      } finally {
        taking = false;
      }
    };
    void take();
    document.addEventListener("visibilitychange", take);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => {});
    };
  }, [on]);
}

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
  /** The pane's voice call as omp reports it; `ended` once, then null on the next stream. */
  const [voice, setVoice] = useState<Voice | null>(null);
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
    setVoice(null);
    setRun(null);
    const qs = block ? `?block=${block}&view=${view}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}` : "";
    let es: EventSource | null = null;
    let liveEnded = false;
    let liveTimer: number | undefined;
    // A failed HTTP response (502 while the server restarts) closes EventSource for good.
    let retryTimer: number | undefined;
    let retryMs = 1000;
    // Only a visible, connected stream's fresh state may dismiss a system notification.
    let notificationState: State | null = null;
    let notificationEpoch = 0;
    const canDismiss = () => notificationState && document.visibilityState === "visible" && es?.readyState === EventSource.OPEN;
    const dismissNotifications = async () => {
      if (!canDismiss() || !("serviceWorker" in navigator)) return;
      const epoch = notificationEpoch;
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration || !canDismiss() || epoch !== notificationEpoch) return;
        const notifications = (await registration.getNotifications()).filter((n) => /^b\d+$/.test(n.tag));
        if (!notifications.length || !canDismiss() || epoch !== notificationEpoch) return;
        // A push may appear during discovery, before its worker message or unseen SSE update.
        const response = await fetch("/api/state", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const unseen = parseUnseenNotificationTags(await response.json());
        if (!unseen || !canDismiss() || epoch !== notificationEpoch) return;
        // Preserve unread updates from SSE that arrived while the state request was pending.
        const currentUnseen = parseUnseenNotificationTags(notificationState);
        if (!currentUnseen) return;
        for (const notification of notifications) {
          if (!unseen.has(notification.tag) && !currentUnseen.has(notification.tag)) notification.close();
        }
      } catch {
        // Browser APIs and state requests can fail; leave notifications intact when unsure.
      }
    };
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== "notification-shown" || document.visibilityState !== "visible" || !es || es.readyState === EventSource.CLOSED) return;
      // Push delivery may beat the unseen SSE update. Reconnect for a full snapshot before closing.
      notificationState = null;
      es.close();
      clearTimeout(retryTimer);
      open();
    };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", onWorkerMessage);
    const open = () => {
      notificationState = null;
      notificationEpoch++;
      // Live text and the queue may have moved on while hidden; the stream resends what's current.
      setLive(null);
      setQueued([]);
      const src = new EventSource(`/api/stream${qs}`);
      es = src;
      src.onopen = () => {
        if (es !== src) return;
        notificationEpoch++;
        notificationState = null;
        // Native reconnects also need a fresh snapshot: empty live text and queues aren't resent.
        clearTimeout(liveTimer);
        retryMs = 1000;
        liveEnded = false;
        setLive(null);
        setQueued([]);
        setOnline(true);
      };
      src.onerror = () => {
        if (es !== src) return;
        notificationEpoch++;
        notificationState = null;
        setOnline(false);
        // Hidden pages let the stream go, unless a call holds it: then the phase must keep coming.
        if (src.readyState !== EventSource.CLOSED || es !== src || (document.visibilityState !== "visible" && !holds)) return;
        clearTimeout(retryTimer);
        retryTimer = window.setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
      // The first `state` is the whole list; after it the stream sends `patch`: changed rows and the order.
      let current: State | null = null;
      const take = (s: State) => {
        if (es !== src) return;
        current = s;
        if (document.visibilityState === "visible") {
          notificationState = s;
          void dismissNotifications();
        }
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
      src.addEventListener("voice", (e) => setVoice(JSON.parse(e.data)));
      src.addEventListener("doc", (e) => setDoc(JSON.parse(e.data)));
      src.addEventListener("subagents", (e) => setSubagents(JSON.parse(e.data)));
    };
    const close = () => {
      notificationState = null;
      notificationEpoch++;
      clearTimeout(retryTimer);
      es?.close();
      es = null;
      setOnline(false);
    };
    // A hidden app (switched away, screen off, tab in the background) holds no stream: no data
    // flows, the server stops live text for it, and its sessions count as unseen again, so
    // notifications and badges work for them. A short grace keeps receiving brief background updates.
    let hideTimer: number | undefined;
    const onVisibility = () => {
      clearTimeout(hideTimer);
      if (document.visibilityState === "hidden") {
        notificationState = null;
        notificationEpoch++;
        if (!holds) hideTimer = window.setTimeout(close, HIDDEN_GRACE_MS);
      } else {
        // Even a brief background interval invalidates the dismissal snapshot. Request a full one.
        es?.close();
        clearTimeout(retryTimer);
        open();
      }
    };
    // A call ending while hidden lets the stream go as hiding would have.
    const onRelease = () => {
      if (holds || document.visibilityState !== "hidden" || !es) return;
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(close, HIDDEN_GRACE_MS);
    };
    holdReleased.add(onRelease);
    if (document.visibilityState === "visible") open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      notificationState = null;
      notificationEpoch++;
      es?.close();
      es = null;
      clearTimeout(liveTimer);
      clearTimeout(retryTimer);
      clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      holdReleased.delete(onRelease);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onWorkerMessage);
    };
  }, [block, view, sub]);
  return { state, chat, subagents, live, queued, run, context, btw, setBtw, screen, draft, doc, online, stretch, voice };
}
