// Films the workflow take on a phone, away from the desk: what needs me. Three real omps with the
// tern-mobile extension in a real Tern window (not filmed), a real tern-awui server and the app in
// a headless Chromium phone, answered by fake-model.ts from script-workflow.ts. One omp edits a
// file in a folder its config restricts, so the edit waits on an approval, which the phone gives.
// Then the Waiting strip and popup, fed by film/codexbar_waiting.py standing in for CodexBar
// AgentView's CLI: a session on you is marked seen, another snoozed. compose.py renders the timeline.
//   bun film/take-workflow.ts [WORK]   (default /tmp/tern-awui-film-workflow)
import { join } from "node:path";
import { until } from "../test/server-harness";
import { PHONE, recorder, setUp, sleep } from "./rig";
import { RESTRICTED, SESSIONS } from "./script-workflow";

const rig = await setUp({
  work: process.argv[2] ?? "/tmp/tern-awui-film-workflow",
  script: join(import.meta.dir, "script-workflow.ts"),
  stretch: false,
  // The infra session first: the window's own pane, where omp.sh starts.
  folders: [...SESSIONS].reverse().map((s) => ({ name: s.project, files: s.files })),
  // A restricted folder asks in every approval mode; yolo leaves everything else alone.
  ompConfig: `tools:\n  approvalMode: yolo\n  restrictedFolders:\n    - "~/${RESTRICTED}"\n`,
  serverEnv: (home) => ({ CODEXBAR_WAITING: join(import.meta.dir, "codexbar_waiting.py"), XDG_STATE_HOME: join(home, ".local/state") }),
});

/** Stops the shooting loops if the take fails midway, before the browsers close under them. */
let stopFilming = () => {};
try {
  await rig.startOmps();
  await sleep(9000);
  for (const s of SESSIONS) {
    await rig.prompt(rig.dirs.find((d) => d.endsWith(`/${s.project}`))!, s.prompt);
    await sleep(3500);
  }
  const phone = await rig.open(PHONE, true);
  const row = (title: string) => phone.locator(".row").filter({ hasText: title }).first();
  await phone.locator(".row").nth(SESSIONS.length - 1).waitFor({ timeout: 20_000 });
  // Only the edit's approval is filmed: should omp ask about the read too, the pane approves it.
  const infra = String((await rig.blocks()).find((b) => b.cwd.endsWith("/infra"))!.id);
  await until(
    async () => {
      const text = (await row("Scale the prod").textContent()) ?? "";
      if (text.includes("Allow read?")) await rig.tern("send", infra, "keys", "ctrl+q").then(() => sleep(1500));
      return text.includes("Allow edit?");
    },
    "the infra session's edit waiting on its approval",
    25_000,
  );
  await row("Rebuild the API reference").locator(".row-status.st-working").waitFor({ timeout: 10_000 });
  await phone.locator(".wait-strip.on-me").waitFor({ timeout: 10_000 });
  await sleep(1500);

  const film = recorder(rig, { surfaces: ["phone"], pages: { phone }, first: "phone" });
  stopFilming = film.stop;
  const { caption, tap } = film;
  film.start();
  caption("tern-awui", "What needs me right now?");
  await sleep(3000);

  // The approval: the row says which tool and why, the card what the call would change.
  caption("Tool approvals", "An edit waits for your OK.");
  await sleep(1400);
  await tap(row("Scale the prod"));
  const card = phone.locator(".approval");
  await card.waitFor({ timeout: 8000 });
  await card.scrollIntoViewIfNeeded();
  await sleep(1400);
  caption("Tool approvals", "See what it would change, in words.");
  await sleep(2800);
  await tap(card.locator(".approval-allow"));
  await card.waitFor({ state: "detached", timeout: 8000 });
  caption("Tool approvals", "Approve once, and it carries on.");
  await phone.locator(".assistant", { hasText: "next deploy" }).first().waitFor({ timeout: 15_000 });
  await until(async () => (await phone.locator(".working-row, .assistant.live").count()) === 0, "the infra turn to settle", 10_000);
  await sleep(2600);

  // Waiting: what you set aside in Tern, grouped by who holds the next step.
  await tap(phone.locator(".back"));
  await sleep(1000);
  caption("Set aside", "Waiting shows what's back on you.");
  await sleep(1000);
  await tap(phone.locator(".wait-strip"));
  const sheet = phone.locator(".wait-sheet");
  await sheet.locator(".wait-group").first().waitFor({ timeout: 5000 });
  await sleep(2600);
  await tap(sheet.locator(".wrow-main", { hasText: "checkout tax" }));
  const seen = sheet.locator(".wd-onyou button.primary");
  await seen.waitFor({ timeout: 5000 });
  caption("Set aside", "Handled it? Mark it seen.");
  await sleep(2400);
  await tap(seen);
  await seen.waitFor({ state: "detached", timeout: 5000 });
  await sleep(1300);
  await tap(sheet.locator(".wd-back"));
  await until(async () => (await sheet.locator(".g-on_me").count()) === 0, "nothing left on you", 5000);
  await sleep(1600);

  caption("Set aside", "Not today? Snooze it a day.");
  await tap(sheet.locator(".wrow-main", { hasText: "nightly backups" }));
  const snooze = sheet.locator(".wd-bar button", { hasText: "Snooze 1d" });
  await snooze.waitFor({ timeout: 5000 });
  await sleep(1400);
  await tap(snooze);
  await until(async () => (await sheet.locator(".wd-head .wrow-time").textContent())?.startsWith("in 1d") ?? false, "the restore test snoozed", 5000);
  await sleep(1600);
  await tap(sheet.locator(".wd-back"));
  await sleep(1200);
  await tap(sheet.locator(".wait-close"));
  await sheet.waitFor({ state: "detached", timeout: 3000 });
  await sleep(1400);
  caption("tern-awui", "Away from the desk. Still in charge.");
  await sleep(600);
  await film.cut("end");
  await sleep(2400);
  await film.finish("workflow", "phone");
} finally {
  stopFilming();
  await rig.tearDown();
}
