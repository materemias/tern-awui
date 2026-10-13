// Push notifications: the bell's state and its toggle, against the service worker's push manager.
import { useEffect, useState } from "preact/hooks";
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
