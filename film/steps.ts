// What a take's script module and the fake model share: the request it answers, and one streamed answer.

export type Block = { type: string; text?: string; tool_use_id?: string };
export type Message = { role: string; content: string | Block[] };
/** The parts of a Messages API request a script picks its answer by. */
export type Request = { tools?: { name: string }[]; messages?: Message[] };

/** One answer: text, a tool call, or both; `pause` before the first word and `pace` between chunks, in ms. */
export type Step = ({ text: string } | { text?: string; tool: { id: string; name: string; input: Record<string, unknown> } }) & { pause?: number; pace?: number };

/** omp's own side requests (the session title) come without the agent's tools or as a `<title-request>`. */
export function isSideRequest(body: Request): boolean {
  return !body.tools?.some((t) => t.name === "ask") || JSON.stringify(body.messages?.at(-1) ?? "").includes("<title-request>");
}

/** The turn's user blocks since the last reply: tool results, the prompt, steers. */
export function turnBlocks(body: Request): Block[] {
  const messages = body.messages ?? [];
  const turn = messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1);
  return turn.flatMap((m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content));
}
