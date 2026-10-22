import { describe, expect, test } from "bun:test";
import { emptyState, listChanged, parseBridgeState, type BridgeState } from "./bridge-state";

const fresh = emptyState(1000);
// A snapshot as omp-extension/tern-mobile.ts sends it.
const snapshot = {
  t: "state",
  pane: "7",
  sessionId: "01a120e7-1994-7127-8f53-7df3a966a37e",
  text: "draft",
  model: "anthropic/claude-opus",
  thinking: "medium",
  levels: ["off", "low", "medium", "high"],
  tiers: ["", "priority"],
  tier: "",
  status: "working",
  context: { tokens: 50_000, window: 200_000, percent: 25 },
  queued: [{ text: "steer", followUp: false }, { text: "later", followUp: true }],
  jobs: [{ id: "bg_1", type: "task", label: "Scout", agent: "scout", since: 5 }],
  leaf: "e012",
  protocol: 3,
  build: "0123456789abcdef",
  caps: { models: true, tiers: false, jobs: true, queue: true, rewind: true, btw: true, complete: true, levels: true },
  stretch: {
    off: false,
    open: { "1792161451904.1": ["cache", "cache › key"] },
    deepen: true,
    answers: { "1792161451904.1": [{ key: "cache › key", text: "More {{why|why it matters}}." }] },
    running: { "1792161451904.1": [{ key: "cache", seconds: 3, partial: "Stale" }] },
  },
};

describe("parseBridgeState", () => {
  test("reads a current extension's snapshot", () => {
    expect(parseBridgeState(snapshot, fresh, 2000)).toEqual({
      sessionId: snapshot.sessionId,
      text: "draft",
      model: "anthropic/claude-opus",
      thinking: "medium",
      levels: ["off", "low", "medium", "high"],
      tiers: ["", "priority"],
      tier: "",
      status: "working",
      since: 2000,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      queued: snapshot.queued,
      jobs: snapshot.jobs,
      leaf: "e012",
      protocol: 3,
      build: "0123456789abcdef",
      caps: snapshot.caps,
      stretch: snapshot.stretch,
    });
  });

  test("old extensions: `idle` instead of status, plain-string queue items (steers)", () => {
    const s = parseBridgeState({ idle: false, queued: ["a", "", { text: "b" }, { followUp: true }] }, fresh, 1);
    expect(s.status).toBe("working");
    expect(s.queued).toEqual([
      { text: "a", followUp: false },
      { text: "b", followUp: false },
    ]);
    expect(parseBridgeState({ idle: true }, fresh, 1).status).toBe("idle");
    expect(parseBridgeState({}, fresh, 1).status).toBe("idle");
    expect(parseBridgeState({ status: "blocked", idle: true }, fresh, 1).status).toBe("blocked");
  });

  test("`since` holds while the status holds and restarts when it changes", () => {
    const working = parseBridgeState(snapshot, fresh, 2000);
    expect(parseBridgeState({ ...snapshot, text: "more" }, working, 3000).since).toBe(2000);
    expect(parseBridgeState({ ...snapshot, status: "idle" }, working, 4000).since).toBe(4000);
    expect(parseBridgeState({ ...snapshot, sessionId: "new-session" }, working, 5000).since).toBe(5000);
  });

  test("no context without a window; malformed lists degrade to empty", () => {
    const s = parseBridgeState({ ...snapshot, context: { tokens: 5, window: 0, percent: 1 }, levels: "high", jobs: {}, queued: null }, fresh, 1);
    expect(s.context).toBeNull();
    expect(s.levels).toEqual([]);
    expect(s.jobs).toEqual([]);
    expect(s.queued).toEqual([]);
  });

  test("stretch state: null without stretch.ts; malformed blocks, keys and empty blocks dropped", () => {
    expect(parseBridgeState({ ...snapshot, stretch: undefined }, fresh, 1).stretch).toBeNull();
    const s = parseBridgeState({ ...snapshot, stretch: { off: true, open: { "12.0": ["a", 3, ""], "x.1": ["b"], "13.2": [] } } }, fresh, 1);
    // A stretch.ts from before ✦ sends no ✦ fields: nothing to press, splice or twinkle.
    expect(s.stretch).toEqual({ off: true, open: { "12.0": ["a"] }, deepen: false, answers: {}, running: {} });
    const answers = { "12.0": [{ key: "a", text: "more" }, { text: "keyless" }], "x.1": [{ key: "b", text: "x" }], "13.2": [] };
    const running = { "12.0": [{ key: "a", seconds: "x", partial: 4 }, { seconds: 1 }] };
    const t = parseBridgeState({ ...snapshot, stretch: { off: false, open: {}, deepen: "yes", answers, running } }, fresh, 1).stretch;
    expect(t).toEqual({ off: false, open: {}, deepen: false, answers: { "12.0": [{ key: "a", text: "more" }] }, running: { "12.0": [{ key: "a", seconds: 0, partial: "" }] } });
    // A protocol 2 extension passes a newer stretch.ts's `deepen` through but can't forward a press.
    expect(parseBridgeState({ ...snapshot, protocol: 2 }, fresh, 1).stretch?.deepen).toBe(false);
  });

  test("drops jobs without an id and empty thinking levels; keeps the standard tier ''", () => {
    const s = parseBridgeState({ ...snapshot, jobs: [{ type: "bash" }, { id: "j", since: "x" }], levels: ["", "off", 3], tiers: ["", 2] }, fresh, 1);
    expect(s.jobs).toEqual([{ id: "j", type: "", label: "", agent: "", since: 0 }]);
    expect(s.levels).toEqual(["off"]);
    expect(s.tiers).toEqual(["", ""]);
  });

  test("an extension from before versioning: protocol 0, no caps, no build", () => {
    const { protocol: _p, caps: _c, build: _b, ...older } = snapshot;
    const s = parseBridgeState(older, fresh, 1);
    expect(s.protocol).toBe(0);
    expect(s.caps).toBeNull();
    expect(s.build).toBe("");
    expect(parseBridgeState({ ...snapshot, caps: [true], protocol: "2", build: 7 }, fresh, 1)).toMatchObject({ caps: null, protocol: 0, build: "" });
  });

  test("caps keep the known names; unnamed or non-true caps are unsupported, extras dropped", () => {
    const s = parseBridgeState({ ...snapshot, caps: { models: true, rewind: "yes", future: true } }, fresh, 1);
    expect(s.caps).toEqual({ models: true, tiers: false, jobs: false, queue: false, rewind: false, btw: false, complete: false, levels: false });
  });
});

describe("listChanged", () => {
  const base = parseBridgeState(snapshot, fresh, 1);
  const changed = (patch: Partial<BridgeState>) => listChanged(base, { ...base, ...patch });

  test("what the list shows: model, thinking, tier, status, context, session, jobs", () => {
    expect(changed({ model: "x/y" })).toBe(true);
    expect(changed({ thinking: "high" })).toBe(true);
    expect(changed({ tier: "priority" })).toBe(true);
    expect(changed({ status: "idle" })).toBe(true);
    expect(changed({ context: { ...base.context!, percent: 26 } })).toBe(true);
    expect(changed({ context: { ...base.context!, tokens: 50_001 } })).toBe(true);
    expect(changed({ context: { ...base.context!, window: 400_000 } })).toBe(true);
    expect(changed({ context: null })).toBe(true);
    expect(changed({ sessionId: "other" })).toBe(true);
    expect(changed({ jobs: [] })).toBe(true);
    expect(changed({ protocol: 4 })).toBe(true);
    expect(changed({ build: "fedcba9876543210" })).toBe(true);
    expect(changed({ caps: { ...base.caps!, rewind: false } })).toBe(true);
    expect(changed({ caps: null })).toBe(true);
  });

  test("not drafts, queue or leaf", () => {
    expect(changed({ text: "typing" })).toBe(false);
    expect(changed({ queued: [] })).toBe(false);
    expect(changed({ leaf: "e001" })).toBe(false);
    expect(listChanged(base, parseBridgeState(snapshot, base, 99))).toBe(false);
  });
});
