// The session list as a stream sends it after the first full copy: only the rows that changed,
// plus the order of every row, so a status flip on one session doesn't resend all of them.
// Shared by the server (statePatch) and the web app (applyStatePatch); no Node imports here.

type Row = { block: string };
type Listed<I extends Row> = { projects: { name: string; items: I[] }[] };

/** Everything but `projects`, the order of every row by project, and the rows that differ from the previous copy. */
export type StatePatch<S extends Listed<I>, I extends Row> = Omit<S, "projects"> & {
  order: [string, string[]][];
  changed: I[];
};

/** Each row's serialised form by block id: what two copies of the list are compared by. */
export function rowKeys<I extends Row>(s: Listed<I>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const p of s.projects) for (const i of p.items) keys.set(i.block, JSON.stringify(i));
  return keys;
}

/** `s` as a patch against the copy whose row keys were `before`; `order` and `keys` are `s`'s own (see rowKeys). */
export function statePatch<S extends Listed<I>, I extends Row>(s: S, order: [string, string[]][], keys: Map<string, string>, before: Map<string, string>): StatePatch<S, I> {
  const { projects, ...rest } = s;
  return {
    ...rest,
    order,
    changed: projects.flatMap((p) => p.items.filter((i) => before.get(i.block) !== keys.get(i.block))),
  };
}

/** The list a patch describes, rows it doesn't carry taken from `prev`; null when `prev` lacks one (resync needed). */
export function applyStatePatch<S extends Listed<I>, I extends Row>(prev: S, patch: StatePatch<S, I>): S | null {
  const rows = new Map<string, I>();
  for (const p of prev.projects) for (const i of p.items) rows.set(i.block, i);
  for (const i of patch.changed) rows.set(i.block, i);
  const { order, changed: _, ...rest } = patch;
  const projects: { name: string; items: I[] }[] = [];
  for (const [name, blocks] of order) {
    const items: I[] = [];
    for (const block of blocks) {
      const row = rows.get(block);
      if (!row) return null;
      items.push(row);
    }
    projects.push({ name, items });
  }
  return { ...rest, projects } as unknown as S;
}
