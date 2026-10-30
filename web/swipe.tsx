// Sideways moves between sessions, and between a session's subagents: the screen follows a
// horizontal swipe, the neighbour's name shows in the gap it opens, and a release past a third of
// the width (or a flick) moves there. Turning the finger up or down mid-swipe opens a wheel of
// all siblings instead: each row of travel steps the highlight, holding near the top or bottom
// keeps stepping, and lifting opens the highlighted one. Alt+← and Alt+→ move from a keyboard.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { goSideways } from "./hooks";

/** A sibling screen: where it is, and what the gap and the wheel show of it. */
export type Side = { href: string; label: ComponentChildren };
/** A screen's siblings in order, and its own place among them (-1 when it isn't, so it has no neighbours). */
export type Siblings = { items: Side[]; index: number };

/** A release past this share of the width moves on. */
const COMMIT_SHARE = 0.3;
/** A flick this fast (px/ms) and this long (px) moves on whatever the share. */
const FLICK_SPEED = 0.5;
const FLICK_MIN = 40;
/** A finger still for this long before lifting has no flick left in it. */
const FLICK_STALE_MS = 100;
/** Movement before the gesture picks its axis. */
const SLOP = 10;
/** Touches starting this close to a side edge belong to the system's back gesture. */
const EDGE = 24;
/** Past an end the screen gives this share of the finger's travel: a bounce, not a move. */
const RUBBER = 0.2;
const OUT_MS = 160;
/**
 * The wheel opens once a drag is this far sideways and the finger then turns this far up or down;
 * dragging back nearer than half of PICK_DX closes it again.
 */
const PICK_DX = 80;
const PICK_DY = 24;
/** A wheel row's height, and the finger travel that steps the highlight one row. */
const ROW = 48;
/** A finger held this close to the top or bottom keeps stepping, faster the longer it stays. */
const HOLD_ZONE = 64;
const HOLD_FIRST_MS = 220;
const HOLD_MIN_MS = 60;
/** The share of the width the screen moves aside for the wheel (style.css sizes the wheel to it). */
const WHEEL_SHARE = 0.62;

/** The side the next screen comes in from, set by a move just before it navigates. */
let entering: -1 | 1 | 0 = 0;

/**
 * Whether a touch on `target` may start a swipe: not in a field, a text selection, an overlay
 * (the image view pages with its own swipes) or anything that scrolls sideways (code, tables).
 * The chat's own scroller counts as vertical: its computed `overflow-x` is `auto` too, and a
 * pixel of sideways overflow there must not switch swiping off for the whole chat.
 */
function swipeable(target: EventTarget | null, root: HTMLElement): boolean {
  if (getSelection()?.isCollapsed === false) return false;
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return false;
    const s = getComputedStyle(el);
    if (s.position === "fixed") return false;
    const sideways = (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1;
    if (sideways && el.scrollHeight <= el.clientHeight + 1) return false;
  }
  return true;
}

/**
 * Wraps a screen so it swipes to its siblings: finger to the left for the next, to the right for
 * the previous. `siblings` is read once per gesture, so a list that changes under a finger (live
 * updates reorder sessions) can't move a drag or the wheel's highlight onto another screen.
 */
export function SwipeNav({ siblings, children }: { siblings: () => Siblings; children: ComponentChildren }) {
  const root = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  /** The way a drag heads: 1 toward the next, -1 toward the previous, 0 when none runs. */
  const [drag, setDrag] = useState<-1 | 0 | 1>(0);
  /** The siblings of the gesture under way, as read when it began. */
  const [shown, setShown] = useState<Siblings | null>(null);
  /** The wheel's highlighted sibling while it is open. */
  const [picked, setPicked] = useState<number | null>(null);
  /** The sibling this screen is sliding out toward. */
  const [out, setOut] = useState<number | null>(null);
  /** The edge a held finger steps toward: -1 up, 1 down. */
  const [hold, setHold] = useState<-1 | 0 | 1>(0);
  const latest = useRef(siblings);
  latest.current = siblings;
  const leaving = useRef(false);
  /** The slide-out's pending navigation, cancelled if the screen goes first (‹ mid-slide). */
  const outTimer = useRef<number | undefined>(undefined);

  /**
   * Opens sibling `at`; false (nothing moves) when there is none. A finger's move slides this screen
   * out toward `dir` over the sibling's name and the next slides in. A key's move (`slide` false)
   * switches at once: whoever presses it sees the list, so a preview would only delay it.
   */
  const go = (sibs: Siblings, at: number, dir: -1 | 1, slide = true): boolean => {
    const side = sibs.items[at];
    const el = page.current;
    if (sibs.index < 0 || at === sibs.index || !side || !el || leaving.current) return false;
    leaving.current = true;
    const land = () => {
      entering = dir;
      goSideways(side.href);
    };
    if (!slide || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      goSideways(side.href);
      return true;
    }
    setShown(sibs);
    setOut(at);
    setDrag(dir);
    el.style.transition = `transform ${OUT_MS}ms ease-out`;
    el.style.transform = `translateX(${-dir * 100}%)`;
    outTimer.current = window.setTimeout(land, OUT_MS);
    return true;
  };

  useLayoutEffect(() => {
    const dir = entering;
    entering = 0;
    const el = page.current;
    // The slide-in itself stays off under reduced motion (style.css).
    if (!dir || !el) return;
    el.classList.add(dir > 0 ? "swipe-in-next" : "swipe-in-prev");
    el.addEventListener("animationend", () => el.classList.remove("swipe-in-next", "swipe-in-prev"), { once: true });
  }, []);

  useEffect(() => {
    const box = root.current;
    const el = page.current;
    if (!box || !el) return;
    let start: { x: number; y: number } | null = null;
    let horizontal = false;
    let sibs: Siblings = { items: [], index: -1 };
    let shift = 0;
    let lastX = 0;
    let lastT = 0;
    let speed = 0;
    // The wheel's highlight, the side it opened on, where the finger last stepped, and the point a
    // sideways drag last turned from (a vertical turn past it opens the wheel).
    let picking: number | null = null;
    let pickDir: -1 | 1 = 1;
    let stepY = 0;
    let lastY = 0;
    let turn = { x: 0, y: 0 };
    let holding: -1 | 0 | 1 = 0;
    let holdTimer: number | undefined;
    let holdMs = HOLD_FIRST_MS;
    // The edge the wheel opened at stays inert until the finger leaves it: a sideways swipe low on
    // the screen drifts into the bottom zone, and stepping from there would buzz down the whole list.
    let inert: -1 | 0 | 1 = 0;
    const pick = (at: number | null) => {
      picking = at;
      setPicked(at);
    };
    const step = (by: -1 | 1) => {
      if (picking === null) return;
      const at = Math.min(Math.max(picking + by, 0), sibs.items.length - 1);
      if (at === picking) return;
      pick(at);
      navigator.vibrate?.(8);
    };
    const zoneAt = (y: number): -1 | 0 | 1 => {
      const r = box.getBoundingClientRect();
      return y < r.top + HOLD_ZONE ? -1 : y > r.bottom - HOLD_ZONE ? 1 : 0;
    };
    const holdAt = (y: number) => {
      let dir = zoneAt(y);
      if (dir !== inert) inert = 0;
      else dir = 0;
      if (dir === holding) return;
      holding = dir;
      setHold(dir);
      clearTimeout(holdTimer);
      if (!dir) return;
      holdMs = HOLD_FIRST_MS;
      const tick = () => {
        if (!holding) return;
        step(holding);
        // Leaving the edge steps from here, not from where the finger arrived.
        stepY = lastY;
        holdMs = Math.max(HOLD_MIN_MS, holdMs * 0.8);
        holdTimer = window.setTimeout(tick, holdMs);
      };
      holdTimer = window.setTimeout(tick, holdMs);
    };
    const closeWheel = () => {
      clearTimeout(holdTimer);
      holding = 0;
      setHold(0);
      pick(null);
    };
    const settle = () => {
      closeWheel();
      el.style.transition = "transform .2s ease-out";
      el.style.transform = "";
      el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
      setDrag(0);
    };
    const onStart = (e: TouchEvent) => {
      // A second finger ends a drag under way: it springs back, and nothing new starts.
      onCancel();
      const t = e.touches[0];
      if (e.touches.length !== 1 || leaving.current || t.clientX < EDGE || t.clientX > innerWidth - EDGE || !swipeable(e.target, box)) return;
      start = { x: t.clientX, y: t.clientY };
      horizontal = false;
      shift = 0;
      speed = 0;
      lastX = t.clientX;
      lastT = e.timeStamp;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!horizontal) {
        if (Math.hypot(dx, dy) < SLOP) return;
        // A vertical start is a scroll; one the browser already owns can't be taken over.
        if (Math.abs(dx) < Math.abs(dy) * 1.2 || !e.cancelable) return void (start = null);
        horizontal = true;
        sibs = latest.current();
        setShown(sibs);
        el.style.transition = "none";
        turn = { x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
      lastY = t.clientY;
      if (picking !== null) {
        if (Math.abs(dx) >= PICK_DX / 2) {
          for (; t.clientY - stepY >= ROW; stepY += ROW) step(1);
          for (; stepY - t.clientY >= ROW; stepY -= ROW) step(-1);
          return holdAt(t.clientY);
        }
        // Back near the start: the wheel closes and the screen follows the finger again.
        closeWheel();
        el.style.transition = "none";
        turn = { x: t.clientX, y: t.clientY };
      }
      const dir = dx < 0 ? 1 : -1;
      const side = sibs.index >= 0 ? sibs.items[sibs.index + dir] : undefined;
      shift = side ? dx : dx * RUBBER;
      el.style.transform = `translateX(${shift}px)`;
      setDrag(dir);
      if (e.timeStamp > lastT) speed = 0.8 * ((t.clientX - lastX) / (e.timeStamp - lastT)) + 0.2 * speed;
      lastX = t.clientX;
      lastT = e.timeStamp;
      // Still heading sideways: the turn point moves along. A vertical turn far enough out opens the wheel.
      if (Math.abs(t.clientX - turn.x) >= Math.abs(t.clientY - turn.y)) turn = { x: t.clientX, y: t.clientY };
      else if (side && Math.abs(dx) > PICK_DX && Math.abs(t.clientY - turn.y) > PICK_DY) {
        pickDir = dir;
        stepY = t.clientY;
        pick(sibs.index + dir);
        el.style.transition = "transform .18s ease-out";
        el.style.transform = `translateX(${-dir * WHEEL_SHARE * 100}%)`;
        // A finger already at an edge has to leave it and come back to keep stepping.
        inert = zoneAt(t.clientY);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || !horizontal) return void (start = null);
      start = null;
      if (picking !== null) {
        const at = picking;
        closeWheel();
        // Lifting on this screen's own row, or a sibling that can't open, springs back.
        if (!go(sibs, at, pickDir)) settle();
        return;
      }
      const dir = shift < 0 ? 1 : -1;
      const far = Math.abs(shift) > box.clientWidth * COMMIT_SHARE;
      const flick =
        e.timeStamp - lastT < FLICK_STALE_MS && Math.abs(shift) > FLICK_MIN && Math.abs(speed) > FLICK_SPEED && Math.sign(speed) === Math.sign(shift);
      if (!((far || flick) && go(sibs, sibs.index + dir, dir))) settle();
    };
    const onCancel = () => {
      if (start && horizontal) settle();
      start = null;
    };
    // Alt+←/→ on a keyboard; in a field Alt (Option) with the arrows moves by word instead. With
    // nowhere to go the key stays the browser's (Back, on Linux and Windows).
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target;
      if (t instanceof Element && t.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const keyed = latest.current();
      if (go(keyed, keyed.index + dir, dir, false)) e.preventDefault();
    };
    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd);
    box.addEventListener("touchcancel", onCancel);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(holdTimer);
      clearTimeout(outTimer.current);
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
      box.removeEventListener("touchcancel", onCancel);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // The sibling the gap shows and the count names: the one sliding in, the wheel's highlight, the
  // neighbour a drag heads for, or this screen itself when there is none that way.
  const near = shown && shown.index >= 0 && shown.items[shown.index + drag] ? shown.index + drag : (shown?.index ?? -1);
  const at = out ?? picked ?? near;
  const label = shown && at !== shown.index ? shown.items[at]?.label : undefined;
  return (
    <div class="swipe" ref={root}>
      {drag !== 0 && shown && (
        <div class={`swipe-peek ${drag > 0 ? "to-next" : "to-prev"}`} aria-hidden="true">
          {picked !== null ? (
            <div class="swipe-wheel">
              <div class="swipe-wheel-list" style={{ transform: `translateY(${-(picked + 0.5) * ROW}px)` }}>
                {shown.items.map((s, i) => (
                  <div key={s.href} class={`swipe-wheel-row${i === shown.index ? " here" : ""}`} style={{ height: `${ROW}px`, opacity: Math.max(0.25, 1 - Math.abs(i - picked) * 0.22) }}>
                    {s.label}
                  </div>
                ))}
              </div>
              <div class="swipe-wheel-frame" style={{ height: `${ROW}px`, marginTop: `${-ROW / 2}px` }} />
              {picked > 0 && <div class={`swipe-edge up${hold < 0 ? " on" : ""}`}>▲</div>}
              {picked < shown.items.length - 1 && <div class={`swipe-edge down${hold > 0 ? " on" : ""}`}>▼</div>}
            </div>
          ) : (
            label && <div class="swipe-label">{label}</div>
          )}
        </div>
      )}
      <div class="swipe-page" ref={page}>
        {children}
      </div>
      {drag !== 0 && shown && at >= 0 && (
        <div class="swipe-count" aria-hidden="true">
          {at + 1} / {shown.items.length}
        </div>
      )}
    </div>
  );
}
