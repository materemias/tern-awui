// The demo's sample data (see demo-backend.ts): three projects with omp sessions in every state, a
// shell, a file and parked panes, spread over three Tern sessions; closed sessions of omp, Claude
// Code and Codex; and CodexBar AgentView's waits. Times are relative to `now`, so the list reads
// "2m ago" whenever it is opened.
import type { Agent, ApprovalView, Ask, BtwHistoryRecord, CatalogModel, ChangedFile, ChatEntry, Closed, Item, Job, LimitView, Live, Role, StretchState, Subagent, TernSession, WaitingRow } from "./api";
import type { Wait } from "../lib/waiting-view";
import type { Companion } from "../lib/companions";

export type DemoSession = {
  item: Item;
  chat: ChatEntry[];
  /** A shell's screen; omp sessions render theirs from the chat. */
  screen: string;
  subagents: Subagent[];
  subagentChats: Record<string, ChatEntry[]>;
  /** The context gauge's tokens; the window is CONTEXT_WINDOW. */
  tokens: number;
  /** A file block's Markdown; null for everything else. */
  doc: string | null;
  /** The tool call omp asks to allow, and what allowing or denying it leads to. */
  approval: ApprovalView | null;
  approve: { allow: string; deny: string; files: ChangedFile[] } | null;
  /** omp-stretch's state for the session's replies; null where it isn't loaded. */
  stretch: StretchState | null;
  btw: BtwHistoryRecord[];
  /** The usage limit its last turn stopped on, as the server's `limit` event shows it; null for none. */
  limit: LimitView | null;
};

export const CONTEXT_WINDOW = 200_000;
export const HOME = "/home/you";
/** The About window's companions (lib/companions.ts reads them on a desktop): the demo has all of them installed. */
export const COMPANIONS: Companion[] = [
  { id: "omp-stretch", installed: true },
  { id: "codexbar-agentview", installed: true },
  { id: "omp-compact", installed: true },
];
export const MODEL = "anthropic/claude-opus-4-5";

export const ROLES: Role[] = [
  { role: "default", spec: `${MODEL}:high` },
  { role: "smol", spec: "anthropic/claude-haiku-4-5:off" },
  { role: "slow", spec: "openai/gpt-5:high" },
];

/** The window's Tern sessions; the desktop shows the first. */
export const TERN_SESSIONS: TernSession[] = [
  { id: "1", name: "Default", shown: true },
  { id: "2", name: "weekend", shown: false },
  { id: "3", name: "ops", shown: false },
];

/** What the model picker lists: omp's models with credentials, as the bridge sends them. */
export const CATALOG: CatalogModel[] = [
  { p: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", r: true, ctx: 200_000, in: 5, out: 25, img: true },
  { p: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", r: true, ctx: 1_000_000, in: 3, out: 15, img: true },
  { p: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", r: true, ctx: 200_000, in: 1, out: 5, img: true },
  { p: "openai", id: "gpt-5", name: "GPT-5", r: true, ctx: 400_000, in: 1.25, out: 10, img: true },
  { p: "openai", id: "gpt-5-mini", name: "GPT-5 mini", r: true, ctx: 400_000, in: 0.25, out: 2, img: true },
  { p: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", r: true, ctx: 1_000_000, in: 1.25, out: 10, img: true },
  { p: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", r: true, ctx: 1_000_000, in: 0.3, out: 2.5, img: true },
];

/** A model's serving tiers ("" = standard), as omp offers them: OpenAI's only. */
export function tiersOf(model: string): string[] {
  return model.startsWith("openai/") ? ["", "flex", "priority"] : [];
}

/** What a bridged omp can do in the demo: everything (demo-coverage.test.ts keeps it so). */
export function demoLive(over: Partial<Live> = {}): Live {
  return {
    model: MODEL,
    thinking: "high",
    levels: ["off", "minimal", "low", "medium", "high"],
    tiers: [],
    tier: "",
    jobs: [],
    protocol: 5,
    caps: { models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: true, levels: true, voice: true },
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
    parked: false,
    ternSession: "Default",
    activity: null,
    stranded: false,
    ...over,
  };
}

function shell(block: string, project: string, title: string, over: Partial<Item>): Item {
  return { ...omp(block, project, title, over), agent: null, live: null, status: null, ...over };
}

/** A session with nothing beyond its item and chat; `over` adds the rest. */
function session(item: Item, chat: ChatEntry[], over: Partial<DemoSession> = {}): DemoSession {
  return { item, chat, screen: "", subagents: [], subagentChats: {}, tokens: 20_000, doc: null, approval: null, approve: null, stretch: null, btw: [], limit: null, ...over };
}

const user = (id: string, text: string, ts: number): ChatEntry => ({ role: "user", id, text, images: [], ts });
const assistant = (text: string, ts: number): ChatEntry => ({ role: "assistant", text, ts });
/** `facts`: what the server would parse from the call's output (lib/tool-facts.ts). */
const tools = (ts: number, ...calls: [name: string, intent: string, facts?: string][]): ChatEntry => ({
  role: "tools",
  calls: calls.map(([name, intent, facts]) => ({ name, intent, ...(facts && { facts }) })),
  images: [],
  todo: null,
  ts,
});
const turn = (ms: number, ts: number, files?: ChangedFile[]): ChatEntry => ({ role: "turn", ms, model: MODEL, ts, ...(files && { files }) });

const MIN = 60_000;
/** A day in the minutes `t()` takes. */
const DAY = 24 * 60;

/** The ask the blocked session waits on: omp's form, and its fields as the server parses them. */
const PUSH_OPTIONS = [
  { value: "web-push", label: "web-push", note: "mature, VAPID built in; one small dependency." },
  { value: "hand-rolled", label: "Hand-rolled", note: "no dependency, but the payload encryption is ours to get right." },
  { value: "skip", label: "Skip push for now", note: "ship the rest; the badge still counts unseen sessions." },
];
export const ASK_FORM: Pick<Ask, "html" | "fields" | "question"> = {
  html: `<form>
  <ul>
${PUSH_OPTIONS.map((o) => `    <li><b>${o.label}</b>: ${o.note}</li>`).join("\n")}
  </ul>
  <fieldset>
    <legend>Which push library should the server use?</legend>
${PUSH_OPTIONS.map((o, i) => `    <label><input type="radio" name="push" value="${o.value}"${i === 0 ? " checked" : ""}> ${o.label}</label>`).join("\n")}
  </fieldset>
</form>`,
  fields: [
    {
      kind: "choice",
      name: "push",
      question: "Which push library should the server use?",
      multi: false,
      select: false,
      other: true,
      options: PUSH_OPTIONS.map((o, i) => ({ value: o.value, label: o.label, checked: i === 0, disabled: false })),
    },
  ],
  question: "Which push library should the server use?",
};

const DRIVER_TABLE = `Here's how the three SQLite drivers compare for the API server:

| Driver | Runtime | Sync API | Prepared statement cache |
| --- | --- | --- | --- |
| \`bun:sqlite\` | Bun only | Yes | Built in |
| \`better-sqlite3\` | Node (native addon) | Yes | Manual |
| \`@libsql/client\` | Node, Bun, edge | No, async | Per client |

Since the server already runs on Bun, **\`bun:sqlite\`** is the simplest choice: no native build step and no extra dependency. The session store would look like this:

\`\`\`ts
import { Database } from "bun:sqlite";

const db = new Database("data/sessions.db", { create: true });
db.run("PRAGMA journal_mode = WAL");
const get = db.query<{ data: string }, [string]>("SELECT data FROM sessions WHERE id = ?");

export const loadSession = (id: string) => get.get(id)?.data ?? null;
\`\`\`

Switch to \`@libsql/client\` only if the server has to run on an edge runtime.`;

/** Numbers in a table: the chat draws them as bar charts under it. */
const SUITE_REPLY = `The suite now runs in 50 s instead of 4 minutes.

| Suite | Time before | Time after |
| --- | --- | --- |
| orders | 84 s | 12 s |
| webhooks | 61 s | 9 s |
| users | 52 s | 8 s |
| auth | 38 s | 6 s |

- **Cause:** \`test/setup.ts\` ran every migration for each of the 412 tests.
- **Fix:** each worker migrates one database once, and every test runs inside a transaction that rolls back.
- **Left over:** \`orders.test.ts\` and \`webhooks.test.ts\` fail about one run in ten, because they depend on the clock.`;

const SUITE_RECAP = "The suite went from 4 min to 50 s: tests now share one database per worker instead of migrating a fresh one per test. Two flaky tests remain.";

/** An omp-stretch reply: tap a short form to grow it, ✦ on an open one to ask for more. With a Mermaid diagram. */
const BRIDGE_REPLY = `The phone reaches omp through {{one WebSocket per session|its tern-mobile extension, which opens one WebSocket to the server on loopback and signs in with a token file only you can read}}. Over it go {{state reports and commands|a snapshot whenever something the phone shows changes (status, model, queue, the running turn, the context gauge), and the other way the phone's commands: submit, set the draft, abort, switch model}}.

\`\`\`mermaid
flowchart LR
  phone[Phone] -- HTTPS and SSE --> server[tern-awui server]
  server -- WebSocket --> omp[omp in a Tern pane]
  server -- tern CLI --> tern[Tern]
\`\`\`

The phone never talks to omp directly: {{the server is the only way in|it checks every request, keeps one connection per pane, and types into a pane with Tern's own CLI when its omp has no bridge}}.`;

/** What ✦ brings for each stretch of BRIDGE_REPLY; `{key}` for any other. */
export const DEEPEN: Record<string, string> = {
  "one WebSocket per session": "When the server restarts, the extension reconnects with a growing backoff, and the server keeps only the newest connection per pane, so a restarted omp never shows twice.",
  "state reports and commands": "Commands carry a sequence number and get one reply each; a command omp doesn't answer within a few seconds fails on the phone instead of hanging.",
  "the server is the only way in": "It listens on 127.0.0.1 only; whoever reaches that port controls the panes, which is why it sits behind Tailscale Serve.",
  "": "More on “{key}”: the short form leaves out the edge cases, and this is where they would go.",
};

const WHEEL_SVG = `\`\`\`svg
<svg viewBox="0 0 320 90" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="318" height="88" rx="8" fill="none" stroke="currentColor" stroke-opacity=".4"/>
  <rect x="1" y="1" width="24" height="88" rx="8" fill="#e0a43a" fill-opacity=".3"/>
  <rect x="295" y="1" width="24" height="88" rx="8" fill="#e0a43a" fill-opacity=".3"/>
  <text x="160" y="50" text-anchor="middle" font-size="12" fill="currentColor">edges wait until the finger moves</text>
</svg>
\`\`\``;

/** A phone screenshot pasted into a prompt: data: URLs need no server. */
const WHEEL_SHOT = `data:image/svg+xml;base64,${btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480" viewBox="0 0 270 480"><rect width="270" height="480" fill="#16181d"/><rect x="0" y="0" width="270" height="44" fill="#22252c"/><text x="16" y="28" font-family="sans-serif" font-size="15" fill="#e6e6e6">tern-awui</text>${[0, 1, 2, 3, 4]
    .map((i) => `<rect x="30" y="${150 + i * 44}" width="210" height="36" rx="8" fill="${i === 2 ? "#3d6fd1" : "#2a2e36"}"/><text x="46" y="${173 + i * 44}" font-family="sans-serif" font-size="13" fill="#e6e6e6">Session ${i + 1}</text>`)
    .join("")}<rect x="0" y="120" width="14" height="260" fill="#e0a43a" fill-opacity=".45"/></svg>`,
)}`;

const RELEASE_DOC = `# Release checklist

1. Move \`## Unreleased\` in CHANGELOG.md to \`## X.Y.Z (date)\`.
2. Set \`version\` in package.json.
3. Run the checks:

   \`\`\`sh
   bun run typecheck && bun test && bun run build
   \`\`\`

4. Commit as \`X.Y.Z\`, then tag: \`git tag -a vX.Y.Z -m "tern-awui X.Y.Z"\`.
5. Push the tag; the release workflow publishes the notes.

- [x] Changelog reads well on its own
- [x] Demo rebuilt
- [ ] Films reshot for the Waiting popup

> Opened from Tern: files and notes in a pane read here, Markdown with its local images.`;

/** The edit omp asks to allow: a hashline patch to a restricted folder. */
const PROD_PATCH = `[deploy/prod.yml#3B1C]
PUT 14.=14:
+    replicas: 4
PUT >22:
+    resources:
+      limits: { cpu: "1", memory: 512Mi }`;

export function demoSessions(now: number): DemoSession[] {
  const t = (minutesAgo: number) => now - minutesAgo * MIN;
  const job: Job = { id: "job-css", type: "task", label: "Audit the CSS colours for the dark theme", agent: "CssAudit", since: t(1.5) };
  const api = `${HOME}/code/api-server`;
  const bridgeBlock = `${Math.round(t(9))}.0`;
  return [
    // Working, with a todo list and a running subagent: the working row's todo progress and the jobs strip.
    session(
      omp("11", "tern-awui", "Add a light theme", {
        tag: "ui",
        status: "working",
        since: t(4),
        agent: demoAgent("demo-11", { lastPrompt: "add a light theme that follows the system setting", lastActivity: t(0.2), subagents: 2 }),
        live: demoLive({ jobs: [job] }),
      }),
      [
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
      {
        subagents: [
          { name: "CssAudit", started: t(1.5), lastActivity: t(0.2), running: true, summary: "Auditing the CSS colours for the dark theme", messages: 7 },
          { name: "IconSweep", started: t(3.2), lastActivity: t(2), running: false, summary: "Checked that every icon uses currentColor", messages: 12 },
        ],
        subagentChats: {
          CssAudit: [
            user("s1", "Find every colour in web/style.css that isn't a :root variable and propose a variable for each.", t(1.5)),
            tools(t(1.3), ["grep", "Finding #hex and rgb() colours", "14 results in 1 file"], ["read", "Reading web/style.css"]),
            assistant("Found 9 literal colours so far. Most are shadows (`rgb(0 0 0 / .4)`), which can stay; three are text colours that should become `--fg-soft`.", t(0.4)),
          ],
          IconSweep: [
            user("s2", "Check that every inline SVG icon draws with currentColor.", t(3.2)),
            tools(t(3), ["grep", "Finding fill= and stroke= in web/*.tsx", "23 results in 6 files"]),
            assistant("All 23 icons use `currentColor`, so they follow the theme without changes.", t(2)),
          ],
        },
        tokens: 61_000,
      },
    ),
    // Blocked on an ask.
    session(
      omp("12", "tern-awui", "Push notifications", {
        status: "blocked",
        since: t(2),
        unseen: "blocked",
        agent: demoAgent("demo-12", { lastPrompt: "notify my phone when a session finishes", lastActivity: t(2) }),
      }),
      [
        user("u12a", "notify my phone when a session finishes", t(9)),
        tools(t(8), ["read", "Reading server.ts"], ["web_search", "Web Push and VAPID on iOS Safari"], ["read", "Reading web/sw.js"]),
        { role: "ask", id: "ask-12", ...ASK_FORM, answer: null, ts: t(2) },
      ],
      { tokens: 38_500 },
    ),
    // omp-stretch's replies, a Mermaid diagram, a rule, an advisor note and a saved side question.
    session(
      omp("16", "tern-awui", "How the bridge works", {
        since: t(8),
        agent: demoAgent("demo-16", { lastPrompt: "how does the phone reach omp?", lastActivity: t(8) }),
      }),
      [
        user("u16a", "how does the phone reach omp?", t(12)),
        { role: "rule", rules: [{ name: "no-secrets-in-logs", text: "Never print tokens, passwords or the bridge token, not even in debug output." }], ts: t(11.5) },
        tools(t(11), ["read", "Reading server.ts"], ["read", "Reading omp-extension/tern-mobile.ts"], ["grep", "Finding the bridge token check"]),
        { role: "assistant", text: BRIDGE_REPLY, block: bridgeBlock, ts: t(9) },
        { role: "advisor", notes: [{ advisor: "reviewer", severity: "concern", note: "Worth saying how the token file is protected: who can read it decides who can drive the panes." }], ts: t(8.8) },
        assistant("Good point: the server writes the token file with mode 0600 and refuses to start if it can't, so only your account can read it.", t(8.5)),
        turn(4 * MIN, t(8.5)),
      ],
      {
        tokens: 44_000,
        stretch: { off: false, open: {}, deepen: true, answers: {}, running: {} },
        btw: [
          {
            id: "btw-16a",
            question: "is SSE fine on mobile networks?",
            answer: "Yes: the stream pings every 25 s so proxies keep it open, and the app reconnects and resends what it missed when the network changes.",
            status: "complete",
            createdAt: t(10),
            updatedAt: t(10),
            leafId: null,
          },
        ],
      },
    ),
    // A file opened in a Tern pane: read as Markdown.
    session(
      shell("17", "tern-awui", "release.md", {
        icon: "\u{F0354}",
        branch: null,
        since: t(40),
        doc: `${HOME}/code/tern-awui/docs/release.md`,
      }),
      [],
      { doc: RELEASE_DOC, tokens: 0 },
    ),
    // A plain shell: no chat, its screen instead.
    session(
      shell("13", "tern-awui", "zsh", { since: t(30) }),
      [],
      {
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
        tokens: 0,
      },
    ),
    // Blocked on a tool approval: an edit to a restricted folder.
    session(
      omp("23", "api-server", "Give prod more workers", {
        status: "blocked",
        since: t(3),
        unseen: "blocked",
        cwd: api,
        ternSession: "weekend",
        agent: demoAgent("demo-23", { lastPrompt: "the API falls over at lunch, give prod more workers", lastActivity: t(3) }),
      }),
      [
        user("u23a", "the API falls over at lunch, give prod more workers", t(6)),
        tools(t(5.5), ["read", "Reading deploy/prod.yml"], ["bash", "Counting requests per second in the access log"]),
        assistant("Two workers saturate at about 180 requests a second, and the lunch peak is 260. Four workers with a memory cap cover it with room to spare.", t(4)),
        tools(t(3), ["edit", "Raising the prod worker count"]),
      ],
      {
        tokens: 27_000,
        approval: { id: "toolu_demo_23", tool: "edit", reason: `Restricted folder: ~/code/api-server/deploy`, args: [{ key: "input", value: PROD_PATCH }] },
        approve: {
          allow: "Prod now runs four workers, each capped at 512 MiB, so a leak in one can't take the others down. The next deploy picks it up.",
          deny: "Left `deploy/prod.yml` as it is. If you'd rather scale on load, I can draft an autoscaler config instead.",
          files: [{ path: "deploy/prod.yml", added: 3, removed: 1 }],
        },
      },
    ),
    // Idle with omp's recap: a table charted, a failed tool run, a cache miss and the changed files.
    session(
      omp("21", "api-server", "Speed up the test suite", {
        since: t(25),
        unseen: "done",
        cwd: api,
        ternSession: "weekend",
        agent: demoAgent("demo-21", { lastPrompt: "the test suite takes four minutes, find out why", recap: SUITE_RECAP, lastActivity: t(25) }),
      }),
      [
        user("u21a", "the test suite takes four minutes, find out why", t(41)),
        { role: "cacheMiss", tokens: 48_200, ts: t(40.5) },
        tools(t(40), ["bash", "Timing bun test per file"], ["read", "Reading test/setup.ts"]),
        {
          role: "tools",
          calls: [
            { name: "edit", intent: "Sharing one database per worker" },
            { name: "bash", intent: "Running bun test", error: true, facts: "412 passed · 3 failed: orders > refunds a cancelled order" },
            { name: "edit", intent: "Rolling back each test's transaction" },
            { name: "bash", intent: "Running bun test", facts: "415 passed" },
          ],
          images: [],
          todo: null,
          ts: t(30),
        },
        assistant(SUITE_REPLY, t(26)),
        turn(15 * MIN, t(26), [
          { path: "test/setup.ts", added: 38, removed: 52 },
          { path: "test/db.ts", added: 24, removed: 0 },
          { path: "package.json", added: 1, removed: 1 },
        ]),
        { role: "recap", text: SUITE_RECAP, ts: t(25) },
      ],
      { tokens: 92_000 },
    ),
    // Idle with a markdown reply: a table and a code block.
    session(
      omp("22", "api-server", "Pick a SQLite driver", {
        since: t(52),
        cwd: api,
        ternSession: "weekend",
        agent: demoAgent("demo-22", { lastPrompt: "which sqlite driver should the session store use?", lastActivity: t(52) }),
      }),
      [
        user("u22a", "which sqlite driver should the session store use?", t(55)),
        tools(t(54), ["read", "Reading package.json"], ["grep", "Finding database imports"]),
        assistant(DRIVER_TABLE, t(52)),
        turn(3 * MIN, t(52)),
      ],
      { tokens: 24_000 },
    ),
    // Stopped on Codex's usage limit: the banner offers to continue once it resets.
    session(
      omp("24", "api-server", "Move sessions to SQLite", {
        since: t(18),
        cwd: api,
        ternSession: "weekend",
        live: demoLive({ model: "openai/gpt-5", tiers: tiersOf("openai/gpt-5") }),
        agent: demoAgent("demo-24", { lastPrompt: "move the session store to bun:sqlite", lastActivity: t(18) }),
      }),
      [
        user("u24a", "move the session store to bun:sqlite", t(31)),
        tools(t(30), ["read", "Reading src/sessions.ts"], ["edit", "Writing the SQLite store"], ["bash", "Running bun test test/sessions.test.ts"]),
        assistant("The SQLite store is in and its tests pass. Next: moving the existing JSON sessions over on first start.", t(19)),
        { role: "turn", ms: 13 * MIN, model: "openai/gpt-5", ts: t(18), files: [{ path: "src/sessions.ts", added: 74, removed: 41 }] },
      ],
      {
        tokens: 58_000,
        limit: { kind: "wait", error: "Codex error event: The usage limit has been reached (code=usage_limit_reached)", resetAt: now + 133 * MIN, continueAt: null },
      },
    ),
    // Parked in Tern: off the list, in the new-omp sheet's Parked tab; Waiting holds it on someone.
    session(
      omp("25", "api-server", "Bump dependencies", {
        since: t(5 * 60),
        cwd: api,
        parked: true,
        ternSession: null,
        agent: demoAgent("demo-25", {
          lastPrompt: "bump the dependencies, but hold the majors",
          recap: "Minor and patch bumps are in and green. Node 22 and the Postgres 17 driver wait for the infra team.",
          lastActivity: t(5 * 60),
        }),
      }),
      [
        user("u25a", "bump the dependencies, but hold the majors", t(5 * 60 + 20)),
        tools(t(5 * 60 + 15), ["bash", "Listing outdated packages"], ["edit", "Bumping 14 minor versions"], ["bash", "Running bun test", "no type errors · 415 passed"]),
        assistant("Fourteen minor and patch bumps are in and the suite is green. Two majors wait: Node 22 and the Postgres 17 driver, both need the infra team's go-ahead.", t(5 * 60)),
        turn(20 * MIN, t(5 * 60), [{ path: "package.json", added: 14, removed: 14 }, { path: "bun.lock", added: 61, removed: 58 }]),
      ],
      { tokens: 31_000 },
    ),
    // Older than a day: the eye in the list header hides these. This one's omp runs an older
    // extension: the list marks it, and its Reload restarts omp.
    session(
      omp("31", "dotfiles", "Tidy the zsh config", {
        since: t(3 * DAY),
        cwd: `${HOME}/dotfiles`,
        branch: null,
        ternSession: "ops",
        live: demoLive({ mismatch: "older", restart: true }),
        agent: demoAgent("demo-31", { lastPrompt: "why does my shell take a second to start?", lastActivity: t(3 * DAY) }),
      }),
      [
        user("u31a", "why does my shell take a second to start?", t(3 * DAY + 10)),
        tools(t(3 * DAY + 9), ["bash", "Timing zsh -i -c exit"], ["read", "Reading .zshrc"]),
        assistant("`nvm` loads eagerly and takes 640 ms of the 900. I made it load on first use of `node`, `npm` or `nvm`; startup is now 180 ms.", t(3 * DAY)),
        turn(10 * MIN, t(3 * DAY)),
      ],
      { tokens: 15_000 },
    ),
    // Parked in a Tern session that has closed since: Tern can't bring it back, only close it.
    session(
      shell("32", "dotfiles", "htop", { since: t(2 * DAY), cwd: `${HOME}/dotfiles`, branch: null, parked: true, stranded: true, ternSession: null }),
      [],
      {
        screen: [
          "  CPU [|||||||                  18.2%]   Tasks: 214, 1 running",
          "  Mem [||||||||||||       5.81G/31.2G]   Load average: 0.42 0.51 0.48",
          "",
          "    PID USER      CPU% MEM%   TIME+  Command",
          "   1834 you        6.1  2.4  3:12.08 tern",
          "   2290 you        3.4  1.1  1:04.51 bun server.ts",
          "   2417 you        1.2  0.8  0:22.90 omp",
        ].join("\n"),
        tokens: 0,
      },
    ),
    session(
      omp("14", "tern-awui", "Fix the swipe wheel", {
        since: t(2 * DAY),
        agent: demoAgent("demo-14", { lastPrompt: "the session wheel keeps stepping on its own near the edge [Image #1]", lastActivity: t(2 * DAY) }),
      }),
      [
        { role: "user", id: "u14a", text: "the session wheel keeps stepping on its own near the edge [Image #1]", images: [{ src: WHEEL_SHOT }], ts: t(2 * DAY + 6) },
        tools(t(2 * DAY + 5), ["read", "Reading web/swipe.tsx"]),
        {
          role: "ask",
          id: "ask-14",
          html: `<form><fieldset><legend>Which edge does it step at?</legend><label><input type="radio" name="edge" value="left"> Left</label><label><input type="radio" name="edge" value="right"> Right</label></fieldset></form>`,
          fields: [],
          question: "Which edge does it step at?",
          answer: 'Which edge does it step at?: Left\n  Note on "Left": where my thumb rests when the wheel opens [Image #1, 412x160]',
          images: [{ src: WHEEL_SHOT }],
          ts: t(2 * DAY + 4),
        },
        tools(t(2 * DAY + 3), ["edit", "Ignoring the edge the wheel opened at"]),
        assistant(`The wheel opened at the screen edge and read the finger resting there as a request to step. It now waits until the finger moves away from that edge first:\n\n${WHEEL_SVG}`, t(2 * DAY)),
        turn(6 * MIN, t(2 * DAY), [{ path: "web/swipe.tsx", added: 9, removed: 3 }]),
      ],
      { tokens: 11_000 },
    ),
  ];
}

/** Folders the "new omp" sheet offers: the projects' and one more. */
export function demoProjects(sessions: DemoSession[]): string[] {
  return [...new Set([...sessions.filter((s) => !s.item.doc).map((s) => s.item.cwd), `${HOME}/code/side-project`])];
}

/** A closed session, and what resuming it opens: an omp's chat, or the screen of Claude Code or Codex. */
export type DemoClosed = { row: Closed; chat: ChatEntry[]; screen: string; tokens: number };

export function demoClosed(now: number): DemoClosed[] {
  const t = (minutesAgo: number) => now - minutesAgo * MIN;
  const ompRow = (id: string, folder: string, title: string, prompt: string, reply: string, recap: string, at: number): DemoClosed => ({
    row: { agent: "omp", id, icon: null, tag: null, title, cwd: `${HOME}/code/${folder}`, prompt, recap, at },
    chat: [user(`${id}-u`, prompt, at - 12 * MIN), tools(at - 11 * MIN, ["read", "Reading the project"], ["bash", "Running the tests"]), assistant(reply, at), turn(12 * MIN, at), { role: "recap", text: recap, ts: at }],
    screen: "",
    tokens: 33_000,
  });
  const other = (agent: "claude" | "codex", id: string, folder: string, title: string, prompt: string, at: number): DemoClosed => ({
    row: { agent, id, icon: null, tag: null, title, cwd: `${HOME}/code/${folder}`, prompt, recap: "", at },
    chat: [],
    screen:
      agent === "claude"
        ? `╭───────────────────────────────────────────╮\n│ ✻ Welcome back to Claude Code              │\n│   cwd: ~/code/${folder.padEnd(29)}│\n╰───────────────────────────────────────────╯\n\n> ${prompt}\n\n● Resumed: ${title}\n\n> `
        : `>_ OpenAI Codex (resumed ${id.slice(0, 8)})\n   ~/code/${folder}\n\nuser\n${prompt}\n\ncodex\nResumed: ${title}\n\n▌ `,
    tokens: 0,
  });
  return [
    ompRow(
      "demo-c48",
      "api-server",
      "Fix the flaky webhook tests",
      "webhooks.test.ts fails one run in ten, fix it",
      "The two flaky tests waited on the real clock. They use a fake one now, and 200 runs in a row passed. PR #48 is open; CI is running.",
      "The flaky webhook tests use a fake clock now; PR #48 waits on CI.",
      t(3 * 60),
    ),
    ompRow(
      "demo-c51",
      "tern-awui",
      "Move to Bun 1.4",
      "upgrade to bun 1.4 and fix whatever breaks",
      "Bun 1.4 is in. Two things broke: `Bun.serve`'s idle timeout is now in seconds, and `bun:test` mocks reset between files. Both are fixed and the suite passes.",
      "On Bun 1.4: the idle timeout and the test mocks needed fixes; all green.",
      t(26 * 60),
    ),
    ompRow(
      "demo-c53",
      "tern-awui",
      "Write the 0.10 release notes",
      "draft the release notes for 0.10 from the changelog",
      "The notes lead with tool approvals and the Waiting popup, then the smaller changes. They're in CHANGELOG.md under 0.10.0, ready for a read.",
      "Release notes for 0.10 drafted in CHANGELOG.md.",
      t(2 * DAY + 90),
    ),
    ompRow(
      "demo-c60",
      "side-project",
      "Dark mode for the docs site",
      "the docs site needs a dark mode",
      "The docs site follows the system theme now, with a toggle in the header that remembers the choice.",
      "Docs site has a dark mode with a remembered toggle.",
      t(4 * DAY),
    ),
    other("claude", "0b7e5c1a-3d2f-4e8a-9c61-2a7d5e9f1b30", "api-server", "Refactor the auth middleware", "split the auth middleware into session and token checks", t(6 * 60)),
    other("claude", "5d21f0e9-8c4b-4a7e-b1f3-6e9a0c2d4b18", "side-project", "Explain the build cache", "why does the build cache miss after every pull?", t(3 * DAY)),
    other("codex", "019a7c2e-4b1d-7f30-9e52-8d6c1a3f2b07", "api-server", "Benchmark JSON parsers", "benchmark three JSON parsers on our payloads", t(9 * 60)),
    other("codex", "019a6f11-2c8e-7a45-b3d9-5f1e7c0a9d62", "side-project", "Port the CLI to Rust", "port the CLI's argument parsing to Rust with clap", t(5 * DAY)),
  ];
}

/** CodexBar AgentView's sessions set aside, one per group; demo-waiting.ts derives their threads. */
export function demoWaiting(now: number): WaitingRow[] {
  const t = (minutesAgo: number) => now - minutesAgo * MIN;
  const wait = (w: Partial<Wait> & Pick<Wait, "id" | "kind" | "label" | "ball">): Wait => ({
    summary: w.label,
    state: "waiting",
    reason: null,
    overdue: false,
    outcome: null,
    mark: "⏳",
    due: 0,
    hasPrompt: false,
    snoozable: w.ball === "on_me",
    ...w,
  });
  const row = (r: Partial<WaitingRow> & Pick<WaitingRow, "session" | "title" | "project" | "ball">): WaitingRow => ({
    pane: null,
    live: false,
    agentState: null,
    outcome: null,
    headline: null,
    threads: [],
    stillWaiting: [],
    waitingFor: null,
    due: 0,
    pinned: false,
    size: null,
    unseen: false,
    note: null,
    suggested: null,
    line: "",
    nextStep: null,
    recap: null,
    recapAt: 0,
    recapStale: false,
    since: 0,
    waits: [],
    history: [],
    prs: [],
    close: null,
    onYou: [],
    stoppable: 0,
    ...r,
  });
  return [
    // On me: the review came; CI still runs.
    row({
      session: "demo-21",
      pane: 21,
      live: true,
      agentState: "idle",
      title: "Speed up the test suite",
      project: "api-server",
      ball: "on_me",
      outcome: "fulfilled",
      headline: "✅ PR#212 approved by sam",
      unseen: true,
      note: "Merge once CI is green, then drop the old fixtures.",
      nextStep: "Merge PR #212 and delete test/fixtures/legacy.",
      recap: SUITE_RECAP,
      recapAt: t(25),
      since: t(24),
      close: { verdict: "safe", reason: "", text: "closable: Tern reopens it when a wait fires" },
      waits: [
        wait({ id: "w-212-review", kind: "pr", label: "Review on PR#212", summary: "PR#212 review", ball: "on_me", state: "fired", outcome: "fulfilled", mark: "✅", reason: "ran, take a look" }),
        wait({ id: "w-212-ci", kind: "pr", label: "CI on PR#212", summary: "PR#212 checks", ball: "on_machine" }),
      ],
      onYou: [{ id: "w-212-review", label: "Review on PR#212", mark: "✅", text: "sam approved PR #212", report: "Approved with one nit: rename `withDb` to `withWorkerDb`." }],
      history: [
        { at: t(24), text: "Set aside: waiting on review and CI", fired: false },
        { at: t(6), text: "PR#212 approved by sam", fired: true },
      ],
      prs: [{ repo: "acme/api-server", number: 212, url: "https://github.com/acme/api-server/pull/212", source: "created", title: "Share one test database per worker", state: "open", review: "approved", checks: "pending" }],
    }),
    // Machine watching: a closed session, its CI and a timer; Resume reopens it.
    row({
      session: "demo-c48",
      title: "Fix the flaky webhook tests",
      project: "api-server",
      ball: "on_machine",
      recap: "The flaky webhook tests use a fake clock now; PR #48 waits on CI.",
      recapAt: t(3 * 60),
      since: t(3 * 60),
      close: { verdict: "safe", reason: "", text: "closable: Tern reopens it when a wait fires" },
      waits: [
        wait({ id: "w-48-ci", kind: "pr", label: "CI on PR#48", summary: "PR#48 checks", ball: "on_machine" }),
        wait({ id: "w-48-rerun", kind: "time", label: "Run the flaky suite 200 times", summary: "rerun at 17:00", ball: "on_timer", mark: "⏲", due: now + 2 * 60 * MIN, hasPrompt: true }),
      ],
      history: [{ at: t(3 * 60), text: "Set aside: CI on PR#48, then a soak run", fired: false }],
      prs: [{ repo: "acme/api-server", number: 48, url: "https://github.com/acme/api-server/pull/48", source: "wait", title: "Use a fake clock in the webhook tests", state: "open", review: "review_required", checks: "pending" }],
    }),
    // On a timer: a closed session that only the clock brings back.
    row({
      session: "demo-c51",
      title: "Move to Bun 1.4",
      project: "tern-awui",
      ball: "on_timer",
      recap: "On Bun 1.4: the idle timeout and the test mocks needed fixes; all green.",
      recapAt: t(26 * 60),
      since: t(26 * 60),
      close: { verdict: "safe", reason: "", text: "closable: Tern reopens it when a wait fires" },
      waits: [wait({ id: "w-51-recheck", kind: "time", label: "Drop the mock workaround on Bun 1.4.1", summary: "in 3 days", ball: "on_timer", mark: "⏲", due: now + 3 * DAY * MIN, hasPrompt: true })],
      history: [{ at: t(26 * 60), text: "Set aside: recheck once Bun 1.4.1 ships", fired: false }],
    }),
    // Waiting on something: the parked session; omp suggests a note.
    row({
      session: "demo-25",
      pane: 25,
      live: true,
      agentState: "idle",
      title: "Bump dependencies",
      project: "api-server",
      ball: "on_someone",
      waitingFor: "infra's go-ahead on Node 22",
      suggested: "Minors are in; the two majors wait for infra.",
      since: t(5 * 60),
      close: { verdict: "manual", reason: "", text: "you reopen: a reply from people comes back to you" },
      waits: [wait({ id: "w-25-infra", kind: "something", label: "Infra signs off on Node 22", summary: "infra signs off on Node 22", ball: "on_someone" })],
      history: [{ at: t(5 * 60), text: "Set aside: the majors wait for infra", fired: false }],
      prs: [{ repo: "acme/api-server", number: 219, url: "https://github.com/acme/api-server/pull/219", source: "mentioned", title: "Node 22 in CI", state: "draft", review: null, checks: null }],
    }),
    // When I have time.
    row({
      session: "demo-31",
      pane: 31,
      live: true,
      agentState: "idle",
      title: "Tidy the zsh config",
      project: "dotfiles",
      ball: "on_my_time",
      pinned: true,
      size: "S",
      note: "Try zsh-defer for the remaining plugins.",
      since: t(2 * DAY),
      waits: [wait({ id: "w-31-later", kind: "later", label: "When I have time", ball: "on_my_time", mark: "" })],
      history: [{ at: t(2 * DAY), text: "Set aside for later", fired: false }],
    }),
  ];
}

/** omp's autocomplete: slash commands, skills and files. */
export const COMPLETIONS = [
  { value: "/btw", label: "/btw", description: "Ask a side question without touching the turn" },
  { value: "/compact", label: "/compact", description: "Summarise the conversation to free context" },
  { value: "/model", label: "/model", description: "Switch the model" },
  { value: "/restart", label: "/restart", description: "Restart omp and resume this session" },
  { value: "/skill:polish", label: "/skill:polish", description: "Second-pass review of a change" },
  { value: "/skill:diagnosing-bugs", label: "/skill:diagnosing-bugs", description: "Find the cause before the fix" },
  { value: "@README.md", label: "README.md", description: "file" },
  { value: "@package.json", label: "package.json", description: "file" },
  { value: "@server.ts", label: "server.ts", description: "file" },
  { value: "@web/app.tsx", label: "web/app.tsx", description: "file" },
  { value: "@web/style.css", label: "web/style.css", description: "file" },
];

/** Canned replies for prompts, taken in turn; `{prompt}` is the prompt sent. */
export const REPLIES = [
  "On it. For **“{prompt}”** I'd start here:\n\n1. Read the files the change touches.\n2. Make the change in one place.\n3. Run the tests before calling it done.\n\n```sh\nbun run typecheck && bun test\n```\n\n_This is the demo: replies are canned and nothing left your browser. With Tern and omp running, this prompt would have gone to the session's pane on your desktop._",
  "Done. Here's what changed for **“{prompt}”**:\n\n| File | Change |\n| --- | --- |\n| `src/config.ts` | New option, off by default |\n| `src/main.ts` | Reads the option at start |\n\nTry steering me with another prompt while a reply streams: it lands in the queue and runs next.",
  "Good question. Short answer: yes, with one caveat: **“{prompt}”** works as long as the session stays connected. Swipe sideways to the next session, or go back to the list to see which one needs you.",
];

export const ANSWER_REPLY = "Going with **{answer}**. I'll wire it up and send a test notification once the server restarts.\n\n_In the demo the answer only lands here; with Tern it would be typed into omp's dialog on your desktop._";

/** The turn after a Deny with a reason, which reached the agent as a steer; `{reason}` is the reason. */
export const DENY_REASON_REPLY =
  "Understood, I left `deploy/prod.yml` as it was. Going by your note, **“{reason}”**, I'll take that route instead and ask before touching anything under `deploy/` again.\n\n_In the demo the reason only lands here; with Tern, Deny is pressed in omp's dialog and the reason steers the turn as your next message._";

export const OPEN_TURN_REPLY =
  "The light theme is in: the palette lives under `prefers-color-scheme: light`, and CssAudit moved the last three literal colours into variables. Contrast of the status dots passes AA on both themes.";

/** A side question's answer; `{question}` is the question. */
export const BTW_REPLY = "Short answer to “{question}”, without touching the main turn: yes. The side question runs on its own, so the session's conversation and context stay as they were.";

/** The scripted voice call: what you say, the turn it hands to the session, and what it reads back. */
export const VOICE = {
  ask: "Where does this session stand, in a sentence?",
  reply: "It's idle and nothing waits on you: the last turn finished cleanly, and the next step is yours.\n\n_The demo's voice call is scripted: no microphone was opened and no audio left your browser._",
  spoken: "It's idle and nothing waits on you. The next step is yours.",
  busy: "It's waiting on you first: answer its question on the screen.",
  /** An answer omp's live mode signals back; the demo's peer never connects anywhere. */
  sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=tern-awui demo\r\nt=0 0\r\n",
};
