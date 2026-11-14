// The first-run guide: a short tour over the session list. Each step darkens the screen around one
// control (a spotlight) and explains it in a card beside it; a step without a target, or whose
// target isn't on screen, shows its card in the middle. It opens once per device and the dock's
// Guide button opens it again.
import { useLayoutEffect, useRef, useState } from "preact/hooks";

const KEY = "tern-mobile:guide";

/** `target`: selectors tried in order; the first on the page gets the spotlight. */
type Step = { target?: string[]; title: string; body: string; desk?: string };

const STEPS: Step[] = [
  {
    title: "Your Tern sessions, in your pocket",
    body: "This is the same list of omp sessions you have open in Tern on your desktop. A session you start here opens a Tern tab there, and one you start there shows up here.",
  },
  {
    target: [".list .row.st-blocked", ".list .row.st-working", ".list .row"],
    title: "Red needs you, green is working",
    body: "Each row is a session. A red dot waits on you, a green one is working, and a coloured icon means it finished since you last looked. Under a busy row: what it's doing, or the question it asks. Tap a row to open its chat; press and hold for its last summary.",
    desk: "Each row is a session. A red dot waits on you, a green one is working, and a coloured icon means it finished since you last looked. Under a busy row: what it's doing, or the question it asks. Click a row to open its chat on the right; rest the pointer on it for its last summary.",
  },
  {
    target: [".list-bar .counts"],
    title: "Everything at a glance",
    body: "How many sessions wait on you, work, or sit idle right now.",
  },
  {
    target: ['.dock [class*="push-"]'],
    title: "Hear when it matters",
    body: "Turn on notifications to learn when a session finishes or needs an answer, even with the app closed.",
  },
  {
    target: [".list-bar .new-omp"],
    title: "Start or resume a session",
    body: "Start omp in one of your projects. The same sheet lists the panes you parked and the closed sessions you can resume.",
  },
  {
    target: [".dock .hide-old"],
    title: "Keep the list short",
    body: "Hide sessions older than a day; tap again to bring them back.",
    desk: "Hide sessions older than a day; click again to bring them back.",
  },
  {
    title: "Inside a session",
    body: "Reply or steer from the box at the bottom, and answer an agent's questions right on their cards. The microphone starts a voice call with the session. Swipe sideways to reach the next session; P parks it in Tern and ✕ closes it.",
    desk: "Reply or steer from the box at the bottom, and answer an agent's questions right on their cards. The microphone starts a voice call with the session. Alt+← and Alt+→ switch sessions, Ctrl+\\ folds this sidebar; P parks a session in Tern and ✕ closes it.",
  },
];

/** Whether this device has finished or skipped the guide. */
export function guideDone(): boolean {
  return localStorage.getItem(KEY) === "done";
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

export function Guide({ wide, onClose }: { wide: boolean; onClose: () => void }) {
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const next = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = STEPS[at];
  const last = at === STEPS.length - 1;

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
      else if (e.key === "ArrowRight") setAt((i) => Math.min(i + 1, STEPS.length - 1));
      else if (e.key === "ArrowLeft") setAt((i) => Math.max(i - 1, 0));
      else if (e.key === "Tab") {
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

  // The spotlight follows its target as the list moves under it: a resize, a scroll, or a list
  // update that re-renders, moves or replaces it.
  useLayoutEffect(() => {
    const find = () => step.target?.map((s) => document.querySelector(s)).find((e) => e !== null) ?? null;
    find()?.scrollIntoView({ block: "nearest" });
    let watched: Element | null = null;
    const update = () => {
      const el = find();
      if (el !== watched) {
        sizes.disconnect();
        if (el) sizes.observe(el);
        watched = el;
      }
      const to = measure(el);
      setBox((b) => (b && to && b.top === to.top && b.left === to.left && b.width === to.width && b.height === to.height ? b : to));
    };
    const sizes = new ResizeObserver(update);
    update();
    const changes = new MutationObserver(update);
    changes.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    next.current?.focus();
    return () => {
      sizes.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [at]);

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

  return (
    <div class="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      {box ? (
        <div class="guide-hole" style={`top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${box.height}px`} />
      ) : (
        <div class="guide-dim" />
      )}
      <div ref={card} class="guide-card" style={`width:${width}px;${place}`}>
        <div class="guide-step muted">
          {at + 1} / {STEPS.length}
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
            <button class="ghost" onClick={() => setAt(at - 1)}>
              Back
            </button>
          )}
          <button ref={next} class="primary" onClick={() => (last ? finish() : setAt(at + 1))}>
            {last ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
