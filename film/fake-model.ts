// Stands in for Anthropic's Messages API during a take: answers each turn with the STEPS entry its
// last message calls for, streamed, so the film shows omp running real tools on fixed replies.
//   bun film/fake-model.ts [port] [log]
import { appendFileSync } from "node:fs";
import { ASK_TERN, DEEPEN_REPLY, DRAFT_PHONE, DRAFT_TERN, PAST, STEPS, type Step } from "./script";

const port = Number(process.argv[2] ?? 4598);
const log = process.argv[3];
const CHUNK = 5;

type Block = { type: string; text?: string; tool_use_id?: string };
type Message = { role: string; content: string | Block[] };

const DEEPEN: Step = { text: DEEPEN_REPLY };

function pick(body: { tools?: { name: string }[]; messages?: Message[] }): Step {
  // An omp-stretch ✦ press is a side request whose last message asks for more on one section.
  if (JSON.stringify(body.messages?.at(-1) ?? "").includes("pressed ✦ to ask")) return DEEPEN;
  // The other projects' sessions, prompted before the take: their title and their one reply.
  const past = PAST.find((p) => JSON.stringify(body.messages ?? "").includes(p.prompt));
  // omp's own side requests: the session title (asked with or without the agent's tools).
  if (!body.tools?.some((t) => t.name === "ask") || JSON.stringify(body.messages?.at(-1) ?? "").includes("<title-request>")) {
    return past ? { text: past.title } : STEPS.title;
  }
  if (past) return { text: past.reply };
  // The turn's user messages since the last reply: omp-stretch adds its notes after the prompt.
  const messages = body.messages ?? [];
  const turn = messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1);
  const blocks = turn.flatMap((m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content));
  const result = blocks.find((b) => b.type === "tool_result")?.tool_use_id;
  if (result === "toolu_read") return STEPS.plan;
  if (result === "toolu_ask") return STEPS.test;
  if (result === "toolu_test") return STEPS.done;
  const text = blocks.map((b) => b.text ?? "").join("\n");
  if (text.includes(DRAFT_PHONE)) return STEPS.pr;
  if (text.includes(DRAFT_TERN)) return STEPS.ask;
  if (text.includes(ASK_TERN)) return STEPS.read;
  return STEPS.title;
}

const sse = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const pieces = (s: string) => Array.from({ length: Math.ceil(s.length / CHUNK) }, (_, i) => s.slice(i * CHUNK, (i + 1) * CHUNK));

function events(step: Step): string[] {
  const out = [sse("message_start", {
    message: { id: "msg_film", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1800, output_tokens: 1 } },
  })];
  let index = 0;
  if (step.text) {
    out.push(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
    for (const text of pieces(step.text)) out.push(sse("content_block_delta", { index, delta: { type: "text_delta", text } }));
    out.push(sse("content_block_stop", { index }));
    index++;
  }
  const tool = "tool" in step ? step.tool : undefined;
  if (tool) {
    out.push(sse("content_block_start", { index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } }));
    for (const partial_json of pieces(JSON.stringify(tool.input))) out.push(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json } }));
    out.push(sse("content_block_stop", { index }));
  }
  out.push(
    sse("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 120 } }),
    sse("message_stop", {}),
  );
  return out;
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/messages")) return Response.json({});
    const body = await req.json();
    const step = pick(body);
    if (log) appendFileSync(log, `${JSON.stringify({ tools: body.tools?.length ?? 0, last: body.messages?.at(-1), step })}\n`);
    const chunks = events(step);
    const stream = new ReadableStream({
      async start(controller) {
        // A pause before the first word, as a model's would; a ✦ answer thinks longer, so the twinkle shows.
        await Bun.sleep(step === STEPS.title ? 0 : step === DEEPEN ? 2200 : 700);
        for (const c of chunks) {
          controller.enqueue(new TextEncoder().encode(c));
          await Bun.sleep(step === DEEPEN ? 45 : 22);
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`fake model on http://127.0.0.1:${port}`);
