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
  /** `compactAt`: percent of the window where omp auto-compacts; null when off. */
  context: { tokens: number; window: number; percent: number; compactAt: number | null } | null;
  /** Background jobs: subagents (`task`, `eval`) and backgrounded bash. */
  jobs: Job[];
  /** The extension's bridge protocol; 0 when it sent none (an extension from before versioning). */
  protocol: number;
  /** What this omp supports, from its feature detection; null (older extension) means everything. */
  caps: Caps | null;
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
  since: number;
  doc: string | null;
  /** A finished turn or a wait on you that the phone hasn't opened yet. */
  unseen: "done" | "blocked" | null;
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
};
/** A side question's answer as it streams from omp (`done` once complete). */
export type Btw = { id: string; question: string; text: string; done: boolean; error: string };

export type ToolCall = { name: string; intent: string; error?: boolean };
export type TodoPhase = { name: string; tasks: { content: string; status: string; blocker?: string }[] };
export type AskQuestion = {
  question: string;
  options: { label: string; description: string }[];
  multi: boolean;
  recommended: number;
};
export type Ask = { role: "ask"; id: string; questions: AskQuestion[]; answer: string | null; ts: number };
export type ChatEntry =
  | { role: "user"; id: string; text: string; images: Img[]; ts: number }
  | { role: "assistant"; text: string; ts: number }
  | { role: "tools"; calls: ToolCall[]; images: Img[]; todo: TodoPhase[] | null; ts: number }
  | Ask
  | { role: "turn"; ms: number; model: string; ts: number }
  | { role: "advisor"; notes: AdvisorNote[]; ts: number };
export type AdvisorNote = { advisor: string; severity: string; note: string };
export type Img = { src: string };
export type Doc = { text: string; markdown: boolean; missing: boolean; clipped: boolean };
/** A model omp has credentials for, as the bridge lists it. */
export type CatalogModel = { p: string; id: string; name: string; r: boolean; ctx: number; in: number; out: number; img: boolean };

/** POSTs an action; null on success, else the server's error (or the network failure). */
export async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tern-mobile": "1" },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    const data: { error?: string } = await r.json().catch(() => ({}));
    return data.error ?? `HTTP ${r.status}`;
  } catch (err) {
    return String(err);
  }
}

/**
 * False when the server refuses this browser as not paired (no or a wrong access cookie): the
 * installer's pairing link sets the cookie. A network failure counts as paired; the app shows it offline.
 */
export async function checkPaired(): Promise<boolean> {
  try {
    const r = await fetch("/api/push/key");
    if (r.status !== 401) return true;
    const data: { error?: string } = await r.json().catch(() => ({}));
    return data.error !== "not paired";
  } catch {
    return true;
  }
}
