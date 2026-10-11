import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

export type CatalogModel = { p: string; id: string; name: string; r: boolean; ctx: number; in: number; out: number; img: boolean };
export type Completion = { value: string; label: string; description?: string; [key: string]: unknown };
export type State = {
	t: string; seq: number; sessionId: string; text: string; model: string; thinking: string;
	levels: string[]; jobs: unknown[]; queued: unknown[]; leaf: string; status: string; tier: string;
	context: { tokens: number; window: number; percent: number }; models: CatalogModel[];
	items: Completion[]; done: boolean;
	protocol: number;
	caps: Record<"models" | "tiers" | "jobs" | "queue" | "rewind" | "btw" | "complete" | "levels", boolean>;
};
export type RpcFrame = {
	type: string; id: string; success: boolean; method: string;
	data: { model: { provider: string; id: string }; thinkingLevel: string; levels: string[]; commands: { name: string }[] };
};
export class Inbox<T = State> {
	messages: T[] = [];
	private arrivals = new EventTarget();
	push(message: T) { this.messages.push(message); this.arrivals.dispatchEvent(new Event("message")); }
	next(match: (message: T) => boolean = () => true, timeout = 3000): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		// A deadline, not a guessed wait: messages wake the waiter immediately.
		const timer = setTimeout(() => {
			this.arrivals.removeEventListener("message", receive);
			reject(new Error(`Timed out waiting for frame; received ${JSON.stringify(this.messages).slice(0, 1000)}`));
		}, timeout);
		const receive = () => {
			const index = this.messages.findIndex(match);
			if (index === -1) return;
			clearTimeout(timer);
			this.arrivals.removeEventListener("message", receive);
			resolve(this.messages.splice(index, 1)[0]);
		};
		this.arrivals.addEventListener("message", receive);
		receive();
		return promise;
	}
}
export function bridgeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tern-awui-extension-"));
	const tokenFile = join(dir, "token");
	writeFileSync(tokenFile, "  test-bridge-secret\n", { mode: 0o600 });
	const inbox = new Inbox();
	const connections: ServerWebSocket<{ token: string | null }>[] = [];
	let closed = 0;
	const server = Bun.serve<{ token: string | null }>({
		hostname: "127.0.0.1", port: 0,
		fetch(req, server) {
			if (new URL(req.url).pathname === "/bridge" && server.upgrade(req, { data: { token: req.headers.get("x-tern-mobile-bridge") } })) return;
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) { connections.push(ws); },
			message(_ws, data) { inbox.push(JSON.parse(String(data))); },
			close() { closed++; },
		},
	});
	let seq = 0;
	return {
		dir, tokenFile, inbox, connections,
		get closed() { return closed; },
		url: `ws://127.0.0.1:${server.port}/bridge`,
		send(message: Record<string, unknown>) { connections.at(-1)!.send(JSON.stringify(message)); },
		async request(message: Record<string, unknown>, timeout = 3000) {
			const id = ++seq;
			connections.at(-1)!.send(JSON.stringify({ ...message, seq: id }));
			return inbox.next((frame) => frame.seq === id, timeout);
		},
		close() { server.stop(true); rmSync(dir, { recursive: true, force: true }); },
	};
}
