/**
 * Context Efficiency Enforcement Contract — Specification Authority for ketema/omp#27.
 *
 * Defines behavioral obligations for:
 *   1. Emission gate (o200k token proxy, 1,500 per-result/per-turn, 6,000 per-session,
 *      400-token UDT descriptor, kernel binding, 60-line / 2 KB displayhook cap)
 *   2. Catalog gate (trusted helper snapshots, ≤80-token cards on every prompt, no bodies)
 *   3. Compaction gate (unpicklable drop to open_items, xz/0x80 snapshot verification,
 *      single auto-compact-memory-<session_id>-<seq> record, cancel on hash/write failure)
 *   4. Prompt assembly (no 32-byte payload-value slice outside cut sample/text line,
 *      ≤700-token fixture transcript)
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

// =============================================================================
// Artifact 2: Domain Exception Classes
// =============================================================================

export class ContextEfficiencyContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextEfficiencyContractError";
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

// =============================================================================
// Artifact 4: Pure Callable Validators
// =============================================================================

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
		requirement_ids: ["REQ-CTX27-11", "REQ-CTX27-13"],
	},
	"ERRORS-CTX27-1": {
		id: "ERRORS-CTX27-1",
		method: "test",
		description:
			"When the compaction snapshot hash does not match the record or the snapshot write fails, session_before_compact returns { cancel: true }, compact() throws CompactionCancelledError, the compaction-entry count is unchanged, and the status text is Compaction cancelled.",
		requirement_ids: ["REQ-CTX27-13"],
	},
	"FORBIDDEN-CTX27-1": {
		id: "FORBIDDEN-CTX27-1",
		method: "test",
		description:
			"No 32-byte slice of a filed payload value appears in the assembled prompt outside a descriptor's cut sample string or cut text line (key names and column names cut at 31 characters are exempt), and the F-over + three-cards + compaction-status transcript excluding user prompts, F-inline, F-turn, and F-session is at most 700 o200k tokens.",
		requirement_ids: ["INV-CTX27-06", "INV-CTX27-07"],
	},
} as const;
