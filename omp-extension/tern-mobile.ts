// tern-mobile bridge: mirrors this omp session's prompt draft, model and busy state to the
// tern-mobile server, and applies drafts and model picks typed on the phone.
// Loaded by omp from ~/.omp/agent/extensions (symlink); does nothing outside a Tern pane.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const POLL_MS = 100;
const RETRY_MS = 5000;
/** The bridge protocol this extension speaks; the server flags whichever side is older. 2: `build`. */
export const PROTOCOL = 2;
/**
 * This file's identity, read once when omp loads it, so a later `git pull` doesn't change what a
 * running session reports: the first 16 hex digits of its sha256, as the server computes for its
 * checkout's copy (lib/extension-check.ts `buildId`). omp imports extensions from their real path,
 * so `import.meta.path` is the repo file for a symlinked install. "" when the file can't be read.
 */
export const BUILD = (() => {
	try {
		return createHash("sha256").update(readFileSync(import.meta.path ?? fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);
	} catch {
		return "";
	}
})();

/** The part of omp's Model this bridge reads; the rest varies by provider. */
type Model = {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	reasoning?: boolean;
	contextWindow?: number;
	input?: string[];
	cost?: { input?: number; output?: number };
};
type TierFamily = "openai" | "anthropic" | "google";
/** What omp's pi-ai shim gives extensions; loaded lazily, absent in an omp without it. */
type Ai = {
	serviceTierFamily?(model: Model): TierFamily | undefined;
	getSupportedThinkingLevels?(model: Model): string[];
};
// omp's loader maps this literal specifier to its pi-ai shim (a computed one isn't rewritten);
// `pi-ai.d.ts` declares it for tsc, and `Ai` above names the parts used.
let ai: Ai = {};
void import("@oh-my-pi/pi-ai").then((m: Ai) => (ai = m)).catch(() => {});

/** The provider family whose service-tier knob governs `model`, if any. */
function tierFamily(model: Model): TierFamily | undefined {
	try {
		if (ai.serviceTierFamily) return ai.serviceTierFamily(model);
	} catch {}
	if (model.provider === "openai" || model.provider === "openai-codex") return "openai";
	if (model.api === "anthropic-messages") return "anthropic";
	if (model.provider === "google" || model.provider === "google-vertex") return "google";
	return undefined;
}
/** Tiers each family realizes; "" omits the parameter (the provider's standard serving). */
const TIERS: Record<TierFamily, string[]> = { openai: ["", "flex", "priority"], anthropic: ["", "priority"], google: ["", "flex", "priority"] };

/** The thinking levels `model` accepts: "off" then its efforts; none for non-reasoning models. */
function thinkingLevels(model: Model): string[] {
	try {
		if (ai.getSupportedThinkingLevels) return ai.getSupportedThinkingLevels(model);
	} catch {}
	return model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"];
}
type Ctx = {
	hasUI?: boolean;
	/** `sub` for any spawned session (task, eval agents, advisors, /tan clones). */
	agent?: { kind: "main" | "sub" };
	ui: {
		getEditorText(): string;
		setEditorText(text: string): void;
		/** Wraps the editor's autocomplete; the factory receives the built-in provider. */
		addAutocompleteProvider?(factory: (current: Completer) => Completer): void;
	};
	model: Model | undefined;
	isIdle(): boolean;
	abort(): void;
	/** Steering or follow-up messages wait for the running turn. */
	hasPendingMessages?(): boolean;
	runEphemeralTurn?(options: {
		promptText: string;
		tools?: false;
		onTextDelta?: (delta: string) => void;
	}): Promise<{ replyText: string }>;
	getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined;
	/** Background jobs: `task` subagents, eval agents, backgrounded bash. */
	getAsyncJobSnapshot?(): { running: { id: string; type: string; label: string; agentId?: string; startTime: number }[] } | null;
	modelRegistry: { find(provider: string, id: string): Model | undefined; getAvailable?(kind?: string): Model[] };
	sessionManager: { getSessionId(): string; getLeafId?(): string | null };
	setInterval(callback: () => void, ms: number): unknown;
};
type ToolEvent = { toolCallId: string; toolName: string };
type CompletionItem = { value: string; label: string; description?: string };
/** pi-tui's AutocompleteProvider, the part this bridge calls. */
type Completer = {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: CompletionItem[]; prefix: string } | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: CompletionItem,
		prefix: string,
	): { lines: string[] };
};
/** The part of an omp message this bridge reads. */
type Message = { role?: string; content?: unknown };
type Pi = {
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: Ctx) => unknown): void;
	on(
		event: "tool_execution_start" | "tool_execution_end" | "tool_approval_requested" | "tool_approval_resolved",
		handler: (event: ToolEvent) => unknown,
	): void;
	on(event: "message_update" | "message_end", handler: (event: { message: Message }) => unknown): void;
	on(event: "input", handler: (event: { text: string; images?: unknown[] }) => unknown): void;
	setModel(model: Model): Promise<boolean>;
	/** Without `deliverAs`: starts a turn when idle, steers while the agent runs. */
	sendUserMessage(
		content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
	getThinkingLevel(): string | undefined;
	setThinkingLevel(level: string): void;
	getServiceTiers?(): Partial<Record<TierFamily, string>>;
	setServiceTier?(family: TierFamily, tier: string | undefined): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: { navigateTree(id: string, o?: { summarize?: boolean }): Promise<{ cancelled: boolean }> }) => Promise<void> },
	): void;
};
type ServerMessage =
	| { t: "set"; text: string; seq: number }
	/** `spec`: provider/id, optionally `:thinking`. */
	| { t: "model"; spec: string; seq: number }
	| { t: "models"; seq: number }
	| { t: "thinking"; level: string; seq: number }
	/** "" clears the session's override for the current model's family. */
	| { t: "tier"; tier: string; seq: number }
	| { t: "complete"; text: string; seq: number }
	| { t: "apply"; text: string; value: string; label: string; prefix: string; seq: number }
	| { t: "abort"; seq: number }
	| { t: "btw"; id: string; text: string; seq: number }
	/** `followUp`: hold it until the running turn ends (omp's Ctrl+Q), instead of steering. */
	| { t: "send"; text: string; images: { data: string; mimeType: string }[]; followUp?: boolean; seq: number }
	| { t: "watch"; on: boolean }
	/** Report the current state now (the server lost track of this pane). */
	| { t: "sync"; seq?: undefined };
const MAX_COMPLETIONS = 40;
/** Side-turn text goes out at most this often while it streams. */
const BTW_FLUSH_MS = 150;
/** The assistant message being written goes out at most this often, only while a phone watches. */
const LIVE_FLUSH_MS = 200;

/** A message's text parts, as the transcript will show them. */
function textOf(message: Message): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string" && p.text.trim() !== "")
		.map((p) => p.text)
		.join("\n\n");
}

export default function ternMobile(pi: Pi): void {
	// Read when omp loads the extension (tests load it once and call this per scenario).
	const PANE = process.env.TERN_PANE;
	if (!PANE) return;
	const BRIDGE_URL = process.env.TERN_MOBILE_BRIDGE ?? "ws://127.0.0.1:4380/bridge";
	// The server's config dir (`$TERN_MOBILE_CONFIG`, else ~/.config/tern-mobile on every OS); the
	// file override lets tests and throwaway servers use their own token.
	const TOKEN_FILE =
		process.env.TERN_MOBILE_TOKEN_FILE ?? join(process.env.TERN_MOBILE_CONFIG || join(homedir(), ".config", "tern-mobile"), "bridge-token");
	let ctx: Ctx | null = null;
	let ws: WebSocket | null = null;
	let sent = ""; // last snapshot sent, as JSON
	let shutdown = false;
	// Tool calls waiting on the user: an open ask dialog or a pending tool approval.
	const waiting = new Set<string>();
	// Context usage is an estimate omp recomputes; sample it every 2 s, not on every 100 ms poll.
	const CONTEXT_MS = 2000;
	let context = { at: 0, value: null as { tokens: number; window: number; percent: number } | null };
	// Prompts submitted while the agent runs wait in omp's queue, which extensions can't read;
	// their text is noted here and dropped once omp reports the queue empty (delivered or
	// pulled back into the editor). A fresh entry gets a moment for omp to queue it.
	let queued: { text: string; at: number; followUp: boolean }[] = [];
	const QUEUE_GRACE_MS = 1000;
	const noteQueued = (text: string, followUp = false) => {
		const last = queued[queued.length - 1];
		if (text && !(last?.text === text && Date.now() - last.at < QUEUE_GRACE_MS)) queued.push({ text, at: Date.now(), followUp });
	};

	// Background jobs, sampled once a second: subagents keep a session working after its own turn
	// yields to wait for them.
	const JOBS_MS = 1000;
	type Job = { id: string; type: string; label: string; agent: string; since: number };
	let jobs = { at: 0, value: [] as Job[] };
	const runningJobs = (c: Ctx): Job[] => {
		if (Date.now() - jobs.at < JOBS_MS) return jobs.value;
		let running: NonNullable<ReturnType<NonNullable<Ctx["getAsyncJobSnapshot"]>>>["running"] = [];
		try {
			running = c.getAsyncJobSnapshot?.()?.running ?? [];
		} catch {}
		const value = running.map((j) => ({ id: j.id, type: j.type, label: j.label.slice(0, 160), agent: j.agentId ?? "", since: j.startTime }));
		jobs = { at: Date.now(), value };
		return value;
	};
	// The current model's thinking levels, cached per model (the snapshot runs every 100 ms) and
	// redone once the pi-ai shim has loaded.
	let levelsFor = { key: "", value: [] as string[] };
	const modelCaps = (model: Model | undefined) => {
		if (!model) return { levels: [], tiers: [], tier: "" };
		const key = `${model.provider}/${model.id}${ai.getSupportedThinkingLevels ? "" : "?"}`;
		if (levelsFor.key !== key) levelsFor = { key, value: thinkingLevels(model) };
		const family = pi.setServiceTier ? tierFamily(model) : undefined;
		return {
			levels: levelsFor.value,
			tiers: family ? TIERS[family] : [],
			tier: (family && pi.getServiceTiers?.()[family]) || "",
		};
	};
	const snapshot = () => {
		if (!ctx) return null;
		if (Date.now() - context.at > CONTEXT_MS) {
			const u = ctx.getContextUsage();
			context = {
				at: Date.now(),
				value: u && u.contextWindow > 0 ? { tokens: u.tokens, window: u.contextWindow, percent: Math.round(u.percent) } : null,
			};
		}
		if (queued.length && ctx.hasPendingMessages?.() !== true) queued = queued.filter((q) => Date.now() - q.at < QUEUE_GRACE_MS);
		return {
			t: "state",
			pane: PANE,
			sessionId: ctx.sessionManager.getSessionId(),
			text: ctx.ui.getEditorText(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
			thinking: pi.getThinkingLevel() ?? "",
			// What the current model offers the phone's picker: its thinking levels and serving tiers.
			...modelCaps(ctx.model),
			// Running subagents count as work; a backgrounded shell job (a watcher, a server) doesn't.
			status: waiting.size
				? "blocked"
				: !ctx.isIdle() || runningJobs(ctx).some((j) => j.type === "task" || j.type === "eval")
					? "working"
					: "idle",
			jobs: runningJobs(ctx),
			context: context.value,
			queued: queued.map((q) => ({ text: q.text, followUp: q.followUp })),
			// `-`: no entry (rewound past the first prompt).
			leaf: ctx.sessionManager.getLeafId ? (ctx.sessionManager.getLeafId() ?? "-") : "",
			protocol: PROTOCOL,
			build: BUILD,
			// What this omp offers beyond the core API; the server and phone turn the rest off.
			caps: {
				models: typeof ctx.modelRegistry.getAvailable === "function",
				tiers: typeof pi.setServiceTier === "function",
				jobs: typeof ctx.getAsyncJobSnapshot === "function",
				queue: typeof ctx.hasPendingMessages === "function",
				rewind: typeof ctx.sessionManager.getLeafId === "function",
				btw: typeof ctx.runEphemeralTurn === "function",
				complete: completer !== null,
				levels: typeof ai.getSupportedThinkingLevels === "function",
			},
		};
	};

	const flush = (force: boolean, seq?: number) => {
		const snap = snapshot();
		if (!snap || ws?.readyState !== WebSocket.OPEN) return;
		const body = JSON.stringify(snap);
		if (!force && body === sent) return;
		sent = body;
		ws.send(seq === undefined ? body : JSON.stringify({ ...snap, seq }));
	};

	// The editor's own provider (slash commands, skills, @files), captured through a pass-through factory.
	let completer: Completer | null = null;
	let offered: CompletionItem[] = [];
	/** The text as editor lines with the cursor at its end, as the provider takes it. */
	const at = (text: string) => {
		const lines = text.split("\n");
		return { lines, line: lines.length - 1, col: lines[lines.length - 1].length };
	};
	const reply = (seq: number, data: object) => {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "reply", seq, ...data }));
	};

	// Live text: the server says when a phone watches this pane; only then does the message omp
	// is writing go out, sampled at most every LIVE_FLUSH_MS from the latest update.
	let watched = false;
	const live = { message: null as Message | null, timer: undefined as ReturnType<typeof setTimeout> | undefined, sent: "" };
	const sendLive = (text: string, done: boolean) => {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "live", text, done }));
	};
	pi.on("message_update", (e) => {
		if (!watched || e.message.role !== "assistant") return;
		live.message = e.message;
		live.timer ??= setTimeout(() => {
			live.timer = undefined;
			const text = live.message ? textOf(live.message) : "";
			if (!watched || text === live.sent) return;
			live.sent = text;
			sendLive(text, false);
		}, LIVE_FLUSH_MS);
	});
	pi.on("message_end", (e) => {
		if (e.message.role !== "assistant") return;
		clearTimeout(live.timer);
		live.timer = undefined;
		live.message = null;
		if (live.sent) sendLive("", true);
		live.sent = "";
	});

	/** A /btw-style side question: answered from the session's context, never added to its history. */
	const btw = async (id: string, question: string) => {
		const send = (data: object) => {
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "btw", id, ...data }));
		};
		if (!ctx?.runEphemeralTurn) return send({ text: "", done: true, error: "this omp has no side turns" });
		let text = "";
		let last = 0;
		try {
			const r = await ctx.runEphemeralTurn({
				promptText: question,
				tools: false,
				onTextDelta: (delta) => {
					text += delta;
					if (Date.now() - last < BTW_FLUSH_MS) return;
					last = Date.now();
					send({ text, done: false });
				},
			});
			send({ text: r.replyText || text, done: true });
		} catch (err) {
			send({ text, done: true, error: String(err instanceof Error ? err.message : err) });
		}
	};

	const apply = async (msg: ServerMessage) => {
		if (msg.t === "watch") {
			watched = msg.on;
			if (!watched) {
				clearTimeout(live.timer);
				live.timer = undefined;
			}
			return;
		}
		if (!ctx) return;
		if (msg.t === "send") {
			// A phone prompt sent directly: images (the editor can't take pasted ones from here) or a
			// follow-up. The draft it replaces is cleared.
			ctx.ui.setEditorText("");
			const followUp = msg.followUp === true && !ctx.isIdle();
			if (!ctx.isIdle()) noteQueued(msg.text || "(image)", followUp);
			pi.sendUserMessage(
				[
					...(msg.text ? [{ type: "text" as const, text: msg.text }] : []),
					...msg.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
				],
				followUp ? { deliverAs: "followUp" } : undefined,
			);
			return flush(true, msg.seq);
		}
		if (msg.t === "abort") {
			ctx.abort();
			return flush(true, msg.seq);
		}
		if (msg.t === "btw") {
			reply(msg.seq, { ok: true });
			return void btw(msg.id, msg.text);
		}
		if (msg.t === "complete") {
			const { lines, line, col } = at(msg.text);
			const r = completer ? await completer.getSuggestions(lines, line, col, AbortSignal.timeout(1500)).catch(() => null) : null;
			offered = r?.items.slice(0, MAX_COMPLETIONS) ?? [];
			const items = offered.map((i) => ({ value: i.value, label: i.label, description: i.description ?? "" }));
			return reply(msg.seq, { prefix: r?.prefix ?? "", items });
		}
		if (msg.t === "apply") {
			// The offered item itself: providers keep extra fields on it.
			const item = offered.find((i) => i.value === msg.value && i.label === msg.label);
			// Refuse when the desktop editor moved on since the phone asked: never overwrite newer text.
			if (!item || !completer || ctx.ui.getEditorText() !== msg.text) return reply(msg.seq, {});
			const { lines, line, col } = at(msg.text);
			const text = completer.applyCompletion(lines, line, col, item, msg.prefix).lines.join("\n");
			ctx.ui.setEditorText(text);
			reply(msg.seq, { text });
			return flush(true);
		}
		if (msg.t === "set") ctx.ui.setEditorText(msg.text);
		if (msg.t === "model") {
			// Model ids may hold `/` and `:` themselves (openrouter's `vendor/name:free`).
			const m = /^([^/]+)\/(.+?)(?::(off|minimal|low|medium|high|xhigh|max))?$/.exec(msg.spec);
			const model = m ? ctx.modelRegistry.find(m[1], m[2]) : undefined;
			if (!model) return reply(msg.seq, { error: "unknown model" });
			if (!(await pi.setModel(model))) return reply(msg.seq, { error: "no credentials for this model" });
			if (m?.[3]) pi.setThinkingLevel(m[3]);
		}
		if (msg.t === "models") {
			// Every model omp has credentials for, chat kind only: what its own picker lists.
			const models = (ctx.modelRegistry.getAvailable?.("chat") ?? []).map((x) => ({
				p: x.provider,
				id: x.id,
				name: x.name ?? x.id,
				r: x.reasoning === true,
				ctx: x.contextWindow ?? 0,
				in: x.cost?.input ?? 0,
				out: x.cost?.output ?? 0,
				img: x.input?.includes("image") === true,
			}));
			return reply(msg.seq, { models });
		}
		if (msg.t === "thinking" && thinkingLevels(ctx.model ?? { provider: "", id: "" }).includes(msg.level)) pi.setThinkingLevel(msg.level);
		if (msg.t === "tier") {
			const family = ctx.model && tierFamily(ctx.model);
			if (!family || !pi.setServiceTier || !TIERS[family].includes(msg.tier)) return reply(msg.seq, { error: "this model has no such tier" });
			pi.setServiceTier(family, msg.tier || undefined);
		}
		flush(true, msg.seq);
	};

	const connect = () => {
		if (shutdown || ws) return;
		let token: string;
		try {
			token = readFileSync(TOKEN_FILE, "utf8").trim();
		} catch {
			setTimeout(connect, RETRY_MS).unref?.();
			return;
		}
		// Bun's WebSocket takes headers; the token keeps other local users off the bridge.
		const socket = new WebSocket(BRIDGE_URL, { headers: { "x-tern-mobile-bridge": token } } as unknown as string[]);
		ws = socket;
		socket.onopen = () => flush(true);
		socket.onmessage = (ev) => {
			try {
				void apply(JSON.parse(String(ev.data)) as ServerMessage);
			} catch {}
		};
		socket.onclose = () => {
			ws = null;
			watched = false;
			if (!shutdown) setTimeout(connect, RETRY_MS).unref?.();
		};
		socket.onerror = () => socket.close();
	};

	pi.on("session_start", (_event, c) => {
		// Subagents run in this process under the same pane; only the session on screen is bridged.
		if (c.hasUI === false || c.agent?.kind === "sub") return;
		const first = ctx === null;
		ctx = c;
		if (!first) return flush(true);
		c.setInterval(() => flush(false), POLL_MS);
		c.ui.addAutocompleteProvider?.((current) => {
			completer = current;
			return current;
		});
		connect();
	});
	// The phone's Rewind on a prompt: the server submits this command (only command handlers may
	// move the leaf). omp rewinds past a user prompt and puts its text back in the editor.
	pi.registerCommand("tern-mobile-rewind", {
		description: "Rewind to before a prompt (used by tern-mobile)",
		handler: async (args, c) => {
			const id = args.trim();
			if (id) await c.navigateTree(id, { summarize: false });
			flush(true);
		},
	});
	pi.on("input", (e) => {
		// Sent while the agent runs: a steer omp queues. Slash commands run instead of queueing.
		const text = e.text.trim();
		if (ctx && !ctx.isIdle() && !text.startsWith("/")) noteQueued(text || "(image)");
	});
	pi.on("tool_execution_start", (e) => {
		if (e.toolName === "ask") waiting.add(e.toolCallId);
	});
	pi.on("tool_approval_requested", (e) => waiting.add(e.toolCallId));
	pi.on("tool_execution_end", (e) => waiting.delete(e.toolCallId));
	pi.on("tool_approval_resolved", (e) => waiting.delete(e.toolCallId));
	pi.on("session_shutdown", () => {
		shutdown = true;
		ws?.close();
	});
}
