// Recently closed sessions, for the new-omp sheet's Closed tab: every session a pane's omp
// reported through the bridge (recorded as it happens), plus the sessions in omp's prompt history
// (history.db, which print-mode runs, evals and subagents never write) for the time before, minus
// those running now, newest first. Prompt history alone misses sessions: its prompts are unique,
// so a prompt typed again moves to the later session. A search also covers Claude Code and Codex
// sessions (lib/other-agents.ts). Only the tools' own files are read, so it works wherever they
// and Tern run.

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inBatches } from "./batch";
import { num, obj, str } from "./json";
import type { OtherSession } from "./other-agents";
import { writePrivateFile } from "./private-file";
import { cachedTranscriptCwd } from "./projects";
import { queryRecaps } from "./recaps";
import { keepsTool, matchesWords, parseSearch, type ClosedAgent } from "./search";

// Nerd-font icons live in the private use areas; the app ships the symbols font for them.
const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/u;
const PUA_ALL = new RegExp(PUA.source, "gu");
/** A folder on a mount that stopped answering counts as gone after this long. */
const FOLDER_TIMEOUT_MS = 2000;

/** An omp title such as `<glyph> RDP: Diagnose login` as its icon, uppercase tag and the rest. */
export function splitTitle(raw: string): { icon: string | null; tag: string | null; title: string } {
  const icon = PUA.exec(raw)?.[0] ?? null;
  const clean = raw.replace(PUA_ALL, "").trim();
  const m = /^([\p{Lu}\d_-]{2,14}):\s+(.*)$/u.exec(clean);
  return { icon, tag: m ? m[1] : null, title: m ? m[2] : clean };
}

export type Closed = {
  /** The tool the session belongs to: resuming runs it. */
  agent: ClosedAgent;
  id: string;
  icon: string | null;
  tag: string | null;
  /** The tool's title; "" for a session it never titled. */
  title: string;
  cwd: string;
  /** The last prompt typed into it, "" when its prompt history has none. */
  prompt: string;
  recap: string;
  /** Its last activity (ms): the transcript's last write, or the last prompt if later. */
  at: number;
};

/** Reads omp's history.db, giving `fallback` without one (server.ts's `fromHistory`). */
export type HistoryReader = <T>(read: (db: Database) => T, fallback: T) => T;

/** Transcript paths by session id, from omp's `<sessions>/<folder>/<time>_<id>.jsonl` names. */
async function transcriptIndex(sessionsDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const rel of new Bun.Glob("*/*_*.jsonl").scan(sessionsDir)) {
      const name = rel.slice(Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1, -".jsonl".length);
      out.set(name.slice(name.indexOf("_") + 1), join(sessionsDir, rel));
    }
  } catch {
    // No sessions folder yet.
  }
  return out;
}

/** `cwd` if Tern can open a tab there: an absolute path to a folder that answers within FOLDER_TIMEOUT_MS. "" otherwise. */
export async function openableFolder(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) return "";
  const late = Promise.withResolvers<false>();
  const timer = setTimeout(() => late.resolve(false), FOLDER_TIMEOUT_MS);
  try {
    const isDir = await Promise.race([stat(cwd).then((s) => s.isDirectory()), late.promise]);
    return isDir ? cwd : "";
  } catch {
    return ""; // gone
  } finally {
    clearTimeout(timer);
  }
}

/** The folder an omp transcript's session ran in, if Tern can open a tab there; "" otherwise. */
export async function resumableCwd(transcript: string): Promise<string> {
  try {
    return await openableFolder(await cachedTranscriptCwd(transcript));
  } catch {
    return ""; // the transcript is gone
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);
/** A session picked for the list, before its folder is checked. */
type Pick = { agent: ClosedAgent; id: string; at: number; path: string; cwd: string; title: string; prompt: string };

/**
 * The `limit` closed sessions with the newest activity, `skip` (running or dismissed) left out, and
 * those Tern can't reopen (no transcript, or its folder is gone) too. Without a `query`: the omp
 * sessions in `seen` and in prompt history. With one: those whose title, prompts, recaps or folders
 * hold every word of it, and the sessions `others` reads (Claude Code, Codex) that do. Tool names
 * among the words (`omp`, `claude`, `codex`) keep those tools' sessions only.
 */
export async function closedSessions(o: {
  history: HistoryReader;
  sessionsDir: string;
  seen: string[];
  skip: Set<string>;
  limit: number;
  query?: string;
  others?: () => Promise<OtherSession[]>;
}): Promise<Closed[]> {
  const { tools, rest: query } = parseSearch(o.query ?? "");
  const searching = (o.query ?? "").trim() !== "";
  const omp = keepsTool(tools, "omp");
  // Read meanwhile: an omp search doesn't wait for them first.
  const others = searching && o.others && (keepsTool(tools, "claude") || keepsTool(tools, "codex")) ? o.others() : Promise.resolve([]);
  // All of prompt history (a row per session, a few thousand at most): only the transcripts' dates rank them.
  const known = o.history(
    (db) => {
      const prompts = new Map<string, { prompt: string; at: number }>();
      // SQLite takes the bare columns from the row holding MAX(): each session's newest prompt.
      for (const raw of db.query("SELECT session_id, prompt, MAX(created_at) AS at FROM history WHERE session_id IS NOT NULL AND session_id <> '' GROUP BY session_id").all()) {
        const r = obj(raw);
        prompts.set(str(r.session_id), { prompt: str(r.prompt), at: num(r.at) * 1000 });
      }
      const titles = new Map<string, string>();
      try {
        for (const raw of db.query("SELECT session_id, title FROM session_titles").all()) {
          const r = obj(raw);
          titles.set(str(r.session_id), str(r.title));
        }
      } catch {
        // An omp before session_titles: rows go by their prompt.
      }
      // A search reads every prompt, folder and recap of each session.
      const text = new Map<string, Set<string>>();
      const add = (id: string, s: string) => {
        if (!s) return;
        const set = text.get(id);
        if (set) set.add(s);
        else text.set(id, new Set([s]));
      };
      if (query && omp) {
        for (const raw of db.query("SELECT session_id, prompt, cwd FROM history WHERE session_id IS NOT NULL AND session_id <> ''").all()) {
          const r = obj(raw);
          add(str(r.session_id), str(r.prompt));
          add(str(r.session_id), str(r.cwd));
        }
        try {
          for (const raw of db.query("SELECT session_id, recap FROM session_recaps").all()) add(str(obj(raw).session_id), str(obj(raw).recap));
        } catch {
          // An omp before recaps.
        }
      }
      return { prompts, titles, text };
    },
    { prompts: new Map<string, { prompt: string; at: number }>(), titles: new Map<string, string>(), text: new Map<string, Set<string>>() },
  );
  const paths = await transcriptIndex(o.sessionsDir);
  const candidates = [...new Set(omp ? [...o.seen, ...known.prompts.keys()] : [])].flatMap((id) => {
    const path = paths.get(id);
    return path && !o.skip.has(id) ? [{ id, path }] : [];
  });
  const found = await inBatches(candidates, async ({ id, path }): Promise<Pick | null> => {
    try {
      if (query) {
        // The transcript's folder too: a session whose prompts all moved to later ones has no history row naming it.
        const text = [...(known.text.get(id) ?? []), await cachedTranscriptCwd(path)];
        if (!matchesWords(query, `${known.titles.get(id) ?? ""} ${text.join(" ")}`)) return null;
      }
      const at = Math.max((await stat(path)).mtimeMs, known.prompts.get(id)?.at ?? 0);
      return { agent: "omp", id, at, path, cwd: "", title: known.titles.get(id) ?? "", prompt: known.prompts.get(id)?.prompt ?? "" };
    } catch {
      return null; // deleted meanwhile
    }
  });
  const picks = found.filter((p) => p !== null);
  for (const s of await others)
    if (keepsTool(tools, s.agent) && !o.skip.has(s.id) && matchesWords(query, `${s.title} ${s.prompts.join(" ")} ${s.cwd}`))
      picks.push({ agent: s.agent, id: s.id, at: s.at, path: "", cwd: s.cwd, title: s.title, prompt: s.prompts.at(-1) ?? "" });
  picks.sort((a, b) => b.at - a.at);
  // Newest first until `limit` have a folder Tern can open.
  const opened = await inBatches(
    picks,
    async (p) => ({ ...p, cwd: p.agent === "omp" ? await resumableCwd(p.path) : await openableFolder(p.cwd) }),
    (done) => done.filter((k) => k.cwd).length >= o.limit,
  );
  const kept = opened.filter((k) => k.cwd).slice(0, o.limit);
  const recaps = o.history((db) => queryRecaps(db, kept.filter((k) => k.agent === "omp").map((k) => k.id)), new Map<string, { text: string }>());
  return kept.map(({ agent, id, cwd, at, title, prompt }) => ({
    agent,
    id,
    // omp titles carry an icon and a tag; the other tools' don't.
    ...(agent === "omp" ? splitTitle(title) : { icon: null, tag: null, title }),
    cwd,
    prompt: oneLine(prompt),
    recap: agent === "omp" ? (recaps.get(id)?.text ?? "") : "",
    at,
  }));
}

/** Session ids kept in a file across restarts, the newest `max` (the Closed tab's seen and dismissed ones). */
export class IdList {
  private ids: string[];
  private set: Set<string>;
  constructor(
    private file: string,
    private max: number,
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      this.ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      this.ids = []; // none yet, or a cut-off file
    }
    this.set = new Set(this.ids);
  }
  all(): string[] {
    return this.ids;
  }
  has(id: string): boolean {
    return this.set.has(id);
  }
  /**
   * Adds `id`, or moves it to the newest end once it sits in the older half of the cap, so an id
   * still in use doesn't age out; the file is written only then, not on every repeat.
   */
  add(id: string): void {
    if (!id) return;
    if (this.set.has(id) && this.ids.indexOf(id) >= this.ids.length - this.max / 2) return;
    this.ids = [...this.ids.filter((x) => x !== id), id].slice(-this.max);
    this.set = new Set(this.ids);
    this.save();
  }
  delete(id: string): void {
    if (!this.set.delete(id)) return;
    this.ids = this.ids.filter((x) => x !== id);
    this.save();
  }
  /** A failed write (full disk, read-only folder) keeps the list in memory for this run. */
  private save(): void {
    try {
      writePrivateFile(this.file, JSON.stringify(this.ids));
    } catch (err) {
      console.error(`tern-awui: cannot save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
