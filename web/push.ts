// Push notifications: the bell's state and its toggle, against the service worker's push manager.
import { useEffect, useRef, useState } from "preact/hooks";
import { post } from "./api";
import { vapidBytes } from "./lib";

/**
 * `off`: no subscription; `pending`: checking, asking for permission, or (re)subscribing and
 * waiting for the server to store it; `on`: the server confirmed this device's subscription;
 * `stopped`: this device chose on, but Android took the permission and the subscription away
 * (an installed app without Android's own notification permission, see `appBlocked`).
 */
export type PushState = "unsupported" | "denied" | "off" | "pending" | "on" | "stopped";
/** The user's choice on this device; survives app updates, reloads and dropped subscriptions. */
const PUSH_WANTED_KEY = "tern-mobile:push";
/**
 * Set when this device saw Android take its notifications away; cleared only by turning them off.
 * Makes a later grant warn that it may not last. No page load proves the Android permission came
 * back: a page opened from a notification or with a borrowed grant looks like a healthy launch.
 * The stopped state itself is detected afresh on every check.
 */
const APP_BLOCKED_KEY = "tern-mobile:push-app-blocked";
export const APP_BLOCKED_WARNING =
  "Notifications are on for now, but Android seems to block them for this app: they will stop the next time you open it from its icon. To keep them, long-press the app's icon → App info → Notifications and allow them.";

/** Running as an app installed from Chrome on Android (a WebAPK), which has its own Android permission. */
function installedAndroid(): boolean {
  return /Android/.test(navigator.userAgent) && matchMedia("(display-mode: standalone)").matches;
}

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

export const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "Notifications unsupported",
  denied: "Notifications blocked in site settings",
  off: "Notifications off",
  pending: "Notifications: connecting…",
  on: "Notifications on",
  stopped: "Notifications stopped: Android blocks this app",
};

/** The service worker, or an error if it isn't active within 10 s (registration failed). */
function workerReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker not active")), 10_000)),
  ]);
}

/**
 * How to allow notifications after a request returned `result`, or null when there is nothing to
 * tell. A page cannot open the permission page itself: Chrome only follows `intent:` links to
 * browsable activities, and Android's settings screens are not.
 */
export function permissionHelp(result: "denied"): string;
export function permissionHelp(result: NotificationPermission): string | null;
export function permissionHelp(result: NotificationPermission): string | null {
  const android = /Android/.test(navigator.userAgent);
  // An installed app on Android is its own app (a WebAPK) with its own notification permission;
  // without it Chrome resets the site's permission each time the app opens from its icon.
  const installed = installedAndroid();
  if (result === "default")
    // A dismissed prompt: tapping the bell asks again. Only an installed app can also fail with no
    // prompt at all, when Android itself blocks it, and that looks the same here.
    return installed
      ? "Notifications weren't allowed. Tap the bell to be asked again. If no prompt appeared, Android blocks them for this app: long-press the app's icon → App info → Notifications."
      : null;
  if (installed)
    return "Android blocks notifications for this app. Long-press the app's icon → App info → Notifications, allow them, then tap the bell again.";
  if (android)
    return "Notifications are blocked for this site. Tap the icon left of the address → Permissions → Notifications, allow them, then tap the bell again.";
  return "Notifications are blocked: allow them in the site settings, then tap the bell again.";
}

/** Push notifications for finished and blocked sessions; on/off per device. */
export function usePush(): [PushState, () => void] {
  const [state, setState] = useState<PushState>("pending");
  /** Bumped by each check and toggle; a result whose number is stale is dropped. */
  const op = useRef(0);
  const toggling = useRef(false);
  /** Bumped by each tap on the bell; a permission answer that comes after a newer tap is dropped. */
  const taps = useRef(0);
  /** Runs a check now; set by the effect, for a permission answer that comes after the bell gave up. */
  const recheck = useRef<() => void>(() => {});
  /**
   * A late grant from the bell is being confirmed by the check: when it succeeds, warn as the bell
   * itself would if Android was seen blocking this app. Ordinary checks never warn.
   */
  const lateEnable = useRef(false);
  /**
   * The one running check, or null. Checks never overlap, so a toggle that waits for it waits for
   * every subscription change a check can still make.
   */
  const checking = useRef<Promise<void> | null>(null);
  /**
   * A permission request started by the first tap after the browser forgot the permission of a
   * device that chose on, until it settles; a tap on the bell meanwhile (the same tap, or one while
   * a request hangs) waits for it instead of asking twice.
   */
  const restoring = useRef<Promise<NotificationPermission> | null>(null);
  /**
   * A tap-to-ask is armed or was used since the permission was last granted: one ask per loss.
   * Any grant ends the loss, the bell's included.
   */
  const restoreArmed = useRef(false);
  const offState = (): PushState => (Notification.permission === "denied" ? "denied" : "off");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState("unsupported");
    let retry: number | undefined;
    /** Failed checks in a row for a device that chose on; spaces the retries out. */
    let failures = 0;
    /**
     * The browser reset the permission (an app update or the OS revoking it) while this device
     * chose on: asking needs a tap, so the first tap anywhere asks again. A dismissed prompt is
     * not asked again until the permission has been granted and lost once more.
     */
    function armRestore() {
      if (restoreArmed.current) return;
      restoreArmed.current = true;
      document.addEventListener("click", restore, { capture: true, once: true });
    }
    function restore() {
      if (localStorage.getItem(PUSH_WANTED_KEY) !== "on" || Notification.permission !== "default") return;
      const asked = Notification.requestPermission();
      restoring.current = asked;
      // The bell's own toggle may run in place of the check; a grant still ends this loss.
      void asked.then((p) => {
        restoring.current = null;
        if (p === "granted") restoreArmed.current = false;
        check();
      }, () => (restoring.current = null));
    }
    /** Retries a failed check after `ms`; a toggle still running then pushes it back, not away. */
    function retryIn(ms: number) {
      retry = window.setTimeout(() => (toggling.current ? retryIn(ms) : check()), ms);
    }
    /**
     * Re-registers this device when it was turned on here. Runs at start, whenever the app comes
     * back to the foreground and when the network returns: the browser can drop a subscription
     * (app update, storage cleanup, key rotation) and the server prunes ones its push service
     * reports gone, while an installed app may stay open in the background for days. A device
     * that chose on also retries a failed check on its own (the server restarting, say).
     */
    async function sync() {
      const mine = ++op.current;
      let wanted = localStorage.getItem(PUSH_WANTED_KEY) === "on";
      try {
        const reg = await workerReady();
        const sub = await reg.pushManager.getSubscription();
        const choice = localStorage.getItem(PUSH_WANTED_KEY);
        wanted = choice === "on" || (sub !== null && choice === null);
        if (!wanted || Notification.permission !== "granted") {
          // When the installed app lacks Android's own notification permission, Chrome resets the
          // site's permission and drops the subscription at each launch from the icon, even after a
          // grant borrowed from another installed app of the same host. No web API shows that
          // permission, so this pattern is the only sign. Asking on a tap anywhere can't help (it
          // hangs or borrows again), so only the bell asks, and it warns when a grant can't last.
          const appBlocked = choice === "on" && sub === null && Notification.permission === "default" && installedAndroid();
          if (appBlocked) localStorage.setItem(APP_BLOCKED_KEY, "1");
          else if (wanted && Notification.permission === "default") armRestore();
          wanted = false;
          if (mine === op.current) setState(appBlocked ? "stopped" : offState());
          return;
        }
        restoreArmed.current = false;
        // A toggle since this check began owns the subscription now.
        if (mine !== op.current) return;
        const now = await ensureSubscription(reg);
        const err = await post("/api/push/subscribe", now.toJSON());
        if (err) throw new Error(err);
        failures = 0;
        // A toggle since this check began has the final say, including the remembered choice.
        if (mine !== op.current) return;
        localStorage.setItem(PUSH_WANTED_KEY, "on");
        // The choice and the subscription live in this origin's storage: ask the browser not to evict it.
        void navigator.storage?.persist?.().catch(() => {});
        setState("on");
        if (lateEnable.current) {
          lateEnable.current = false;
          if (localStorage.getItem(APP_BLOCKED_KEY)) alert(APP_BLOCKED_WARNING);
        }
      } catch {
        // A failed recheck does not undo a confirmed subscription; the next one retries. Before any
        // confirmation the bell stays tappable, so a tap can retry too.
        if (mine === op.current) setState((s) => (s === "on" ? s : offState()));
        if (wanted) retryIn(Math.min(5_000 * 2 ** failures++, 60_000));
      }
    }
    const check = () => {
      if (toggling.current || checking.current) return;
      clearTimeout(retry);
      checking.current = sync().finally(() => {
        checking.current = null;
      });
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    recheck.current = check;
    check();
    return () => {
      clearTimeout(retry);
      document.removeEventListener("click", restore, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, []);
  async function toggle() {
    if (state === "unsupported" || state === "pending") return;
    const wasOn = state === "on";
    const wasStopped = state === "stopped";
    const asked = restoring.current;
    const tap = ++taps.current;
    lateEnable.current = false;
    // A check already running started before this choice; its result is stale.
    op.current++;
    toggling.current = true;
    setState("pending");
    try {
      // A check that already passed its last staleness test may still subscribe; turning off must
      // run after it, or it would leave that new subscription live.
      await checking.current;
      const reg = await workerReady();
      if (wasOn) {
        localStorage.setItem(PUSH_WANTED_KEY, "off");
        localStorage.removeItem(APP_BLOCKED_KEY);
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await post("/api/push/unsubscribe", sub.toJSON());
          await sub.unsubscribe();
        }
        return setState("off");
      }
      // An installed Android app without Android's own notification permission gets no prompt:
      // Chrome hands the request to another installed app of the same host and it never settles
      // (seen with Chrome 155 on Android 16). Stop waiting so the bell is tappable again.
      const request = asked ?? Notification.requestPermission();
      const gaveUp = Promise.withResolvers<NotificationPermission | null>();
      setTimeout(() => gaveUp.resolve(null), 10_000);
      const answer = await Promise.race([request, gaveUp.promise]);
      if (answer === null)
        // A slow answer still counts (a prompt read for more than 10 s, say): a grant with no tap
        // on the bell since records the choice and subscribes through the check.
        void request.then((p) => {
          if (p !== "granted" || tap !== taps.current) return;
          localStorage.setItem(PUSH_WANTED_KEY, "on");
          lateEnable.current = true;
          recheck.current();
        }, () => {});
      const permission = answer ?? "default";
      if (permission !== "granted") {
        // Android still blocks the app if the permission stayed default: keep showing that.
        setState(wasStopped && Notification.permission === "default" ? "stopped" : offState());
        const help = permissionHelp(permission);
        if (help) alert(help);
        return;
      }
      restoreArmed.current = false;
      const sub = await ensureSubscription(reg);
      const err = await post("/api/push/subscribe", sub.toJSON());
      if (err) throw new Error(err);
      localStorage.setItem(PUSH_WANTED_KEY, "on");
      void navigator.storage?.persist?.().catch(() => {});
      setState("on");
      if (localStorage.getItem(APP_BLOCKED_KEY)) alert(APP_BLOCKED_WARNING);
    } catch (e) {
      alert(`Notifications failed: ${e}`);
      // Turning off already cleared the choice; the server drops a dead subscription on its own.
      setState(wasOn ? "off" : offState());
    } finally {
      toggling.current = false;
    }
  }
  return [state, toggle];
}
