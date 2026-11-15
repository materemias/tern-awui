// Runs before the app (demo.ts imports it first): the page's fetch and EventSource go to the
// in-page DemoServer for /api/*, and the service worker is hidden, so the demo neither registers
// one under the site's origin nor offers notifications.
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
// WebIDL attributes are configurable: without it, `"serviceWorker" in navigator` is false everywhere.
Reflect.deleteProperty(Navigator.prototype, "serviceWorker");

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
