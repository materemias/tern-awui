import { afterAll, beforeAll, expect, test } from "bun:test";
import { Events, Extension, Sandbox, item, until } from "./server-harness";
import { obj } from "../lib/json";

const s = new Sandbox();
const extension = new Extension(s);
beforeAll(async () => {
  await s.start();
  await extension.connect();
  await until(async () => item(await s.state(), 1).agent, "bridged session");
}, 6000);
afterAll(() => s.close());

test("a phone opens a stretch in the pane's stretch.ts, and the pane's open stretches stream to the phone", async () => {
  const tap = { block: "1792161451904.1", key: "wraps values", open: true };
  expect((await s.action(1, "stretch", tap)).status).toBe(409);

  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  // Before stretch.ts reports, the stream says so: a phone keeps no stale state from an earlier omp.
  expect(await events.take("stretch")).toBeNull();
  extension.report({ stretch: { off: false, open: {} } });
  const none = { deepen: false, answers: {}, running: {} };
  expect(await events.take("stretch")).toEqual({ off: false, open: {}, ...none });

  expect((await s.action(1, "stretch", { ...tap, block: "../1" })).status).toBe(400);
  expect((await s.action(1, "stretch", { ...tap, key: "" })).status).toBe(400);
  expect((await s.action(1, "stretch", tap)).status).toBe(200);
  expect(await extension.take("stretch")).toMatchObject(tap);

  // Opened on the desktop (or confirmed after the tap): the phone hears it.
  extension.report({ stretch: { off: false, open: { [tap.block]: [tap.key] } } });
  expect(await events.take("stretch", (d) => tap.block in obj(obj(d).open))).toEqual({ off: false, open: { [tap.block]: [tap.key] }, ...none });
  // A phone opening the session later starts from the current state.
  const late = new Events();
  await late.open(s, "?block=1&view=chat");
  expect(await late.take("stretch")).toEqual({ off: false, open: { [tap.block]: [tap.key] }, ...none });
});

test("a phone presses ✦ only where the pane's stretch.ts can ask for more; its answer streams back in the state", async () => {
  const press = { block: "1792161451904.1", key: "wraps values", deepen: true };
  extension.report({ protocol: 3, stretch: { off: false, open: {}, deepen: false } });
  await until(async () => (await s.action(1, "stretch", press)).status === 409, "refused without ✦");
  const events = new Events();
  await events.open(s, "?block=1&view=chat");
  // An extension before protocol 3 passes a ✦ stretch.ts's state through but would drop the press.
  extension.report({ protocol: 2, stretch: { off: false, open: { [press.block]: [press.key] }, deepen: true } });
  expect(await events.take("stretch", (d) => press.block in obj(obj(d).open))).toMatchObject({ deepen: false });
  expect((await s.action(1, "stretch", press)).status).toBe(409);
  extension.report({ protocol: 3, stretch: { off: false, open: {}, deepen: true } });
  await events.take("stretch", (d) => obj(d).deepen === true);
  expect((await s.action(1, "stretch", press)).status).toBe(200);
  expect(await extension.take("deepen")).toMatchObject({ block: press.block, key: press.key });
  const running = { [press.block]: [{ key: press.key, seconds: 2, partial: "Stale" }] };
  extension.report({ stretch: { off: false, open: {}, deepen: true, running } });
  expect(await events.take("stretch", (d) => press.block in obj(obj(d).running))).toMatchObject({ running });
  const answers = { [press.block]: [{ key: press.key, text: "Stale entries {{linger|linger until evicted}}." }] };
  extension.report({ stretch: { off: false, open: {}, deepen: true, answers } });
  expect(await events.take("stretch", (d) => press.block in obj(obj(d).answers))).toMatchObject({ answers, running: {} });
});
