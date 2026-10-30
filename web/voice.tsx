// Voice calls: omp's live mode (`/live`) with the phone as its microphone and speaker. The phone's
// WebRTC peer carries the audio to OpenAI; omp signals the call (through the bridge) and runs what
// the voice model hands off as ordinary turns of the session, which the chat then shows.
import { useEffect, useRef, useState } from "preact/hooks";
import { postJson, type Voice } from "./api";
import { holdStream, useWakeLock } from "./hooks";
import { buzz } from "./parts";

/** How long the offer waits for the phone's network candidates before it goes with what it has. */
const ICE_WAIT_MS = 1500;

/** What the phone shows for each of omp's live phases (a call with the phone's audio has no `speaking`). */
export const PHASE_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  working: "Agent working",
  muted: "Muted",
  error: "Voice error",
};

/** `seen`: the stream has reported this call (tagged with its `attempt`) at least once. */
type Call = { block: string; attempt: string; seen: boolean; pc: RTCPeerConnection; mic: MediaStream; audio: HTMLAudioElement; release: () => void };
/** `starting`: asking for the microphone and waiting for omp's answer; `on`: audio flows. */
export type CallState = "idle" | "starting" | "on";

/** Resolves once the peer has gathered its candidates, or after `ms`. */
function iceGathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const check = () => {
    if (pc.iceGatheringState === "complete") done();
  };
  const done = () => {
    clearTimeout(timer);
    pc.removeEventListener("icegatheringstatechange", check);
    resolve();
  };
  const timer = setTimeout(done, ms);
  pc.addEventListener("icegatheringstatechange", check);
  return promise;
}

/** Why the microphone couldn't open, as the user can act on it. */
export function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Microphone blocked: allow it in the site settings";
  if (name === "NotFoundError") return "No microphone found";
  return `Microphone failed: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * The phone's side of a voice call on `block`: `start` opens the microphone and a WebRTC peer and
 * hands its offer to omp; `voice` (the stream's report) ends it, and its `muted` phase (omp's mute
 * key) silences the microphone as the phone's own mute does. Leaving the session hangs up.
 * Each start has an attempt id: the server tags the call with it, so this phone knows which reports
 * are its own, and its automatic hang-ups (a failed start, leaving) can only end its own call.
 */
export function useVoiceCall(block: string, voice: Voice | null, setError: (error: string | null) => void) {
  const call = useRef<Call | null>(null);
  /** The start waiting for the microphone; hanging up or leaving clears it, so a late grant opens nothing. */
  const asking = useRef<object | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);

  const teardown = () => {
    const c = call.current;
    if (!c) return;
    call.current = null;
    c.pc.close();
    for (const track of c.mic.getTracks()) track.stop();
    c.audio.srcObject = null;
    c.release();
    setState("idle");
    setMuted(false);
  };

  /** Asks omp to end `attempt`'s call, if that is the one it runs; a newer call is left alone. */
  const endAttempt = (c: Call, keepalive = false) =>
    void postJson(`/api/blocks/${c.block}/hangup`, { attempt: c.attempt }, { keepalive }).catch(() => {});

  /** Ends this phone's call, or its start (a start still asking for the microphone sent nothing yet). */
  const hangupOwn = (keepalive = false) => {
    const c = call.current;
    if (asking.current) {
      asking.current = null;
      setState("idle");
    }
    teardown();
    if (!c) return;
    buzz();
    endAttempt(c, keepalive);
  };

  const start = async () => {
    if (call.current || asking.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") return setError("Voice needs HTTPS and a browser with WebRTC");
    setError(null);
    setState("starting");
    // Made during the tap: some browsers only let audio that a gesture created play.
    const audio = new Audio();
    audio.autoplay = true;
    const prompt = {};
    asking.current = prompt;
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      if (asking.current !== prompt) return;
      asking.current = null;
      setState("idle");
      return setError(micError(err));
    }
    // Hung up, or left the session, while the permission prompt was open.
    if (asking.current !== prompt) {
      for (const track of mic.getTracks()) track.stop();
      return;
    }
    asking.current = null;
    const pc = new RTCPeerConnection();
    const c: Call = { block, attempt: crypto.randomUUID(), seen: false, pc, mic, audio, release: holdStream() };
    call.current = c;
    pc.addTrack(mic.getAudioTracks()[0], mic);
    // OpenAI's realtime peer expects this channel; omp reads the call's events on its own socket.
    pc.createDataChannel("oai-events");
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (call.current !== c || (pc.connectionState !== "failed" && pc.connectionState !== "closed")) return;
      setError("Voice connection lost");
      hangupOwn();
    };
    let r: Response | null = null;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc, ICE_WAIT_MS);
      // Hung up while the peer gathered candidates: no offer goes out.
      if (call.current !== c) return;
      r = await postJson(`/api/blocks/${block}/voice`, { sdp: pc.localDescription?.sdp ?? "", attempt: c.attempt });
      const data: { sdp?: string; error?: string } = await r.json().catch(() => ({}));
      // Hung up while omp signaled: the hang-up may have reached omp before the offer did.
      if (call.current !== c) return void (r.ok && endAttempt(c));
      if (!r.ok || typeof data.sdp !== "string") throw new Error(data.error ?? `HTTP ${r.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      if (call.current !== c) return;
      setState("on");
      buzz();
    } catch (err) {
      if (call.current !== c) return;
      teardown();
      // A refused offer (another call runs, a bad offer) started nothing; anything else may have.
      if (!r || r.status >= 500 || r.ok) endAttempt(c);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // omp ended this phone's call: its stop key, `/live`, a failure, or the session going away. Only
  // reports tagged with this call's attempt count; once one arrived, "no call" (a stream that
  // reconnected after missing the end) ends it too.
  useEffect(() => {
    const c = call.current;
    if (!c) return;
    if (voice?.attempt === c.attempt) {
      if (!voice.ended) return void (c.seen = true);
      teardown();
      if (voice.error) setError(voice.error);
    } else if (!voice && c.seen) {
      teardown();
    }
  }, [voice]);

  // The microphone is silent while the phone mutes or omp's phase says muted.
  const phase = voice && !voice.ended ? voice.phase : "";
  useEffect(() => {
    for (const track of call.current?.mic.getAudioTracks() ?? []) track.enabled = !muted && phase !== "muted";
  }, [muted, phase, state]);

  // Keeps the screen on through the call (the browser lets go when the page hides; it comes back with it).
  useWakeLock(state !== "idle");

  // Leaving the session (or the page) hangs up, so no call talks to nobody.
  useEffect(() => {
    const onHide = () => hangupOwn(true);
    addEventListener("pagehide", onHide);
    return () => {
      removeEventListener("pagehide", onHide);
      hangupOwn();
    };
  }, [block]);

  /** This phone's call, or (none here) the call another device runs on this session. */
  const hangup = () => {
    if (call.current || asking.current) return hangupOwn();
    buzz();
    void postJson(`/api/blocks/${block}/hangup`, {}).catch(() => {});
  };

  return { state, muted, toggleMute: () => setMuted((m) => !m), start, hangup };
}

/** How long a finger must rest on the black screen to bring the call back: a brush in a pocket doesn't. */
export const WAKE_HOLD_MS = 1000;
/** How far the resting finger may drift before the hold no longer counts. */
const WAKE_SLOP_PX = 20;
/** How long the dim hint stays after the screen goes black or is touched. */
const HINT_MS = 3000;

/**
 * Pocket mode: the screen stays on but shows only black, so the microphone keeps working (Android
 * silences a page's microphone while the screen is off) and touches in a pocket do nothing. Holding
 * a finger still for `WAKE_HOLD_MS` brings the call back. Full screen hides the system bars, and an
 * edge swipe there reveals them instead of going back (which would leave the session and end the call).
 */
function Pocket({ label, onWake }: { label: string; onWake: () => void }) {
  const [hint, setHint] = useState(true);
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const hintTimer = useRef(0);
  const showHint = () => {
    setHint(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(false), HINT_MS);
  };
  const release = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => {
    showHint();
    let entered = false;
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(() => (entered = true), () => {});
    }
    return () => {
      release();
      clearTimeout(hintTimer.current);
      if (entered && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  return (
    <div
      class="pocket"
      role="button"
      aria-label="Black screen: hold to show the call"
      // The session's sideways swipe must not see these touches: it would leave the session and end the call.
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        showHint();
        release();
        hold.current = { timer: window.setTimeout(onWake, WAKE_HOLD_MS), x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (hold.current && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > WAKE_SLOP_PX) release();
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div class={`pocket-hint${hint ? " on" : ""}`}>
        {label}
        <br />
        Hold to show the call
      </div>
    </div>
  );
}

/** The call above the composer: what omp is doing, the last thing each side said, mute, black screen and hang up. */
export function VoiceBar({ voice, call }: { voice: Voice | null; call: ReturnType<typeof useVoiceCall> }) {
  const [pocket, setPocket] = useState(false);
  const active = voice && !voice.ended ? voice : null;
  const mine = call.state !== "idle";
  // Each call starts lit: the black screen belongs to the call it was turned on in.
  useEffect(() => {
    if (!mine) setPocket(false);
  }, [mine]);
  if (!mine && !active) return null;
  const phase = active?.phase ?? "connecting";
  const muted = mine && (call.muted || phase === "muted");
  const label = muted ? "Muted" : (PHASE_LABEL[phase] ?? phase);
  return (
    <div class={`voice voice-${muted ? "muted" : phase}`}>
      <div class="voice-head">
        <span class="voice-dot" />
        <span class="voice-phase">{label}</span>
        {!mine && <span class="voice-elsewhere">on another device</span>}
        <span class="spacer" />
        {mine && (
          <button type="button" class="icon-btn" onClick={() => setPocket(true)} aria-label="Black screen (microphone stays on)" title="Black screen (microphone stays on)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            </svg>
          </button>
        )}
        {mine && (
          <button type="button" class={`icon-btn${call.muted ? " on" : ""}`} onClick={call.toggleMute} aria-label={call.muted ? "Unmute" : "Mute"} aria-pressed={call.muted}>
            <MicIcon off={call.muted} />
          </button>
        )}
        <button
          type="button"
          class="voice-end"
          onClick={call.hangup}
          aria-label="Hang up"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 11.5c3.9-3.3 10.1-3.3 14 0l-1.6 2.2-3-1.1v-2a8.6 8.6 0 0 0-4.8 0v2l-3 1.1Z" fill="currentColor" />
          </svg>
        </button>
      </div>
      {mine && pocket && <Pocket label={label} onWake={() => setPocket(false)} />}
      {active?.user && (
        <div class="voice-line voice-user">
          <span class="user-mark">›</span> {active.user}
        </div>
      )}
      {active?.assistant && <div class="voice-line">{active.assistant}</div>}
    </div>
  );
}

export function MicIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="7.25" y="2.5" width="5.5" height="10" rx="2.75" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      {off && <path d="m3.5 3.5 13 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />}
    </svg>
  );
}
