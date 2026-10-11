// Run explicitly: TERN_AWUI_LIVE=1 bun test omp-extension/tern-mobile.live.test.ts
// Requires omp on PATH and a configured model catalog. No model prompts are sent:
// rpc-ui keeps hasUI=true; --no-session and a temp cwd keep the session disposable.
// RPC has no editor/autocomplete provider, so completion's empty fallback is asserted.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bridgeFixture, Inbox, type RpcFrame } from "./bridge-fixture";
import { PROTOCOL } from "./tern-mobile";
import { buildId } from "../lib/extension-check";

const enabled = process.env.TERN_AWUI_LIVE === "1" && Bun.which("omp") !== null;
test.skipIf(!enabled)("real omp: bridge state, pi-ai capabilities, model catalog/switch, thinking and rewind", async () => {
	const bridge = bridgeFixture();
	const rpc = new Inbox<RpcFrame>();
	let stderr = "";
	const child = Bun.spawn([
		"omp", "--mode", "rpc-ui", "--no-extensions", "-e", resolve(import.meta.dir, "tern-mobile.ts"),
		"--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-title",
	], {
		cwd: bridge.dir, stdin: "pipe", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, TERN_PANE: "tern-awui-contract-test", TERN_MOBILE_BRIDGE: bridge.url, TERN_MOBILE_TOKEN_FILE: bridge.tokenFile },
	});
	const stdoutTask = (async () => {
		let pending = "";
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) {
			pending += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, end); pending = pending.slice(end + 1);
				if (line.trim()) rpc.push(JSON.parse(line));
			}
		}
	})();
	const stderrTask = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
	})();
	let id = 0;
	const request = async (command: Record<string, unknown>) => {
		const requestId = `test-${++id}`;
		child.stdin.write(JSON.stringify({ ...command, id: requestId }) + "\n");
		await child.stdin.flush();
		const response = await rpc.next((frame) => frame.type === "response" && frame.id === requestId, 15000);
		expect(response.success).toBe(true);
		return response.data;
	};
	try {
		await rpc.next((frame) => frame.type === "ready", 20000);
		const initial = await bridge.inbox.next((frame) => frame.t === "state", 20000);
		expect(initial.sessionId).toMatch(/^[a-f0-9-]{36}$/i);
		expect(initial.model).toMatch(/^[^/]+\/.+/);
		expect(initial.status).toBe("idle");
		expect(initial.protocol).toBe(PROTOCOL);
		// omp's loader gives the extension its real path: the build is this file's.
		expect(initial.build).toBe(buildId(readFileSync(resolve(import.meta.dir, "tern-mobile.ts"))));
		expect(initial.caps).toEqual({ models: true, tiers: true, jobs: true, queue: true, rewind: true, btw: true, complete: false, levels: true });
		expect(bridge.connections[0].data.token).toBe("test-bridge-secret");
		const realState = await request({ type: "get_state" });
		expect(initial.model).toBe(`${realState.model.provider}/${realState.model.id}`);
		expect(initial.thinking).toBe(realState.thinkingLevel);
		// Comparing against omp's own API catches silently taking the extension's fallback.
		const levels = await request({ type: "get_available_thinking_levels" });
		expect(initial.levels).toEqual(levels.levels);
		expect(initial.levels).toContain("high");
		const catalog = await bridge.request({ t: "models" });
		expect(catalog.models.length).toBeGreaterThan(0);
		const currentProvider = initial.model.split("/")[0];
		const alternative = catalog.models.find((model: { p: string; id: string; r: boolean }) => model.p === currentProvider && model.r && `${model.p}/${model.id}` !== initial.model)
			?? catalog.models.find((model: { p: string; id: string; r: boolean }) => model.r && `${model.p}/${model.id}` !== initial.model);
		if (!alternative) throw new Error("omp catalog has no alternative reasoning model");
		const model = `${alternative.p}/${alternative.id}`;
		const changed = await bridge.request({ t: "model", spec: model }, 15000);
		expect(changed).toMatchObject({ t: "state", sessionId: initial.sessionId, model });
		const changedState = await request({ type: "get_state" });
		expect(`${changedState.model.provider}/${changedState.model.id}`).toBe(model);
		const effort = changed.levels.find((level: string) => level !== changed.thinking && level !== "off");
		if (!effort) throw new Error("selected model exposes no alternative thinking level");
		expect(await bridge.request({ t: "thinking", level: effort })).toMatchObject({ t: "state", thinking: effort });
		expect((await request({ type: "get_state" })).thinkingLevel).toBe(effort);
		// rpc-ui exposes setEditorText through a host frame, but getEditorText returns "".
		await bridge.request({ t: "set", text: "/" });
		expect(await rpc.next((frame) => frame.type === "extension_ui_request" && frame.method === "set_editor_text")).toMatchObject({ text: "/" });
		expect(await bridge.request({ t: "complete", text: "/" })).toMatchObject({ prefix: "", items: [] });
		const commands = await request({ type: "get_available_commands" });
		expect(commands.commands.some((command: { name: string }) => command.name === "tern-mobile-rewind")).toBe(true);
		// Empty args exercise command dispatch without touching the tree or invoking a model.
		await request({ type: "prompt", message: "/tern-mobile-rewind" });
		expect(await rpc.next((frame) => frame.type === "prompt_result")).toMatchObject({ agentInvoked: false, status: "completed" });
		expect(rpc.messages.filter((frame) => frame.type === "extension_error")).toEqual([]);
		child.stdin.end();
		expect(await child.exited).toBe(0);
		await Promise.all([stdoutTask, stderrTask]);
		expect(bridge.closed).toBe(1);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nomp stderr: ${stderr.slice(-3000)}`);
	} finally {
		child.kill();
		await child.exited;
		await Promise.allSettled([stdoutTask, stderrTask]);
		bridge.close();
	}
}, 60000);
