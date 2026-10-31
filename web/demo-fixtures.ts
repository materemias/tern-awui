// The demo's sample sessions (see demo-backend.ts): three projects with omp sessions in every state
// and a plain shell. Times are relative to `now`, so the list reads "2m ago" whenever it is opened.
import type { Agent, AskQuestion, ChatEntry, Item, Job, Live, Role, Subagent } from "./api";

export type DemoSession = {
  item: Item;
  chat: ChatEntry[];
  /** A shell's screen; omp sessions render theirs from the chat. */
  screen: string;
  subagents: Subagent[];
  subagentChats: Record<string, ChatEntry[]>;
  /** The context gauge's tokens; the window is CONTEXT_WINDOW. */
  tokens: number;
};

export const CONTEXT_WINDOW = 200_000;
export const HOME = "/home/you";
export const MODEL = "anthropic/claude-opus-4-5";

export const ROLES: Role[] = [
  { role: "default", spec: `${MODEL}:high` },
  { role: "smol", spec: "anthropic/claude-haiku-4-5:off" },
  { role: "slow", spec: "openai/gpt-5:high" },
];

/** What a bridged omp can do in the demo: no model catalog, voice, side questions, autocomplete or rewind. */
export function demoLive(over: Partial<Live> = {}): Live {
  return {
    model: MODEL,
    thinking: "high",
    levels: ["off", "minimal", "low", "medium", "high"],
    tiers: [],
    tier: "",
    jobs: [],
    protocol: 3,
    caps: { models: false, tiers: false, jobs: true, queue: true, rewind: false, btw: false, complete: false, levels: true, voice: false },
    build: "",
    mismatch: null,
    restart: false,
    ...over,
  };
}

export function demoAgent(sessionId: string, over: Partial<Agent> = {}): Agent {
  return { sessionId, lastPrompt: "", recap: "", recapStale: false, lastActivity: 0, subagents: 0, ...over };
}

function omp(block: string, project: string, title: string, over: Partial<Item>): Item {
  return {
    block,
    icon: null,
    tag: null,
    title,
    cwd: `${HOME}/code/${project}`,
    project,
    branch: "main",
    agent: demoAgent(`demo-${block}`),
    live: demoLive(),
    status: "idle",
    starting: false,
    since: 0,
    doc: null,
    unseen: null,
    ...over,
  };
}

const user = (id: string, text: string, ts: number): ChatEntry => ({ role: "user", id, text, images: [], ts });
const assistant = (text: string, ts: number): ChatEntry => ({ role: "assistant", text, ts });
const tools = (ts: number, ...calls: [name: string, intent: string][]): ChatEntry => ({
  role: "tools",
  calls: calls.map(([name, intent]) => ({ name, intent })),
  images: [],
  todo: null,
  ts,
});
const turn = (ms: number, ts: number): ChatEntry => ({ role: "turn", ms, model: MODEL, ts });

const MIN = 60_000;

/** The ask the blocked session waits on. */
export const ASK_QUESTIONS: AskQuestion[] = [
  {
    question: "Which push library should the server use?",
    options: [
      { label: "web-push", description: "Mature, VAPID built in; one small dependency." },
      { label: "Hand-rolled", description: "No dependency, but the payload encryption is ours to get right." },
      { label: "Skip push for now", description: "Ship the rest; the badge still counts unseen sessions." },
    ],
    multi: false,
    recommended: 0,
  },
];

const ORDER_TABLE = `Here's how the three order types compare on the venues you trade:

| Type | Fills | Fee (taker / maker) | Slippage risk |
| --- | --- | --- | --- |
| Market | Immediately | 0.05% / — | High in thin books |
| Limit | When price is reached | — / 0.02% | None, but may not fill |
| Stop-limit | After the trigger, as a limit | — / 0.02% | Gaps can skip the limit |

For the mean-reversion entries a **post-only limit** is the better default: it never pays the taker fee and the strategy is rarely in a hurry. The order helper would look like this:

\`\`\`ts
export async function placeEntry(venue: Venue, side: "buy" | "sell", qty: number, price: number) {
  // Post-only: rejected instead of crossing the book, so it always rests as a maker order.
  return venue.order({ side, qty, price, type: "limit", postOnly: true, timeInForce: "GTC" });
}
\`\`\`

Exits stay as market orders: when the stop is hit, getting out matters more than the fee.`;

export function demoSessions(now: number): DemoSession[] {
  const t = (minutesAgo: number) => now - minutesAgo * MIN;
  const job: Job = { id: "job-css", type: "task", label: "Audit the CSS colours for the dark theme", agent: "CssAudit", since: t(1.5) };
  return [
    // Working, with a todo list and a running subagent: the working row's todo progress and the jobs strip.
    {
      item: omp("11", "tern-awui", "Add a light theme", {
        tag: "ui",
        status: "working",
        since: t(4),
        agent: demoAgent("demo-11", { lastPrompt: "add a light theme that follows the system setting", lastActivity: t(0.2), subagents: 2 }),
        live: demoLive({ jobs: [job] }),
      }),
      chat: [
        user("u11a", "add a light theme that follows the system setting", t(4)),
        tools(t(3.8), ["read", "Reading web/style.css"], ["grep", "Finding hard-coded colours"]),
        assistant("The colours already live in `:root` variables, so a light theme is mostly a second set of values under `prefers-color-scheme: light`. I'll plan it, then have a subagent audit the stray colours.", t(3.5)),
        {
          role: "tools",
          calls: [{ name: "todo", intent: "Planning the light theme" }, { name: "task", intent: "Starting CssAudit" }],
          images: [],
          todo: [
            {
              name: "Light theme",
              tasks: [
                { content: "Move hard-coded colours into variables", status: "completed" },
                { content: "Audit remaining colours (CssAudit)", status: "in_progress" },
                { content: "Add the light palette under prefers-color-scheme", status: "pending" },
                { content: "Check contrast of the status dots", status: "pending" },
              ],
            },
          ],
          ts: t(1.5),
        },
      ],
      screen: "",
      subagents: [
        { name: "CssAudit", started: t(1.5), lastActivity: t(0.2), running: true, summary: "Auditing the CSS colours for the dark theme", messages: 7 },
        { name: "IconSweep", started: t(3.2), lastActivity: t(2), running: false, summary: "Checked that every icon uses currentColor", messages: 12 },
      ],
      subagentChats: {
        CssAudit: [
          user("s1", "Find every colour in web/style.css that isn't a :root variable and propose a variable for each.", t(1.5)),
          tools(t(1.3), ["grep", "Finding #hex and rgb() colours"], ["read", "Reading web/style.css"]),
          assistant("Found 9 literal colours so far. Most are shadows (`rgb(0 0 0 / .4)`), which can stay; three are text colours that should become `--fg-soft`.", t(0.4)),
        ],
        IconSweep: [
          user("s2", "Check that every inline SVG icon draws with currentColor.", t(3.2)),
          tools(t(3), ["grep", "Finding fill= and stroke= in web/*.tsx"]),
          assistant("All 23 icons use `currentColor`, so they follow the theme without changes.", t(2)),
        ],
      },
      tokens: 61_000,
    },
    // Blocked on an ask.
    {
      item: omp("12", "tern-awui", "Push notifications", {
        status: "blocked",
        since: t(2),
        unseen: "blocked",
        agent: demoAgent("demo-12", { lastPrompt: "notify my phone when a session finishes", lastActivity: t(2) }),
      }),
      chat: [
        user("u12a", "notify my phone when a session finishes", t(9)),
        tools(t(8), ["read", "Reading server.ts"], ["web_search", "Web Push and VAPID on iOS Safari"], ["read", "Reading web/sw.js"]),
        { role: "ask", id: "ask-12", questions: ASK_QUESTIONS, answer: null, ts: t(2) },
      ],
      screen: "",
      subagents: [],
      subagentChats: {},
      tokens: 38_500,
    },
    // A plain shell: no chat, its screen instead.
    {
      item: {
        block: "13",
        icon: null,
        tag: null,
        title: "zsh",
        cwd: `${HOME}/code/tern-awui`,
        project: "tern-awui",
        branch: "main",
        agent: null,
        live: null,
        status: null,
        starting: false,
        since: t(30),
        doc: null,
        unseen: null,
      },
      chat: [],
      screen: [
        "~/code/tern-awui main",
        "❯ git log --oneline -5",
        "9821e31 docs: macOS is tested",
        "4be07aa feat(web): todo progress in the working row",
        "1f3c2d9 fix(stream): resend the run after a reconnect",
        "a77e014 feat(home): open a recent project",
        "0c9d5b2 chore: bun 1.4.3",
        "",
        "~/code/tern-awui main",
        "❯ ",
      ].join("\n"),
      subagents: [],
      subagentChats: {},
      tokens: 0,
    },
    // Idle with omp's recap.
    {
      item: omp("21", "trading-bot", "Backtest mean reversion", {
        since: t(25),
        unseen: "done",
        cwd: `${HOME}/code/trading-bot`,
        agent: demoAgent("demo-21", {
          lastPrompt: "backtest the mean-reversion strategy on the last 90 days",
          recap: "Backtested mean reversion over 90 days: Sharpe 1.4, max drawdown 6.2%. Fees eat a third of the edge; maker-only entries are next.",
          lastActivity: t(25),
        }),
      }),
      chat: [
        user("u21a", "backtest the mean-reversion strategy on the last 90 days", t(41)),
        tools(t(40), ["bash", "Fetching 90 days of 5m candles"], ["bash", "Running the backtest"], ["read", "Reading results/summary.json"]),
        assistant(
          "The backtest finished.\n\n- **Sharpe:** 1.4\n- **Max drawdown:** 6.2%\n- **Trades:** 312, 58% winners\n\nFees take about a third of the gross edge, since every entry pays the taker fee. Switching entries to maker-only limit orders is the cheapest improvement.",
          t(26),
        ),
        turn(15 * MIN, t(26)),
        { role: "recap", text: "Backtested mean reversion over 90 days: Sharpe 1.4, max drawdown 6.2%. Fees eat a third of the edge; maker-only entries are next.", ts: t(25) },
      ],
      screen: "",
      subagents: [],
      subagentChats: {},
      tokens: 92_000,
    },
    // Idle with a markdown reply: a table and a code block.
    {
      item: omp("22", "trading-bot", "Compare order types", {
        since: t(52),
        cwd: `${HOME}/code/trading-bot`,
        agent: demoAgent("demo-22", { lastPrompt: "which order type should entries use?", lastActivity: t(52) }),
      }),
      chat: [
        user("u22a", "which order type should entries use?", t(55)),
        tools(t(54), ["read", "Reading src/venues/*.ts"], ["grep", "Finding fee schedules"]),
        assistant(ORDER_TABLE, t(52)),
        turn(3 * MIN, t(52)),
      ],
      screen: "",
      subagents: [],
      subagentChats: {},
      tokens: 24_000,
    },
    // An older idle session.
    {
      item: omp("31", "dotfiles", "Tidy the zsh config", {
        since: t(190),
        cwd: `${HOME}/dotfiles`,
        branch: null,
        agent: demoAgent("demo-31", { lastPrompt: "why does my shell take a second to start?", lastActivity: t(190) }),
      }),
      chat: [
        user("u31a", "why does my shell take a second to start?", t(200)),
        tools(t(199), ["bash", "Timing zsh -i -c exit"], ["read", "Reading .zshrc"]),
        assistant("`nvm` loads eagerly and takes 640 ms of the 900. I made it load on first use of `node`, `npm` or `nvm`; startup is now 180 ms.", t(190)),
        turn(10 * MIN, t(190)),
      ],
      screen: "",
      subagents: [],
      subagentChats: {},
      tokens: 15_000,
    },
  ];
}

/** Folders the "new omp" sheet offers: the projects' and one more. */
export function demoProjects(sessions: DemoSession[]): string[] {
  return [...new Set([...sessions.map((s) => s.item.cwd), `${HOME}/code/side-project`])];
}

/** Canned replies for prompts, taken in turn; `{prompt}` is the prompt sent. */
export const REPLIES = [
  "On it. For **“{prompt}”** I'd start here:\n\n1. Read the files the change touches.\n2. Make the change in one place.\n3. Run the tests before calling it done.\n\n```sh\nbun run typecheck && bun test\n```\n\n_This is the demo: replies are canned and nothing left your browser. With Tern and omp running, this prompt would have gone to the session's pane on your desktop._",
  "Done. Here's what changed for **“{prompt}”**:\n\n| File | Change |\n| --- | --- |\n| `src/config.ts` | New option, off by default |\n| `src/main.ts` | Reads the option at start |\n\nTry steering me with another prompt while a reply streams: it lands in the queue and runs next.",
  "Good question. Short answer: yes, with one caveat: **“{prompt}”** works as long as the session stays connected. Swipe sideways to the next session, or go back to the list to see which one needs you.",
];

export const ANSWER_REPLY = "Going with **{answer}**. I'll wire it up and send a test notification once the server restarts.\n\n_In the demo the answer only lands here; with Tern it would be typed into omp's dialog on your desktop._";

export const OPEN_TURN_REPLY =
  "The light theme is in: the palette lives under `prefers-color-scheme: light`, and CssAudit moved the last three literal colours into variables. Contrast of the status dots passes AA on both themes.";
