/**
 * RLM model-facing tool — the ipython tool definition.
 *
 * Implements the contract at contracts/rlm-tool.contract.ts.
 * All constants are redeclared independently (no import from the contract);
 * alignment tests import both sides and assert equality.
 */

import { type } from "@oh-my-pi/omptype";
import type { KernelBusyAfterInterruptError, KernelExecutionResult } from "./kernel";
import {
	bindOutputCode,
	countOutputTokens,
	IPYTHON_ARTIFACT_TOOL_TYPE,
	IPYTHON_FILE_THRESHOLD_TOKENS,
	ipythonDescriptor,
	type SaveArtifact,
} from "./ipython_filing";

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

/**
 * ERRORS-TOOL-SESSION-CHANGED-1 / POST-TOOL-SESSION-BINDING-1: raised by a bound kernel port when the kernel an
 * invocation was bound to at entry has since been replaced, disposed or shut down. The tool turns it into a
 * visible abort; cell code is never dispatched to any other kernel.
 */
export class RlmSessionChangedError extends RlmToolContractError {
	constructor() {
		super(
			"The session changed before this cell could run; the cell was not executed. Re-issue it in the current session if it is still needed.",
		);
		this.name = "RlmSessionChangedError";
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
	/**
	 * POST-TOOL-SESSION-BINDING-1: captures the kernel current NOW and returns a port bound to it. Every call on
	 * the returned port targets that kernel, or rejects with {@link RlmSessionChangedError} once it is replaced.
	 * Optional: a port without it is used as-is (single-kernel callers).
	 */
	acquire?(): Promise<RlmToolKernelPort>;
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
	/** The complete stdout, present only when `stdout` was cut at the kernel's output cap. */
	readonly stdoutFull?: string;
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
	/** The session manager, when the host provides one: the artifact copy of a filed output is saved through it. */
	sessionManager?: { saveArtifact?: SaveArtifact };
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
	"- File-write paths (`write`, `open`, `dill.dump_session`) must be a literal, statically-inspectable string; an f-string or other computed path is rejected by governance write-guards even for scratch/session files.",
	'- Call `dill.dump_session("<literal path>.pkl")` with a bare filename only; never open the destination yourself first (e.g. as a compressor handle) and pass that handle in — the dumper serializes the whole namespace, including any open file/compressor object still in scope.',
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
	/** Called once for each filed output whose artifact copy was saved, with the artifact id and the `out_<n>` number. */
	readonly onFiled?: (artifactId: string, n: number) => void;
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
	let nextFiledOutput = 1;

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
				// POST-TOOL-SESSION-BINDING-1: bind this invocation to the kernel current at entry.
				const bound = await bindToEntryKernel(kernel);

				// First invocation: ensure kernel started with working messages
				if (firstInvocation) {
					firstInvocation = false;
					await bound.ensureStarted(phase => setWorking(phaseToMessage(phase)));
				}

				// Execute the cell — busy-kernel choice loop
				let result: KernelExecutionResult;
				while (true) {
					try {
						result = (await bound.execute(params.code)) as KernelExecutionResult;
						break;
					} catch (error: unknown) {
						// Check if this is a KernelBusyAfterInterruptError
						if (error instanceof Error && error.name === "KernelBusyAfterInterruptError") {
							const busyError = error as KernelBusyAfterInterruptError;

							// Busy path: if no UI, auto-cancel
							if (!ctx.hasUI) {
								return abortedResult(busyError.message);
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
								await bound.kill();
								toolKernelRestarted = true;
								continue;
							}

							// User cancelled / no selection → aborted
							return abortedResult("Execution cancelled");
						}
						throw error;
					}
				}

				// Determine kernelRestarted: tool-tracked OR result-carried
				const kernelRestarted = toolKernelRestarted || result.kernelRestarted === true;
				toolKernelRestarted = false;

				// REQ-CTX27-23: a large stdout of a cell that raised no error is filed into the kernel and replaced by a descriptor.
				const filed = await fileLargeStdout(
					bound,
					result,
					nextFiledOutput,
					ctx?.sessionManager?.saveArtifact?.bind(ctx.sessionManager),
				);
				if (filed !== null) {
					nextFiledOutput = filed.n + 1;
					if (filed.artifactId !== null) options.onFiled?.(filed.artifactId, filed.n);
				}

				// Text assembly
				let text = assembleText(
					filed === null ? result.stdout : filed.descriptor,
					result.stderr,
					result.result,
					result.traceback,
					kernelRestarted,
				);

				// ERRORS-TOOL-1: runtime-missing detection
				if (isRuntimeMissing(result)) {
					text = new RlmRuntimeMissingError(buildKernelGuidance()).message;
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
			} catch (error: unknown) {
				// ERRORS-TOOL-SESSION-CHANGED-1: visible abort, never a throw, never a re-dispatch.
				return abortedBySessionChange(error);
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

type RlmToolExecuteResult = {
	content: { type: "text"; text: string }[];
	details: RlmToolResultDetails;
	isError: boolean;
};

/** A tool result that reports an aborted, not-executed invocation visibly (never a throw). */
function abortedResult(message: string): RlmToolExecuteResult {
	return {
		content: [{ type: "text", text: assembleText("", "", "", message, false) }],
		details: { durationMs: 0, status: "aborted", errorEname: undefined, kernelRestarted: undefined },
		isError: true,
	};
}

/** POST-TOOL-SESSION-BINDING-1: the port this invocation is bound to, captured at entry (a port without `acquire` is used as-is). */
async function bindToEntryKernel(kernel: RlmToolKernelPort): Promise<RlmToolKernelPort> {
	return kernel.acquire !== undefined ? await kernel.acquire() : kernel;
}

/** ERRORS-TOOL-SESSION-CHANGED-1: a session change becomes a visible abort; any other error is rethrown untouched. */
function abortedBySessionChange(error: unknown): RlmToolExecuteResult {
	if (error instanceof RlmSessionChangedError) return abortedResult(error.message);
	throw error;
}

/** ERRORS-TOOL-1: the cell failed because the rlm runtime package is not importable in the kernel. */
function isRuntimeMissing(result: KernelExecutionResult): boolean {
	return (
		result.status === "error" &&
		result.errorEname === "ModuleNotFoundError" &&
		result.traceback?.includes("No module named 'rlm'") === true
	);
}

/**
 * REQ-CTX27-23 to REQ-CTX27-26: files a large stdout of a cell that raised no error. Binds the full text to the first
 * free out_<n> in the kernel, saves the same text as a session artifact, and returns the descriptor that replaces the
 * stdout. Returns null when the stdout stays inline.
 */
async function fileLargeStdout(
	port: RlmToolKernelPort,
	result: KernelExecutionResult,
	nextN: number,
	saveArtifact: SaveArtifact | undefined,
): Promise<{ n: number; descriptor: string; artifactId: string | null } | null> {
	if (result.status !== "ok") return null;
	const text = result.stdoutFull ?? result.stdout;
	const tokens = countOutputTokens(text);
	if (tokens < IPYTHON_FILE_THRESHOLD_TOKENS) return null;
	const bind = await port.execute(bindOutputCode(nextN));
	const n = Number.parseInt(bind.stdout.trim(), 10);
	if (bind.status !== "ok" || !Number.isInteger(n)) return null;
	let artifactId: string | null = null;
	if (saveArtifact !== undefined) {
		try {
			artifactId = (await saveArtifact(text, IPYTHON_ARTIFACT_TOOL_TYPE)) ?? null;
		} catch {
			artifactId = null;
		}
	}
	return { n, descriptor: ipythonDescriptor({ n, text, tokens, artifactId }), artifactId };
}
