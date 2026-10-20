import { describe, expect, test } from "bun:test";
import type { Caps, CatalogModel, Install, Item, Job, Live, Project, Role } from "./api";
import {
  OLD_MS,
  age,
  askAnswers,
  askReady,
  backStep,
  btwCommand,
  can,
  clock,
  composerKey,
  ctxShort,
  currentRole,
  duration,
  fitEdge,
  folderLabel,
  isAbove,
  installNotice,
  isOld,
  jobsSummary,
  langOf,
  lineEdit,
  listProjects,
  matchesWords,
  needsReencode,
  parseAdvisorNote,
  parseCollapsed,
  parseRecent,
  parseRoute,
  prettyModel,
  priceShort,
  routeHash,
  rowText,
  sessionNotice,
  shellArg,
  searchModels,
  todoSummary,
  toggled,
  tokensShort,
  trackOrigin,
  vapidBytes,
  withRecent,
  type AskPick,
  type Route,
} from "./lib";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

function item(over: Partial<Item> = {}): Item {
  return {
    block: "1",
    icon: null,
    tag: null,
    title: "a session",
    cwd: "/home/u/code/app",
    project: "app",
    branch: null,
    agent: null,
    live: null,
    status: "idle",
    since: NOW - 60_000,
    doc: null,
    unseen: null,
    ...over,
  };
}
const agent = (over: Partial<NonNullable<Item["agent"]>> = {}) => ({
  sessionId: "s",
  lastPrompt: "",
  recap: "",
  recapStale: false,
  lastActivity: 0,
  subagents: 0,
  ...over,
});

describe("tokensShort", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [1234, "1.2k"],
    [9_999, "10k"],
    [15_499, "15k"],
    [15_500, "16k"],
    [999_499, "999k"],
    // Rounds up to a million: "1M", never "1000k".
    [999_500, "1M"],
    [1_000_000, "1M"],
    [1_048_576, "1M"],
    [1_500_000, "1.5M"],
  ])("%d → %s", (n, want) => expect(tokensShort(n)).toBe(want));
});

describe("ctxShort", () => {
  test.each([
    [999, "999"],
    [1000, "1k"],
    [1500, "2k"],
    [200_000, "200k"],
    [999_999, "1M"],
    [1_048_576, "1M"],
    [2_000_000, "2M"],
  ])("%d → %s", (n, want) => expect(ctxShort(n)).toBe(want));
});

describe("priceShort", () => {
  const m = (inp: number, out: number): CatalogModel => ({ p: "x", id: "y", name: "Y", r: false, ctx: 0, in: inp, out, img: false });
  test("no price at all is blank, a free side still shows", () => {
    expect(priceShort(m(0, 0))).toBe("");
    expect(priceShort(m(0, 5))).toBe("$0·5");
  });
  test("cents below 10, whole dollars from 10", () => {
    expect(priceShort(m(0.25, 1.25))).toBe("$0.25·1.25");
    expect(priceShort(m(2.5, 10))).toBe("$2.5·10");
    expect(priceShort(m(12.6, 75))).toBe("$13·75");
    expect(priceShort(m(3, 15))).toBe("$3·15");
  });
});

describe("age", () => {
  test("no time is blank", () => expect(age(0, NOW)).toBe(""));
  test.each([
    [59_400, "59s"],
    [59_600, "1m"],
    [3_599_000, "59m"],
    [3_600_000, "1h"],
    [86_399_000, "23h"],
    [86_400_000, "1d"],
    [3 * 86_400_000, "3d"],
  ])("%d ms ago → %s", (ago, want) => expect(age(NOW - ago, NOW)).toBe(want));
  test("a clock slightly ahead never goes negative", () => expect(age(NOW + 5000, NOW)).toBe("0s"));
});

describe("duration", () => {
  test.each([
    [0, "0s"],
    [59_000, "59s"],
    [60_000, "1m00s"],
    [125_000, "2m05s"],
    [3_599_000, "59m59s"],
    [3_600_000, "1h00m"],
    [3_725_000, "1h02m"],
  ])("%d ms → %s", (ms, want) => expect(duration(ms)).toBe(want));
});

describe("clock", () => {
  test("24-hour, midnight as 00", () => {
    expect(clock(new Date(2026, 0, 1, 0, 5).getTime())).toBe("00:05");
    expect(clock(new Date(2026, 0, 1, 13, 7).getTime())).toBe("13:07");
  });
});

describe("prettyModel", () => {
  test.each([
    ["anthropic/claude-opus-5-5", "Opus 5.5"],
    ["anthropic/claude-opus-5-5:medium", "Opus 5.5"],
    ["anthropic/claude-fable-5-1", "Fable 5.1"],
    ["openai-codex/gpt-6.1-sol", "GPT 6.1 Sol"],
    ["openai-codex/gpt-6-luna", "GPT 6 Luna"],
    ["opencode-go/deepseek-v4.1-flash", "Deepseek V4.1 Flash"],
    ["zai/glm-5.3-flash:high", "Glm 5.3 Flash"],
    ["", ""],
  ])("%s → %s", (spec, want) => expect(prettyModel(spec)).toBe(want));
});

describe("jobsSummary", () => {
  const job = (type: string, id = type): Job => ({ id, type, label: "", agent: "", since: 0 });
  test("nothing running is blank", () => expect(jobsSummary([])).toBe(""));
  test("task and eval are subagents, the rest background jobs", () => {
    expect(jobsSummary([job("task")])).toBe("1 subagent");
    expect(jobsSummary([job("task", "a"), job("eval", "b")])).toBe("2 subagents");
    expect(jobsSummary([job("bash")])).toBe("1 background job");
    expect(jobsSummary([job("task"), job("eval"), job("bash")])).toBe("2 subagents · 1 background job");
    expect(jobsSummary([job("bash", "a"), job("bash", "b")])).toBe("2 background jobs");
  });
});

describe("currentRole", () => {
  // As omp's config lists them (modelRoles + cycleOrder).
  const roles: Role[] = [
    { role: "default", spec: "anthropic/claude-opus-5-5:medium" },
    { role: "claude", spec: "anthropic/claude-fable-5-1:medium" },
    { role: "smol", spec: "openai-codex/gpt-6-luna:high" },
    { role: "commit", spec: "openai-codex/gpt-6-luna" },
    { role: "advisor", spec: "openai-codex/gpt-6-luna:max" },
  ];
  test("matches model and thinking", () => {
    expect(currentRole(roles, "anthropic/claude-opus-5-5", "medium")).toBe("default");
    expect(currentRole(roles, "openai-codex/gpt-6-luna", "max")).toBe("advisor");
  });
  test("same model at another level falls back to its first role", () => {
    expect(currentRole(roles, "openai-codex/gpt-6-luna", "low")).toBe("smol");
    expect(currentRole(roles, "anthropic/claude-opus-5-5", "high")).toBe("default");
  });
  test("a model id without its provider still matches", () => {
    expect(currentRole(roles, "claude-fable-5-1", "medium")).toBe("claude");
  });
  test("no partial-name or empty-model matches", () => {
    expect(currentRole(roles, "opus-5-5", "medium")).toBeNull();
    expect(currentRole(roles, "anthropic/claude-opus-5", "medium")).toBeNull();
    expect(currentRole(roles, "", "")).toBeNull();
    expect(currentRole([], "anthropic/claude-opus-5-5", "medium")).toBeNull();
  });
});

const caps: Caps = { models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: true, levels: true };
const live = (over: Partial<Live> = {}): Live => ({
  model: "anthropic/claude-opus-5-5",
  thinking: "medium",
  levels: [],
  tiers: [],
  tier: "",
  context: null,
  jobs: [],
  protocol: 2,
  caps,
  build: "0123456789abcdef",
  mismatch: null,
  restart: false,
  ...over,
});

describe("bridge capabilities", () => {
  test("a reported cap decides, per feature", () => {
    const l = live({ caps: { ...caps, rewind: false, btw: false } });
    expect(can(l, "rewind")).toBe(false);
    expect(can(l, "btw")).toBe(false);
    expect(can(l, "models")).toBe(true);
    expect(can(l, "complete")).toBe(true);
  });
  test("an older extension without caps can do everything", () => {
    for (const cap of Object.keys(caps) as (keyof Caps)[]) expect(can(live({ protocol: 0, caps: null }), cap)).toBe(true);
  });
  test("no bridge, no features", () => {
    expect(can(null, "rewind")).toBe(false);
    expect(can(undefined, "models")).toBe(false);
  });
  test("a cap the extension doesn't name is unsupported", () => {
    const { complete: _, ...older } = caps;
    expect(can(live({ caps: older as Caps }), "complete")).toBe(false);
  });
});

describe("extension notices", () => {
  const install = (over: Partial<Install> = {}): Install => ({
    status: "ok",
    path: "/home/u/.omp/agent/extensions/tern-mobile.ts",
    target: "",
    repo: "/home/u/code/tern-awui",
    windows: false,
    ...over,
  });
  const session = (over: Partial<Live>, status = "idle") => item({ status, agent: agent({ sessionId: "019a-c0de" }), live: live(over) });

  test("an installed file that is this checkout's gets no banner", () => {
    expect(installNotice(install())).toBeNull();
  });
  test("missing, stale and foreign installs say what's wrong and run the installer in the checkout", () => {
    const fix = "cd /home/u/code/tern-awui && bun install.ts";
    expect(installNotice(install({ status: "missing" }))).toEqual({
      text: "No tern-mobile extension at /home/u/.omp/agent/extensions/tern-mobile.ts, so omp sessions don't connect to tern-mobile. Install it from the checkout (running omp sessions load it once restarted):",
      command: fix,
      reload: false,
    });
    expect(installNotice(install({ status: "stale" }))).toMatchObject({ text: expect.stringContaining("is an outdated copy"), command: fix });
    expect(installNotice(install({ status: "foreign", target: "/home/u/old/tern-awui/omp-extension/tern-mobile.ts" }))).toMatchObject({
      text: expect.stringContaining("links to /home/u/old/tern-awui/omp-extension/tern-mobile.ts, not this checkout"),
      command: fix,
    });
  });
  test("the fix quotes an odd checkout path for its shell; Windows gets PowerShell's form", () => {
    expect(installNotice(install({ status: "missing", repo: "/home/u/My Code/it's" }))?.command).toBe("cd '/home/u/My Code/it'\\''s' && bun install.ts");
    expect(installNotice(install({ status: "stale", repo: "C:\\Users\\Ann\\My Code\\tern-awui", windows: true }))?.command).toBe(
      "cd 'C:\\Users\\Ann\\My Code\\tern-awui'; bun install.ts",
    );
    expect(installNotice(install({ status: "stale", repo: "C:\\Users\\Ann\\tern-awui", windows: true }))?.command).toBe("cd C:\\Users\\Ann\\tern-awui; bun install.ts");
    expect(shellArg("C:\\Ann's", true)).toBe("'C:\\Ann''s'");
  });

  test("matching sessions and sessions without a bridge get none", () => {
    expect(sessionNotice(session({}), install())).toBeNull();
    expect(sessionNotice(item({ status: null }), install())).toBeNull();
  });
  test("an older extension in an omp with /restart: Reload, offered only while idle", () => {
    const idle = sessionNotice(session({ mismatch: "older", restart: true }), install());
    expect(idle).toEqual({
      text: "This omp loaded an older tern-mobile extension than the checkout's, so some of it may not work from here. Reload restarts omp in this pane with /restart and resumes the session.",
      command: null,
      reload: true,
    });
    for (const status of ["working", "blocked"]) {
      const busy = sessionNotice(session({ mismatch: "older", restart: true }, status), install());
      expect(busy).toMatchObject({ reload: false, command: null, text: expect.stringContaining("(once it is idle).") });
    }
  });
  test("an older extension in an omp without /restart: quit and resume this session by id", () => {
    expect(sessionNotice(session({ mismatch: "older" }), install())).toEqual({
      text: "This omp loaded an older tern-mobile extension than the checkout's, so some of it may not work from here. Quit omp in this pane and start it again; this continues the session:",
      command: "omp --resume 019a-c0de",
      reload: false,
    });
    expect(sessionNotice(item({ status: "idle", live: live({ mismatch: "older" }) }), install())?.command).toBe("omp --continue");
  });
  test("an older extension while the installed file is outdated too: reinstall first, no Reload", () => {
    expect(sessionNotice(session({ mismatch: "older", restart: true }), install({ status: "stale" }))).toMatchObject({
      text: expect.stringContaining("The installed file is outdated too: reinstall it, then restart this omp."),
      command: "cd /home/u/code/tern-awui && bun install.ts",
      reload: false,
    });
  });
  test("a newer extension than the server: update tern-awui", () => {
    expect(sessionNotice(session({ mismatch: "newer", restart: true }), install())).toEqual({
      text: "This omp runs a newer tern-mobile extension than the server. Update tern-awui:",
      command: "cd /home/u/code/tern-awui && git pull && bun install.ts",
      reload: false,
    });
    expect(sessionNotice(session({ mismatch: "newer" }), install({ windows: true, repo: "C:\\tern-awui" }))?.command).toBe("cd C:\\tern-awui; git pull; bun install.ts");
  });
});

describe("vapidBytes", () => {
  const b64url = (bytes: number[]) => Buffer.from(bytes).toString("base64url");
  test("decodes base64url without padding at every length remainder", () => {
    for (const bytes of [[1], [1, 2], [1, 2, 3], [0xfb, 0xff, 0xbf], [0, 255, 62, 63]]) {
      expect([...vapidBytes(b64url(bytes))]).toEqual(bytes);
    }
  });
  test("maps - and _ back to + and /", () => {
    const key = b64url([0xfb, 0xff]);
    expect(key).toMatch(/[-_]/);
    expect([...vapidBytes(key)]).toEqual([0xfb, 0xff]);
  });
  test("a 65-byte P-256 public key round-trips", () => {
    const bytes = Array.from({ length: 65 }, (_, i) => (i * 37 + 4) & 255);
    const out = vapidBytes(b64url(bytes));
    expect(out.length).toBe(65);
    expect([...out]).toEqual(bytes);
  });
});

describe("langOf", () => {
  test("ő or ű alone mark Hungarian", () => {
    expect(langOf("Ez egy hosszú mondat, de nincs benne sok ékezet, csak ő.")).toBe("hu");
    expect(langOf("Check the TŰZFAL config")).toBe("hu");
  });
  test("Hungarian prose without ő/ű is still Hungarian", () => {
    expect(langOf("Megnéztem a fájlokat, és a teszt már átmegy a gépen.")).toBe("hu");
  });
  test("English with a few accented names stays English", () => {
    const text =
      "José and Zoë reviewed the deployment checklist with Ángel yesterday afternoon; the rollout plan, the database migration and the monitoring dashboards all look ready for the release on Monday.";
    expect(langOf(text)).toBe("en");
  });
  test("the 2 % share is a strict threshold", () => {
    expect(langOf("áá" + "a".repeat(98))).toBe("en");
    expect(langOf("ááá" + "a".repeat(97))).toBe("hu");
  });
  test("no letters is English", () => {
    expect(langOf("")).toBe("en");
    expect(langOf("12 + 34 = 46")).toBe("en");
  });
});

describe("isOld", () => {
  const old = NOW - OLD_MS - 1;
  test("idle for over a day", () => {
    expect(isOld(item({ since: old }), NOW, null)).toBe(true);
    expect(isOld(item({ since: NOW - OLD_MS }), NOW, null)).toBe(false);
  });
  test("working, blocked, unseen and the open session stay", () => {
    expect(isOld(item({ since: old, status: "working" }), NOW, null)).toBe(false);
    expect(isOld(item({ since: old, status: "blocked" }), NOW, null)).toBe(false);
    expect(isOld(item({ since: old, unseen: "done" }), NOW, null)).toBe(false);
    expect(isOld(item({ since: old, unseen: "blocked" }), NOW, null)).toBe(false);
    expect(isOld(item({ since: old, block: "7" }), NOW, "7")).toBe(false);
    expect(isOld(item({ since: old, block: "7" }), NOW, "8")).toBe(true);
  });
  test("blocks without a time stay", () => {
    expect(isOld(item({ since: 0, status: null }), NOW, null)).toBe(false);
  });
});

describe("listProjects", () => {
  const old = NOW - OLD_MS - 1;
  const projects: Project[] = [
    {
      name: "app",
      items: [
        item({ block: "1", title: "Fix login", since: old }),
        item({ block: "2", title: "Docs", tag: "WIP", status: "working", since: old }),
      ],
    },
    { name: "infra", items: [item({ block: "3", title: "Backups", since: old, agent: agent({ lastPrompt: "rotate the borg keys" }) })] },
  ];
  const blocks = (ps: Project[]) => ps.map((p) => [p.name, p.items.map((i) => i.block)]);

  test("no filter, nothing hidden: the list as is", () => {
    expect(listProjects(projects, "", false, NOW, null)).toBe(projects);
  });
  test("hiding old drops them and projects left empty", () => {
    expect(blocks(listProjects(projects, "", true, NOW, null))).toEqual([["app", ["2"]]]);
  });
  test("the open session survives hiding", () => {
    expect(blocks(listProjects(projects, "", true, NOW, "3"))).toEqual([
      ["app", ["2"]],
      ["infra", ["3"]],
    ]);
  });
  test("a filter searches hidden sessions too", () => {
    expect(blocks(listProjects(projects, "fix", true, NOW, null))).toEqual([["app", ["1"]]]);
  });
  test("a filter matches project, tag, title and last prompt, not cwd", () => {
    expect(blocks(listProjects(projects, "infra", false, NOW, null))).toEqual([["infra", ["3"]]]);
    expect(blocks(listProjects(projects, "wip", false, NOW, null))).toEqual([["app", ["2"]]]);
    expect(blocks(listProjects(projects, "borg keys", false, NOW, null))).toEqual([["infra", ["3"]]]);
    expect(listProjects(projects, "/home/u", false, NOW, null)).toEqual([]);
  });
});

describe("rowText", () => {
  test("idle agents show the recap, marked once turns followed it", () => {
    const a = agent({ recap: "Refactored the parser", lastPrompt: "fix it" });
    expect(rowText(item({ agent: a }), NOW)).toEqual({ sub: "Refactored the parser", recap: true, stale: false });
    expect(rowText(item({ agent: { ...a, recapStale: true } }), NOW).sub).toBe("Earlier: Refactored the parser");
  });
  test("working agents show the last prompt even with a recap", () => {
    const r = rowText(item({ status: "working", agent: agent({ recap: "old", lastPrompt: "fix it" }) }), NOW);
    expect(r).toEqual({ sub: "fix it", recap: false, stale: false });
  });
  test("shells show their cwd; notes their kind, files their folder named from the project", () => {
    expect(rowText(item({ status: null }), NOW).sub).toBe("/home/u/code/app");
    expect(rowText(item({ doc: "/home/u/.local/state/tern/notes/x.md" }), NOW).sub).toBe("Note");
    expect(rowText(item({ doc: "/home/u/code/app/README.md" }), NOW).sub).toBe("app");
    expect(rowText(item({ doc: "/home/u/code/app/docs/a/b.md" }), NOW).sub).toBe("app/docs/a");
    // A sibling folder sharing the prefix is outside the project.
    expect(rowText(item({ doc: "/home/u/code/app2/x.md" }), NOW).sub).toBe("/home/u/code/app2");
    expect(rowText(item({ doc: "/home/u/todo.txt" }), NOW).sub).toBe("/home/u");
    expect(rowText(item({ cwd: "C:\\code\\app", doc: "C:\\code\\app\\src\\x.md" }), NOW).sub).toBe("app\\src");
    expect(rowText(item({ doc: "/Users/u/Library/Application Support/Tern/notes/x.md" }), NOW).sub).toBe("Note");
    expect(rowText(item({ doc: "C:\\Users\\u\\AppData\\Local\\Tern\\notes\\x.md" }), NOW).sub).toBe("Note");
  });
  test("only idle rows go stale after a day", () => {
    expect(rowText(item({ since: NOW - 86_400_001 }), NOW).stale).toBe(true);
    expect(rowText(item({ since: NOW - 86_400_000 }), NOW).stale).toBe(false);
    expect(rowText(item({ since: NOW - 86_400_001, status: "blocked" }), NOW).stale).toBe(false);
  });
});

describe("collapsed projects", () => {
  test("stored list round-trips; missing or broken storage is none", () => {
    expect([...parseCollapsed(JSON.stringify(["a", "b"]))]).toEqual(["a", "b"]);
    expect(parseCollapsed(null).size).toBe(0);
    expect(parseCollapsed("{not json").size).toBe(0);
    expect(parseCollapsed("5").size).toBe(0);
    expect([...parseCollapsed(JSON.stringify("abc"))]).toEqual([]);
    expect([...parseCollapsed(JSON.stringify([null, 42, {}, "project"]))]).toEqual(["project"]);
  });
  test("toggling flips one name and leaves the old set alone", () => {
    const before = new Set(["a"]);
    const added = toggled(before, "b");
    expect([...added]).toEqual(["a", "b"]);
    expect([...toggled(added, "a")]).toEqual(["b"]);
    expect([...before]).toEqual(["a"]);
  });
});

describe("model search", () => {
  const m = (p: string, id: string, name: string): CatalogModel => ({ p, id, name, r: true, ctx: 0, in: 0, out: 0, img: false });
  const catalog = [
    m("x", "sonnet-5-mini", "Mini 5 Sonnet"),
    m("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    m("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
    m("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
    m("openrouter", "anthropic/claude-sonnet-5", "Anthropic: Claude Sonnet 5"),
  ];
  const keys = (ms: CatalogModel[]) => ms.map((x) => `${x.p}/${x.id}`);

  test("every word must match; the phrase in the name ranks first", () => {
    expect(keys(searchModels(catalog, "sonnet 5"))).toEqual([
      "anthropic/claude-sonnet-5",
      "openrouter/anthropic/claude-sonnet-5",
      "x/sonnet-5-mini",
      "anthropic/claude-sonnet-4-5",
    ]);
  });
  test("the query in provider/id only ranks after the name matches", () => {
    const list = [m("a", "claude-sonnet-x", "X"), m("b", "q", "Old Claude-Sonnet")];
    expect(keys(searchModels(list, "claude-sonnet"))).toEqual(["b/q", "a/claude-sonnet-x"]);
  });
  test("case and surrounding space don't matter; a blank query finds nothing", () => {
    expect(keys(searchModels(catalog, "  OPUS  "))).toEqual(["anthropic/claude-opus-5-5"]);
    expect(searchModels(catalog, "   ")).toEqual([]);
  });
  test("matchesWords: all words anywhere, any order; no words matches all", () => {
    expect(matchesWords("tern awui", "/home/u/Sync/code/tern-awui")).toBe(true);
    expect(matchesWords("awui TERN", "/home/u/Sync/code/tern-awui")).toBe(true);
    expect(matchesWords("tern mobile", "/home/u/Sync/code/tern-awui")).toBe(false);
    expect(matchesWords("", "anything")).toBe(true);
  });
});

describe("recent models", () => {
  test("a pick moves to the front once; the list keeps six", () => {
    const recent = ["a", "b", "c", "d", "e", "f"];
    expect(withRecent(recent, "d")).toEqual(["d", "a", "b", "c", "e", "f"]);
    expect(withRecent(recent, "g")).toEqual(["g", "a", "b", "c", "d", "e"]);
    expect(withRecent([], "a")).toEqual(["a"]);
  });
  test("stored list is capped; broken storage is empty", () => {
    expect(parseRecent(JSON.stringify(["1", "2", "3", "4", "5", "6", "7"]))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("[")).toEqual([]);
    expect(parseRecent(JSON.stringify("bad storage"))).toEqual([]);
    expect(parseRecent(JSON.stringify([null, 42, {}, "test/model"]))).toEqual(["test/model"]);
  });
});

describe("todoSummary", () => {
  const t = (content: string, status: string) => ({ content, status });
  test("counts done and blocked across phases; the task under way is current", () => {
    const s = todoSummary([
      { name: "One", tasks: [t("a", "completed"), t("b", "blocked")] },
      { name: "Two", tasks: [t("c", "in_progress"), t("d", "pending")] },
    ]);
    expect(s).toEqual({ done: 1, total: 4, blocked: 1, current: "c" });
  });
  test("a blocked task is current when nothing is in progress", () => {
    expect(todoSummary([{ name: "", tasks: [t("a", "pending"), t("b", "blocked")] }]).current).toBe("b");
  });
  test("only pending: no current task", () => {
    expect(todoSummary([{ name: "", tasks: [t("a", "pending")] }]).current).toBe("");
  });
  test("all done", () => {
    expect(todoSummary([{ name: "", tasks: [t("a", "completed"), t("b", "completed")] }])).toEqual({ done: 2, total: 2, blocked: 0, current: "all done" });
  });
});

describe("parseAdvisorNote", () => {
  test("Key: is the headline and leaves the body", () => {
    const n = parseAdvisorNote("Key: Retry loop never ends\nEvidence: line 40\nImpact: hangs\nplain remark");
    expect(n.key).toBe("Retry loop never ends");
    expect(n.lines).toEqual([
      { label: "Evidence", text: "line 40" },
      { label: "Impact", text: "hangs" },
      { label: null, text: "plain remark" },
    ]);
  });
  test("without Key: no headline; every line stays in the body", () => {
    const n = parseAdvisorNote("Evidence: x\nFix: y");
    expect(n.key).toBeNull();
    expect(n.lines.map((l) => l.label)).toEqual(["Evidence", "Fix"]);
  });
});

describe("ask answers", () => {
  const q = (multi: boolean) => ({ question: "?", options: [{ label: "A", description: "" }], multi, recommended: 0 });
  const pick = (over: Partial<AskPick> = {}): AskPick => ({ option: null, picks: [], other: "", otherOpen: false, ...over });
  test("single choice needs an option; multi is ready with none", () => {
    expect(askReady([q(false)], [pick()])).toBe(false);
    expect(askReady([q(false)], [pick({ option: 0 })])).toBe(true);
    expect(askReady([q(true)], [pick()])).toBe(true);
    expect(askReady([q(false), q(false)], [pick({ option: 0 }), pick()])).toBe(false);
  });
  test("Other needs non-blank text", () => {
    expect(askReady([q(false)], [pick({ otherOpen: true, other: "  " })])).toBe(false);
    expect(askReady([q(true)], [pick({ otherOpen: true })])).toBe(false);
    expect(askReady([q(false)], [pick({ otherOpen: true, other: "mine" })])).toBe(true);
  });
  test("payload: trimmed Other text, else the picked option; picks always go along", () => {
    expect(askAnswers([pick({ otherOpen: true, other: " mine ", picks: [1] }), pick({ option: 2 }), pick({ otherOpen: true, other: " " })])).toEqual([
      { other: "mine", picks: [1] },
      { option: 2, picks: [] },
      { option: null, picks: [] },
    ]);
  });
});

describe("lineEdit", () => {
  test("types appended text without backspacing", () => expect(lineEdit("ls", "ls -l")).toEqual({ back: 0, text: " -l" }));
  test("backspaces only past the common prefix", () => expect(lineEdit("ls -l", "ls -a")).toEqual({ back: 1, text: "a" }));
  test("no change, no keys", () => expect(lineEdit("ls", "ls")).toEqual({ back: 0, text: "" }));
  test("clearing backspaces everything", () => expect(lineEdit("git st", "")).toEqual({ back: 6, text: "" }));
  test("an emoji is one Backspace, not two", () => expect(lineEdit("a😀", "a")).toEqual({ back: 1, text: "" }));
});

describe("btwCommand", () => {
  test("extracts the side question", () => {
    expect(btwCommand("/btw what is x?")).toEqual({ kind: "question", question: "what is x?" });
    expect(btwCommand("  /btw   two\nlines  ")).toEqual({ kind: "question", question: "two\nlines" });
  });
  test("bare commands open history", () => {
    expect(btwCommand("/btw")).toEqual({ kind: "history" });
    expect(btwCommand("  /btw \t\n ")).toEqual({ kind: "history" });
  });
  test("unrelated text remains an ordinary prompt", () => {
    expect(btwCommand("")).toBeNull();
    expect(btwCommand("/BTW")).toBeNull();
    expect(btwCommand("/btwx y")).toBeNull();
    expect(btwCommand("ask /btw y")).toBeNull();
  });
});

describe("composerKey", () => {
  const key = (k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => ({ key: k, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift });
  const desk = { working: false, live: true, terminal: false, touch: false };
  const busy = { ...desk, working: true };
  test("Enter sends, Shift+Enter breaks the line, touch Enter breaks the line", () => {
    expect(composerKey(key("Enter"), desk)).toBe("send");
    expect(composerKey(key("Enter", { shift: true }), desk)).toBeNull();
    expect(composerKey(key("Enter"), { ...desk, touch: true })).toBeNull();
    expect(composerKey(key("a"), desk)).toBeNull();
  });
  test("Ctrl+Enter or Ctrl+Q queues a follow-up only while a bridged agent works", () => {
    expect(composerKey(key("Enter", { ctrl: true }), busy)).toBe("followUp");
    expect(composerKey(key("q", { ctrl: true }), busy)).toBe("followUp");
    expect(composerKey(key("q", { ctrl: true }), desk)).toBeNull();
    expect(composerKey(key("Enter", { ctrl: true }), desk)).toBe("send");
    expect(composerKey(key("Enter", { ctrl: true }), { ...busy, live: false })).toBe("send");
    expect(composerKey(key("Enter", { ctrl: true }), { ...busy, terminal: true })).toBe("send");
  });
});

describe("pasted images", () => {
  const MB = 1024 * 1024;
  test("sendable types under 3 MB go as they are", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(needsReencode(type, MB)).toBe(false);
    expect(needsReencode("image/png", 3 * MB)).toBe(false);
  });
  test("bigger or other types are redrawn", () => {
    expect(needsReencode("image/png", 3 * MB + 1)).toBe(true);
    expect(needsReencode("image/heic", 10)).toBe(true);
    expect(needsReencode("image/svg+xml", 10)).toBe(true);
  });
  test("long edge capped at 2048, aspect kept, never enlarged", () => {
    expect(fitEdge(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(fitEdge(3000, 4000)).toEqual({ width: 1536, height: 2048 });
    expect(fitEdge(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(fitEdge(2048, 2048)).toEqual({ width: 2048, height: 2048 });
    expect(fitEdge(8192, 2)).toEqual({ width: 2048, height: 1 });
  });
});

describe("folderLabel", () => {
  test("name and parent, home as ~ with either separator", () => {
    expect(folderLabel("/home/u/code/app", "/home/u")).toEqual({ name: "app", parent: "~/code" });
    expect(folderLabel("/home/u/app", "/home/u")).toEqual({ name: "app", parent: "~" });
    expect(folderLabel("C:\\Users\\u\\code\\app", "C:\\Users\\u")).toEqual({ name: "app", parent: "~\\code" });
    expect(folderLabel("c:\\users\\u\\app", "C:\\Users\\u")).toEqual({ name: "app", parent: "~" });
  });
  test("outside home, a look-alike prefix, or no home: the parent as it is", () => {
    expect(folderLabel("/home/user2/app", "/home/u")).toEqual({ name: "app", parent: "/home/user2" });
    expect(folderLabel("/srv/app", "/home/u")).toEqual({ name: "app", parent: "/srv" });
    expect(folderLabel("/home/u/app", "")).toEqual({ name: "app", parent: "/home/u" });
    expect(folderLabel("/", "/home/u")).toEqual({ name: "/", parent: "" });
  });
});

describe("routes", () => {
  test.each<[string, Route]>([
    ["", { view: "list" }],
    ["#/", { view: "list" }],
    ["#/b/12", { view: "session", block: "12" }],
    ["#/b/12/sub", { view: "subagents", block: "12" }],
    ["#/b/12/sub/ViewA", { view: "subagent", block: "12", name: "ViewA" }],
    ["#/b/12/sub/Fix.v2-a_b", { view: "subagent", block: "12", name: "Fix.v2-a_b" }],
    // Names that could leave the subagent folder, or reach an advisor transcript, are no subagent.
    ["#/b/12/sub/..%2F..%2Fsecret", { view: "subagents", block: "12" }],
    ["#/b/12/sub/..", { view: "subagents", block: "12" }],
    ["#/b/12/sub/__advisor.sol61-high", { view: "subagents", block: "12" }],
    ["#/b/12/sub/%E0%A4%A", { view: "subagents", block: "12" }],
    ["#/b/12/sub/a/b", { view: "list" }],
    ["#/b/x", { view: "list" }],
    ["#/b/12/other", { view: "list" }],
  ])("%s", (hash, want) => expect(parseRoute(hash)).toEqual(want));

  test("a route's hash parses back to the same route", () => {
    const routes: Route[] = [
      { view: "list" },
      { view: "session", block: "3" },
      { view: "subagents", block: "3" },
      { view: "subagent", block: "3", name: "WebTests" },
    ];
    for (const r of routes) expect(parseRoute(routeHash(r))).toEqual(r);
    expect(routeHash({ view: "subagent", block: "3", name: "WebTests" })).toBe("#/b/3/sub/WebTests");
  });

  test("the list is above every screen, a session above its own subagent screens only", () => {
    const list: Route = { view: "list" };
    const session: Route = { view: "session", block: "1" };
    const subs: Route = { view: "subagents", block: "1" };
    const sub: Route = { view: "subagent", block: "1", name: "A" };
    expect([isAbove(list, session), isAbove(list, sub), isAbove(list, list)]).toEqual([true, true, false]);
    expect([isAbove(session, subs), isAbove(session, sub), isAbove(subs, sub)]).toEqual([true, true, true]);
    expect([isAbove(sub, session), isAbove(subs, session), isAbove(session, session)]).toEqual([false, false, false]);
    expect(isAbove({ view: "session", block: "2" }, sub)).toBe(false);
  });

  /** Walks hashes as the browser reports them, then asks where ‹ leads from the last. */
  function walk(hashes: string[]) {
    const origins = new Map<string, string>();
    for (let i = 1; i < hashes.length; i++) trackOrigin(origins, hashes[i - 1], hashes[i]);
    return backStep(origins, parseRoute(hashes.at(-1)!));
  }

  test("a subagent opened from the session's strip pops back to the session, which pops back to the list", () => {
    expect(walk(["", "#/b/1", "#/b/1/sub/A"])).toEqual({ target: "#/b/1", pop: true });
    // The pop returns to the session; it still remembers coming from the list.
    expect(walk(["", "#/b/1", "#/b/1/sub/A", "#/b/1"])).toEqual({ target: "#/", pop: true });
  });

  test("a subagent opened from the subagent list pops back to that list, and the list to the session", () => {
    expect(walk(["#/", "#/b/1", "#/b/1/sub", "#/b/1/sub/A"])).toEqual({ target: "#/b/1/sub", pop: true });
    expect(walk(["#/", "#/b/1", "#/b/1/sub", "#/b/1/sub/A", "#/b/1/sub"])).toEqual({ target: "#/b/1", pop: true });
  });

  test("a deep-linked subagent replaces itself with its session, which then replaces itself with the list", () => {
    expect(walk(["#/b/1/sub/A"])).toEqual({ target: "#/b/1", pop: false });
    expect(walk(["#/b/1/sub/A", "#/b/1"])).toEqual({ target: "#/", pop: false });
    expect(walk(["#/b/1/sub"])).toEqual({ target: "#/b/1", pop: false });
  });

  test("a subagent reached from elsewhere goes to its own session without popping", () => {
    expect(walk(["#/", "#/b/2", "#/b/1/sub/A"])).toEqual({ target: "#/b/1", pop: false });
    expect(walk(["#/", "#/b/1", "#/b/1/sub/A", "#/b/1/sub/B"])).toEqual({ target: "#/b/1", pop: false });
  });

  test("a session opened from another session (the desktop sidebar) replaces itself with the list", () => {
    expect(walk(["#/", "#/b/5", "#/b/12"])).toEqual({ target: "#/", pop: false });
    expect(walk(["#/b/5/sub/A", "#/b/12"])).toEqual({ target: "#/", pop: false });
  });
});
