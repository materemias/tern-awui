import { afterEach, beforeEach, describe, expect, test, setSystemTime, jest } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ternMobile, { bridgeSettings, BUILD, PROTOCOL } from "./tern-mobile";
import { bridgeFixture, type Completion } from "./bridge-fixture";
import { PROTOCOL as SERVER_PROTOCOL } from "../lib/bridge-state";
import { buildId } from "../lib/extension-check";

type Model = { provider: string; id: string; name?: string; reasoning?: boolean; api?: string; contextWindow?: number; input?: string[]; cost?: { input: number; output: number } };
type Handler = (...args: unknown[]) => unknown;
type Command = { handler: (args: string, ctx: { navigateTree(id: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }> }) => Promise<void> };
type SideTurn = { promptText: string; tools?: false; onTextDelta: (delta: string) => void };
const reasoning: Model = { provider: "openai", id: "reasoner", reasoning: true, name: "Reasoner", contextWindow: 100000, input: ["text", "image"], cost: { input: 2, output: 8 } };
// Bun has no omp pi-ai shim: fallback thinking works, but native levels discovery is absent.
const capsWithoutShim = { models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: true, levels: false };
const cleanup: (() => void)[] = [];
const originalEnv = { TERN_PANE: process.env.TERN_PANE, TERN_AWUI_BRIDGE: process.env.TERN_AWUI_BRIDGE, TERN_AWUI_TOKEN_FILE: process.env.TERN_AWUI_TOKEN_FILE, TERN_AWUI_CONFIG: process.env.TERN_AWUI_CONFIG };
let now: number;
beforeEach(() => { now = 2_000_000_000_000; setSystemTime(now); });
afterEach(() => {
	jest.useRealTimers();
	for (const close of cleanup.splice(0).reverse()) close();
	setSystemTime();
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});
function advance(ms: number) { now += ms; setSystemTime(now); }
/** `configDir`: no file override; the token sits in `$TERN_AWUI_CONFIG/bridge-token`. `factory`: another copy of the extension. */
function fixture(options: { pane?: boolean; hasUI?: boolean; sub?: boolean; configDir?: boolean; factory?: typeof ternMobile } = {}) {
	const bridge = bridgeFixture();
	cleanup.push(() => bridge.close());
	process.env.TERN_PANE = "test-pane";
	if (options.pane === false) delete process.env.TERN_PANE;
	process.env.TERN_AWUI_BRIDGE = bridge.url;
	process.env.TERN_AWUI_TOKEN_FILE = bridge.tokenFile;
	delete process.env.TERN_AWUI_CONFIG;
	if (options.configDir) {
		// Bun reads the home folder once at startup, so ~/.config itself can't be redirected here.
		delete process.env.TERN_AWUI_TOKEN_FILE;
		const dir = join(bridge.dir, "config");
		mkdirSync(dir);
		writeFileSync(join(dir, "bridge-token"), "config-dir-secret\n");
		process.env.TERN_AWUI_CONFIG = dir;
	}
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const state = {
		text: "desktop draft", idle: true, pending: false, thinking: "medium", sessionId: "session-123", leaf: "entry-1" as string | null,
		model: { ...reasoning } as Model | undefined, models: [reasoning] as Model[], credentials: true,
		usage: { tokens: 1234, contextWindow: 10000, percent: 12.34 } as { tokens: number; contextWindow: number; percent: number } | undefined,
		jobs: [] as { id: string; type: string; label: string; agentId?: string; startTime: number }[],
		tiers: {} as Record<string, string>, poll: undefined as (() => void) | undefined, intervals: [] as number[], aborts: 0,
		modelCalls: [] as Model[], thinkingCalls: [] as string[], tierCalls: [] as unknown[][], sends: [] as unknown[][], catalogKinds: [] as unknown[],
		suggestions: { items: [{ value: "/help", label: "Help", extra: "provider field" }], prefix: "/" } as { items: Completion[]; prefix: string } | null,
		completionCalls: [] as unknown[][], applyCalls: [] as unknown[][], ephemeralCalls: [] as SideTurn[],
	};
	const provider = {
		async getSuggestions(...args: unknown[]) { state.completionCalls.push(args); return state.suggestions; },
		applyCompletion(...args: unknown[]) { state.applyCalls.push(args); return { lines: ["applied", "completion"] }; },
	};
	const ctx = {
		hasUI: options.hasUI ?? true, agent: { kind: options.sub ? "sub" : "main" },
		ui: {
			getEditorText: () => state.text,
			setEditorText(text: string) { state.text = text; },
			addAutocompleteProvider(factory: (p: typeof provider) => typeof provider) { expect(factory(provider)).toBe(provider); },
		},
		get model() { return state.model; },
		isIdle: () => state.idle,
		abort() { state.aborts++; },
		hasPendingMessages: () => state.pending,
		getContextUsage: () => state.usage,
		getAsyncJobSnapshot: () => ({ running: state.jobs }),
		sessionManager: { getSessionId: () => state.sessionId, getLeafId: () => state.leaf },
		modelRegistry: {
			find: (provider: string, id: string) => state.models.find((model) => model.provider === provider && model.id === id),
			getAvailable(kind?: string) { state.catalogKinds.push(kind); return state.models; },
		},
		setInterval(callback: () => void, ms: number) { state.poll = callback; state.intervals.push(ms); },
		runEphemeralTurn: async (options: SideTurn) => { state.ephemeralCalls.push(options); return { replyText: "side answer" }; },
	};
	const pi = {
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		async setModel(model: Model) { state.modelCalls.push(model); if (state.credentials) state.model = model; return state.credentials; },
		getThinkingLevel: () => state.thinking,
		setThinkingLevel(level: string) { state.thinkingCalls.push(level); state.thinking = level; },
		getServiceTiers: () => state.tiers,
		setServiceTier(family: string, tier: string | undefined) { state.tierCalls.push([family, tier]); if (tier) state.tiers[family] = tier; else delete state.tiers[family]; },
		sendUserMessage(...args: unknown[]) { state.sends.push(args); },
	};
	// Event names determine handler argument types in omp; the recorder stores them uniformly.
	const api = pi as unknown as Parameters<typeof ternMobile>[0];
	(options.factory ?? ternMobile)(api);
	cleanup.push(() => handlers.get("session_shutdown")?.({}, ctx));
	return {
		bridge, state, ctx, pi, handlers, commands, provider,
		emit(event: string, data: Record<string, unknown> = {}) { return handlers.get(event)?.(data, ctx); },
		async start() { handlers.get("session_start")?.({}, ctx); return bridge.inbox.next((m) => m.t === "state"); },
	};
}

describe("installed bridge discovery", () => {
	test("uses the installed port and token path unless explicitly overridden", () => {
		const home = mkdtempSync(join(tmpdir(), "tern-mobile-discovery-"));
		cleanup.push(() => rmSync(home, { recursive: true, force: true }));
		const dir = join(home, ".config", "tern-mobile");
		mkdirSync(dir, { recursive: true });
		const tokenFile = join(home, "relocated", "bridge-token");
		writeFileSync(join(dir, "bridge.json"), JSON.stringify({ endpoint: "ws://127.0.0.1:4567/bridge", tokenFile }));
		expect(bridgeSettings({}, home)).toEqual({ url: "ws://127.0.0.1:4567/bridge", tokenFile });
		expect(bridgeSettings({ TERN_AWUI_BRIDGE: "ws://localhost:1234/bridge" }, home)).toEqual({ url: "ws://localhost:1234/bridge", tokenFile });
		expect(bridgeSettings({ TERN_AWUI_TOKEN_FILE: "/explicit/token" }, home).tokenFile).toBe("/explicit/token");
		expect(bridgeSettings({ TERN_AWUI_CONFIG: "/explicit/config" }, home).tokenFile).toBe(join("/explicit/config", "bridge-token"));
		expect(bridgeSettings({ TERN_AWUI_CONFIG: "/explicit/config", TERN_AWUI_TOKEN_FILE: "/explicit/token" }, home).tokenFile).toBe("/explicit/token");
	});

	test("missing or malformed discovery preserves the defaults", () => {
		const home = mkdtempSync(join(tmpdir(), "tern-mobile-discovery-"));
		cleanup.push(() => rmSync(home, { recursive: true, force: true }));
		const dir = join(home, ".config", "tern-mobile");
		mkdirSync(dir, { recursive: true });
		const defaults = { url: "ws://127.0.0.1:4380/bridge", tokenFile: join(dir, "bridge-token") };
		expect(bridgeSettings({}, home)).toEqual(defaults);
		for (const value of ["not json", "null", "[]", JSON.stringify({ endpoint: "ws://remote.example/bridge", tokenFile: "/token" }), JSON.stringify({ endpoint: "ws://127.0.0.1:4567/bridge", tokenFile: "relative" }), JSON.stringify({ endpoint: "ws://user@127.0.0.1:4567/bridge", tokenFile: "/token" })]) {
			writeFileSync(join(dir, "bridge.json"), value);
			expect(bridgeSettings({}, home)).toEqual(defaults);
		}
	});
});

describe("omp extension bridge contract", () => {
	test("does nothing without a pane; ignores headless and subagent session starts", async () => {
		const absent = fixture({ pane: false });
		expect(absent.handlers.size).toBe(0);
		expect(absent.commands.size).toBe(0);
		for (const options of [{ hasUI: false }, { sub: true }]) {
			const f = fixture(options);
			f.emit("session_start");
			expect(f.bridge.connections).toHaveLength(0);
			expect(f.state.intervals).toEqual([]);
			f.ctx.hasUI = true; f.ctx.agent.kind = "main";
			await f.start();
			f.handlers.get("session_start")!({}, { ...f.ctx, agent: { kind: "sub" }, sessionManager: { getSessionId: () => "wrong-session" } });
			expect((await f.bridge.request({ t: "sync" })).sessionId).toBe("session-123");
		}
	});

	test("authenticates and snapshots all fields, sends only changes, and replaces main session context", async () => {
		const f = fixture();
		expect<unknown>(await f.start()).toEqual({ t: "state", pane: "test-pane", sessionId: "session-123", text: "desktop draft", model: "openai/reasoner", thinking: "medium", levels: ["off", "minimal", "low", "medium", "high", "xhigh"], tiers: ["", "flex", "priority"], tier: "", status: "idle", run: null, jobs: [], context: { tokens: 1234, window: 10000, percent: 12 }, queued: [], leaf: "entry-1", protocol: PROTOCOL, build: BUILD, caps: capsWithoutShim, stretch: null });
		expect(f.bridge.connections[0].data.token).toBe("test-bridge-secret");
		expect(f.state.intervals).toEqual([100]);
		f.state.poll!();
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
		f.state.text = "changed on desktop"; f.state.poll!();
		expect((await f.bridge.inbox.next()).text).toBe("changed on desktop");
		f.state.poll!(); await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
		f.state.sessionId = "session-456"; f.emit("session_start");
		expect((await f.bridge.inbox.next()).sessionId).toBe("session-456");
		expect(f.state.intervals).toEqual([100]);
		expect(f.bridge.connections).toHaveLength(1);
	});

	test("stretches: reports stretch.ts's open keys, and opens one for the phone in the pane", async () => {
		const key = Symbol.for("omp-stretch");
		const f = fixture(); await f.start();
		expect(await f.bridge.request({ t: "stretch", block: "1.0", key: "a", open: true })).toMatchObject({ error: "stretch.ts is not loaded in this omp" });
		const open: Record<string, string[]> = {};
		const calls: unknown[][] = [];
		const g = globalThis as Record<symbol, unknown>;
		g[key] = { bridge: { version: 1, state: () => ({ off: false, open: structuredClone(open) }), setOpen: (...args: unknown[]) => { calls.push(args); open["1.0"] = ["a"]; } } };
		try {
			const reply = await f.bridge.request({ t: "stretch", block: "1.0", key: "a", open: true });
			expect(calls).toEqual([["1.0", "a", true]]);
			// A stretch.ts without ✦ (no `deepen` method) never offers it, and a press is refused.
			expect(reply.stretch).toEqual({ off: false, open: { "1.0": ["a"] }, deepen: false });
			expect(await f.bridge.request({ t: "deepen", block: "1.0", key: "a" })).toMatchObject({ error: "this stretch.ts can't ask for more" });
			// With ✦, a phone press reaches the pane's stretch.ts, and the reply carries the running press.
			const running: Record<string, unknown[]> = {};
			const presses: unknown[][] = [];
			g[key] = { bridge: { version: 1, state: () => ({ off: false, open: {}, deepen: true, running: structuredClone(running) }), setOpen() {}, deepen: (...args: unknown[]) => { presses.push(args); running["1.0"] = [{ key: "a", seconds: 0, partial: "" }]; } } };
			const pressed = await f.bridge.request({ t: "deepen", block: "1.0", key: "a" });
			expect(presses).toEqual([["1.0", "a"]]);
			expect(pressed.stretch).toEqual({ off: false, open: {}, deepen: true, running: { "1.0": [{ key: "a", seconds: 0, partial: "" }] } });
			// A newer bridge shape is not guessed at.
			g[key] = { bridge: { version: 2, state: () => ({ off: true, open: {} }), setOpen: () => {} } };
			expect((await f.bridge.request({ t: "sync" })).stretch).toBeNull();
		} finally {
			delete g[key];
		}
	});

	test("a new session clears the previous session's queue, tools, samples and completions", async () => {
		const f = fixture(); await f.start();
		f.state.idle = false; f.state.pending = true;
		f.state.jobs = [{ id: "old-job", type: "task", label: "Old task", startTime: 1 }];
		f.emit("input", { text: "old queued prompt" });
		f.emit("tool_execution_start", { toolCallId: "old-ask", toolName: "ask" });
		advance(2001);
		expect((await f.bridge.request({ t: "sync" })).status).toBe("blocked");
		await f.bridge.request({ t: "complete", text: "/" });
		f.state.sessionId = "new-session"; f.state.text = "/";
		f.state.idle = true; f.state.pending = false; f.state.jobs = [];
		f.state.usage = { tokens: 0, contextWindow: 10000, percent: 0 };
		f.emit("session_switch");
		expect(await f.bridge.inbox.next()).toMatchObject({
			sessionId: "new-session", status: "idle", queued: [], jobs: [],
			context: { tokens: 0, window: 10000, percent: 0 },
		});
		expect(await f.bridge.request({ t: "apply", text: "/", value: "/help", label: "Help", prefix: "/" })).not.toHaveProperty("text");
		expect(f.state.text).toBe("/");
	});

	test("without the file override, the token comes from $TERN_AWUI_CONFIG", async () => {
		const f = fixture({ configDir: true });
		await f.start();
		expect(f.bridge.connections[0].data.token).toBe("config-dir-secret");
	});

	test("reports the build of the file omp loaded, as the server computes it, and the server's protocol", async () => {
		expect(PROTOCOL).toBe(SERVER_PROTOCOL);
		expect(BUILD).toMatch(/^[0-9a-f]{16}$/);
		expect(BUILD).toBe(buildId(readFileSync(join(import.meta.dir, "tern-mobile.ts"))));
		// A copy that differs only in a comment, as a session started before a `git pull` runs it.
		const dir = mkdtempSync(join(tmpdir(), "tern-mobile-copy-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const source = `// an older edit\n${readFileSync(join(import.meta.dir, "tern-mobile.ts"), "utf8")}`;
		writeFileSync(join(dir, "tern-mobile.ts"), source);
		// The copy's path exists only at run time, and loading it the way omp does is the point.
		const copy: { BUILD: typeof BUILD; default: typeof ternMobile } = await import(join(dir, "tern-mobile.ts"));
		expect(copy.BUILD).toBe(buildId(source));
		expect(copy.BUILD).not.toBe(BUILD);
		const f = fixture({ factory: copy.default });
		expect(await f.start()).toMatchObject({ protocol: PROTOCOL, build: copy.BUILD });
	});

	test("samples context and handles absent model/context/leaf", async () => {
		const f = fixture(); await f.start();
		f.state.usage = { tokens: 6000, contextWindow: 10000, percent: 60.6 };
		expect((await f.bridge.request({ t: "sync" })).context.percent).toBe(12);
		advance(2001);
		expect((await f.bridge.request({ t: "sync" })).context).toEqual({ tokens: 6000, window: 10000, percent: 61 });
		f.state.usage.contextWindow = 0; f.state.model = undefined; f.state.leaf = null; advance(2001);
		const state = await f.bridge.request({ t: "sync" });
		expect(state).toMatchObject({ model: "", levels: [], tiers: [], tier: "", context: null, leaf: "-" });
	});

	test("blocked approval/ask outranks work; task and eval jobs count but bash does not", async () => {
		const f = fixture(); await f.start();
		f.state.idle = false;
		expect((await f.bridge.request({ t: "sync" })).status).toBe("working");
		f.emit("tool_approval_requested", { toolCallId: "approval", toolName: "bash" });
		f.emit("tool_execution_start", { toolCallId: "question", toolName: "ask" });
		expect((await f.bridge.request({ t: "sync" })).status).toBe("blocked");
		f.emit("tool_approval_resolved", { toolCallId: "approval" });
		expect((await f.bridge.request({ t: "sync" })).status).toBe("blocked");
		f.emit("tool_execution_end", { toolCallId: "question" });
		f.state.idle = true;
		for (const [type, status] of [["bash", "idle"], ["task", "working"], ["eval", "working"]]) {
			f.state.jobs = [{ id: "j1", type, label: "x".repeat(180), agentId: "agent", startTime: 123 }]; advance(1001);
			const state = await f.bridge.request({ t: "sync" });
			expect(state.status).toBe(status);
			expect(state.jobs).toEqual([{ id: "j1", type, label: "x".repeat(160), agent: "agent", since: 123 }]);
		}
		f.ctx.getAsyncJobSnapshot = () => { throw new Error("job manager disposed"); }; advance(1001);
		expect((await f.bridge.request({ t: "sync" })).status).toBe("idle");
	});

	test("run: the turn's start and its newest tool intent, streamed or resolved; gone when idle", async () => {
		const f = fixture(); await f.start();
		f.state.idle = false;
		f.emit("agent_start");
		const started = (await f.bridge.request({ t: "sync" })).run!;
		expect(started).toEqual({ since: expect.any(Number), intent: "" });
		// While the call streams, its `i` argument; then omp's resolved label replaces it.
		f.emit("message_update", { message: { role: "assistant", content: [{ type: "toolCall", arguments: { i: " Old " } }, { type: "toolCall", arguments: { i: "  Rebuilding suite  " } }] } });
		expect((await f.bridge.request({ t: "sync" })).run).toEqual({ since: started.since, intent: "Rebuilding suite" });
		f.emit("message_update", { message: { role: "assistant", content: [{ type: "toolCall", arguments: { code: "1" } }] } });
		f.emit("tool_execution_start", { toolCallId: "e1", toolName: "eval", intent: "running javascript" });
		expect((await f.bridge.request({ t: "sync" })).run).toEqual({ since: started.since, intent: "running javascript" });
		f.emit("tool_execution_start", { toolCallId: "e2", toolName: "eval", intent: "x".repeat(200) });
		expect((await f.bridge.request({ t: "sync" })).run?.intent).toBe("x".repeat(120));
		f.state.idle = true;
		expect((await f.bridge.request({ t: "sync" })).run).toBeNull();
		f.state.idle = false; f.emit("agent_end");
		expect((await f.bridge.request({ t: "sync" })).run).toBeNull();
	});

	test("set/unknown/sync roundtrip drafts and sequences; malformed JSON does not kill connection", async () => {
		const f = fixture(); await f.start();
		expect(await f.bridge.request({ t: "set", text: "phone\ndraft" })).toMatchObject({ t: "state", text: "phone\ndraft" });
		expect(f.state.text).toBe("phone\ndraft");
		// The desktop typed since the phone last saw the draft: refused, editor untouched.
		expect(await f.bridge.request({ t: "set", text: "stale", expected: "phone" })).toMatchObject({ error: "draft changed" });
		expect(await f.bridge.request({ t: "set", text: "newer", expected: "phone\ndraft" })).toMatchObject({ text: "newer" });
		f.bridge.connections[0].send("not JSON");
		expect(await f.bridge.request({ t: "future-command" })).toMatchObject({ t: "state", text: "newer" });
	});

	test("parses model ids containing slash and colon, thinking suffixes, and model failures", async () => {
		const f = fixture(); await f.start();
		f.state.models = [{ provider: "openrouter", id: "vendor/name:free", reasoning: true }, { provider: "ollama", id: "qwen:8b", reasoning: true }];
		for (const [spec, id, thinking] of [["openrouter/vendor/name:free", "vendor/name:free", "medium"], ["ollama/qwen:8b:high", "qwen:8b", "high"]]) {
			const result = await f.bridge.request({ t: "model", spec });
			expect(result.model).toContain(id);
			expect(result.thinking).toBe(thinking);
			expect(f.state.modelCalls.at(-1)?.id).toBe(id);
		}
		for (const spec of ["bad", "missing/model", "openrouter/"]) expect(await f.bridge.request({ t: "model", spec })).toMatchObject({ t: "reply", error: "unknown model" });
		f.state.credentials = false;
		expect(await f.bridge.request({ t: "model", spec: "openrouter/vendor/name:free:low" })).toMatchObject({ error: "no credentials for this model" });
		expect(f.state.thinkingCalls).toEqual(["high"]);
	});

	test("catalog uses chat models and stable compact fields with defaults", async () => {
		const f = fixture(); await f.start();
		f.state.models.push({ provider: "plain", id: "basic" });
		expect((await f.bridge.request({ t: "models" })).models).toEqual([
			{ p: "openai", id: "reasoner", name: "Reasoner", r: true, ctx: 100000, in: 2, out: 8, img: true },
			{ p: "plain", id: "basic", name: "basic", r: false, ctx: 0, in: 0, out: 0, img: false },
		]);
		expect(f.state.catalogKinds).toEqual(["chat"]);
	});

	test("thinking refuses unsupported effort without changing current effort", async () => {
		const f = fixture(); await f.start();
		expect((await f.bridge.request({ t: "thinking", level: "high" })).thinking).toBe("high");
		expect(await f.bridge.request({ t: "thinking", level: "nonsense" })).toMatchObject({ error: "this model has no such thinking level" });
		f.state.model = { provider: "plain", id: "plain", reasoning: false };
		expect(await f.bridge.request({ t: "thinking", level: "low" })).toMatchObject({ error: "this model has no such thinking level" });
		expect(f.state.thinkingCalls).toEqual(["high"]);
		expect((await f.bridge.request({ t: "thinking", level: "off" })).thinking).toBe("off");
	});

	test("tier uses provider family, clears overrides, and refuses unsupported tiers", async () => {
		const f = fixture(); await f.start();
		for (const [model, family, tiers] of [
			[{ provider: "openai-codex", id: "x" }, "openai", ["", "flex", "priority"]],
			[{ provider: "proxy", id: "x", api: "anthropic-messages" }, "anthropic", ["", "priority"]],
			[{ provider: "google", id: "x" }, "google", ["", "flex", "priority"]],
			[{ provider: "google-vertex", id: "x" }, "google", ["", "flex", "priority"]],
		] as const) {
			f.state.model = model;
			expect(await f.bridge.request({ t: "tier", tier: "priority" })).toMatchObject({ tier: "priority", tiers: [...tiers] });
			expect(f.state.tierCalls.at(-1)).toEqual([family, "priority"]);
			expect((await f.bridge.request({ t: "tier", tier: "" })).tier).toBe("");
			expect(f.state.tierCalls.at(-1)).toEqual([family, undefined]);
		}
		f.state.model = { provider: "anthropic", id: "x", api: "anthropic-messages" };
		expect(await f.bridge.request({ t: "tier", tier: "flex" })).toMatchObject({ error: "this model has no such tier" });
		f.state.model = { provider: "other", id: "x" };
		expect(await f.bridge.request({ t: "tier", tier: "priority" })).toMatchObject({ error: "this model has no such tier" });
	});

	test("sends images and follow-ups, clears editor, and holds notes until pending queue empties", async () => {
		const f = fixture(); await f.start();
		const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
		expect(await f.bridge.request({ t: "send", text: "look", images, followUp: true })).toMatchObject({ text: "", queued: [] });
		expect(f.state.sends[0]).toEqual([[{ type: "text", text: "look" }, { type: "image", ...images[0] }], undefined]);
		f.state.idle = false; f.state.pending = true;
		expect((await f.bridge.request({ t: "send", text: "later", images: [], followUp: true })).queued).toEqual([{ text: "later", followUp: true }]);
		expect(f.state.sends[1]).toEqual([[{ type: "text", text: "later" }], { deliverAs: "followUp" }]);
		f.emit("input", { text: "later" });
		expect((await f.bridge.request({ t: "send", text: "", images })).queued).toEqual([{ text: "later", followUp: true }, { text: "(image)", followUp: false }]);
		expect(f.state.sends[2]).toEqual([[{ type: "image", ...images[0] }], undefined]);
		advance(1001);
		expect((await f.bridge.request({ t: "sync" })).queued).toHaveLength(2);
		f.state.pending = false;
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([]);
		f.emit("input", { text: "  new steer  " });
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([{ text: "new steer", followUp: false }]);
		advance(1001);
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([]);
		f.emit("input", { text: " /help " }); f.state.idle = true; f.emit("input", { text: "ordinary idle input" });
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([]);
	});

	test("send keeps newer desktop text, and refuses without a model before touching the editor", async () => {
		const f = fixture(); await f.start();
		f.state.text = "desktop";
		expect(await f.bridge.request({ t: "send", text: "x", images: [], expected: "phone" })).toMatchObject({ text: "desktop" });
		expect(await f.bridge.request({ t: "send", text: "y", images: [], expected: "desktop" })).toMatchObject({ text: "" });
		f.state.text = "draft"; f.state.model = undefined;
		expect(await f.bridge.request({ t: "send", text: "keep", images: [] })).toMatchObject({ error: "no model selected" });
		expect(f.state.text).toBe("draft");
		expect(f.state.sends).toHaveLength(2);
	});

	test("native interactive queue prefixes and explicit phone follow-ups publish the same clean queue", async () => {
		const text = "btw evaluate this\n  keep this indentation\nand this line";
		for (const prefix of ["->", "=>"]) {
			const desktop = fixture(); await desktop.start();
			desktop.state.idle = false; desktop.state.pending = true;
			const event = { text: `${prefix}\n${text}\n`, source: "interactive" };
			const original = { ...event };
			expect(desktop.emit("input", event)).toBeUndefined();
			const snapshot = await desktop.bridge.request({ t: "sync" });
			expect(snapshot.queued).toEqual([{ text, followUp: true }]);
			expect(event).toEqual(original);
			expect(desktop.state.sends).toEqual([]);

			const phone = fixture(); await phone.start();
			phone.state.idle = false; phone.state.pending = true;
			expect((await phone.bridge.request({ t: "send", text, images: [], followUp: true })).queued).toEqual(snapshot.queued);
			expect(phone.state.sends).toEqual([[[{ type: "text", text }], { deliverAs: "followUp" }]]);
		}
	});

	test("queue display normalization is exact, interactive-only, and preserves grouped payloads", async () => {
		for (const event of [
			{ text: "  -> leading whitespace  ", source: "interactive" },
			{ text: "embedded -> arrow", source: "interactive" },
			{ text: "→ unrelated arrow", source: "interactive" },
			{ text: "-> rpc literal", source: "rpc" },
			{ text: "=> extension literal", source: "extension" },
			{ text: "-> missing source" },
			{ text: " normal steer ", source: "interactive" },
		]) {
			const f = fixture(); await f.start();
			f.state.idle = false; f.state.pending = true;
			f.emit("input", event);
			expect((await f.bridge.request({ t: "sync" })).queued).toEqual([{ text: event.text.trim(), followUp: false }]);
		}
		const f = fixture(); await f.start();
		f.state.idle = false; f.state.pending = true;
		const grouped = "1. first\n2. second\n  continuation";
		f.emit("input", { text: `->\n${grouped}`, source: "interactive" });
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([{ text: grouped, followUp: true }]);
	});

	test("blank native queue payloads do not invent images or alter slash command handling", async () => {
		const f = fixture(); await f.start();
		f.state.idle = false; f.state.pending = true;
		for (const text of ["->\n ", "=> ", "  ", " /help "]) {
			f.emit("input", { text, source: "interactive", images: [] });
			expect((await f.bridge.request({ t: "sync" })).queued).toEqual([]);
		}
		f.emit("input", { text: "->\n", source: "interactive", images: [{}] });
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([{ text: "(image)", followUp: true }]);
		advance(1001); f.state.pending = false;
		await f.bridge.request({ t: "sync" });
		f.emit("input", { text: "", source: "interactive", images: [{}] });
		expect((await f.bridge.request({ t: "sync" })).queued).toEqual([{ text: "(image)", followUp: false }]);
	});

	test("a rejected async command returns its error without breaking the bridge", async () => {
		const f = fixture(); await f.start();
		f.pi.setModel = async () => { throw new Error("model metadata unavailable"); };
		expect(await f.bridge.request({ t: "model", spec: "openai/reasoner" })).toMatchObject({ t: "reply", error: "model metadata unavailable" });
		expect((await f.bridge.request({ t: "sync" })).model).toBe("openai/reasoner");
	});

	test("watch gates live text, coalesces updates, filters content, and ends the stream", async () => {
		const f = fixture(); await f.start();
		const update = (text: string, role = "assistant") => f.emit("message_update", { message: { role, content: [{ type: "text", text }] } });
		jest.useFakeTimers();
		update("hidden"); jest.advanceTimersByTime(201);
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
		f.bridge.send({ t: "watch", on: true }); await f.bridge.request({ t: "sync" });
		update("first"); update("second"); update("user text", "user");
		jest.advanceTimersByTime(199);
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
		jest.advanceTimersByTime(1);
		expect<unknown>(await f.bridge.inbox.next((m) => m.t === "live")).toEqual({ t: "live", text: "second", done: false });
		update("second"); jest.advanceTimersByTime(201);
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
		f.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", text: "secret" }, { type: "text", text: " " }, { type: "text", text: "A" }, { type: "text", text: "B" }] } });
		jest.advanceTimersByTime(201);
		expect((await f.bridge.inbox.next()).text).toBe("A\n\nB");
		f.emit("message_end", { message: { role: "assistant" } });
		expect<unknown>(await f.bridge.inbox.next()).toEqual({ t: "live", text: "", done: true });
		update("cancel this timer"); f.bridge.send({ t: "watch", on: false }); await f.bridge.request({ t: "sync" });
		jest.advanceTimersByTime(201);
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
	});

	test("abort calls the session and replies with state", async () => {
		const f = fixture(); await f.start();
		expect((await f.bridge.request({ t: "abort" })).t).toBe("state");
		expect(f.state.aborts).toBe(1);
	});

	test("btw streams throttled side-turn text, final result, and partial errors", async () => {
		const f = fixture(); await f.start();
		f.ctx.runEphemeralTurn = async (options) => {
			f.state.ephemeralCalls.push(options);
			options.onTextDelta("A"); options.onTextDelta("B"); advance(151); options.onTextDelta("C");
			return { replyText: "final answer" };
		};
		expect(await f.bridge.request({ t: "btw", id: "side1", text: "question" })).toMatchObject({ ok: true });
		expect<unknown>(await f.bridge.inbox.next()).toEqual({ t: "btw", id: "side1", text: "A", done: false });
		expect<unknown>(await f.bridge.inbox.next()).toEqual({ t: "btw", id: "side1", text: "ABC", done: false });
		expect<unknown>(await f.bridge.inbox.next()).toEqual({ t: "btw", id: "side1", text: "final answer", done: true });
		expect(f.state.ephemeralCalls[0]).toMatchObject({ promptText: "question", tools: false });
		f.ctx.runEphemeralTurn = async (options) => { options.onTextDelta("partial"); throw new Error("provider failed"); };
		await f.bridge.request({ t: "btw", id: "side2", text: "oops" });
		expect<unknown>(await f.bridge.inbox.next((m) => m.done)).toEqual({ t: "btw", id: "side2", text: "partial", done: true, error: "provider failed" });
	});

	test("a side turn cannot stream its old session's answer after a session switch", async () => {
		const f = fixture(); await f.start();
		const result = Promise.withResolvers<{ replyText: string }>();
		f.ctx.runEphemeralTurn = (options) => { f.state.ephemeralCalls.push(options); return result.promise; };
		await f.bridge.request({ t: "btw", id: "old-side", text: "old question" });
		f.state.sessionId = "new-session"; f.emit("session_start");
		expect((await f.bridge.inbox.next()).sessionId).toBe("new-session");
		f.state.ephemeralCalls[0].onTextDelta("old session text");
		result.resolve({ replyText: "old session answer" });
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
	});

	test("complete caps results and apply preserves provider fields, refusing stale/unoffered items", async () => {
		const f = fixture(); await f.start();
		f.state.suggestions = { prefix: "/", items: Array.from({ length: 45 }, (_, i) => ({ value: `/cmd${i}`, label: `Command ${i}`, private: i })) };
		const result = await f.bridge.request({ t: "complete", text: "first line\n/" });
		expect(result.items).toHaveLength(40);
		expect(result.items[0]).toEqual({ value: "/cmd0", label: "Command 0", description: "" });
		expect(f.state.completionCalls[0].slice(0, 3)).toEqual([["first line", "/"], 1, 1]);
		expect(f.state.completionCalls[0][3]).toBeInstanceOf(AbortSignal);
		const apply = { t: "apply", text: "first line\n/", value: "/cmd0", label: "Command 0", prefix: "/" };
		expect(await f.bridge.request(apply)).not.toHaveProperty("text");
		expect(f.state.text).toBe("desktop draft");
		f.state.text = apply.text;
		expect(await f.bridge.request({ ...apply, value: "/forged" })).not.toHaveProperty("text");
		expect(await f.bridge.request(apply)).toMatchObject({ text: "applied\ncompletion" });
		expect(f.state.applyCalls[0][3]).toBe(f.state.suggestions.items[0]);
		expect((await f.bridge.inbox.next()).text).toBe("applied\ncompletion");
		f.provider.getSuggestions = async () => { throw new Error("cancelled"); };
		expect(await f.bridge.request({ t: "complete", text: "/" })).toMatchObject({ prefix: "", items: [] });
	});

	test("a slower old completion cannot replace the latest offered items", async () => {
		const f = fixture(); await f.start();
		const old = Promise.withResolvers<NonNullable<typeof f.state.suggestions>>();
		f.provider.getSuggestions = async (...args) => args[0]?.toString() === "/old" ? old.promise : { items: [{ value: "/new", label: "New", private: 2 }], prefix: "/" };
		f.bridge.send({ t: "complete", text: "/old", seq: 1000 });
		await f.bridge.request({ t: "sync" });
		expect((await f.bridge.request({ t: "complete", text: "/new" })).items[0]?.value).toBe("/new");
		old.resolve({ items: [{ value: "/old", label: "Old" }], prefix: "/" });
		await f.bridge.inbox.next((m) => m.seq === 1000);
		f.state.text = "/new";
		expect(await f.bridge.request({ t: "apply", text: "/new", value: "/new", label: "New", prefix: "/" })).toMatchObject({ text: "applied\ncompletion" });
		expect(f.state.applyCalls[0][3]).toMatchObject({ private: 2 });
	});

	test.each([
		["models", "registry", "getAvailable"],
		["tiers", "pi", "setServiceTier"],
		["jobs", "ctx", "getAsyncJobSnapshot"],
		["queue", "ctx", "hasPendingMessages"],
		["rewind", "session", "getLeafId"],
		["btw", "ctx", "runEphemeralTurn"],
		["complete", "ui", "addAutocompleteProvider"],
	] as const)("%s capability is false without %s.%s", async (cap, owner, method) => {
		const f = fixture();
		const targets = { registry: f.ctx.modelRegistry, pi: f.pi, ctx: f.ctx, session: f.ctx.sessionManager, ui: f.ctx.ui };
		Reflect.deleteProperty(targets[owner], method);
		expect((await f.start()).caps).toEqual({ ...capsWithoutShim, [cap]: false });
	});

	test("older omp without optional APIs gets explicit side-turn/tier failures and empty completion", async () => {
		const f = fixture();
		Reflect.deleteProperty(f.ctx, "runEphemeralTurn");
		Reflect.deleteProperty(f.ctx.ui, "addAutocompleteProvider");
		Reflect.deleteProperty(f.ctx.sessionManager, "getLeafId");
		Reflect.deleteProperty(f.pi, "setServiceTier");
		Reflect.deleteProperty(f.ctx.modelRegistry, "getAvailable");
		expect(await f.start()).toMatchObject({ leaf: "", tiers: [] });
		expect(await f.bridge.request({ t: "complete", text: "/" })).toMatchObject({ prefix: "", items: [] });
		expect(await f.bridge.request({ t: "models" })).toMatchObject({ models: [] });
		expect(await f.bridge.request({ t: "tier", tier: "priority" })).toMatchObject({ error: "this model has no such tier" });
		await f.bridge.request({ t: "btw", id: "unsupported", text: "question" });
		expect<unknown>(await f.bridge.inbox.next()).toEqual({ t: "btw", id: "unsupported", text: "", done: true, error: "this omp has no side turns" });
	});

	test("reconnects after server closes and disables watching on the new socket", async () => {
		const f = fixture(); await f.start();
		f.bridge.send({ t: "watch", on: true }); await f.bridge.request({ t: "sync" });
		// Exercise Bun's native close/reconnect ordering and production retry delay once.
		f.bridge.connections[0].close();
		expect((await f.bridge.inbox.next((m) => m.t === "state", 7000)).sessionId).toBe("session-123");
		expect(f.bridge.connections).toHaveLength(2);
		expect(f.bridge.connections[1].data.token).toBe("test-bridge-secret");
		jest.useFakeTimers();
		f.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "not watched" }] } });
		jest.advanceTimersByTime(201);
		await f.bridge.request({ t: "sync" });
		expect(f.bridge.inbox.messages).toEqual([]);
	}, 10000);

	test("rewind command trims entry id and disables summarization; empty args do not navigate", async () => {
		const f = fixture(); await f.start();
		const calls: unknown[][] = [];
		const ctx = { async navigateTree(...args: unknown[]) { calls.push(args); f.state.leaf = String(args[0]); return { cancelled: false }; } };
		await f.commands.get("tern-mobile-rewind")!.handler("  old-entry  ", ctx);
		expect(calls).toEqual([["old-entry", { summarize: false }]]);
		expect((await f.bridge.inbox.next()).leaf).toBe("old-entry");
		await f.commands.get("tern-mobile-rewind")!.handler("  ", ctx);
		await f.bridge.inbox.next(); expect(calls).toHaveLength(1);
	});
});
