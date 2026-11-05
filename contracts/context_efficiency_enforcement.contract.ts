/**
 * Context Efficiency Enforcement Contract — Specification Authority for ketema/omp#27.
 *
 * Defines behavioral obligations for:
 *   1. Preconditions & Invariants (PRE-CTX27-1, INV-CTX27-1)
 *   2. Emission gate (POST-CTX27-1..3, SEQ-CTX27-1..2)
 *   3. Catalog gate (POST-CTX27-4, SEQ-CTX27-3)
 *   4. Compaction gate (POST-CTX27-5, SEQ-CTX27-4, ERRORS-CTX27-1)
 *   5. Prompt assembly (FORBIDDEN-CTX27-1)
 *
 * The implementation MUST NOT import from this file (CL11-F); tests import both.
 */

// =============================================================================
// Artifact 1: Importable Constants
// =============================================================================

export const RESULT_TOKEN_THRESHOLD = 1500;
export const TURN_INLINE_TOKEN_BUDGET = 1500;
export const SESSION_INLINE_TOKEN_BUDGET = 6000;
export const DESCRIPTOR_MAX_TOKENS = 400;
export const SCHEMA_NAME_MAX_CHARS = 31;
export const TEXT_HEAD_LINES = 5;
export const TEXT_TAIL_LINES = 5;
export const TEXT_LINE_MAX_CHARS = 40;
export const SAMPLE_STRING_MAX_CHARS = 40;
export const DISPLAY_MAX_LINES = 60;
export const DISPLAY_MAX_BYTES = 2048;

export const CARD_MAX_TOKENS = 80;
export const CARD_NAME_MAX_CHARS = 16;
export const CARD_SIGNATURE_MAX_CHARS = 24;
export const CARD_SUMMARY_MAX_CHARS = 32;
export const CARD_SNAPSHOT_MAX_CHARS = 24;

export const PAYLOAD_SLICE_BYTES = 32;
export const FIXTURE_TRANSCRIPT_MAX_TOKENS = 700;
export const COMPACTION_CANCELLED_TEXT = "Compaction cancelled";
/** REQ-CTX27-16 (Z8): the loader the kernel runs at start, relative to the kernel process's HOME. */
export const WORKBENCH_LOADER_PATH_FROM_HOME = ".agents/skills/repl-snapshots/restore.py";
/** REQ-CTX27-18 (Z9): the workbench notice starts with this text. */
export const WORKBENCH_READY_PREFIX = "Workbench ready: ";
/** ERRORS-CTX27-3: failures are appended to the same one-line notice after this text. */
export const WORKBENCH_FAILED_SEPARATOR = ". Failed to load: ";
/** REQ-CTX27-18: the loaded-names list when nothing loaded. */
export const WORKBENCH_NONE_LOADED = "none";

// =============================================================================
// Artifact 2: Domain Exception Classes
// =============================================================================

export class ContextEfficiencyContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextEfficiencyContractError";
	}
}

export class PreconditionViolationError extends ContextEfficiencyContractError {
	constructor(detail: string) {
		super(`PRE-CTX27-1 violation: ${detail}`);
		this.name = "PreconditionViolationError";
	}
}

export class BudgetInvariantViolationError extends ContextEfficiencyContractError {
	constructor(detail: string) {
		super(`INV-CTX27-1 violation: ${detail}`);
		this.name = "BudgetInvariantViolationError";
	}
}

export class DescriptorSchemaViolationError extends ContextEfficiencyContractError {
	constructor(detail: string) {
		super(`POST-CTX27-2 violation: invalid Universal Data Topology descriptor: ${detail}`);
		this.name = "DescriptorSchemaViolationError";
	}
}

export class CardSchemaViolationError extends ContextEfficiencyContractError {
	constructor(detail: string) {
		super(`POST-CTX27-4 violation: invalid helper catalog card: ${detail}`);
		this.name = "CardSchemaViolationError";
	}
}

export class PayloadLeakViolationError extends ContextEfficiencyContractError {
	constructor(slice: string) {
		super(`FORBIDDEN-CTX27-1 violation: 32-byte payload value slice leaked into prompt: ${slice}`);
		this.name = "PayloadLeakViolationError";
	}
}

export class SnapshotMigrationViolationError extends ContextEfficiencyContractError {
	constructor(recordId: string, detail: string) {
		super(`ERRORS-CTX27-2 violation: failed to migrate snapshot ${recordId}: ${detail}`);
		this.name = "SnapshotMigrationViolationError";
	}
}

export class WorkbenchReportViolationError extends ContextEfficiencyContractError {
	constructor(clauseId: string, detail: string) {
		super(`${clauseId} violation: ${detail}`);
		this.name = "WorkbenchReportViolationError";
	}
}

// =============================================================================
// Artifact 3: Immutable Typed Records
// =============================================================================

export type UdtClass = "json_array" | "json_object" | "tabular" | "text";

export interface UdtDescriptorRecord {
	readonly class: UdtClass;
	readonly name: string;
	readonly count?: number;
	readonly key_schema_union?: readonly string[];
	readonly low_cardinality_distributions?: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly sample_row_0?: Readonly<Record<string, unknown>> | null;
	readonly top_level_keys?: readonly string[];
	readonly per_key_shape?: Readonly<Record<string, string>>;
	readonly columns?: readonly string[];
	readonly row_count?: number;
	readonly numeric_summary?: Readonly<Record<string, { readonly min: number; readonly max: number; readonly avg: number }>>;
	readonly total_lines?: number;
	readonly head?: readonly string[];
	readonly omitted?: number;
	readonly tail?: readonly string[];
}

export interface HelperCatalogCard {
	readonly name: string;
	readonly signature: string;
	readonly summary: string;
	readonly snapshot: string;
}

export interface AutoCompactMemoryRecord {
	readonly narrative: string;
	readonly descriptors: Readonly<Record<string, UdtDescriptorRecord>>;
	readonly kernel_handles: readonly string[];
	readonly snapshot_path: string;
	readonly sha256: string;
	readonly files_touched: readonly string[];
	readonly open_items: readonly string[];
}

/** One snapshot record restore.py refused, with its reason (ERRORS-CTX27-3). */
export interface WorkbenchRefusal {
	readonly record: string;
	readonly reason: string;
}

/** What loading the workbench at kernel start produced (POST-CTX27-8, ERRORS-CTX27-3). */
export interface WorkbenchReport {
	readonly loaded: readonly string[];
	readonly refused: readonly WorkbenchRefusal[];
	/** The cause when restore.py is missing or raises; null when it ran. */
	readonly error: string | null;
}

// =============================================================================
// Artifact 4: Pure Callable Validators & Assertion Signatures
// =============================================================================

export function assertValidEnforcerPreconditions(options: {
	readonly agentDir: string;
	readonly sessionId: string;
}): asserts options is { readonly agentDir: string; readonly sessionId: string } {
	if (typeof options.agentDir !== "string" || options.agentDir.trim().length === 0) {
		throw new PreconditionViolationError("agentDir must be a non-empty string");
	}
	if (typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
		throw new PreconditionViolationError("sessionId must be a non-empty string");
	}
}

export function assertBudgetInvariant(state: {
	readonly turnInlineTokens: number;
	readonly sessionInlineTokens: number;
}): void {
	if (
		!Number.isInteger(state.turnInlineTokens) ||
		state.turnInlineTokens < 0 ||
		state.turnInlineTokens > TURN_INLINE_TOKEN_BUDGET
	) {
		throw new BudgetInvariantViolationError(
			`turnInlineTokens ${state.turnInlineTokens} outside [0, ${TURN_INLINE_TOKEN_BUDGET}]`,
		);
	}
	if (
		!Number.isInteger(state.sessionInlineTokens) ||
		state.sessionInlineTokens < 0 ||
		state.sessionInlineTokens > SESSION_INLINE_TOKEN_BUDGET
	) {
		throw new BudgetInvariantViolationError(
			`sessionInlineTokens ${state.sessionInlineTokens} outside [0, ${SESSION_INLINE_TOKEN_BUDGET}]`,
		);
	}
}

export function validateUdtDescriptorRecord(
	record: UdtDescriptorRecord,
	tokenCount: number,
): boolean {
	if (!record || typeof record !== "object") {
		throw new DescriptorSchemaViolationError("descriptor must be an object");
	}
	if (!["json_array", "json_object", "tabular", "text"].includes(record.class)) {
		throw new DescriptorSchemaViolationError(`unsupported class: ${String(record.class)}`);
	}
	if (typeof record.name !== "string" || !/^artifact_[A-Za-z0-9_-]+$/.test(record.name)) {
		throw new DescriptorSchemaViolationError(`invalid artifact name: ${String(record.name)}`);
	}
	if (tokenCount > DESCRIPTOR_MAX_TOKENS) {
		throw new DescriptorSchemaViolationError(`token count ${tokenCount} > ${DESCRIPTOR_MAX_TOKENS}`);
	}
	const schemaNames = [
		...(record.key_schema_union ?? []),
		...(record.top_level_keys ?? []),
		...(record.columns ?? []),
		...Object.keys(record.per_key_shape ?? {}),
	];
	for (const key of schemaNames) {
		if (key.length > SCHEMA_NAME_MAX_CHARS) {
			throw new DescriptorSchemaViolationError(`schema name exceeds ${SCHEMA_NAME_MAX_CHARS} chars: ${key}`);
		}
	}
	if (record.class === "text") {
		const head = record.head ?? [];
		const tail = record.tail ?? [];
		if (head.length > TEXT_HEAD_LINES || tail.length > TEXT_TAIL_LINES) {
			throw new DescriptorSchemaViolationError("text head/tail line count exceeded");
		}
		for (const line of [...head, ...tail]) {
			if (line.length > TEXT_LINE_MAX_CHARS) {
				throw new DescriptorSchemaViolationError(`text line exceeds ${TEXT_LINE_MAX_CHARS} chars`);
			}
		}
	}
	return true;
}

export function validateHelperCatalogCard(card: HelperCatalogCard, tokenCount: number): boolean {
	if (!card || typeof card !== "object") {
		throw new CardSchemaViolationError("card must be an object");
	}
	if (card.name.length === 0 || card.name.length > CARD_NAME_MAX_CHARS) {
		throw new CardSchemaViolationError(`name length ${card.name.length} out of bounds`);
	}
	if (card.signature.length === 0 || card.signature.length > CARD_SIGNATURE_MAX_CHARS) {
		throw new CardSchemaViolationError(`signature length ${card.signature.length} out of bounds`);
	}
	if (card.summary.length === 0 || card.summary.length > CARD_SUMMARY_MAX_CHARS) {
		throw new CardSchemaViolationError(`summary length ${card.summary.length} out of bounds`);
	}
	if (
		card.snapshot.length === 0 ||
		card.snapshot.length > CARD_SNAPSHOT_MAX_CHARS ||
		card.snapshot.includes("/") ||
		card.snapshot.includes("\\")
	) {
		throw new CardSchemaViolationError(`snapshot must be basename <= ${CARD_SNAPSHOT_MAX_CHARS} chars`);
	}
	if (tokenCount > CARD_MAX_TOKENS) {
		throw new CardSchemaViolationError(`card token count ${tokenCount} > ${CARD_MAX_TOKENS}`);
	}
	return true;
}

/** REQ-CTX27-18: the exact one-line notice for a workbench report. Pure; used by validateWorkbenchNotice. */
export function expectedWorkbenchNotice(report: WorkbenchReport): string {
	const loaded = report.loaded.length > 0 ? report.loaded.join(", ") : WORKBENCH_NONE_LOADED;
	const failures = [
		...(report.error === null ? [] : [report.error]),
		...report.refused.map(r => `${r.record} (${r.reason})`),
	];
	return failures.length === 0
		? `${WORKBENCH_READY_PREFIX}${loaded}`
		: `${WORKBENCH_READY_PREFIX}${loaded}${WORKBENCH_FAILED_SEPARATOR}${failures.join("; ")}`;
}

/** POST-CTX27-8 / ERRORS-CTX27-3: a workbench report has the contracted shape. */
export function validateWorkbenchReport(raw: unknown): WorkbenchReport {
	if (raw === null || typeof raw !== "object") {
		throw new WorkbenchReportViolationError("POST-CTX27-8", "report must be an object");
	}
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.loaded) || !r.loaded.every(n => typeof n === "string" && n.length > 0)) {
		throw new WorkbenchReportViolationError("POST-CTX27-8", "loaded must be a list of names");
	}
	if (
		!Array.isArray(r.refused) ||
		!r.refused.every(
			x =>
				x !== null &&
				typeof x === "object" &&
				typeof (x as Record<string, unknown>).record === "string" &&
				typeof (x as Record<string, unknown>).reason === "string",
		)
	) {
		throw new WorkbenchReportViolationError("ERRORS-CTX27-3", "refused must be a list of {record, reason}");
	}
	if (r.error !== null && typeof r.error !== "string") {
		throw new WorkbenchReportViolationError("ERRORS-CTX27-3", "error must be a string or null");
	}
	return {
		loaded: r.loaded as string[],
		refused: r.refused as WorkbenchRefusal[],
		error: r.error as string | null,
	};
}

/** POST-CTX27-9: the shown notice equals the contracted notice for the report. */
export function validateWorkbenchNotice(report: WorkbenchReport, notice: string): void {
	const expected = expectedWorkbenchNotice(report);
	if (notice !== expected) {
		throw new WorkbenchReportViolationError("POST-CTX27-9", `notice ${JSON.stringify(notice)} != ${JSON.stringify(expected)}`);
	}
}

// =============================================================================
// Artifact 5: Method-Aware Clause Map
// =============================================================================

export interface ContractClause {
	readonly id: string;
	readonly method: "test" | "execution" | "tool";
	readonly description: string;
	readonly requirement_ids: readonly string[];
}

export const CONTRACT_CONTEXT_EFFICIENCY_ENFORCEMENT: Readonly<Record<string, ContractClause>> = {
	"PRE-CTX27-1": {
		id: "PRE-CTX27-1",
		method: "test",
		description:
			"ContextEfficiencyEnforcer requires non-empty agentDir and sessionId strings at construction, and admitToolResult requires a non-empty toolCallId string; violating inputs throw PreconditionViolationError citing PRE-CTX27-1.",
		requirement_ids: ["REQ-CTX27-01", "REQ-CTX27-02"],
	},
	"INV-CTX27-1": {
		id: "INV-CTX27-1",
		method: "test",
		description:
			"At every public entry and exit of ContextEfficiencyEnforcer, turnInlineTokens is an integer in [0, 1500] and sessionInlineTokens is an integer in [0, 6000]; any violation throws BudgetInvariantViolationError citing INV-CTX27-1.",
		requirement_ids: ["REQ-CTX27-02", "REQ-CTX27-03"],
	},
	"POST-CTX27-1": {
		id: "POST-CTX27-1",
		method: "test",
		description:
			"The emission gate counts tokens with natives.countTokens(text, Encoding.O200kBase), admits a result < 1,500 tokens inline only while turn inline tokens <= 1,500 and session inline tokens <= 6,000, and files any result >= 1,500 tokens or exceeding the turn or session budget as one UDT descriptor bound in the IPython kernel under artifact_<id>.",
		requirement_ids: ["REQ-CTX27-01", "REQ-CTX27-02", "REQ-CTX27-03", "REQ-CTX27-14", "INV-CTX27-01"],
	},
	"POST-CTX27-2": {
		id: "POST-CTX27-2",
		method: "test",
		description:
			"Each filed UDT descriptor is one JSON object of at most 400 o200k tokens with required class and name (artifact_<id>), schema names cut at 31 characters, text keeping 5 head and 5 tail lines cut at 40 characters, JSON array sample strings cut at 40 characters, JSON object descriptors copying no values, and progressive fallback dropping sample_row_0 then low_cardinality_distributions while preserving class, name, and cut schema names.",
		requirement_ids: ["REQ-CTX27-04", "REQ-CTX27-05", "INV-CTX27-02", "INV-CTX27-03"],
	},
	"POST-CTX27-3": {
		id: "POST-CTX27-3",
		method: "test",
		description:
			"For every filed tool result, the IPython kernel value bound at artifact_<id> hashes equal (SHA-256) to the original payload, and the kernel display output for that name is capped at 60 lines and 2,048 bytes.",
		requirement_ids: ["REQ-CTX27-06", "REQ-CTX27-07"],
	},
	"POST-CTX27-4": {
		id: "POST-CTX27-4",
		method: "test",
		description:
			"Saving F reusable helper functions to trusted helper snapshots under ~/.omp/agent/repl-snapshots/ causes every subsequent assembled prompt to contain exactly F cards matching the schema (name <= 16, signature <= 24, summary <= 32, snapshot basename <= 24, each card <= 80 o200k tokens, total <= 80*F tokens) and zero function bodies.",
		requirement_ids: ["REQ-CTX27-08", "REQ-CTX27-09", "INV-CTX27-04"],
	},
	"POST-CTX27-5": {
		id: "POST-CTX27-5",
		method: "test",
		description:
			"On session_before_compact, unpicklable kernel names are dropped from the snapshot, listed in open_items, and compaction proceeds; a valid snapshot writes ~/.omp/agent/ipython-compact-<session_id>.pkl as a non-empty xz stream whose decompressed bytes start with 0x80, writes exactly one auto-compact-memory-<session_id>-<seq> record with {narrative, descriptors, kernel_handles, snapshot_path, sha256, files_touched, open_items} and no payload, and a fresh dill.load_session restores the payload hash.",
		requirement_ids: ["REQ-CTX27-10", "REQ-CTX27-11", "REQ-CTX27-12", "INV-CTX27-05"],
	},
	"POST-CTX27-6": {
		id: "POST-CTX27-6",
		method: "test",
		description:
			"migrateHelperSnapshotsToTargetPython migrates every snapshot record in manifest.json from its neutral Python source (stored in manifest.json or supplied via sourceOverrides) to targetPython's major.minor version and dill version, atomically updating the snapshot file and manifest.json (python_version, dill_version, sha256, byte_size) so restore.py restores all migrated helpers under targetPython.",
	},
	"SEQ-CTX27-1": {
		id: "SEQ-CTX27-1",
		method: "test",
		description:
			"ContextEfficiencyEnforcer.admitToolResult evaluates the o200k token count and turn/session budgets BEFORE returning transcriptText to the tool-result path (IP-1).",
		requirement_ids: ["REQ-CTX27-01", "REQ-CTX27-02", "REQ-CTX27-03"],
	},
	"SEQ-CTX27-2": {
		id: "SEQ-CTX27-2",
		method: "test",
		description:
			"When ContextEfficiencyEnforcer.admitToolResult files a tool result, it binds artifact_<id> in the IPython kernel BEFORE returning the UDT descriptor (IP-2).",
		requirement_ids: ["REQ-CTX27-03", "REQ-CTX27-06"],
	},
	"SEQ-CTX27-3": {
		id: "SEQ-CTX27-3",
		method: "test",
		description:
			"assemblePromptWithCatalogCards reads manifest.json from the snapshots directory and appends bounded catalog cards BEFORE returning the assembled prompt (IP-3).",
		requirement_ids: ["REQ-CTX27-08", "REQ-CTX27-09"],
	},
	"SEQ-CTX27-4": {
		id: "SEQ-CTX27-4",
		method: "test",
		description:
			"ContextEfficiencyEnforcer.runCompactionWithGate invokes runBeforeCompactHook BEFORE committing a compaction entry and aborts with CompactionCancelledError when the hook returns { cancel: true } (IP-4).",
	},
	"ERRORS-CTX27-1": {
		id: "ERRORS-CTX27-1",
		method: "test",
		description:
			"When the compaction snapshot hash does not match the record or the snapshot write fails, session_before_compact returns { cancel: true }, compact() throws CompactionCancelledError, the compaction-entry count is unchanged, and the status text is Compaction cancelled.",
		requirement_ids: ["REQ-CTX27-13"],
	},
	"ERRORS-CTX27-2": {
		id: "ERRORS-CTX27-2",
		method: "test",
		description:
			"When any snapshot record in manifest.json lacks a neutral Python source or fails compilation under targetPython during migration, migrateHelperSnapshotsToTargetPython throws SnapshotMigrationViolationError naming the record ID and leaves manifest.json and existing snapshot files unchanged.",
		requirement_ids: ["REQ-CTX27-15"],
	},
	"FORBIDDEN-CTX27-1": {
		id: "FORBIDDEN-CTX27-1",
		method: "test",
		description:
			"No 32-byte slice of a filed payload value appears in the assembled prompt outside a descriptor's cut sample string or cut text line (key names and column names cut at 31 characters are exempt), and the F-over + three-cards + compaction-status transcript excluding user prompts, F-inline, F-turn, and F-session is at most 700 o200k tokens.",
		requirement_ids: ["INV-CTX27-06", "INV-CTX27-07"],
	},
	"SEQ-CTX27-6": {
		id: "SEQ-CTX27-6",
		method: "test",
		description:
			"KernelManager's start sequence runs restore.py inside the IPython kernel AFTER transport bootstrap and BEFORE the first cell executes, so the first cell sees every restored helper name (IP-5).",
		requirement_ids: ["REQ-CTX27-16"],
	},
	"POST-CTX27-8": {
		id: "POST-CTX27-8",
		method: "test",
		description:
			"After kernel start, the workbench report's loaded list equals the names restore.py restored, each is bound in the kernel's global namespace, and no other global restore.py defines is bound there.",
		requirement_ids: ["REQ-CTX27-16"],
	},
	"POST-CTX27-9": {
		id: "POST-CTX27-9",
		method: "test",
		description:
			"The first ipython tool call of a session shows exactly one notice, and its text equals expectedWorkbenchNotice(report) for that kernel's workbench report.",
		requirement_ids: ["REQ-CTX27-18"],
	},
	"ERRORS-CTX27-3": {
		id: "ERRORS-CTX27-3",
		method: "test",
		description:
			"When restore.py is missing or raises, or refuses a snapshot, kernel start still completes, the next cell executes, the report carries the cause in error and every refused record in refused, and the notice names them.",
		requirement_ids: ["REQ-CTX27-16"],
	},
	"FORBIDDEN-CTX27-2": {
		id: "FORBIDDEN-CTX27-2",
		method: "test",
		description:
			"createAgentSession does not mount createContextEfficiencyExtension in any session: no loaded extension registers its tool_result and before_agent_start handlers.",
		requirement_ids: ["REQ-CTX27-17"],
	},
} as const;
