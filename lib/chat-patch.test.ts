import { expect, test } from "bun:test";
import { applyChatPatch, chatKeys, chatUpdate, type ChatPatch } from "./chat-patch";

type Entry = { role: string; text?: string; calls?: { name: string }[]; ts: number };
type Chat = { entries: Entry[]; note?: string };

const said = (i: number): Entry => ({ role: "assistant", text: `Answer number ${i}, long enough to be worth not resending.`, ts: i });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => said(from + i));

/** What a stream that sent `before` sends for `after`; a patch must rebuild `after` from `before`. */
function update(before: Chat, after: Chat) {
  const sent = chatUpdate(after, chatKeys(after), chatKeys(before));
  if (sent?.[0] === "chatpatch") expect(applyChatPatch(before, sent[1])).toEqual(after);
  return sent;
}

test("the first copy is sent whole, an unchanged one not at all", () => {
  const chat = { entries: range(0, 5) };
  expect(chatUpdate(chat, chatKeys(chat), null)).toEqual(["chat", chat]);
  expect(update(chat, { entries: range(0, 5) })).toBeNull();
});

test("an appended entry is the only one sent", () => {
  const sent = update({ entries: range(0, 10) }, { entries: range(0, 11) });
  expect(sent).toEqual(["chatpatch", { base: 10, drop: 0, keep: 10, add: [said(10)] }]);
});

test("a streamed tool group growing in the last entry resends just that entry", () => {
  const tools = (n: number): Entry => ({ role: "tools", calls: Array.from({ length: n }, (_, i) => ({ name: `call ${i}` })), ts: 99 });
  const sent = update({ entries: [...range(0, 10), tools(2)] }, { entries: [...range(0, 10), tools(3)] });
  expect(sent).toEqual(["chatpatch", { base: 11, drop: 0, keep: 10, add: [tools(3)] }]);
});

test("at the 80-entry window, entries leaving the front cost nothing", () => {
  const sent = update({ entries: range(0, 80) }, { entries: range(2, 82) });
  expect(sent).toEqual(["chatpatch", { base: 80, drop: 2, keep: 78, add: [said(80), said(81)] }]);
});

test("a rewind that rewrote the window falls back to the full chat", () => {
  const after = { entries: range(0, 80) };
  expect(update({ entries: range(20, 100) }, after)).toEqual(["chat", after]);
  // So does a tiny chat, where the patch's own fields outweigh the entries.
  const short = { entries: [said(1)] };
  expect(update({ entries: [] }, short)).toEqual(["chat", short]);
});

test("fields besides the entries travel in the patch", () => {
  const sent = update({ entries: range(0, 10), note: "before" }, { entries: range(0, 10), note: "after" });
  expect(sent).toEqual(["chatpatch", { note: "after", base: 10, drop: 0, keep: 10, add: [] }]);
});

test("a patch for another copy of the chat can't be applied", () => {
  const patch: ChatPatch<Chat> = { base: 10, drop: 0, keep: 10, add: [said(10)] };
  expect(applyChatPatch({ entries: range(0, 9) }, patch)).toBeNull();
  expect(applyChatPatch({ entries: range(0, 10) }, { ...patch, keep: 11 })).toBeNull();
  expect(applyChatPatch({ entries: range(0, 10) }, { ...patch, add: undefined as never })).toBeNull();
});

test("a patch whose counts aren't whole, non-negative numbers is refused", () => {
  const prev = { entries: range(0, 10) };
  const patch: ChatPatch<Chat> = { base: 10, drop: 0, keep: 10, add: [said(10)] };
  for (const bad of [{ drop: 0.5 }, { keep: 9.5 }, { drop: -1, keep: 10 }, { base: "10" as never }, { keep: Number.NaN }, { drop: null as never }]) {
    expect(applyChatPatch(prev, { ...patch, ...bad })).toBeNull();
  }
  expect(applyChatPatch(prev, patch)?.entries).toEqual(range(0, 11));
});
