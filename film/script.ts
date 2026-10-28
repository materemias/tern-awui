// What the film's omp is asked and how the fake model answers. One task travels from Tern to a
// desktop browser to the phone and back: each prompt is typed on another screen.
import { isSideRequest, turnBlocks, type Request, type Step } from "./steps";

export const PROJECT = "webshop";

/**
 * Earlier work in other projects, prompted in their own Tern tabs before the take, so the web app's
 * list groups sessions by project. `title` is the fake model's answer to omp's title request.
 */
export const PAST = [
  {
    project: "homelab",
    title: `<title nf="nf-fa-database" emoji="💾" code="BACKUP">Verify nightly backups</title>`,
    prompt: "Check that last night's backups ran and restore one file as a test.",
    reply: "All three backups ran. I restored `photos/2026/10/beach.jpg` from last night's snapshot and it matches the original.",
  },
  {
    project: "blog",
    title: `<title nf="nf-fa-pencil" emoji="✏️" code="POST">Draft offline notes post</title>`,
    prompt: "Draft a post about how offline note sync works.",
    reply: "The draft is in `posts/offline-notes.md`, about 900 words, ready for your review.",
  },
];

/** Typed in the Tern pane and sent there. */
export const ASK_TERN = "Add rate limiting to the orders API.";
/** Started in the Tern pane, left as a draft, finished and sent in the desktop browser. */
export const DRAFT_TERN = "Also return a Retry-After header";
export const DRAFT_WEB = " and log each rejected call.";
/** The ask's options; the phone taps the first. */
export const WHERE = { question: "Where should the limit apply?", options: ["Per API key", "Per IP address"] };
/** Typed on the phone and left as a draft, sent from the Tern pane. */
export const DRAFT_PHONE = "Open a PR for this.";

/** The orders handler the film's omp reads. */
export const ORDERS_TS = `import { Hono } from "hono";
import { createOrder, listOrders } from "../db/orders";

export const orders = new Hono();

orders.get("/", async (c) => c.json(await listOrders(c.get("account"))));
orders.post("/", async (c) => c.json(await createOrder(c.get("account"), await c.req.json()), 201));
`;

/** The done reply's stretches (omp-stretch): the phone opens and closes the first, opens the second and presses ✦ on it. */
export const STRETCH_KEY_GIST = "Each API key gets 60 requests a minute.";
export const STRETCH_LIMIT_GIST = "Past that, the API answers 429.";

/** The answer to the ✦ press on the second stretch: it reads on after that stretch's last word. */
export const DEEPEN_REPLY = `{{Well-behaved clients back off on their own.|Well-behaved clients back off on their own: they wait out \`Retry-After\` instead of retrying at once and earning another 429.}}`;
// A ✦ answer thinks longer and writes slower, so the twinkle shows.
const DEEPEN: Step = { text: DEEPEN_REPLY, pause: 2200, pace: 45 };

/** What the model says to each turn, picked by the last message it is sent. */
export const STEPS = {
  read: { tool: { id: "toolu_read", name: "read", input: { i: "Reading the orders routes", path: "src/api/orders.ts" } } },
  plan: {
    text: "The orders routes have no limit yet. I'll put a **token bucket** in front of them: 60 requests a minute, then `429 Too Many Requests`.",
  },
  ask: {
    text: "Before I write it, one choice:",
    tool: {
      id: "toolu_ask",
      name: "ask",
      input: {
        i: "Choosing the rate limit key",
        questions: [{
          id: "key",
          question: WHERE.question,
          options: [
            { label: WHERE.options[0], description: "Fair to every customer" },
            { label: WHERE.options[1], description: "Also covers anonymous calls" },
          ],
          recommended: 0,
        }],
      },
    },
  },
  test: { tool: { id: "toolu_test", name: "bash", input: { i: "Running the orders API tests", command: "sleep 2.5 && echo '12 pass, 0 fail'" } } },
  done: {
    text: `Done, and the orders API tests pass.

| Check | Result |
|---|---|
| orders API tests | 12 pass |
| 61st request in a minute | 429, Retry-After: 14 |

{{${STRETCH_KEY_GIST}|Each API key gets **60 requests a minute** from a token bucket that refills every second, so one burst can't lock a customer out for long.}}

{{${STRETCH_LIMIT_GIST}|Past that, the API answers \`429\` with a \`Retry-After\` header saying when the bucket refills, and logs the rejected call with its key.}}`,
  },
  pr: { text: "Pushed `rate-limit` and opened **PR #42: Rate limit the orders API**." },
  /** Side requests, such as the session's title. */
  title: { text: `<title nf="nf-md-speedometer" emoji="🚦" code="RATE">Rate limit the orders API</title>`, pause: 0 },
} satisfies Record<string, Step>;

/** The fake model's answer to each request of the take. */
export function pick(body: Request): Step {
  // An omp-stretch ✦ press is a side request whose last message asks for more on one section.
  if (JSON.stringify(body.messages?.at(-1) ?? "").includes("pressed ✦ to ask")) return DEEPEN;
  // The other projects' sessions, prompted before the take: their title and their one reply.
  const past = PAST.find((p) => JSON.stringify(body.messages ?? "").includes(p.prompt));
  if (isSideRequest(body)) return past ? { text: past.title, pause: 0 } : STEPS.title;
  if (past) return { text: past.reply };
  // omp-stretch adds its notes after the prompt, so the whole turn is searched.
  const blocks = turnBlocks(body);
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
