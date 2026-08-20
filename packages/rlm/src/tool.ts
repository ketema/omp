/**
 * RLM model-facing tool — the ipython tool definition.
 *
 * Implements the contract at requirements/contracts/rlm-tool.contract.ts.
 * All constants are redeclared independently (no import from the contract);
 * alignment tests import both sides and assert equality.
 */

import { type } from "@oh-my-pi/omptype";
import type { KernelBusyAfterInterruptError, KernelExecutionResult } from "./kernel";

// =============================================================================
// Constants (redeclared; aligned with contract TOOL_*)
// =============================================================================

export const TOOL_NAME = "ipython";
export const TOOL_PROMPT_SNIPPET =
	"ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration";
export const TOOL_EXECUTION_MODE = "sequential";
export const TOOL_RESTART_NOTICE_OPEN = "[ipython_kernel_reset]";
export const TOOL_RESTART_NOTICE_CLOSE = "[/ipython_kernel_reset]";
export const TOOL_WORKING_MESSAGES: readonly string[] = [
	"Starting IPython kernel...",
	"Restoring IPython state...",
	"Preparing IPython runtime...",
] as const;
export const TOOL_BUSY_CHOICES: readonly [string, string] = [
	"Wait and preserve state",
	"Kill kernel and restart",
] as const;

// =============================================================================
// Exceptions (redeclared; aligned with contract)
// =============================================================================

export class RlmToolContractError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RlmToolContractError";
	}
}

/** F-237: runtime missing from the kernel environment. */
export class RlmRuntimeMissingError extends RlmToolContractError {
	constructor(kernelGuidance: string) {
		super(`rlm-runtime is not installed in this IPython kernel; rebuild via ${kernelGuidance}`);
		this.name = "RlmRuntimeMissingError";
	}
}

// =============================================================================
// Structural types
// =============================================================================

/** The kernel port the tool speaks to. */
export interface RlmToolKernelPort {
	ensureStarted(onProgress?: (phase: "starting" | "restoring" | "preparing") => void): Promise<void>;
	execute(code: string): Promise<RlmToolKernelResult>;
	kill(): Promise<void>;
	dispose(): Promise<void>;
	restoredNames(): readonly string[];
}

/** Result from a kernel execution, as seen by the tool. */
export interface RlmToolKernelResult {
	readonly status: "ok" | "error" | "aborted";
	readonly stdout: string;
	readonly stderr: string;
	readonly result: string;
	readonly traceback: string | undefined;
	readonly errorEname: string | undefined;
	readonly durationMs: number;
	readonly kernelRestarted: boolean | undefined;
}

/** Details attached to every tool result. */
export interface RlmToolResultDetails {
	readonly durationMs: number;
	readonly status: "ok" | "error" | "aborted";
	readonly errorEname: string | undefined;
	readonly kernelRestarted: boolean | undefined;
}

/** Structural ctx for the execute function. */
export interface RlmToolExecuteContext {
	readonly hasUI: boolean;
	setWorkingMessage(message?: string): void;
	ui: {
		select(title: string, options: ReadonlyArray<{ label: string }>): Promise<string | undefined>;
	};
}

// =============================================================================
// Parameter schema — omptype (repo convention, autoresearch precedent);
// toJsonSchema() yields exactly { code: string } (F-020, TOOL-V1).
// =============================================================================

const ipythonSchema = type({
	code: type("string").describe(
		"Python scratchpad code or `%%bash` shell cells to execute in the persistent IPython kernel.",
	),
});

// =============================================================================
// Tool description (POST-TOOL-5: F-040..F-062 prompt contract)
// =============================================================================

const TOOL_DESCRIPTION = [
	"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel.",
	"This is a long-lived notebook: the persistent kernel maintains a control environment for reasoning,",
	"context management, state, and tool orchestration. Variables, imports, and loaded data persist",
	"across calls and survive compaction — state the Model must keep is stored in named variables,",
	"helper functions, classes, imports, notes, parsed outputs, and helper data structures,",
	"and is revived on a best-effort basis when a session is resumed.",
	"",
	"Rules:",
	"- `%%bash` must be the first cell line; avoid `!cmd` escapes.",
	"- Do not install packages into the kernel for a project; use project commands or `uv run`.",
	"- Always assign read/search results to named variables.",
	"- `%%bash` state (cd/export/source/vars) does NOT carry across cells; use `%cd`, `os.environ[...]`, or `%env`.",
	"",
	"Harness ledger API: use the harness to create/update/delete memory, skill, subagent, and prompt entries.",
	"The harness is the persisted prompt/memory/skill/subagent layer; the kernel is the runtime/call interface.",
	"",
	"Recursion: `await rlm('sub-task')` returns an admission handle (rlm_child_id, name, session_dir, model)",
	"and never waits for the child to finish. A child's reply is never the rlm() return value.",
	"Use `await rlm.list_subagents()` to recover handles after restart/compaction.",
	"Delegation: spawn independent children in separate calls and end the turn for parallel work;",
	"use inline execution for single lookups.",
].join("\n");

// =============================================================================
// Restart notice text (F-029)
// =============================================================================

const RESTART_NOTICE_BODY =
	"The IPython kernel was restarted after a previous interrupted cell kept running. " +
	"Variables, imports, async tasks, and open resources from before the restart are no longer available; " +
	"recreate them before using them.";

// =============================================================================
// Kernel guidance for runtime-missing error (ERRORS-TOOL-1)
// =============================================================================

function buildKernelGuidance(): string {
	return (
		"set RLM_KERNEL_PYTHON to a kernel environment with rlm-runtime installed, " +
		"or rebuild the managed venv via the bootstrap"
	);
}

// =============================================================================
// Text assembly
// =============================================================================

function assembleText(
	stdout: string,
	stderr: string,
	result: string,
	traceback: string | undefined,
	kernelRestarted: boolean,
): string {
	const parts: string[] = [];
	if (stdout) parts.push(stdout);
	if (stderr) parts.push(stderr);
	if (result) parts.push(result);
	if (traceback) parts.push(traceback);
	let body = parts.join("\n");

	if (kernelRestarted) {
		const notice = `${TOOL_RESTART_NOTICE_OPEN}\n${RESTART_NOTICE_BODY}\n${TOOL_RESTART_NOTICE_CLOSE}`;
		body = body ? `${notice}\n\n${body}` : notice;
	}

	return body;
}

// =============================================================================
// Tool definition factory
// =============================================================================

export interface RlmToolDefinitionOptions {
	readonly kernel: RlmToolKernelPort;
	readonly onRevival?: (names: readonly string[]) => void;
}

/**
 * SEQ-TOOL-1: creates the model-facing tool definition wired to the kernel.
 * Returns a descriptor with EXACTLY these keys: name, label, description,
 * parameters, executionMode, execute, onSession (FORBIDDEN-TOOL-1).
 */
export function createRlmToolDefinition(options: RlmToolDefinitionOptions): {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	executionMode: "sequential";
	execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate:
			| ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void)
			| undefined,
		ctx: RlmToolExecuteContext,
	) => Promise<{
		content: { type: "text"; text: string }[];
		details: RlmToolResultDetails;
		isError: boolean;
	}>;
	onSession: (event: { reason: "start" | "shutdown" }) => Promise<void>;
} {
	const { kernel, onRevival } = options;

	let firstInvocation = true;
	let toolKernelRestarted = false;

	return {
		name: TOOL_NAME,
		label: TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: ipythonSchema,
		executionMode: "sequential",

		async execute(
			_toolCallId: string,
			params: { code: string },
			_signal: AbortSignal | undefined,
			_onUpdate:
				| ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void)
				| undefined,
			ctx: RlmToolExecuteContext,
		): Promise<{
			content: { type: "text"; text: string }[];
			details: RlmToolResultDetails;
			isError: boolean;
		}> {
			let hasWorkingMessage = false;
			const setWorking = (message?: string): void => {
				try {
					ctx.setWorkingMessage(message);
					hasWorkingMessage = message !== undefined;
				} catch {
					// stale UI context
				}
			};

			const phaseToMessage = (phase: "starting" | "restoring" | "preparing"): string => {
				if (phase === "starting") return TOOL_WORKING_MESSAGES[0]!;
				if (phase === "restoring") return TOOL_WORKING_MESSAGES[1]!;
				return TOOL_WORKING_MESSAGES[2]!;
			};

			try {
				// First invocation: ensure kernel started with working messages
				if (firstInvocation) {
					firstInvocation = false;
					await kernel.ensureStarted(phase => setWorking(phaseToMessage(phase)));
				}

				// Execute the cell — busy-kernel choice loop
				let result: KernelExecutionResult;
				while (true) {
					try {
						result = (await kernel.execute(params.code)) as KernelExecutionResult;
						break;
					} catch (error: unknown) {
						// Check if this is a KernelBusyAfterInterruptError
						if (error instanceof Error && error.name === "KernelBusyAfterInterruptError") {
							const busyError = error as KernelBusyAfterInterruptError;

							// Busy path: if no UI, auto-cancel
							if (!ctx.hasUI) {
								return {
									content: [
										{
											type: "text",
											text: assembleText("", "", "", busyError.message, false),
										},
									],
									details: {
										durationMs: 0,
										status: "aborted",
										errorEname: undefined,
										kernelRestarted: undefined,
									},
									isError: true,
								};
							}

							// UI available: show choice dialog
							const choice = await ctx.ui.select(
								"The kernel is busy. Choose how to handle the state:",
								TOOL_BUSY_CHOICES.map(label => ({ label })),
							);

							if (choice === TOOL_BUSY_CHOICES[0]) {
								// "Wait and preserve state" → retry
								continue;
							}

							if (choice === TOOL_BUSY_CHOICES[1]) {
								// "Kill kernel and restart" → kill, set restart flag, retry
								await kernel.kill();
								toolKernelRestarted = true;
								continue;
							}

							// User cancelled / no selection → aborted
							return {
								content: [
									{
										type: "text",
										text: assembleText("", "", "", "Execution cancelled", false),
									},
								],
								details: {
									durationMs: 0,
									status: "aborted",
									errorEname: undefined,
									kernelRestarted: undefined,
								},
								isError: true,
							};
						}
						throw error;
					}
				}

				// Determine kernelRestarted: tool-tracked OR result-carried
				const kernelRestarted = toolKernelRestarted || result.kernelRestarted === true;
				toolKernelRestarted = false;

				// Text assembly
				let text = assembleText(result.stdout, result.stderr, result.result, result.traceback, kernelRestarted);

				// ERRORS-TOOL-1: runtime-missing detection
				if (
					result.status === "error" &&
					result.errorEname === "ModuleNotFoundError" &&
					result.traceback?.includes("No module named 'rlm'")
				) {
					const runtimeError = new RlmRuntimeMissingError(buildKernelGuidance());
					text = runtimeError.message;
				}

				const status: "ok" | "error" | "aborted" = result.status;
				const isError = status === "error" || status === "aborted";

				return {
					content: [{ type: "text", text }],
					details: {
						durationMs: result.durationMs,
						status,
						errorEname: result.errorEname,
						kernelRestarted: kernelRestarted || undefined,
					},
					isError,
				};
			} finally {
				if (hasWorkingMessage) {
					setWorking(undefined);
				}
			}
		},

		async onSession(event: { reason: "start" | "shutdown" }): Promise<void> {
			if (event.reason === "start") {
				await kernel.ensureStarted();
				const names = kernel.restoredNames();
				if (names.length > 0 && onRevival !== undefined) {
					onRevival(names);
				}
			} else if (event.reason === "shutdown") {
				await kernel.dispose();
			}
		},
	};
}
