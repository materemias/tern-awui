import { KEY_SEPARATOR, parse, streamingView, writeOpen } from "./stretch-core";

/** Agent text with every stretch drawn open, for views without links (side answers). */
export function openText(text: string): string {
  return text.includes("{{") ? writeOpen(parse(text)) : text;
}

/** A reply still being written: short forms only, so neither markup nor a half long form shows. */
export function liveText(text: string): string {
  return text.includes("{{") ? streamingView(parse(text)) : text;
}

/** A block's open keys after opening or closing `key`; closing also closes the stretches nested in it. */
export function withOpen(keys: readonly string[], key: string, open: boolean): string[] {
  if (open) return keys.includes(key) ? [...keys] : [...keys, key];
  return keys.filter((k) => k !== key && !k.startsWith(key + KEY_SEPARATOR));
}
