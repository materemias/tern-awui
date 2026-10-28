// Stands in for Anthropic's Messages API during a take: answers each request with the step the
// take's script module picks for it (its `pick`), streamed, so the film shows omp running real
// tools on fixed replies.
//   bun film/fake-model.ts [port] [log] [script module]
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request as ModelRequest, Step } from "./steps";

const port = Number(process.argv[2] ?? 4598);
// The take names its script on the command line, so the module is only known at run time.
const { pick }: { pick: (body: ModelRequest) => Step } = await import(resolve(process.argv[4] ?? `${import.meta.dir}/script.ts`));
const log = process.argv[3];
const CHUNK = 5;

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
        // A pause before the first word, as a model's would.
        await Bun.sleep(step.pause ?? 700);
        for (const c of chunks) {
          controller.enqueue(new TextEncoder().encode(c));
          await Bun.sleep(step.pace ?? 22);
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`fake model on http://127.0.0.1:${port}`);
