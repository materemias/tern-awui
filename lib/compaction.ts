// Where omp auto-compacts a session, for the context meter's marker.

/** omp's `compaction.*` settings; `reserveTokens` null when unset. */
export type Compaction = { enabled: boolean; thresholdTokens: number; thresholdPercent: number; reserveTokens: number | null };

/**
 * Where auto-compaction fires, as a percent of `window`; null when it is off. Mirrors omp's
 * resolveThresholdTokens (pi-agent-core compaction.ts): fixed tokens, else a percent, else the
 * window minus a reserve of max(15 %, reserveTokens ?? 16384). Per-model thresholds are not read.
 */
export function compactAtPercent(s: Compaction, window: number): number | null {
  if (!s.enabled || !(window > 0)) return null;
  let tokens: number;
  if (s.thresholdTokens > 0) tokens = Math.min(window - 1, Math.max(1, s.thresholdTokens));
  else if (s.thresholdPercent > 0) tokens = Math.floor(window * (Math.min(99, Math.max(1, s.thresholdPercent)) / 100));
  else {
    const proportional = Math.max(1, Math.floor(window * 0.15));
    let reserve = Math.max(Math.floor(window * 0.15), s.reserveTokens ?? 16384);
    if ((s.reserveTokens === null && reserve >= window - proportional) || reserve >= window) reserve = proportional;
    tokens = Math.max(0, Math.min(window - 1, window - reserve));
  }
  return tokens > 0 ? (tokens / window) * 100 : null;
}
