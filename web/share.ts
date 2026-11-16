// What another app shared to the installed app (the manifest's share target): sw.js keeps the
// posted form in a cache entry and opens the app with `?share=<id>`. The list then asks which
// session it goes to, and that session's composer takes it as a draft; nothing is sent.
import { useEffect, useState } from "preact/hooks";

export type Share = { text: string; images: Blob[] };

/** The shared text in one draft: title, text and link, each once (apps often repeat the link in the text). */
export function shareText(title: string, text: string, url: string): string {
  const parts: string[] = [];
  for (const part of [title, text, url].map((p) => p.trim()))
    if (part && !parts.some((p) => p.includes(part))) parts.push(part);
  return parts.join("\n\n");
}

/** Reads and removes the share sw.js stashed under `id`; null when it is gone. */
async function fromCache(id: string): Promise<Share | null> {
  if (!/^[a-z0-9]{1,40}$/.test(id) || !("caches" in window)) return null;
  const cache = await caches.open("tern-share");
  const key = `/share/${id}`;
  const stored = await cache.match(key);
  if (!stored) return null;
  await cache.delete(key);
  const form = await stored.formData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const images = form.getAll("images").filter((f): f is File => typeof f !== "string" && f.type.startsWith("image/"));
  return { text: shareText(field("title"), field("text"), field("url")), images };
}

let loader: (id: string) => Promise<Share | null> = fromCache;
/** The demo has no service worker: it hands over a sample share for `?share=demo` instead. */
export function setShareLoader(load: (id: string) => Promise<Share | null>) {
  loader = load;
}

/** The share waiting for a session to be picked. */
let pending: Share | null = null;
/**
 * The share picked for a block until that block's composer takes it, and when: one its composer
 * never took (a session that closed meanwhile) is gone after PICK_MS, or once another is picked.
 */
let picked: { block: string; share: Share; at: number } | null = null;
const PICK_MS = 2 * 60_000;
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

/** On load: a `?share=<id>` in the address loads that share once and leaves the address. */
export async function loadShare() {
  const params = new URLSearchParams(location.search);
  const id = params.get("share");
  if (id === null) return;
  params.delete("share");
  const query = params.toString();
  // Without the marker, a reload doesn't ask again; the list shows the picker.
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}#/`);
  const share = await loader(id).catch(() => null);
  if (!share || (!share.text && !share.images.length)) return;
  pending = share;
  // A newer share replaces one picked earlier that no composer took.
  picked = null;
  changed();
}

/** Re-renders on every share change; its count, for effects that must rerun. */
export function useShareChanges(): number {
  const [n, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return n;
}

/** The share waiting for its session, kept current. */
export function usePendingShare(): Share | null {
  useShareChanges();
  return pending;
}

/** Sends the waiting share to `block`'s composer (null drops it). */
export function pickShare(block: string | null) {
  picked = pending && block ? { block, share: pending, at: Date.now() } : null;
  pending = null;
  changed();
}

/** The share picked for `block`, once, while it is fresh. */
export function takeShare(block: string): Share | null {
  if (picked?.block !== block) return null;
  const share = Date.now() - picked.at < PICK_MS ? picked.share : null;
  picked = null;
  return share;
}
