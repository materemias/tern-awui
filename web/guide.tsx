// The first-run guide: a short tour of the session list and of a session. Each step darkens the
// screen around one control (a spotlight) and explains it in a card beside it; a step without a
// target, or whose target isn't on screen, shows its card in the middle. The app hosts it
// (GuideHost), so it survives a phone moving between the list and a session: a step names the
// screen it needs and the guide goes there. It opens once per device and the dock's Guide button
// opens it again.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { goBack } from "./hooks";
import { parseRoute, type Route } from "./lib";

const KEY = "tern-mobile:guide";

/**
 * `target`: selectors tried in order; the first on the page gets the spotlight. `view`: the screen
 * the step needs; a phone goes there first, and the desktop opens a session for a "session" step.
 * `optional`: a step whose target isn't on the page is skipped instead of shown in the middle.
 */
type Step = { target?: string[]; view?: "list" | "session"; optional?: true; title: string; body: string; desk?: string };

const STEPS: Step[] = [
  {
    title: "Your Tern sessions, in your pocket",
    body: "The omp sessions you have open in Tern on your desktop. A session you start here opens a Tern tab there, and one you start there shows up here.",
  },
  {
    target: [".list .row.st-blocked", ".list .row.st-working", ".list .row"],
    view: "list",
    title: "Red needs you, green is working",
    body: "Each row is a session. A red dot waits on you, a green one is working, and a coloured icon means it finished since you last looked. Under a busy row: what it's doing, or the question it asks. Tap a row to open its chat; press and hold for its last summary.",
    desk: "Each row is a session. A red dot waits on you, a green one is working, and a coloured icon means it finished since you last looked. Under a busy row: what it's doing, or the question it asks. Click a row to open its chat on the right; rest the pointer on it for its last summary.",
  },
  {
    target: [".list-bar .counts"],
    view: "list",
    title: "Everything at a glance",
    body: "How many sessions wait on you, work, or sit idle right now.",
  },
  {
    target: [".wait-strip"],
    view: "list",
    optional: true,
    title: "Set aside for later",
    body: "Sessions you set aside in Tern, with what each waits for. The count shows the ones back on you.",
  },
  {
    target: [".list-bar .new-omp"],
    view: "list",
    title: "Start or resume a session",
    body: "Start omp in a project; the same sheet holds parked panes and closed sessions to resume.",
  },
  {
    target: ['.dock [class*="push-"]'],
    view: "list",
    optional: true,
    title: "Hear when it matters",
    body: "Turn on notifications to learn when a session finishes or needs an answer, even with the app closed.",
  },
  {
    target: [".dock .hide-old"],
    view: "list",
    title: "Keep the list short",
    body: "Hide sessions older than a day; tap again to bring them back.",
    desk: "Hide sessions older than a day; click again to bring them back.",
  },
  {
    target: [".composer"],
    view: "session",
    title: "Reply or steer",
    body: "Write to the session here. While it works, what you send steers the running turn.",
  },
  {
    target: [".approval", ".ask:not(.done)"],
    view: "session",
    optional: true,
    title: "Answer on the card",
    body: "Questions and tool approvals arrive as cards in the chat: pick an answer or allow the call right there.",
  },
  {
    target: [".composer .voice-btn"],
    view: "session",
    optional: true,
    title: "Talk instead of typing",
    body: "The microphone starts a voice call with the session.",
  },
  {
    target: [".session-more", ".session-bar"],
    view: "session",
    title: "Park it or show it",
    body: "⋯ parks the session in Tern or shows it on your desktop, and ✕ closes it. Swipe sideways for the next session.",
    desk: "Park the session in Tern or show it on your desktop from here, and ✕ closes it. Alt+← and Alt+→ switch sessions; Ctrl+\\ folds the sidebar.",
  },
];

/** How long an optional step waits for its target (a screen still loading) before it is skipped. */
export const OPTIONAL_WAIT_MS = 800;

/** Whether this device has finished or skipped the guide. */
export function guideDone(): boolean {
  return localStorage.getItem(KEY) === "done";
}

/** Opens the mounted GuideHost's guide; null while none is mounted. */
let openHost: (() => void) | null = null;

/** Opens the guide again (the dock's Guide button). */
export function openGuide() {
  openHost?.();
}

/**
 * The guide's place in the app, rendered once beside the screens. It opens by itself on a device
 * that hasn't seen it, unless the desktop sidebar starts as the rail, which shows no guide.
 */
export function GuideHost({ route, wide, rail }: { route: Route; wide: boolean; rail: boolean }) {
  const [open, setOpen] = useState(() => !rail && !guideDone());
  useEffect(() => {
    openHost = () => setOpen(true);
    return () => {
      openHost = null;
    };
  }, []);
  return open ? <Guide route={route} wide={wide} onClose={() => setOpen(false)} /> : null;
}

/** The session a "session" step opens when none was open during the tour: the first red row, else the first row. */
function firstRow(): string | null {
  const row = document.querySelector(".list .row.st-blocked") ?? document.querySelector(".list .row");
  const to = parseRoute(row?.getAttribute("href") ?? "");
  return to.view === "session" ? to.block : null;
}

type Box = { top: number; left: number; width: number; height: number };

/** Where the spotlight goes: around `el`, padded, or null (no target on the page) to center the card. */
function measure(el: Element | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const pad = 6;
  return { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** The least height the card keeps on a short screen: its text's first lines and its buttons. */
const CARD_MIN_HEIGHT = 200;

export function Guide({ route, wide, onClose }: { route: Route; wide: boolean; onClose: () => void }) {
  const [at, setAt] = useState(0);
  /** The way the tour moves (1 forward, -1 back), so a skipped step passes on in that direction. */
  const dir = useRef(1);
  /** Optional steps skipped for a missing target; the counter leaves them out. */
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set<number>());
  /** An optional step waiting for its target: its card stays hidden until it shows or is skipped. */
  const [seeking, setSeeking] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const next = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  /** The session open last during the tour, which its "session" steps return to. */
  const session = useRef<string | null>(null);
  if ("block" in route) session.current = route.block;
  const step = STEPS[at];
  const last = at === STEPS.length - 1;

  function go(to: number) {
    dir.current = to < at ? -1 : 1;
    setAt(to);
  }

  function finish() {
    localStorage.setItem(KEY, "done");
    onClose();
  }

  // A modal: Tab and Shift+Tab cycle through the card's buttons, never the dimmed app behind, and
  // closing hands focus back to what had it before the guide opened. A layout effect declared first,
  // so it reads that focus before the step's effect moves it to Next, and holds Tab from the start.
  // Its keys are its own: caught first and stopped, so Alt+←/→ doesn't switch sessions behind it,
  // and Ctrl+\ doesn't fold the sidebar mid-tour.
  useLayoutEffect(() => {
    const before = document.activeElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") {
        dir.current = 1;
        setAt((i) => Math.min(i + 1, STEPS.length - 1));
      } else if (e.key === "ArrowLeft") {
        dir.current = -1;
        setAt((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab") {
        const buttons = [...(card.current?.querySelectorAll("button") ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const to = i < 0 ? (e.shiftKey ? buttons.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[to]?.focus();
      } else if (e.key !== "\\" || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // The screen the step needs. A phone shows one at a time: back to the list as ‹ would, or into
  // a session as a tap on its row would, so back still leads where it should after the tour. The
  // desktop always shows the list and only needs a session opened.
  useEffect(() => {
    if (step.view === "list" && !wide && route.view !== "list") {
      if (route.view === "session") goBack(route);
      else location.replace("#/");
    } else if (step.view === "session" && route.view !== "session") {
      const block = session.current ?? firstRow();
      if (block) location.hash = `#/b/${block}`;
    }
  }, [at, route, wide]);

  // The spotlight follows its target as the screen moves under it: a resize, a scroll, a list
  // update that re-renders, moves or replaces it, or a screen the step just opened. An optional
  // step whose target doesn't turn up in time passes on.
  useLayoutEffect(() => {
    const find = () => step.target?.map((s) => document.querySelector(s)).find((e) => e !== null) ?? null;
    let watched: Element | null = null;
    let grace: number | undefined;
    const update = () => {
      const el = find();
      if (el !== watched) {
        sizes.disconnect();
        if (el) {
          sizes.observe(el);
          el.scrollIntoView({ block: "nearest" });
        }
        watched = el;
      }
      if (el && step.optional) {
        clearTimeout(grace);
        setSeeking(false);
        setSkipped((s) => (s.has(at) ? new Set([...s].filter((i) => i !== at)) : s));
      }
      const to = measure(el);
      setBox((b) => (b && to && b.top === to.top && b.left === to.left && b.width === to.width && b.height === to.height ? b : to));
    };
    const sizes = new ResizeObserver(update);
    if (step.optional && !find()) {
      setSeeking(true);
      grace = window.setTimeout(() => {
        if (find()) return;
        setSkipped((s) => new Set(s).add(at));
        setAt(at + dir.current);
      }, OPTIONAL_WAIT_MS);
    } else setSeeking(false);
    update();
    const changes = new MutationObserver(update);
    changes.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearTimeout(grace);
      sizes.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [at]);

  // Before paint, as the card shows: a key pressed right away already reaches Next.
  useLayoutEffect(() => {
    if (!seeking) next.current?.focus();
  }, [at, seeking]);

  // The card sits below a target in the upper half of the screen and above one in the lower half,
  // as wide as the phone allows, centered on the target and kept inside the window. On a short
  // screen it keeps at least CARD_MIN_HEIGHT (over the target if it must) and scrolls inside, so
  // Skip, Back and Next stay in reach.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(340, vw - 24);
  const room = Math.min(CARD_MIN_HEIGHT, vh - 24);
  let place: string;
  if (!box) place = `left:${(vw - width) / 2}px;top:50%;transform:translateY(-50%);max-height:${vh - 24}px`;
  else {
    const left = Math.max(12, Math.min(box.left + box.width / 2 - width / 2, vw - width - 12));
    if (box.top + box.height / 2 < vh / 2) {
      const top = Math.max(12, Math.min(box.top + box.height + 12, vh - 12 - room));
      place = `left:${left}px;top:${top}px;max-height:${vh - top - 12}px`;
    } else {
      const bottom = Math.max(12, Math.min(vh - box.top + 12, vh - 12 - room));
      place = `left:${left}px;bottom:${bottom}px;max-height:${vh - bottom - 12}px`;
    }
  }
  // Counted as shown: the optional steps skipped so far are left out.
  const before = [...skipped].filter((i) => i < at).length;

  return (
    <div class="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      {box ? (
        <div class="guide-hole" style={`top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${box.height}px`} />
      ) : (
        <div class="guide-dim" />
      )}
      <div ref={card} class="guide-card" hidden={seeking} style={`width:${width}px;${place}`}>
        <div class="guide-step muted">
          {at + 1 - before} / {STEPS.length - skipped.size}
        </div>
        <h3 id="guide-title">{step.title}</h3>
        <p>{(wide && step.desk) || step.body}</p>
        <div class="guide-actions">
          {!last && (
            <button class="guide-skip" onClick={finish}>
              Skip
            </button>
          )}
          <span class="spacer" />
          {at > 0 && (
            <button class="ghost" onClick={() => go(at - 1)}>
              Back
            </button>
          )}
          <button ref={next} class="primary" onClick={() => (last ? finish() : go(at + 1))}>
            {last ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
