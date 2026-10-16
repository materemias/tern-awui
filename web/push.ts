// Push notifications: the bell's state and its toggle, against the service worker's push manager.
import { useEffect, useRef, useState } from "preact/hooks";
import { post } from "./api";
import { vapidBytes } from "./lib";

/**
 * `off`: no subscription; `pending`: checking, asking for permission, or (re)subscribing and
 * waiting for the server to store it; `on`: the server confirmed this device's subscription.
 */
export type PushState = "unsupported" | "denied" | "off" | "pending" | "on";
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

export const PUSH_LABEL: Record<PushState, string> = {
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
export function usePush(): [PushState, () => void] {
  const [state, setState] = useState<PushState>("pending");
  /** Bumped by each check and toggle; a result whose number is stale is dropped. */
  const op = useRef(0);
  const toggling = useRef(false);
  /**
   * The one running check, or null. Checks never overlap, so a toggle that waits for it waits for
   * every subscription change a check can still make.
   */
  const checking = useRef<Promise<void> | null>(null);
  const offState = (): PushState => (Notification.permission === "denied" ? "denied" : "off");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState("unsupported");
    /**
     * Re-registers this device when it was turned on here. Runs at start, whenever the app comes
     * back to the foreground and when the network returns: the browser can drop a subscription
     * (app update, storage cleanup, key rotation) and the server prunes ones its push service
     * reports gone, while an installed app may stay open in the background for days.
     */
    async function sync() {
      const mine = ++op.current;
      try {
        const reg = await workerReady();
        const sub = await reg.pushManager.getSubscription();
        const choice = localStorage.getItem(PUSH_WANTED_KEY);
        const wanted = choice === "on" || (sub !== null && choice === null);
        if (!wanted || Notification.permission !== "granted") {
          if (mine === op.current) setState(offState());
          return;
        }
        // A toggle since this check began owns the subscription now.
        if (mine !== op.current) return;
        const now = await ensureSubscription(reg);
        const err = await post("/api/push/subscribe", now.toJSON());
        if (err) throw new Error(err);
        // A toggle since this check began has the final say, including the remembered choice.
        if (mine !== op.current) return;
        localStorage.setItem(PUSH_WANTED_KEY, "on");
        setState("on");
      } catch {
        // A failed recheck does not undo a confirmed subscription; the next one retries. Before any
        // confirmation the bell stays tappable, so a tap can retry too.
        if (mine === op.current) setState((s) => (s === "on" ? s : offState()));
      }
    }
    const check = () => {
      if (toggling.current || checking.current) return;
      checking.current = sync().finally(() => {
        checking.current = null;
      });
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    check();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, []);
  async function toggle() {
    if (state === "unsupported" || state === "pending") return;
    const wasOn = state === "on";
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
    } finally {
      toggling.current = false;
    }
  }
  return [state, toggle];
}
