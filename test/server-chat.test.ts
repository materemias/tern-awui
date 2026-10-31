import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { arr, obj } from "../lib/json";
import { Events, Extension, Sandbox, item, until } from "./server-harness";

const s = new Sandbox();
let agent: Extension;
beforeAll(async () => {
  await s.start();
  agent = new Extension(s);
  await agent.connect();
  await until(async () => item(await s.state(), 1).agent, "bridged session");
}, 6000);
afterAll(() => s.close());

const say = (text: string, at: number) => {
  s.transcript.say(text, at);
  appendFileSync(s.transcriptPath, s.transcript.lines().at(-1)! + "\n");
};

test("after the first full chat, a transcript write sends only what changed", async () => {
  // No bridged leaf: the file's last entry is the chat's end.
  agent.report({ leaf: "" });
  for (let i = 0; i < 20; i++) say(`Earlier answer ${i}, long enough that resending it costs something.`, 5000 + i * 100);
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  const first = obj(await events.take("chat", (c) => arr(obj(c).entries).some((e) => obj(e).text === "Earlier answer 19, long enough that resending it costs something.")));
  say("The newest answer.", 9000);
  const patch = obj(await events.take("chatpatch"));
  expect(patch.base).toBe(arr(first.entries).length);
  expect(arr(patch.add).length).toBeLessThan(3);
  // The harness applies it like the page does; a new stream's full copy is the same chat.
  const applied = await events.take("chat");
  const fresh = new Events();
  await fresh.open(s, "?block=1&view=chat");
  expect(applied).toEqual(await fresh.take("chat"));
  expect(arr(obj(applied).entries).some((e) => obj(e).text === "The newest answer.")).toBe(true);
  events.close();
  fresh.close();
});
