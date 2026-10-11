// Untyped JSON from tern and omp: every field is read through these, so a missing or
// mistyped one degrades to an empty value instead of throwing.

export type Obj = Record<string, unknown>;

/** Narrows parsed JSON to an object; anything else reads as empty. */
export function obj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
export function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
