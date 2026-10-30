// What the phone film's omps are asked and how the fake model answers. Six sessions in six
// projects, prompted before the take: by the time it starts one waits on an ask, one runs a long
// dry run and the rest are idle, three of them from earlier days. Each session's steps are its
// replies in order; a tool that should keep running until the take says so waits for a gate file
// in the film's HOME (`~/.go-<name>`).
import { isSideRequest, type Request, type Step } from "./steps";

/** Typed on the phone while the checkout tests run: it steers the running turn. */
export const STEER = "Skip the e2e suite, CI runs it.";

const gated = (gate: string, id: string, intent: string, out: string) => ({
  tool: { id, name: "bash", input: { i: intent, command: `until [ -e ~/.go-${gate} ]; do sleep 0.3; done; echo '${out}'` } },
});

/** `daysAgo`: the take moves the session's transcript back this far, so the list counts it as old. */
export type Session = { project: string; title: string; prompt: string; steps: Step[]; daysAgo?: number };

/**
 * In the order they're prompted. The list puts the newest activity on top, so the backdated ones
 * sink below the rest, oldest last: the screenshots session ends up at the bottom, a few steps
 * down the wheel.
 */
export const SESSIONS: Session[] = [
  {
    project: "storefront",
    title: `<title nf="nf-md-cellphone" emoji="📱" code="UI">Review the new cart screens</title>`,
    prompt: "Take screenshots of the new cart on a phone.",
    daysAgo: 3,
    steps: [
      { text: "Opening the cart on a phone-sized viewport.", tool: { id: "toolu_cart", name: "read", input: { i: "Looking at the cart", path: "shots/cart.png" } } },
      { tool: { id: "toolu_pay", name: "read", input: { i: "Looking at the payment step", path: "shots/pay.png" } } },
      { text: "Both screens fit a phone. The total sits above the fold now, and **Pay** is within thumb reach." },
      // The voice call's request (fake-live.ts), handed to the session as a turn.
      { tool: { id: "toolu_total", name: "bash", input: { i: "Comparing the two totals", command: "echo 'cart: €91.00  payment: €91.00'" } } },
      { text: "Both screens show **€91.00**, so the totals match." },
    ],
  },
  {
    project: "homelab",
    title: `<title nf="nf-fa-database" emoji="💾" code="BACKUP">Verify nightly backups</title>`,
    prompt: "Check that last night's backups ran and restore one file as a test.",
    daysAgo: 2,
    steps: [{ text: "All three backups ran. I restored `photos/2026/10/beach.jpg` from last night's snapshot and it matches the original." }],
  },
  {
    project: "blog",
    title: `<title nf="nf-fa-pencil" emoji="✏️" code="POST">Draft offline notes post</title>`,
    prompt: "Draft a post about how offline note sync works.",
    daysAgo: 1.5,
    steps: [{ text: "The draft is in `posts/offline-notes.md`, about 900 words, ready for your review." }],
  },
  {
    project: "docs",
    title: `<title nf="nf-md-book_open_variant" emoji="📖" code="DOCS">Write the orders API changelog</title>`,
    prompt: "Write the changelog entry for the orders API.",
    steps: [{ text: "Added the 2.4 entry: rate limits, the `Retry-After` header and the new 429 response." }],
  },
  {
    project: "infra",
    title: `<title nf="nf-dev-postgresql" emoji="🐘" code="PG">Upgrade staging Postgres to 18</title>`,
    prompt: "Upgrade the staging Postgres to 18.",
    steps: [
      { text: "Starting with a dry run on a copy of staging.", ...gated("infra", "toolu_dry", "Running the migration dry run", "214 tables migrated") },
      { text: "The dry run passed on a copy of staging: **214 tables** migrated in 3 min 12 s. Ready for the real upgrade when you are." },
    ],
  },
  {
    project: "webshop",
    title: `<title nf="nf-fa-shopping_cart" emoji="🛒" code="TAX">Fix checkout tax rounding</title>`,
    prompt: "Fix the tax rounding at checkout: totals are a cent off.",
    steps: [
      {
        text: "Tax is rounded per line, so the cents add up. One choice first:",
        tool: {
          id: "toolu_ask",
          name: "ask",
          input: {
            i: "Choosing where to round",
            questions: [{
              id: "round",
              question: "Where should tax be rounded?",
              options: [
                { label: "Once per order", description: "Matches the receipt" },
                { label: "Per line", description: "Matches each item's price" },
              ],
              recommended: 0,
            }],
          },
        },
      },
      { text: "Rounding once per order now.", ...gated("tests", "toolu_tests", "Running the checkout tests", "38 pass, 0 fail") },
      // The steer comes in while the tests run: omp moves them to the background and answers it at once.
      { text: "Got it: the e2e suite stays with CI. Waiting for the checkout tests." },
      { text: "Fixed: tax is rounded once per order, so totals match the receipt, and the 38 checkout tests pass." },
    ],
  },
];

/**
 * The fake model's answer to each request of the take: the session's next step, counted by the
 * replies it already has. The webshop's steer and its tests finishing each start a request.
 */
export function pick(body: Request): Step {
  const all = JSON.stringify(body.messages ?? "");
  const session = SESSIONS.find((s) => all.includes(s.prompt));
  if (isSideRequest(body)) return { text: session?.title ?? "<title>Session</title>", pause: 0 };
  if (!session) return { text: "Done." };
  const done = (body.messages ?? []).filter((m) => m.role === "assistant").length;
  return session.steps[Math.min(done, session.steps.length - 1)];
}
