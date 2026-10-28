// Films one take of the handover: a real omp with the tern-mobile extension and omp-stretch in a
// real Tern window, a real tern-awui server, and the app in a desktop and a phone browser (headless
// Chromium), all answered by fake-model.ts from script.ts. compose.py renders the timeline.
//   bun film/take.ts [WORK]   (default /tmp/tern-awui-film)
import { join } from "node:path";
import type { Page } from "playwright-core";
import { until } from "../test/server-harness";
import { PHONE, TERN_SIZE, WEB, recorder, setUp, sleep } from "./rig";
import { ASK_TERN, DRAFT_PHONE, DRAFT_TERN, DRAFT_WEB, ORDERS_TS, PAST, PROJECT, STRETCH_KEY_GIST, STRETCH_LIMIT_GIST, WHERE } from "./script";

const rig = await setUp({
  work: process.argv[2] ?? "/tmp/tern-awui-film",
  script: join(import.meta.dir, "script.ts"),
  stretch: true,
  // The other projects' sessions are started and prompted live before the take, since omp names a
  // pane only when it titles a new session, not when it resumes one.
  folders: [{ name: PROJECT, files: { "src/api/orders.ts": ORDERS_TS }, branch: "rate-limit" }, ...PAST.map((p) => ({ name: p.project }))],
});

/** Stops the shooting loops if the take fails midway, before the browsers close under them. */
let stopFilming = () => {};
try {
  const webshop = await rig.startOmps();
  await sleep(9000);
  // Earlier work in the other projects: one prompt each, answered and titled by the fake model.
  for (const [n, p] of PAST.entries()) await rig.prompt(rig.dirs[n + 1], p.prompt);
  await sleep(5000);
  await rig.tern("focus", webshop);
  const pages = { web: await rig.open(WEB, false), phone: await rig.open(PHONE, true) };
  // The film's session, wherever the list puts it; its title comes with the first prompt.
  const row = (page: Page) => page.locator(".row").filter({ hasText: "Rate limit" }).first();
  await pages.web.locator(".row").nth(PAST.length).waitFor({ timeout: 20_000 });
  await sleep(4000);
  const film = recorder(rig, { surfaces: ["tern", "web", "phone"], pages, first: "wide" });
  stopFilming = film.stop;
  const { caption, cut, click, tap, tapLink, glide } = film;
  film.pointer.tern = { x: TERN_SIZE[0] * 0.62, y: TERN_SIZE[1] * 0.72 };
  await rig.ctl("move", String(film.pointer.tern.x), String(film.pointer.tern.y));
  film.pointer.web = { x: WEB.width * 0.7, y: WEB.height * 0.6 };
  await pages.web.mouse.move(film.pointer.web.x, film.pointer.web.y);

  film.start();
  caption("tern-awui", "One agent. Every screen.");
  await sleep(3200);

  // At the desk: a prompt in the Tern pane.
  caption("At the desk", "Start in Tern.");
  await cut("tern");
  await film.typeTern(ASK_TERN);
  await sleep(300);
  await rig.ctl("key", "Enter");
  await sleep(4500);
  caption("At the desk", "Walk away mid‑thought.");
  await sleep(500);
  await film.typeTern(DRAFT_TERN);
  await sleep(1400);

  // A browser elsewhere: the same session, the draft waiting in the composer.
  caption("In any browser", "Your draft is already there.");
  await cut("web");
  await click(row(pages.web), 0.3);
  const textarea = pages.web.locator("textarea");
  await textarea.waitFor();
  await until(async () => (await textarea.inputValue()).startsWith(DRAFT_TERN), "the Tern draft in the browser", 5000);
  await sleep(1500);
  caption("In any browser", "Finish it. Send it.");
  await click(textarea, 0.9);
  await pages.web.keyboard.press("Control+End");
  await textarea.pressSequentially(DRAFT_WEB, { delay: 45 });
  await sleep(400);
  await click(pages.web.getByRole("button", { name: "Send", exact: true }));
  await pages.web.locator(".ask .opt").first().waitFor({ timeout: 8000 });
  await sleep(1400);

  // On the phone: the session waits for an answer.
  caption("On your phone", "Red means it needs you.");
  await cut("phone");
  await sleep(900);
  await tap(row(pages.phone));
  const option = pages.phone.locator(".ask .opt").filter({ hasText: WHERE.options[0] }).first();
  await option.waitFor();
  caption("On your phone", "One tap answers.");
  await sleep(1500);
  await tap(option);
  await pages.phone.locator(".assistant table").waitFor({ timeout: 12_000 });
  await sleep(1200);

  // omp-stretch: the reply's gists open in place, fold back, and ✦ asks the pane's model for more.
  const stretch = (op: string) => pages.phone.locator(`.assistant a[href^='#stretch/${op}/']`);
  caption("With omp-stretch", "Tap a phrase. It opens in place.");
  await cut("phone:reply");
  await tapLink(stretch("open").filter({ hasText: STRETCH_KEY_GIST }));
  await sleep(1600);
  await tapLink(stretch("close").first());
  await sleep(1000);
  await tapLink(stretch("open").filter({ hasText: STRETCH_LIMIT_GIST }));
  await sleep(1300);
  caption("With omp-stretch", "Tap the star, and the model writes more.");
  await tapLink(stretch("deepen").first());
  await pages.phone.locator(".assistant", { hasText: "Well-behaved clients" }).first().waitFor({ timeout: 12_000 });
  await sleep(1800);
  caption("On your phone", "Reply on the go.");
  const phoneText = pages.phone.locator("textarea");
  await tap(phoneText);
  await sleep(300);
  await phoneText.pressSequentially(DRAFT_PHONE, { delay: 60 });
  await sleep(1300);

  // Back at the desk: the open stretches and the ✦ answer are in the pane too, the draft in omp's editor.
  caption("Back at the desk", "Same stretches, open here too.");
  await cut("tern");
  await sleep(2200);
  caption("Back at the desk", "Send it from Tern.");
  await glide("tern", TERN_SIZE[0] * 0.86, TERN_SIZE[1] * 0.83, 600);
  await sleep(700);
  await rig.ctl("key", "Enter");
  await sleep(3800);

  caption("tern-awui", "Leave the desk. Keep the agent.");
  await cut("wide");
  await sleep(3500);
  await film.finish("handover", "stage");
} finally {
  stopFilming();
  await rig.tearDown();
}
