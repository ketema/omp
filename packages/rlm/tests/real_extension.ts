/**
 * Shared fixture for specs that drive createRlmExtension()'s DEFAULT factory against a REAL Python kernel: real
 * RlmTransport, KernelManager, adapter and tool, with the unmodified bundled runner. Only the host is synthetic - the two
 * things the extension consumes from it (resolveOwnArtifactsDir, and the artifact copy a spec performs itself).
 *
 * Interpreter: `RLM_TEST_PYTHON` when set; otherwise the managed kernel venv via uv, as the other real-kernel specs do.
 */
import * as crypto from "node:crypto";
import { join } from "node:path";

import { createRlmExtension } from "../src/extension.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
export interface HostMessage {
	readonly customType?: string;
	readonly content?: string;
}
interface ToolResult {
	readonly content: Array<{ text: string }>;
	readonly isError?: boolean;
}

export interface RealSession {
	readonly root: string;
	/** Every message the extension sent to the host, in order. */
	readonly messages: HostMessage[];
	/** The text of every rlm-warning message. */
	readonly warnings: string[];
	/** Fires `type` to every registered handler with `event`; the session's owned directory is `dir` (default: the initial one). */
	emit(type: string, event?: object, dir?: string): Promise<void>;
	start(): Promise<void>;
	shutdown(): Promise<void>;
	call(code: string): Promise<ToolResult>;
	/** The tool's text output for `code`. */
	run(code: string): Promise<string>;
}

export async function openRealSession(root: string, initialDir: string): Promise<RealSession> {
	const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
	if (process.env.RLM_TEST_PYTHON) flags.RLM_KERNEL_PYTHON = process.env.RLM_TEST_PYTHON;
	const handlers = new Map<string, Handler[]>();
	const tools: Array<{ execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
	const messages: HostMessage[] = [];
	const api = {
		registerTool(tool: (typeof tools)[number]) {
			tools.push(tool);
		},
		registerFlag() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getFlag(name: string) {
			return flags[name];
		},
		sendMessage(payload: HostMessage) {
			messages.push(payload);
		},
	};
	const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };
	await createRlmExtension()(api as never);
	const emit = async (type: string, event: object = {}, dir: string = initialDir) => {
		const ctx = { cwd: root, sessionManager: { resolveOwnArtifactsDir: async () => dir } };
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	};
	const call = (code: string) => tools[0].execute(`c-${crypto.randomUUID()}`, { code }, undefined, undefined, toolCtx);
	return {
		root,
		messages,
		get warnings() {
			return messages
				.filter(message => message.customType === "rlm-warning")
				.map(message => String(message.content));
		},
		emit,
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		call,
		run: async code => (await call(code)).content.map(part => part.text).join("\n"),
	};
}
