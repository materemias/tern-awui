// Search helpers shared by the web app's lists and the server's Closed search.

/** The tools whose sessions the Closed tab lists and resumes. */
export const CLOSED_AGENTS = ["omp", "claude", "codex"] as const;
export type ClosedAgent = (typeof CLOSED_AGENTS)[number];

/** Every whitespace-separated word of `query` appears in `text`, ignoring case. */
export function matchesWords(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => lower.includes(w));
}

/** A Closed search: the tools its words name (empty: every tool's sessions) and the words left to match. */
export function parseSearch(query: string): { tools: Set<ClosedAgent>; rest: string } {
  const tools = new Set<ClosedAgent>();
  const rest: string[] = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const tool = CLOSED_AGENTS.find((a) => a === word);
    if (tool) tools.add(tool);
    else rest.push(word);
  }
  return { tools, rest: rest.join(" ") };
}

/** Whether a search for `tools` (from `parseSearch`) keeps `agent`'s sessions. */
export const keepsTool = (tools: Set<ClosedAgent>, agent: ClosedAgent) => tools.size === 0 || tools.has(agent);
