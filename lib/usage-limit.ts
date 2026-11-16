// A turn omp ended on a provider's usage or rate limit: what kind it is, and when it lifts.

import { arr, num, obj, str } from "./json";

/**
 * `wait`: a usage or rate limit that lifts on its own (a 5-hour window, a busy provider).
 * `spend`: a spending or credit cap, which waiting doesn't lift.
 */
export type LimitKind = "wait" | "spend";

/**
 * What a session's banner shows: the limit, when it resets (null: unknown, or never for `spend`),
 * and when the server sends the continue it was asked to (null: none set).
 */
export type LimitView = { kind: LimitKind; error: string; resetAt: number | null; continueAt: number | null };

/** What a session stopped on a usage limit is sent, at the reset or on the phone's tap. */
export const CONTINUE_TEXT = "Continue from where you stopped.";
/** How long after the reset the continue goes, so it doesn't race the provider's own clock. */
export const CONTINUE_AFTER_MS = 60_000;

// OpenAI's `insufficient_quota` and a billing hard limit are caps; a bare "exceeded your current
// quota" (Gemini's 429 RESOURCE_EXHAUSTED says it too, with "check your plan and billing details")
// is a rate limit that lifts.
const SPEND = /spend(?:ing)? limit|insufficient[_ ](?:quota|credits?|balance|funds)|credit balance|out of credits|billing[_ ]hard[_ ]limit/i;
const WAIT = /rate[_ ]limit|usage[_ ]limit|FreeUsageLimitError|too many requests|exceeded your current quota|RESOURCE_EXHAUSTED|\b429\b.*\blimit/i;

/** The limit an omp `errorMessage` reports; null for any other error. */
export function limitKind(error: string): LimitKind | null {
  if (SPEND.test(error)) return "spend";
  return WAIT.test(error) ? "wait" : null;
}

/**
 * When the limit lifts, as the message says: `retry-after-ms=N` counts from `at` (the message's
 * time); `reset at YYYY-MM-DD HH:MM[:SS]` with a zone (`Z`, `UTC`, `+08:00`) is that time, and
 * without one is read as local time, which may be off by the provider's zone: `exact` is false
 * then. Null when it says neither.
 */
export function resetFromMessage(error: string, at: number): { at: number; exact: boolean } | null {
  const after = /retry-after-ms=(\d+)/i.exec(error);
  if (after) return { at: at + Number(after[1]), exact: true };
  const on = /\breset(?:s)? at (\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?(?: ?(Z|UTC|GMT|[+-]\d\d:?\d\d))?/i.exec(error);
  if (!on) return null;
  const [y, mo, d, h, mi, s] = on.slice(1, 7).map((v) => Number(v ?? 0));
  const zone = on[7]?.toUpperCase();
  if (!zone) {
    const local = new Date(y, mo - 1, d, h, mi, s).getTime();
    return Number.isFinite(local) ? { at: local, exact: false } : null;
  }
  const offset = /^[+-]/.test(zone) ? (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * 60_000 : 0;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - offset;
  return Number.isFinite(utc) ? { at: utc, exact: true } : null;
}

/**
 * When `provider` can serve again, from `omp usage --json`: each account is blocked until the
 * last of its exhausted limits resets (status `exhausted`, or all of it used), and the session can
 * go on once the first account frees. Null unless that is after `now`: an account free already, an
 * exhausted limit without a reset time on every account, or no report for the provider.
 */
export function resetFromUsage(data: unknown, provider: string, now: number): number | null {
  /** When each account frees; 0 when nothing of it is exhausted. */
  const accounts = new Map<string, number>();
  for (const [i, report] of arr(obj(data).reports).map(obj).entries()) {
    if (str(report.provider) !== provider) continue;
    // omp reports each account apart; its id names it when the limit's scope doesn't.
    const reportAccount = str(obj(report.metadata).accountId) || `report ${i}`;
    for (const limit of arr(report.limits).map(obj)) {
      const account = str(obj(limit.scope).accountId) || reportAccount;
      const exhausted = limit.status === "exhausted" || num(obj(limit.amount).usedFraction) >= 1;
      const resetsAt = num(obj(limit.window).resetsAt);
      const frees = accounts.get(account) ?? 0;
      accounts.set(account, exhausted ? Math.max(frees, resetsAt > 0 ? resetsAt : Infinity) : frees);
    }
  }
  if (!accounts.size) return null;
  const at = Math.min(...accounts.values());
  return Number.isFinite(at) && at > now ? at : null;
}
