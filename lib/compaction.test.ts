import { describe, expect, test } from "bun:test";
import { compactAtPercent, type Compaction } from "./compaction";

// omp's defaults: enabled, thresholdTokens/thresholdPercent -1 (unset), reserveTokens unset.
const defaults: Compaction = { enabled: true, thresholdTokens: -1, thresholdPercent: -1, reserveTokens: null };
const at = (s: Partial<Compaction>, window: number) => compactAtPercent({ ...defaults, ...s }, window);

describe("compactAtPercent", () => {
  test("off when compaction is disabled or the window is unknown", () => {
    expect(at({ enabled: false, thresholdPercent: 80 }, 200_000)).toBeNull();
    expect(at({ thresholdPercent: 80 }, 0)).toBeNull();
    expect(at({ thresholdPercent: 80 }, -5)).toBeNull();
    expect(at({ thresholdPercent: 80 }, NaN)).toBeNull();
  });

  test("a fixed token threshold wins over a percent, clamped below the window", () => {
    expect(at({ thresholdTokens: 100_000, thresholdPercent: 10 }, 200_000)).toBe(50);
    expect(at({ thresholdTokens: 500_000 }, 200_000)).toBeCloseTo(((200_000 - 1) / 200_000) * 100, 10);
  });

  test("a percent threshold is clamped to 1..99 and floors to whole tokens", () => {
    expect(at({ thresholdPercent: 80 }, 200_000)).toBe(80);
    expect(at({ thresholdPercent: 150 }, 200_000)).toBe(99);
    expect(at({ thresholdPercent: 0.2 }, 200_000)).toBe(1);
    // floor(1001 * 0.5) = 500 tokens
    expect(at({ thresholdPercent: 50 }, 1001)).toBeCloseTo((500 / 1001) * 100, 10);
  });

  test("unset thresholds leave a reserve of max(15 %, 16384) below the window", () => {
    expect(at({}, 200_000)).toBe(85); // 15 % = 30000 > 16384
    expect(at({}, 64_000)).toBeCloseTo(((64_000 - 16_384) / 64_000) * 100, 10);
  });

  test("a default reserve too big for a small window falls back to 15 %", () => {
    expect(at({}, 16_000)).toBe(85);
    expect(at({}, 19_000)).toBe(85); // 16384 >= 19000 - 2850
  });

  test("an explicit reserve is honoured unless it swallows the window", () => {
    expect(at({ reserveTokens: 50_000 }, 200_000)).toBe(75);
    expect(at({ reserveTokens: 90_000 }, 100_000)).toBeCloseTo(10, 10);
    expect(at({ reserveTokens: 100_000 }, 100_000)).toBe(85);
    // A small explicit reserve is still at least 15 % of the window.
    expect(at({ reserveTokens: 1000 }, 200_000)).toBe(85);
  });

  test("no marker when the threshold resolves to zero tokens", () => {
    expect(at({ thresholdPercent: 1 }, 50)).toBeNull(); // floor(0.5) = 0
  });
});
