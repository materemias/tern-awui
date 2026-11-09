export type { BtwHistoryRecord, BtwHistoryTurn } from "../lib/btw-history";
export type { ContextUse, Run, StretchState, Voice } from "../lib/bridge-state";
export type { Closed } from "../lib/closed";

// ---------- API shapes (mirror server.ts) ----------

/** The omp session in a pane (present while its omp is connected to the bridge). */
export type Agent = {
  sessionId: string;
  lastPrompt: string;
  recap: string;
  recapStale: boolean;
  lastActivity: number;
  /** Its subagents: finished ones with a transcript and running ones. */
  subagents: number;
};
export type Live = {
  model: string;
  thinking: string;
  /** The current model's thinking levels ("off" first) and serving tiers ("" = standard). */
  levels: string[];
  tiers: string[];
  tier: string;
  /** Background jobs: subagents (`task`, `eval`) and backgrounded bash. */
  jobs: Job[];
  /** The extension's bridge protocol; 0 when it sent none (an extension from before versioning). */
  protocol: number;
  /** What this omp supports, from its feature detection; null (older extension) means everything. */
  caps: Caps | null;
  /** The extension's build id; "" when it reported none. */
  build: string;
  /**
   * How this session's extension differs from the server's: `older` (omp loaded it before the
   * checkout changed; restarting omp loads the installed one), `newer` (the server is older); null: same.
   */
  mismatch: "older" | "newer" | null;
  /** This omp has `/restart` (restarts it in its pane, resuming the session); asked only when `older`. */
  restart: boolean;
};
export type Caps = {
  models: boolean;
  tiers: boolean;
  jobs: boolean;
  queue: boolean;
  rewind: boolean;
  btw: boolean;
  complete: boolean;
  levels: boolean;
  /** omp runs voice calls for the phone (`ctx.startLive`, omp after 18.13.3). */
  voice: boolean;
};
export type Job = { id: string; type: string; label: string; agent: string; since: number };
/** A session's subagent as `view=subagents` lists it; `running`: one of the session's jobs. */
export type Subagent = { name: string; started: number; lastActivity: number; running: boolean; summary: string; messages: number };

export type Item = {
  block: string;
  icon: string | null;
  tag: string | null;
  title: string;
  cwd: string;
  project: string;
  branch: string | null;
  agent: Agent | null;
  live: Live | null;
  /** working / blocked / idle; null for shells and files. */
  status: string | null;
  /** An omp pane whose omp hasn't connected yet: it is still starting. */
  starting: boolean;
  since: number;
  doc: string | null;
  /** A finished turn or a wait on you that the phone hasn't opened yet. */
  unseen: "done" | "blocked" | null;
  /** Parked in Tern, its program still running: off the list, in the new-omp sheet's Parked tab. */
  parked: boolean;
};
export type Role = { role: string; spec: string };
export type Project = { name: string; items: Item[] };
export type State = {
  projects: Project[];
  counts: Record<string, number>;
  roles: Role[];
  /** Unseen updates across sessions. */
  badge: number;
  at: number;
  /** The server's dist/ build id; a page from another build reloads. */
  app: string;
  /** The extension file omp loads (`<omp dir>/extensions/tern-mobile.ts`) against this checkout. */
  extension: Install;
};
/**
 * `ok`: a link to the checkout's file or an identical copy; `missing`; `stale`: a copy that differs;
 * `foreign`: a link to another file (`target`). `repo`: the checkout, where `bun install.ts` fixes it;
 * `windows`: the fix is a PowerShell command.
 */
export type Install = { status: "ok" | "missing" | "stale" | "foreign"; path: string; target: string; repo: string; windows: boolean };
/** A side question's answer as it streams from omp (`done` once complete). */
export type Btw = { id: string; question: string; text: string; done: boolean; error: string };

export type ToolCall = { name: string; intent: string; error?: boolean };
export type TodoPhase = { name: string; tasks: { content: string; status: string; blocker?: string }[] };
/** A field of an ask form (lib/ask-form.ts): `other` groups get a free-text Other answer. */
export type AskField =
  | { kind: "text"; name: string; question: string; multiline: boolean; value: string }
  | { kind: "choice"; name: string; question: string; multi: boolean; select: boolean; other: boolean; options: { value: string; label: string; checked: boolean; disabled: boolean }[] };
/** An `ask` call: one HTML form; `answer` one `question: answer` line per field once omp has it. */
export type Ask = { role: "ask"; id: string; html: string; fields: AskField[]; question: string; answer: string | null; ts: number };
export type ChatEntry =
  | { role: "user"; id: string; text: string; images: Img[]; ts: number }
  /** `block`: the stretchtext id of a reply holding `{{short|long}}` markup (see lib/transcript.ts). */
  | { role: "assistant"; text: string; block?: string; imageSources?: Record<string, string>; ts: number }
  | { role: "tools"; calls: ToolCall[]; images: Img[]; todo: TodoPhase[] | null; ts: number }
  | Ask
  | { role: "turn"; ms: number; model: string; ts: number }
  | { role: "advisor"; notes: AdvisorNote[]; ts: number }
  /** omp rules injected mid-turn; `text` is the rule body, "" when the transcript has only the name. */
  | { role: "rule"; rules: { name: string; text: string }[]; ts: number }
  /** omp's idle recap, merged in by time (see lib/recaps.ts). */
  | { role: "recap"; text: string; ts: number }
  /** omp's cache-miss marker: `tokens` of prompt sent again in full (see lib/transcript.ts). */
  | { role: "cacheMiss"; tokens: number; ts: number };
export type AdvisorNote = { advisor: string; severity: string; note: string };
export type Img = { src: string };
/** `imageSources`: a markdown file's local images (relative to it or absolute) as `/api/blob/…` URLs. */
export type Doc = { text: string; markdown: boolean; imageSources?: Record<string, string>; missing: boolean; clipped: boolean };
/** A model omp has credentials for, as the bridge lists it. */
export type CatalogModel = { p: string; id: string; name: string; r: boolean; ctx: number; in: number; out: number; img: boolean };

/** A JSON POST with the header the server requires of the app; `init` adds options such as `keepalive`. */
export function postJson(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", "x-tern-mobile": "1" },
    body: JSON.stringify(body),
  });
}

/** POSTs an action; null on success, else the server's error (or the network failure). */
export async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const r = await postJson(path, body);
    if (r.ok) return null;
    const data: { error?: string } = await r.json().catch(() => ({}));
    return data.error ?? `HTTP ${r.status}`;
  } catch (err) {
    return String(err);
  }
}
