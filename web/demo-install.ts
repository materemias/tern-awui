// Runs before the app (demo.ts imports it first): the page's fetch and EventSource go to the
// in-page DemoServer for /api/*, and a stand-in service worker and notification permission let
// the bell switch on without registering a worker under the site's origin or asking the browser.
import { DemoServer, demoEventSource } from "./demo-backend";

const server = new DemoServer();
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" || input instanceof URL) {
    const url = new URL(input, location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) return server.fetch(url, init);
  }
  return realFetch(input, init);
}) as typeof fetch;
window.EventSource = demoEventSource(server) as unknown as typeof EventSource;

// The demo opens on the session waiting for a tool approval (the list beside it on the desktop)
// when the link has no hash; `#/` (the list, a reload there) stays. Before the app reads its
// route, and with no history entry.
if (location.hash.length <= 1) history.replaceState(null, "", "#/b/23");

/**
 * Notifications: the app's real push code runs against a service worker that registers nothing,
 * a push manager whose subscription leads nowhere and a permission granted without a prompt.
 * DemoServer accepts the subscription, so the bell turns on; no notification is ever sent.
 */
const DEMO_PERMISSION_KEY = "tern-mobile:demo-notifications";
class DemoNotification {
  static get permission(): NotificationPermission {
    return localStorage.getItem(DEMO_PERMISSION_KEY) === "granted" ? "granted" : "default";
  }
  static async requestPermission(): Promise<NotificationPermission> {
    localStorage.setItem(DEMO_PERMISSION_KEY, "granted");
    return "granted";
  }
}
let subscription: PushSubscription | null = null;
const registration = {
  active: {},
  pushManager: {
    getSubscription: async () => subscription,
    subscribe: async ({ applicationServerKey }: PushSubscriptionOptionsInit) => {
      const key = new Uint8Array(applicationServerKey as Uint8Array).buffer;
      subscription = {
        endpoint: "https://push.invalid/tern-awui-demo",
        options: { applicationServerKey: key, userVisibleOnly: true },
        toJSON: () => ({ endpoint: "https://push.invalid/tern-awui-demo", keys: { p256dh: "demo", auth: "demo" } }),
        unsubscribe: async () => {
          subscription = null;
          return true;
        },
      } as unknown as PushSubscription;
      return subscription;
    },
  },
  getNotifications: async () => [],
} as unknown as ServiceWorkerRegistration;
const worker = Object.assign(new EventTarget(), {
  controller: null,
  ready: Promise.resolve(registration),
  register: async () => registration,
  getRegistration: async () => registration,
});
Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
Object.defineProperty(window, "PushManager", { configurable: true, value: class DemoPushManager {} });
Object.defineProperty(window, "Notification", { configurable: true, value: DemoNotification });

/**
 * The voice call's microphone and WebRTC peer. DemoServer scripts the call, so the app's real call
 * code runs against a silent stream and a peer that pretends to connect: no permission prompt,
 * nothing recorded, and no audio leaves the browser.
 */
class DemoPeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((e: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack() {}
  createDataChannel() {
    return new EventTarget();
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=tern-awui demo\r\nt=0 0\r\n" };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription() {
    this.connectionState = "connected";
  }
  close() {
    this.connectionState = "closed";
  }
}
window.RTCPeerConnection = DemoPeer as unknown as typeof RTCPeerConnection;
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => new MediaStream() } });
