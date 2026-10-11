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
  });

  test("no context without a window; malformed lists degrade to empty", () => {
    const s = parseBridgeState({ ...snapshot, context: { tokens: 5, window: 0, percent: 1 }, levels: "high", jobs: {}, queued: null }, fresh, 1);
    expect(s.context).toBeNull();
    expect(s.levels).toEqual([]);
    expect(s.jobs).toEqual([]);
    expect(s.queued).toEqual([]);
  });

  test("drops jobs without an id and empty thinking levels; keeps the standard tier ''", () => {
    const s = parseBridgeState({ ...snapshot, jobs: [{ type: "bash" }, { id: "j", since: "x" }], levels: ["", "off", 3], tiers: ["", 2] }, fresh, 1);
    expect(s.jobs).toEqual([{ id: "j", type: "", label: "", agent: "", since: 0 }]);
    expect(s.levels).toEqual(["off"]);
    expect(s.tiers).toEqual(["", ""]);
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
    expect(changed({ context: null })).toBe(true);
    expect(changed({ sessionId: "other" })).toBe(true);
    expect(changed({ jobs: [] })).toBe(true);
  });

  test("not drafts, queue, leaf or token counts at the same percent", () => {
    expect(changed({ text: "typing" })).toBe(false);
    expect(changed({ queued: [] })).toBe(false);
    expect(changed({ leaf: "e001" })).toBe(false);
    expect(changed({ context: { ...base.context!, tokens: 50_001 } })).toBe(false);
    expect(listChanged(base, parseBridgeState(snapshot, base, 99))).toBe(false);
  });
});
