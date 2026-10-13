// The app's pure logic: formatting, list filtering, model search, and the payloads it sends.
import type { AskQuestion, Caps, CatalogModel, Install, Item, Job, Live, Project, Role, TodoPhase } from "./api";

// ---------- formatting ----------

export const isAgentJob = (j: Job) => j.type === "task" || j.type === "eval";

/** What's running in the background, one line: "2 subagents · 1 background job". */
export function jobsSummary(jobs: Job[]): string {
  const agents = jobs.filter(isAgentJob).length;
  const other = jobs.length - agents;
  return [
    agents ? `${agents} subagent${agents > 1 ? "s" : ""}` : "",
    other ? `${other} background job${other > 1 ? "s" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Time since `ms` in its largest unit: "42s", "5m", "3h", "2d"; "" when there is no time. */
export function age(ms: number, now: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A turn's length: "42s", "3m05s", "1h02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Wall-clock time, always 24-hour. */
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** 1234 → "1.2k", 200000 → "200k", 1000000 → "1M". */
export function tokensShort(n: number): string {
  // 999.5k and up would round to "1000k".
  if (n >= 999_500) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${n >= 1e4 ? Math.round(n / 1e3) : +(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** `600000` → `600k`, `1048576` → `1M`. */
export function ctxShort(n: number): string {
  return n >= 999_500 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

/** `$4·20` per million tokens in and out; "" when the catalog has no price. */
export function priceShort(m: CatalogModel): string {
  if (!m.in && !m.out) return "";
  const f = (n: number) => (n >= 10 ? String(Math.round(n)) : String(+n.toFixed(2)));
  return `$${f(m.in)}·${f(m.out)}`;
}

/** `anthropic/claude-opus-5-5` → `Opus 5.5`, `openai-codex/gpt-6.1-sol` → `GPT 6.1 Sol`. */
export function prettyModel(spec: string): string {
  const parts = (spec.split("/").pop() ?? "").split(":")[0].replace(/^claude-/, "").split("-");
  const words: string[] = [];
  for (const p of parts) {
    const prev = words[words.length - 1];
    if (/^\d+$/.test(p) && prev && /\d$/.test(prev)) words[words.length - 1] = `${prev}.${p}`;
    else words.push(p === "gpt" ? "GPT" : p.charAt(0).toUpperCase() + p.slice(1));
  }
  return words.join(" ");
}

/** The ⟨role⟩ whose model is the session's current one, if any. */
export function currentRole(roles: Role[], model: string, thinking: string): string | null {
  const matches = roles.filter((r) => r.spec.split(":")[0] === model || r.spec.split(":")[0].endsWith(`/${model}`));
  return (matches.find((r) => r.spec.split(":")[1] === thinking) ?? matches[0])?.role ?? null;
}

// ---------- the bridge ----------

/**
 * Whether the session's omp supports `cap`. Without a bridge nothing works; an extension from
 * before feature detection (no caps) is taken to support everything, as it did.
 */
export function can(live: Live | null | undefined, cap: keyof Caps): boolean {
  if (!live) return false;
  // A cap missing from the list is one the extension predates: unsupported.
  return live.caps === null || live.caps[cap] === true;
}

// ---------- the extension ----------

/** One argument of a POSIX shell or PowerShell command, quoted only when it needs it. */
export function shellArg(value: string, windows: boolean): string {
  if (/^[\w@%+=:,./\\~-]+$/.test(value)) return value;
  return windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Commands run in the checkout: `&&` in a POSIX shell; Windows PowerShell 5.1 has no `&&`, so `;` there. */
function inRepo(install: Install, ...steps: string[]): string {
  return [`cd ${shellArg(install.repo, install.windows)}`, ...steps].join(install.windows ? "; " : " && ");
}

/** What to tell the user, the command that fixes it, and whether a Reload button can (omp's `/restart`). */
export type Notice = { text: string; command: string | null; reload: boolean };

/** The list's banner when omp's extension file isn't this checkout's: the installer puts it right. */
export function installNotice(install: Install): Notice | null {
  if (install.status === "ok") return null;
  const problem = {
    missing: `No tern-mobile extension at ${install.path}, so omp sessions don't connect to tern-mobile.`,
    stale: `The tern-mobile extension at ${install.path} is an outdated copy.`,
    foreign: `The tern-mobile extension at ${install.path} links to ${install.target}, not this checkout.`,
  }[install.status];
  return {
    text: `${problem} Install it from the checkout (running omp sessions load it once restarted):`,
    command: inRepo(install, "bun install.ts"),
    reload: false,
  };
}

/**
 * A session's notice when its extension isn't the server's. `newer`: the server is behind, so
 * tern-awui gets updated. `older`: omp loaded the extension before the checkout changed, so omp
 * restarts: Reload (omp's `/restart`, offered when this omp has it and is idle, the installed file
 * being current), else quitting and resuming by hand. Sessions without a bridge get none.
 */
export function sessionNotice(item: Item, install: Install): Notice | null {
  const live = item.live;
  if (!live?.mismatch) return null;
  if (live.mismatch === "newer")
    return {
      text: "This omp runs a newer tern-mobile extension than the server. Update tern-awui:",
      command: inRepo(install, "git pull", "bun install.ts"),
      reload: false,
    };
  const older = "This omp loaded an older tern-mobile extension than the checkout's, so some of it may not work from here.";
  if (install.status !== "ok")
    return { text: `${older} The installed file is outdated too: reinstall it, then restart this omp.`, command: inRepo(install, "bun install.ts"), reload: false };
  if (live.restart) {
    const idle = item.status === "idle";
    return {
      text: `${older} Reload restarts omp in this pane with /restart and resumes the session${idle ? "." : " (once it is idle)."}`,
      command: null,
      reload: idle,
    };
  }
  const id = item.agent?.sessionId;
  return {
    text: `${older} Quit omp in this pane and start it again; this continues the session:`,
    command: id ? `omp --resume ${shellArg(id, install.windows)}` : "omp --continue",
    reload: false,
  };
}

// ---------- routes ----------

/** A subagent name as omp writes it (and the server accepts): no separators, no leading dot or underscore. */
export const SUBAGENT_NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;

/** The screen a URL hash shows: the list, a session, its subagents, or one subagent's chat. */
export type Route =
  | { view: "list" }
  | { view: "session"; block: string }
  | { view: "subagents"; block: string }
  | { view: "subagent"; block: string; name: string };

/** `#/b/12`, `#/b/12/sub`, `#/b/12/sub/<name>`; anything else is the list, a bad name the subagent list. */
export function parseRoute(hash: string): Route {
  const m = /^#\/b\/(\d+)(\/sub(?:\/([^/]+))?)?$/.exec(hash);
  if (!m) return { view: "list" };
  const [, block, sub, raw] = m;
  if (!sub) return { view: "session", block };
  let name = "";
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    // A malformed escape is no name.
  }
  return SUBAGENT_NAME.test(name) ? { view: "subagent", block, name } : { view: "subagents", block };
}

export function routeHash(r: Route): string {
  if (r.view === "list") return "#/";
  const session = `#/b/${r.block}`;
  if (r.view === "session") return session;
  return r.view === "subagents" ? `${session}/sub` : `${session}/sub/${encodeURIComponent(r.name)}`;
}

/** Whether `to` is a screen above `from`: the list above all, a session above its subagent screens, the subagent list above each subagent. */
export function isAbove(to: Route, from: Route): boolean {
  if (to.view === "list") return from.view !== "list";
  if (from.view === "list" || to.block !== from.block) return false;
  return to.view === "session" ? from.view !== "session" : to.view === "subagents" && from.view === "subagent";
}

/**
 * Records the screen `newHash` was entered from, so its ‹ can pop history. Going up (back to the
 * list, to a session from its subagents) keeps what the screen above was entered from.
 */
export function trackOrigin(origins: Map<string, string>, oldHash: string, newHash: string): void {
  const from = parseRoute(oldHash);
  const to = parseRoute(newHash);
  if (!isAbove(to, from)) origins.set(routeHash(to), routeHash(from));
}

/**
 * Where ‹ leads from `r`, and whether that is a history pop (the target is the screen `r` was
 * entered from) rather than a replace (a deep link, a notification, a jump from elsewhere), so
 * back never stacks a screen it would reopen. A session goes to the list, the subagent list to
 * its session, a subagent to the subagent list when opened from there, else to its session.
 */
export function backStep(origins: Map<string, string>, r: Route): { target: string; pop: boolean } {
  const origin = origins.get(routeHash(r));
  let target = "#/";
  if (r.view === "subagents" || r.view === "subagent") {
    const session = `#/b/${r.block}`;
    target = r.view === "subagent" && origin === `${session}/sub` ? origin : session;
  }
  return { target, pop: origin === target };
}

// ---------- folders ----------

/**
 * A folder as the project picker shows it: its name, and its parent with the home folder as `~`.
 * Paths come from the server's OS: `/` or `\` separators, and Windows compares without case.
 */
export function folderLabel(path: string, home: string): { name: string; parent: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = cut < 0 ? "" : path.slice(0, cut);
  const fold = (s: string) => (/^[A-Za-z]:/.test(home) ? s.toLowerCase() : s);
  const head = fold(parent.slice(0, home.length));
  const underHome = home !== "" && head === fold(home) && (parent.length === home.length || "/\\".includes(parent[home.length]));
  return { name: path.slice(cut + 1) || path, parent: underHome ? `~${parent.slice(home.length)}` : parent };
}

/** base64url VAPID key → bytes, as pushManager.subscribe wants it. */
export function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * The language hyphenation should use. Hungarian-only letters (ő, ű) or a high share of accented
 * vowels mark a message as Hungarian; everything else hyphenates as English.
 */
export function langOf(text: string): "hu" | "en" {
  if (/[őűŐŰ]/.test(text)) return "hu";
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const accented = text.match(/[áéíóöúüÁÉÍÓÖÚÜ]/g)?.length ?? 0;
  return letters > 0 && accented / letters > 0.02 ? "hu" : "en";
}

// ---------- the session list ----------

export const OLD_MS = 24 * 3600_000;

/**
 * Untouched for over a day. Working, waiting, unseen and open sessions never are; neither are
 * blocks without a time (shells, notes).
 */
export function isOld(i: Item, now: number, selected: string | null): boolean {
  return i.since > 0 && now - i.since > OLD_MS && i.status !== "working" && i.status !== "blocked" && !i.unseen && i.block !== selected;
}

/**
 * The projects the list shows. A filter (lowercase `needle`) matches project, tag, title and last
 * prompt, hidden old sessions included; otherwise `hideOld` drops old ones. Empty projects go.
 */
export function listProjects(projects: Project[], needle: string, hideOld: boolean, now: number, selected: string | null): Project[] {
  if (!needle && !hideOld) return projects;
  const keep = (p: Project, i: Item) =>
    needle
      ? [p.name, i.tag ?? "", i.title, i.agent?.lastPrompt ?? ""].join(" ").toLowerCase().includes(needle)
      : !isOld(i, now, selected);
  return projects.map((p) => ({ ...p, items: p.items.filter((i) => keep(p, i)) })).filter((p) => p.items.length);
}

/** A row's second line, whether it is omp's recap, and whether an idle row has gone stale (a day). */
export function rowText(item: Item, now: number): { sub: string; recap: boolean; stale: boolean } {
  const a = item.agent;
  const idle = item.status === "idle";
  // Idle agents show omp's recap ("Earlier:" once turns followed it); others the last prompt.
  const recap = idle && a?.recap ? `${a.recapStale ? "Earlier: " : ""}${a.recap}` : "";
  const sub = item.doc ? docSub(item.doc, item.cwd) : recap || a?.lastPrompt || item.cwd;
  return { sub, recap: !!recap, stale: idle && now - item.since > 86_400_000 };
}

/** A file block's second line: "Note" for Tern's notes, else its folder, named from the block's cwd folder when inside it. */
function docSub(doc: string, cwd: string): string {
  // Tern's notes folder on any OS: …/tern/notes/ (Linux), …/Tern/notes/ (macOS), …\Tern\notes\ (Windows).
  if (/[\\/]tern[\\/]notes[\\/]/i.test(doc)) return "Note";
  const cut = Math.max(doc.lastIndexOf("/"), doc.lastIndexOf("\\"));
  const dir = cut < 0 ? "" : doc.slice(0, cut);
  const base = cwd.replace(/[\\/]+$/, "");
  if (!base || !(dir === base || (dir.startsWith(base) && "/\\".includes(dir[base.length])))) return dir;
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1);
  return name + dir.slice(base.length);
}

/** The collapsed projects as stored on this device; anything unreadable counts as none. */
export function parseCollapsed(raw: string | null): Set<string> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** `set` with `name` flipped in or out. */
export function toggled(set: Set<string>, name: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(name)) next.add(name);
  return next;
}

// ---------- the model picker ----------

export const RECENT_MAX = 6;

/** Every whitespace-separated word of `query` appears in `text`, ignoring case. */
export function matchesWords(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => lower.includes(w));
}

/** Models matching every word; the whole query in the name ranks first, then in the id. */
export function searchModels(models: CatalogModel[], query: string): CatalogModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const rank = (m: CatalogModel) => (m.name.toLowerCase().includes(needle) ? 0 : `${m.p}/${m.id}`.includes(needle) ? 1 : 2);
  return models.filter((m) => matchesWords(needle, `${m.name} ${m.p}/${m.id}`)).sort((x, y) => rank(x) - rank(y));
}

/** The recent picks as stored on this device, newest first. */
export function parseRecent(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** `recent` after picking `spec`: it moves to the front, the oldest falls off. */
export function withRecent(recent: string[], spec: string): string[] {
  return [spec, ...recent.filter((k) => k !== spec)].slice(0, RECENT_MAX);
}

// ---------- chat ----------

/** A todo list's one-line summary: done of total, blocked count, and the task under way. */
export function todoSummary(phases: TodoPhase[]): { done: number; total: number; blocked: number; current: string } {
  const tasks = phases.flatMap((p) => p.tasks);
  const done = tasks.filter((t) => t.status === "completed").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const active = tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "blocked");
  return { done, total: tasks.length, blocked, current: done === tasks.length ? "all done" : (active?.content ?? "") };
}

/** An advisor note's `Key:` value (else its whole first line) and the other lines, `Label:` split off. */
export function parseAdvisorNote(note: string): { key: string; lines: { label: string | null; text: string }[] } {
  const lines = note.split("\n").map((l) => {
    const f = /^(\w[\w ]{0,15}):\s*(.*)$/.exec(l);
    return f ? { label: f[1], text: f[2] } : { label: null, text: l };
  });
  const key = lines.find((l) => l.label === "Key")?.text ?? note.split("\n")[0];
  return { key, lines: lines.filter((l) => l.label !== "Key") };
}

/** One question's state in an open ask card. */
export type AskPick = { option: number | null; picks: number[]; other: string; otherOpen: boolean };

/** Every question answered: an option picked, any boxes (multi), or Other's text typed. */
export function askReady(questions: AskQuestion[], picks: AskPick[]): boolean {
  return picks.every((p, i) => (p.otherOpen ? p.other.trim() !== "" : questions[i].multi ? true : p.option !== null));
}

/** The answers as the server's `answer` endpoint takes them. */
export function askAnswers(picks: AskPick[]) {
  return picks.map((p) =>
    p.otherOpen && p.other.trim() ? { other: p.other.trim(), picks: p.picks } : { option: p.option, picks: p.picks },
  );
}

// ---------- the composer ----------

/** The keystrokes turning a shell line from `before` into `after`: Backspaces, then new text. */
export function lineEdit(before: string, after: string): { back: number; text: string } {
  const was = Array.from(before);
  const now = Array.from(after);
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same++;
  return { back: was.length - same, text: now.slice(same).join("") };
}

/** Bare `/btw` opens saved history; `/btw …` asks a side question. */
export function btwCommand(text: string): { kind: "history" } | { kind: "question"; question: string } | null {
  const match = /^\/btw(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!match) return null;
  return match[1] ? { kind: "question", question: match[1] } : { kind: "history" };
}

/**
 * What a key in the composer does. A hardware keyboard's Enter sends; Shift+Enter breaks the line;
 * Ctrl+Enter or Ctrl+Q queues a follow-up while the agent works, as in omp. Touch keyboards'
 * Enter only breaks the line.
 */
export function composerKey(
  e: { key: string; ctrlKey: boolean; shiftKey: boolean },
  s: { working: boolean; live: boolean; terminal: boolean; touch: boolean },
): "followUp" | "send" | null {
  if (e.ctrlKey && (e.key === "Enter" || e.key === "q") && s.working && s.live && !s.terminal) return "followUp";
  return e.key === "Enter" && !e.shiftKey && !s.touch ? "send" : null;
}

const SENDABLE: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true };
/** Bigger pastes (photos, 4K screenshots) are scaled to this long edge and sent as JPEG. */
const MAX_EDGE = 2048;
const MAX_RAW_BYTES = 3 * 1024 * 1024;

/** Whether a pasted image must be redrawn as JPEG: a type omp can't take, or too big. */
export function needsReencode(type: string, size: number): boolean {
  return SENDABLE[type] !== true || size > MAX_RAW_BYTES;
}

/** A redrawn image's size: its long edge at most MAX_EDGE, never enlarged. */
export function fitEdge(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
