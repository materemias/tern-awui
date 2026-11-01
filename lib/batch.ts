/** Files looked at once: a few thousand must not exhaust file descriptors. */
const BATCH = 64;

/** `fn` over `items`, BATCH at a time, results in order; `enough` stops before the next batch. */
export async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, enough?: (done: R[]) => boolean): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length && !enough?.(out); i += BATCH) out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))));
  return out;
}
