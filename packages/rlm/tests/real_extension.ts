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
	readonly display?: boolean;
	/** How the extension asked the host to deliver it (`sendMessage` options), when it said. */
	readonly deliverAs?: string;
}
interface ToolResult {
	readonly content: Array<{ text: string }>;
	readonly isError?: boolean;
}
/** One artifact the extension saved through `sessionManager.saveArtifact(content, toolType)`; the id is what `artifact://<id>` reads. */
export interface SavedArtifact {
	readonly id: string;
	readonly content: string;
	readonly toolType: string;
}

export interface RealSession {
	readonly root: string;
	/** Every message the extension sent to the host, in order. */
	readonly messages: HostMessage[];
	/** Every artifact saved through the session manager, in order. */
	readonly artifacts: SavedArtifact[];
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

export async function openRealSession(
	root: string,
	initialDir: string,
	options?: Parameters<typeof createRlmExtension>[0],
): Promise<RealSession> {
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
		sendMessage(payload: HostMessage, options?: { deliverAs?: string }) {
			messages.push({ ...payload, deliverAs: options?.deliverAs });
		},
	};
	const artifacts: SavedArtifact[] = [];
	// Mirrors ReadonlySessionManager.saveArtifact: resolves the id of the saved copy.
	const sessionManager = {
		saveArtifact: async (content: string, toolType: string): Promise<string> => {
			const id = String(artifacts.length);
			artifacts.push({ id, content, toolType });
			return id;
		},
	};
	const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined }, sessionManager };
	await createRlmExtension(options)(api as never);
	const emit = async (type: string, event: object = {}, dir: string = initialDir) => {
		const ctx = { cwd: root, sessionManager: { resolveOwnArtifactsDir: async () => dir } };
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	};
	const call = (code: string) => tools[0].execute(`c-${crypto.randomUUID()}`, { code }, undefined, undefined, toolCtx);
	return {
		root,
		messages,
		artifacts,
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
