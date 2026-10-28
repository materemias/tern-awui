// Films one take of the app on a phone, away from the desk: six real omps with the tern-mobile
// extension in a real Tern window (not filmed), a real tern-awui server, and the app in a headless
// Chromium phone, answered by fake-model.ts from script-phone.ts. compose.py renders the timeline.
//   bun film/take-phone.ts [WORK]   (default /tmp/tern-awui-film-phone)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "../test/server-harness";
import { PHONE, recorder, setUp, sleep } from "./rig";
import { SESSIONS, STEER } from "./script-phone";

/** A phone-sized page of the storefront the screenshots session reads: the cart, then the payment step. */
const SCREENS: Record<string, string> = {
  cart: `<h1>Your cart</h1>
    <div class="item"><div class="pic" style="background:#f4c7a1"></div><div><b>Linen shirt</b><span>Size M · Sand</span></div><b>€49.00</b></div>
    <div class="item"><div class="pic" style="background:#b9d3ee"></div><div><b>Canvas tote</b><span>Navy</span></div><b>€24.00</b></div>
    <div class="item"><div class="pic" style="background:#c8e6c9"></div><div><b>Wool socks</b><span>2 pairs</span></div><b>€18.00</b></div>
    <div class="sum"><span>Total, tax included</span><b>€91.00</b></div>
    <button>Checkout</button>`,
  pay: `<h1>Payment</h1>
    <div class="card">•••• •••• •••• 4242<span>Expires 08/29</span></div>
    <div class="sum"><span>Subtotal</span><b>€76.47</b></div>
    <div class="sum"><span>VAT 19%</span><b>€14.53</b></div>
    <div class="sum total"><span>Total</span><b>€91.00</b></div>
    <button>Pay €91.00</button>`,
};
const SCREEN_CSS = `body{margin:0;padding:28px 22px;font:16px system-ui,sans-serif;color:#1d1d1f;background:#fafafa}
  h1{font-size:28px;margin:0 0 22px}
  .item{display:flex;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid #e5e5ea}
  .item div:nth-child(2){flex:1;display:flex;flex-direction:column;gap:3px}.item span{color:#6e6e73;font-size:14px}
  .pic{width:56px;height:56px;border-radius:12px}
  .card{padding:22px;border-radius:16px;background:#1d1d1f;color:#fff;font:600 18px ui-monospace,monospace;display:flex;flex-direction:column;gap:10px;margin-bottom:22px}
  .card span{font:14px system-ui;color:#c7c7cc}
  .sum{display:flex;justify-content:space-between;padding:12px 0;color:#3a3a3c}.sum.total{font-size:20px;color:#1d1d1f}
  button{width:100%;margin-top:26px;padding:16px;border:0;border-radius:14px;background:#0071e3;color:#fff;font:600 18px system-ui}`;

const rig = await setUp({
  work: process.argv[2] ?? "/tmp/tern-awui-film-phone",
  script: join(import.meta.dir, "script-phone.ts"),
  stretch: false,
  folders: SESSIONS.map((s) => ({ name: s.project })),
});

/** Stops the shooting loops if the take fails midway, before the browsers close under them. */
let stopFilming = () => {};
try {
  const shots = join(rig.dirs[0], "shots");
  mkdirSync(shots, { recursive: true });
  const render = await rig.open({ width: 390, height: 760 }, true);
  for (const [name, body] of Object.entries(SCREENS)) {
    await render.setContent(`<!doctype html><style>${SCREEN_CSS}</style>${body}`);
    await render.screenshot({ path: join(shots, `${name}.png`) });
  }
  await render.close();

  await rig.startOmps();
  await sleep(9000);
  // Oldest first, a few seconds apart, so the list's order is the sessions' order reversed.
  for (const [n, s] of SESSIONS.entries()) {
    await rig.prompt(rig.dirs[n], s.prompt);
    await sleep(3500);
  }
  await sleep(4000);
  // Earlier days' work: their transcripts move back in time, as if prompted then. Same-length
  // timestamps keep the file's size, and its new mtime makes the server read it afresh.
  const sessions = join(rig.home, ".omp/agent/sessions");
  const files = readdirSync(sessions, { recursive: true }).map((f) => join(sessions, String(f))).filter((f) => f.endsWith(".jsonl"));
  for (const s of SESSIONS) {
    if (!s.daysAgo) continue;
    const shift = s.daysAgo * 86_400_000;
    const file = files.find((f) => readFileSync(f, "utf8").includes(s.prompt));
    if (!file) throw new Error(`no transcript for ${s.project}`);
    const text = readFileSync(file, "utf8")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) => new Date(Date.parse(iso) - shift).toISOString())
      .replace(/("timestamp":)(\d{13})\b/g, (_, key, ms) => `${key}${Number(ms) - shift}`);
    writeFileSync(file, text);
  }
  const phone = await rig.open(PHONE, true);
  const row = (title: string) => phone.locator(".row").filter({ hasText: title }).first();
  await phone.locator(".row").nth(SESSIONS.length - 1).waitFor({ timeout: 20_000 });
  await row("Fix checkout tax").locator(".dot").waitFor();
  await until(async () => (await phone.locator(".row.st-blocked").count()) === 1, "the webshop session waiting on its ask", 20_000);
  await until(async () => (await phone.locator(".row .age").filter({ hasText: /^\dd$/ }).count()) === 3, "the backdated sessions in the list", 20_000);
  // Their finished turns were never opened on a phone, and an unseen session never counts as old:
  // opening each once, before filming, is seeing it.
  for (const s of SESSIONS.filter((s) => s.daysAgo)) {
    const block = (await rig.blocks()).find((b) => b.cwd.endsWith(`/${s.project}`))!.id;
    await phone.goto(`${phone.url().split("#")[0]}#/b/${block}`);
    await phone.locator(".session-bar").waitFor();
    await sleep(500);
  }
  await phone.goto(`${phone.url().split("#")[0]}#/`);
  await phone.reload();
  await phone.locator(".row").nth(SESSIONS.length - 1).waitFor({ timeout: 10_000 });
  await sleep(2000);
  const title = () => phone.locator(".session-title .title").textContent();
  const opened = (want: string) => until(async () => (await title())?.includes(want) ?? false, `the ${want} session`, 8000);

  const film = recorder(rig, { surfaces: ["phone"], pages: { phone }, first: "phone" });
  stopFilming = film.stop;
  const { caption, tap, touch, drag } = film;
  film.start();
  caption("tern-awui", "Your agents, in your pocket.");
  await sleep(2800);
  caption("At a glance", "Red needs you. Green is working.");
  await sleep(3000);

  // The waiting session: its ask, answered with one tap.
  await tap(row("Fix checkout tax"));
  const option = phone.locator(".ask .opt").filter({ hasText: "Once per order" }).first();
  await option.waitFor();
  caption("One tap", "Answer it from anywhere.");
  await sleep(1600);
  await tap(option);
  await phone.locator(".working-row").waitFor({ timeout: 10_000 });
  await sleep(1800);

  // A steer while the tests run: queued under the chat until omp takes it.
  caption("While it works", "Steer the running turn.");
  const text = phone.locator("textarea");
  await tap(text);
  await sleep(300);
  await text.pressSequentially(STEER, { delay: 55 });
  await sleep(400);
  await tap(phone.getByRole("button", { name: "Send", exact: true }));
  await phone.locator(".queued").waitFor({ timeout: 8000 });
  // omp takes the steer at once and answers it while the tests keep running.
  await phone.locator(".assistant", { hasText: "stays with CI" }).first().waitFor({ timeout: 10_000 });
  await sleep(2000);
  // The tests and the other session's dry run finish, and the reply follows.
  writeFileSync(join(rig.home, ".go-infra"), "");
  await sleep(600);
  writeFileSync(join(rig.home, ".go-tests"), "");
  await phone.locator(".assistant", { hasText: "checkout tests pass" }).first().waitFor({ timeout: 15_000 });
  await until(async () => (await phone.locator(".working-row, .assistant.live").count()) === 0, "the webshop turn to settle", 10_000);
  await sleep(2000);

  // A swipe to the next session in the list.
  caption("Between sessions", "Swipe to the next one.");
  await sleep(900);
  await touch("down", 340, 420);
  await drag(Array.from({ length: 16 }, (_, i) => [340 - (i + 1) * 15, 420 + i * 0.4] as [number, number]));
  await touch("up", 100, 426);
  await opened("Upgrade staging Postgres");
  await sleep(2000);

  // The wheel: sideways, then down, a row at a time, until the screenshots session is framed.
  caption("Between sessions", "Or pick any of them from the wheel.");
  await sleep(900);
  await touch("down", 340, 260);
  await drag(Array.from({ length: 10 }, (_, i) => [340 - (i + 1) * 15, 260] as [number, number]));
  let y = 260;
  for (let i = 0; i < 4; i++) await touch("move", 190, (y += 10)).then(() => sleep(20));
  const framed = () =>
    phone.evaluate(() => {
      const n = Number(document.querySelector(".swipe-count")?.textContent?.split(" / ")[0]);
      return document.querySelectorAll(".swipe-wheel-row")[n - 1]?.querySelector(".title")?.textContent ?? "";
    });
  await sleep(400);
  while (!(await framed()).includes("Review the new cart") && y < 640) {
    for (let i = 0; i < 6; i++) await touch("move", 190, (y += 8)).then(() => sleep(28));
    await sleep(380);
  }
  await sleep(700);
  await touch("up", 190, y);
  await opened("Review the new cart");
  await sleep(1600);

  // A screenshot full size, the next one a swipe away, and a tap to close.
  caption("Up close", "Screenshots open full size.");
  await tap(phone.locator(".thumb").first());
  await phone.locator(".lightbox").waitFor();
  await sleep(1800);
  await touch("down", 330, 420);
  await drag(Array.from({ length: 12 }, (_, i) => [330 - (i + 1) * 22, 420] as [number, number]));
  await touch("up", 66, 420);
  await sleep(2000);
  await tap(phone.locator(".lightbox-page img").nth(1));
  await sleep(1200);

  // Back to the list, and the eye hides what's older than a day: nothing left waits on you.
  await tap(phone.locator(".back"));
  await sleep(1600);
  caption("Stay focused", "Hide what's older than a day.");
  await sleep(1200);
  await tap(phone.locator(".hide-old"));
  await until(async () => (await phone.locator(".row").count()) === SESSIONS.filter((s) => !s.daysAgo).length, "the old sessions hidden", 5000);
  await sleep(2600);
  caption("tern-awui", "Away from the desk. Still in charge.");
  await sleep(600);
  await film.cut("end");
  await sleep(2400);
  await film.finish("phone", "phone");
} finally {
  stopFilming();
  await rig.tearDown();
}
