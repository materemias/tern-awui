// The open chat as a stream sends it after the first full copy: the run of entries it still shares
// with the previous copy, by position, and the entries after that run. A working turn rewrites the
// transcript often, and the newest 80 entries would otherwise be resent on every write.
// Shared by the server (chatUpdate) and the web app (applyChatPatch); no Node imports here.

type Chat = { entries: unknown[] };

/**
 * Everything but `entries`; `base`, the previous copy's length; the entries kept from it, `keep`
 * of them from index `drop` on; then `add`, the entries after them.
 */
export type ChatPatch<C extends Chat> = Omit<C, "entries"> & { base: number; drop: number; keep: number; add: C["entries"] };

/** What two copies of a chat are compared by: everything but its entries, and each entry, serialised. */
export type ChatKeys = { rest: string; entries: string[] };

export function chatKeys(chat: Chat): ChatKeys {
  const { entries, ...rest } = chat;
  return { rest: JSON.stringify(rest), entries: entries.map((e) => JSON.stringify(e)) };
}

/** The length of `value` serialised with `entries` (or `field`) as the array whose items serialise to `items`. */
function serialisedLength(value: object, field: string, items: string[]): number {
  let length = JSON.stringify({ ...value, [field]: [] }).length + Math.max(items.length - 1, 0);
  for (const item of items) length += item.length;
  return length;
}

/**
 * What a stream sends for `chat` (whose keys are `keys`) after the copy whose keys were `before`,
 * null if it sent none: nothing when they match, a patch when it is smaller, else the full copy.
 * The patch keeps the longest run of `before` that `chat` starts with: entries dropped off the
 * front of the window and a changed or growing tail cost only the entries after the run.
 */
export function chatUpdate<C extends Chat>(chat: C, keys: ChatKeys, before: ChatKeys | null): ["chat", C] | ["chatpatch", ChatPatch<C>] | null {
  if (!before) return ["chat", chat];
  const prev = before.entries;
  const next = keys.entries;
  if (keys.rest === before.rest && prev.length === next.length && prev.every((k, i) => k === next[i])) return null;
  let drop = 0;
  let keep = 0;
  // A run can't be longer than what's left of `prev` from where it starts.
  for (let d = 0; d < prev.length && prev.length - d > keep; d++) {
    let k = 0;
    while (d + k < prev.length && k < next.length && prev[d + k] === next[k]) k++;
    if (k > keep) {
      drop = d;
      keep = k;
    }
  }
  const { entries, ...rest } = chat;
  const head = { ...rest, base: prev.length, drop, keep };
  const added = next.slice(keep);
  if (serialisedLength(head, "add", added) >= serialisedLength(rest, "entries", next)) return ["chat", chat];
  return ["chatpatch", { ...head, add: entries.slice(keep) } as ChatPatch<C>];
}

/** The chat a patch describes, built on `prev`; null when `prev` isn't the copy it was made against (resync needed). */
export function applyChatPatch<C extends Chat>(prev: C, patch: ChatPatch<C>): C | null {
  const { base, drop, keep, add, ...rest } = patch;
  if (prev.entries.length !== base || !Array.isArray(add) || drop < 0 || keep < 0 || drop + keep > base) return null;
  return { ...rest, entries: [...prev.entries.slice(drop, drop + keep), ...add] } as unknown as C;
}
