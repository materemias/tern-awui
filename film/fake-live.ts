// The phone film's tern-mobile: the real extension, with a scripted `ctx.startLive` in place of
// omp's live mode, so a take films a voice call without OpenAI, a Codex sign-in or a microphone.
// The call hands its request to the session the way omp's live mode does (a `live-delegation`
// message that starts a turn, answered by the fake model) and speaks the answer once the turn ends.
import ternMobile from "../omp-extension/tern-mobile";

/** What the film's caller says, and what the voice answers once the turn is done. */
export const SAID = "Do the cart and the payment screen show the same total?";
export const ANSWER = "They match: both screens show ninety-one euros.";

type Live = {
  sdpOffer: string;
  onPhase?(phase: string): void;
  onTranscript?(t: { role: "user" | "assistant"; text: string; turn: number; final: boolean }): void;
  onEnd?(error?: Error): void;
};
type Pi = { on(event: string, handler: (...args: any[]) => unknown): unknown; sendMessage(message: object, options?: object): void };

/** Says `text` a word at a time, as omp's transcript deltas arrive. */
async function say(call: Live, role: "user" | "assistant", text: string, still: () => boolean) {
  const words = text.split(" ");
  for (let i = 1; i <= words.length && still(); i++) {
    call.onTranscript?.({ role, text: words.slice(0, i).join(" "), turn: 1, final: i === words.length });
    await Bun.sleep(170);
  }
}

export default function filmVoice(pi: Pi): void {
  let call: Live | null = null;
  let delegated = false;
  const live = async (options: Live) => {
    const mine = options;
    call = mine;
    delegated = false;
    const still = () => call === mine;
    void (async () => {
      await Bun.sleep(900);
      if (!still()) return;
      mine.onPhase?.("listening");
      await Bun.sleep(1800);
      await say(mine, "user", SAID, still);
      if (!still()) return;
      delegated = true;
      mine.onPhase?.("working");
      pi.sendMessage({ customType: "live-delegation", content: SAID, display: true, attribution: "agent" }, { triggerTurn: true });
    })();
    return {
      sdpAnswer: "v=0 film answer",
      voice: "sol",
      async stop() {
        if (call !== mine) return;
        call = null;
        mine.onEnd?.();
      },
    };
  };
  pi.on("agent_end", () => {
    const mine = call;
    if (!mine || !delegated) return;
    delegated = false;
    void (async () => {
      await Bun.sleep(700);
      await say(mine, "assistant", ANSWER, () => call === mine);
      if (call === mine) mine.onPhase?.("listening");
    })();
  });

  // tern-mobile sees omp's ctx with `startLive` swapped; one stand-in per ctx keeps identity checks true.
  const stands = new WeakMap<object, object>();
  const wrap = (ctx: unknown) => {
    if (!ctx || typeof ctx !== "object") return ctx;
    let stand = stands.get(ctx);
    if (!stand) {
      stand = new Proxy(ctx, {
        get(target, key) {
          if (key === "startLive") return live;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      stands.set(ctx, stand);
    }
    return stand;
  };
  ternMobile(
    new Proxy(pi, {
      get(target, key) {
        if (key === "on") return (event: string, handler: (...args: any[]) => unknown) => target.on(event, (e: unknown, ctx: unknown, ...rest: unknown[]) => handler(e, wrap(ctx), ...rest));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as never,
  );
}
