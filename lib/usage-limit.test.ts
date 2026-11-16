import { describe, expect, test } from "bun:test";
import { limitKind, resetFromMessage, resetFromUsage } from "./usage-limit";

// errorMessage values omp wrote to real transcripts.
const CODEX_USAGE = "Codex error event: The usage limit has been reached (code=usage_limit_reached)";
const CODEX_BUSY = "Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded) retry-after-ms=50000";
const CLAUDE_MAX = "Anthropic stream error (rate_limit_error): Claude Max rate limit reached. Wait a moment and try again.";
const RETRIES = "Retry budget exhausted after 10 retries: Anthropic stream error (rate_limit_error): Claude Max rate limit reached.";
const ZAI = "429 Usage limit reached for 5 hour. Your limit will reset at 2026-09-03 17:37:46\nPlease wait. (type=1308)";
const FREE = "429 Error from provider (Console): Rate limit exceeded. Please try again later. (type=FreeUsageLimitError)";
const SPEND = "Anthropic stream error (api_error): Claude Code returned an error result: You've hit your org's monthly spend limit · raise it at claude.ai";
const GEMINI = "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. (RESOURCE_EXHAUSTED)";

describe("limitKind", () => {
  test("usage and rate limits wait for a reset", () => {
    for (const error of [CODEX_USAGE, CODEX_BUSY, CLAUDE_MAX, RETRIES, ZAI, FREE, GEMINI]) expect(limitKind(error)).toBe("wait");
  });

  test("spending and credit caps don't lift by waiting", () => {
    expect(limitKind(SPEND)).toBe("spend");
    expect(limitKind("OpenAI error: You exceeded your current quota (code=insufficient_quota)")).toBe("spend");
    expect(limitKind("Your credit balance is too low to access the Anthropic API.")).toBe("spend");
  });

  test("other errors are no limit", () => {
    expect(limitKind("Anthropic stream error (overloaded_error): Overloaded")).toBeNull();
    expect(limitKind("Request was aborted")).toBeNull();
    expect(limitKind("")).toBeNull();
  });
});

describe("resetFromMessage", () => {
  test("retry-after-ms counts from the message's time", () => {
    expect(resetFromMessage(CODEX_BUSY, 1_000_000)).toEqual({ at: 1_050_000, exact: true });
  });

  test("a reset date without a zone is local time, and not exact", () => {
    expect(resetFromMessage(ZAI, 0)).toEqual({ at: new Date(2026, 8, 3, 17, 37, 46).getTime(), exact: false });
  });

  test("a reset date with a zone is that time", () => {
    expect(resetFromMessage("Your limit will reset at 2026-09-03 17:37:46 UTC", 0)).toEqual({ at: Date.UTC(2026, 8, 3, 17, 37, 46), exact: true });
    expect(resetFromMessage("Your limit will reset at 2026-09-03 17:37:46+08:00", 0)).toEqual({ at: Date.UTC(2026, 8, 3, 9, 37, 46), exact: true });
  });

  test("a message naming no time gives none", () => {
    expect(resetFromMessage(CODEX_USAGE, 1)).toBeNull();
    expect(resetFromMessage(CLAUDE_MAX, 1)).toBeNull();
  });
});

describe("resetFromUsage", () => {
  const NOW = 1_000_000;
  const limit = (resetsAt: number | undefined, status: string, usedFraction = 0.5, accountId?: string) => ({
    scope: { provider: "p", ...(accountId && { accountId }) },
    window: { resetsAt },
    amount: { usedFraction },
    status,
  });
  const report = (limits: unknown[], accountId?: string, provider = "p") => ({ provider, limits, metadata: { accountId } });

  test("an account is blocked until the last of its exhausted limits resets", () => {
    const data = { reports: [report([limit(NOW + 5000, "exhausted"), limit(NOW + 9000, "ok", 1), limit(NOW + 99_000, "ok")], "a")] };
    // The 7-day window's 1.0 counts as exhausted; the unexhausted one doesn't block.
    expect(resetFromUsage(data, "p", NOW)).toBe(NOW + 9000);
  });

  test("the session goes on once the first account frees", () => {
    const data = { reports: [report([limit(NOW + 9000, "exhausted")], "a"), report([limit(NOW + 4000, "exhausted")], "b")] };
    expect(resetFromUsage(data, "p", NOW)).toBe(NOW + 4000);
  });

  test("limits name their account in their scope, over the report's", () => {
    const data = { reports: [report([limit(NOW + 9000, "exhausted", 1, "a"), limit(NOW + 3000, "exhausted", 1, "b")], "x")] };
    expect(resetFromUsage(data, "p", NOW)).toBe(NOW + 3000);
  });

  test("no future time: an account free now, a reset passed, an exhausted limit without one, or no report", () => {
    expect(resetFromUsage({ reports: [report([limit(NOW + 9000, "exhausted")], "a"), report([limit(NOW + 9000, "ok")], "b")] }, "p", NOW)).toBeNull();
    expect(resetFromUsage({ reports: [report([limit(NOW - 1, "exhausted")], "a")] }, "p", NOW)).toBeNull();
    expect(resetFromUsage({ reports: [report([limit(undefined, "exhausted")], "a")] }, "p", NOW)).toBeNull();
    expect(resetFromUsage({ reports: [report([limit(NOW + 9000, "exhausted")], "a", "other")] }, "p", NOW)).toBeNull();
    expect(resetFromUsage(null, "p", NOW)).toBeNull();
  });
});
