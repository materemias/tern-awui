import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Voice } from "./api";
import { settle } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Static imports would bind Preact to the environment before the DOM is registered.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { useVoiceCall } = await import("./voice");

const restore: (() => void)[] = [];
function property(target: object, key: PropertyKey, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => (old ? Object.defineProperty(target, key, old) : Reflect.deleteProperty(target, key)));
}

/** A WebRTC peer that offers at once; `gathering` holds its ICE candidates until `finishGathering`. */
class FakePeer extends EventTarget {
  static all: FakePeer[] = [];
  static gathering = false;
  iceGatheringState = FakePeer.gathering ? "gathering" : "complete";
  connectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remote: RTCSessionDescriptionInit | null = null;
  closed = false;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  constructor() {
    super();
    FakePeer.all.push(this);
  }
  addTrack() {}
  createDataChannel() {}
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription(d: RTCSessionDescriptionInit) { this.localDescription = d; }
  async setRemoteDescription(d: RTCSessionDescriptionInit) { this.remote = d; }
  close() { this.closed = true; }
  finishGathering() {
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }
}

type Post = { url: string; body: Record<string, unknown> };
let posts: Post[];
let reply: (post: Post) => Response | Promise<Response>;
let track: { enabled: boolean; stop: ReturnType<typeof mock> };
let root: HTMLElement;
beforeEach(() => {
  posts = [];
  reply = () => Response.json({ ok: true });
  FakePeer.all = [];
  FakePeer.gathering = false;
  track = { enabled: true, stop: mock(() => {}) };
  property(globalThis, "RTCPeerConnection", FakePeer);
  property(navigator, "mediaDevices", { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) });
  property(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const post = { url, body: JSON.parse(String(init.body ?? "{}")) };
    posts.push(post);
    return reply(post);
  });
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(async () => {
  await act(() => render(null, root));
  root.remove();
  for (const undo of restore.splice(0).reverse()) undo();
});

let errors: (string | null)[] = [];
function Host({ voice = null, block = "5" }: { voice?: Voice | null; block?: string }) {
  const call = useVoiceCall(block, voice, (e) => errors.push(e));
  return (
    <>
      <output>{call.state}</output>
      <button id="start" onClick={() => void call.start()} />
      <button id="hangup" onClick={call.hangup} />
    </>
  );
}
const show = (props: { voice?: Voice | null; block?: string } = {}) => act(async () => { render(<Host {...props} />, root); await settle(); });
const press = (id: string) => act(async () => { root.querySelector<HTMLButtonElement>(`#${id}`)!.click(); await settle(); });
const state = () => root.querySelector("output")!.textContent;
const offers = () => posts.filter((p) => p.url.endsWith("/voice"));
const hangups = () => posts.filter((p) => p.url.endsWith("/hangup"));
const call = (over: Partial<Voice>): Voice => ({ phase: "listening", user: "", assistant: "", ended: false, error: "", attempt: "", ...over });
beforeEach(() => { errors = []; });

test("leaving while the microphone prompt is open: a late grant stops its tracks and starts no call", async () => {
  const grant = Promise.withResolvers<MediaStream>();
  property(navigator, "mediaDevices", { getUserMedia: () => grant.promise });
  await show();
  await press("start");
  expect(state()).toBe("starting");
  await act(() => render(null, root));
  await act(async () => {
    grant.resolve({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
    await grant.promise;
  });
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(FakePeer.all).toEqual([]);
  expect(posts).toEqual([]);
});

test("a call answered by omp is on; the offer names its attempt and the phone's hang-up names it too", async () => {
  reply = (p) => Response.json(p.url.endsWith("/voice") ? { sdp: "v=0 answer" } : { ok: true });
  await show();
  await press("start");
  expect(state()).toBe("on");
  const attempt = offers()[0].body.attempt;
  expect(offers()).toEqual([{ url: "/api/blocks/5/voice", body: { sdp: "v=0 offer", attempt } }]);
  expect(FakePeer.all[0].remote).toEqual({ type: "answer", sdp: "v=0 answer" });
  await press("hangup");
  expect(state()).toBe("idle");
  expect(hangups()).toEqual([{ url: "/api/blocks/5/hangup", body: { attempt } }]);
  expect(track.stop).toHaveBeenCalled();
});

test("a refused start sends no hang-up; a start omp may have taken ends only its own attempt", async () => {
  reply = (p) => (p.url.endsWith("/voice") ? Response.json({ error: "a voice call is already running" }, { status: 409 }) : Response.json({ ok: true }));
  await show();
  await press("start");
  expect(state()).toBe("idle");
  expect(errors.at(-1)).toBe("a voice call is already running");
  expect(hangups()).toEqual([]);
  reply = (p) => (p.url.endsWith("/voice") ? Response.json({ error: "omp did not start the call" }, { status: 502 }) : Response.json({ ok: true }));
  await press("start");
  expect(hangups()).toEqual([{ url: "/api/blocks/5/hangup", body: { attempt: offers()[1].body.attempt } }]);
});

test("hanging up while the peer gathers candidates sends no offer", async () => {
  FakePeer.gathering = true;
  await show();
  await press("start");
  await press("hangup");
  await act(async () => { FakePeer.all[0].finishGathering(); await settle(); });
  expect(offers()).toEqual([]);
  expect(FakePeer.all[0].closed).toBe(true);
});

test("only this call's reports end it: another call's end is ignored, and a reconnect's 'no call' ends it once seen", async () => {
  reply = (p) => Response.json(p.url.endsWith("/voice") ? { sdp: "v=0 answer" } : { ok: true });
  await show();
  await press("start");
  const attempt = String(offers()[0].body.attempt);
  // A previous call's late end, before this call was reported.
  await show({ voice: call({ attempt: "older", ended: true, error: "old failure" }) });
  expect(state()).toBe("on");
  // Not yet reported, so a 'no call' snapshot may be from before the server knew it.
  await show({ voice: null });
  expect(state()).toBe("on");
  await show({ voice: call({ attempt, phase: "muted" }) });
  expect(track.enabled).toBe(false);
  // The stream dropped and missed the end: reconnecting, the server reports no call.
  await show({ voice: null });
  expect(state()).toBe("idle");
  expect(track.stop).toHaveBeenCalled();
});
