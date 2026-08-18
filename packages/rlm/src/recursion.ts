/**
 * RLM host recursion engine — `await rlm()` admission, registry, model
 * resolution, and attribution.
 *
 * Implements requirements/contracts/rlm-recursion.contract.ts (SLICE-6).
 * All constants, exceptions, structural types, and validators are
 * redeclared independently here (no import of the contract); tests import
 * both this file and the contract to assert alignment.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";

// =============================================================================
// Constants (redeclared; aligned with contract REC_*, F-250..F-258)
// =============================================================================

/** F-250: default recursion depth (root). */
export const REC_DEPTH_DEFAULT = 0;
/** F-251: default max depth. */
export const REC_MAX_DEPTH_DEFAULT = 1;
/** F-257: child name length cap. */
export const REC_NAME_MAX_CHARS = 64;
/** F-120/F-256: model-search default limit. */
export const REC_MODEL_SEARCH_DEFAULT_LIMIT = 8;
/** F-120/F-256: model-search hard cap. */
export const REC_MODEL_SEARCH_MAX_LIMIT = 20;
/** F-122: child directory prefix. */
export const REC_CHILD_DIR_PREFIX = "sub-";
/** F-122: child id hex length. */
export const REC_CHILD_ID_HEX_LEN = 8;
/** F-125: task seeding prefix, exact. */
export const REC_TASK_PREFIX = "[task from parent]";
/** F-114: fallback slug when name derivation fails. */
export const REC_DEFAULT_NAME_FALLBACK = "worker";

// Exact error strings (F-226..F-234)
export const REC_ERR_DEPTH = "RLM recursion depth limit reached (RLM_DEPTH=%d, RLM_MAX_DEPTH=%d)";
export const REC_ERR_KWARGS = "Unsupported rlm.run kwargs: %s";
export const REC_ERR_PROMPT_TYPE = "rlm.run prompt must be a string";
export const REC_ERR_MODEL_UNAVAILABLE = 'Requested subagent model "%s" is unavailable, unauthenticated, or expired';
export const REC_ERR_PREFLIGHT = 'Requested subagent model "%s" failed authentication preflight';
export const REC_ERR_INVALID_HANDLE = "rlm.run returned an invalid spawn handle";
export const REC_ERR_UNKNOWN_TARGET = 'No direct RLM subagent matches "%s" in the current parent session';
export const REC_ERR_AMBIGUOUS = 'RLM subagent selector "%s" is ambiguous';
export const REC_ERR_DISPOSED_PARENT = "Cannot spawn a subagent after its parent was disposed";

// =============================================================================
// Exceptions (redeclared; aligned with contract)
// =============================================================================

export class RlmRecursionContractError extends Error {
	/** CL12-E traceability: the violated clause, carried separately so thrown
	 * messages can remain byte-exact to the reference behavior strings. */
	readonly clause: string | undefined;
	constructor(message: string, options?: { cause?: unknown; clause?: string }) {
		super(message, options);
		this.name = "RlmRecursionContractError";
		this.clause = options?.clause;
	}
}

// =============================================================================
// Structural types (redeclared; aligned with contract)
// =============================================================================

/** F-070: the admission handle. Python mirrors this frozen dataclass. */
export interface RlmSpawnHandle {
	readonly rlm_child_id: string;
	readonly name: string;
	readonly session_dir: string;
	readonly model: string;
}

/** F-141: registry status enum. */
export type RlmSubagentStatus = "running" | "completed" | "error";

/** F-140: one registry entry. */
export interface RlmSubagentEntry {
	readonly rlm_child_id: string;
	readonly active_session_id: string | null;
	readonly session_id: string | null;
	readonly session_name: string;
	readonly session_dir: string;
	readonly status: RlmSubagentStatus;
}

/** F-144: delete outcome. */
export type RlmDeleteOutcome = "deleted" | "skipped_running";

/** rlm.run's optional kwargs (F-111/F-227: only name and model are supported). */
export interface RlmSpawnOptions {
	readonly name?: string;
	readonly model?: string;
}

// =============================================================================
// Validators (redeclared; behavior aligned with contract REC-V1..V6)
// =============================================================================

/**
 * REC-V1: depth gate. Throws the exact F-228 string when depth is
 * exhausted (F-110).
 */
export function validateDepth(depth: number, maxDepth: number): void {
	if (depth >= maxDepth) {
		throw new RlmRecursionContractError(REC_ERR_DEPTH.replace("%d", String(depth)).replace("%d", String(maxDepth)), {
			clause: "REC-V1",
		});
	}
}

/**
 * REC-V2: kwargs whitelist. Only name and model; sorted in the error (F-111/F-227).
 */
export function validateRunKwargs(kwargs: Record<string, unknown>): void {
	const unsupported = Object.keys(kwargs)
		.filter(k => k !== "name" && k !== "model")
		.sort();
	if (unsupported.length > 0) {
		throw new RlmRecursionContractError(REC_ERR_KWARGS.replace("%s", unsupported.join(", ")), {
			clause: "REC-V2",
		});
	}
}

/**
 * REC-V3: child name validation. String, trimmed, non-empty, ≤64 (F-113).
 */
export function validateChildName(name: string): string {
	if (typeof name !== "string" || name.trim().length === 0 || name.length > REC_NAME_MAX_CHARS) {
		throw new RlmRecursionContractError(
			`REC-V3 violation: rlm.run name must be a non-empty string of at most ${REC_NAME_MAX_CHARS} characters`,
			{ clause: "REC-V3" },
		);
	}
	return name.trim();
}

/**
 * REC-V4: spawn handle integrity. All four fields non-empty strings (F-124/F-226).
 */
export function validateSpawnHandle(handle: unknown): RlmSpawnHandle {
	const h = handle as Partial<RlmSpawnHandle> | null;
	if (
		h === null ||
		typeof h !== "object" ||
		typeof h.rlm_child_id !== "string" ||
		h.rlm_child_id.length === 0 ||
		typeof h.name !== "string" ||
		h.name.length === 0 ||
		typeof h.session_dir !== "string" ||
		h.session_dir.length === 0 ||
		typeof h.model !== "string" ||
		h.model.length === 0
	) {
		throw new RlmRecursionContractError(REC_ERR_INVALID_HANDLE, { clause: "REC-V4" });
	}
	return { rlm_child_id: h.rlm_child_id, name: h.name, session_dir: h.session_dir, model: h.model };
}

/**
 * REC-V5: child id shape. `sub-` + exactly 8 lowercase hex chars (F-122).
 */
export function validateChildId(id: string): string {
	if (!new RegExp(`^${REC_CHILD_DIR_PREFIX}[0-9a-f]{${REC_CHILD_ID_HEX_LEN}}$`).test(id)) {
		throw new RlmRecursionContractError(
			`REC-V5 violation: child id must be "${REC_CHILD_DIR_PREFIX}" followed by ${REC_CHILD_ID_HEX_LEN} lowercase hex characters, got ${JSON.stringify(id)}`,
			{ clause: "REC-V5" },
		);
	}
	return id;
}

/**
 * REC-V6: delete outcome consistency. A running child yields skipped_running;
 * anything else must be deleted (F-144).
 */
export function validateDeleteOutcome(status: RlmSubagentStatus, outcome: RlmDeleteOutcome): RlmDeleteOutcome {
	const expected: RlmDeleteOutcome = status === "running" ? "skipped_running" : "deleted";
	if (outcome !== expected) {
		throw new RlmRecursionContractError(
			`REC-V6 violation: outcome must be ${expected} for status ${status}, got ${outcome}`,
			{ clause: "REC-V6" },
		);
	}
	return outcome;
}

// =============================================================================
// Registry (INV-REC-1 / INV-REC-LIFETIME-1 / POST-REC-5 / FORBIDDEN-REC-2)
// =============================================================================

/**
 * One parent's subagent registry: admission, listing, deletion, and
 * serialize/deserialize for snapshot persistence. Names are reserved the
 * instant an entry is registered, so a pending (still-`running`) child
 * counts toward INV-REC-1 uniqueness the same as a completed one.
 */
export class RlmSubagentRegistry {
	private readonly entries = new Map<string, RlmSubagentEntry>();

	/** INV-REC-1: true when `name` is already pending or registered. */
	hasName(name: string): boolean {
		for (const entry of this.entries.values()) {
			if (entry.session_name === name) return true;
		}
		return false;
	}

	/** Admits a new entry (status "running") once name/id/dir are resolved. */
	register(entry: RlmSubagentEntry): void {
		this.entries.set(entry.rlm_child_id, entry);
	}

	/** SEQ-REC-7: records a finishing child's terminal status before parent turn accounting closes. */
	complete(rlmChildId: string, status: "completed" | "error"): void {
		const entry = this.entries.get(rlmChildId);
		if (entry === undefined) return;
		this.entries.set(rlmChildId, { ...entry, status });
	}

	/**
	 * ERRORS-REC-1 / FORBIDDEN-REC-2: resolves target against rlm_child_id or
	 * session_name (unique match required), tombstones a non-running child by
	 * removing it from the registry, and skips a running one — never erasing
	 * transcripts or artifacts, which this registry never touches.
	 */
	delete(target: string): RlmDeleteOutcome {
		let match = this.entries.get(target);
		if (match === undefined) {
			const byName = [...this.entries.values()].filter(
				entry => entry.session_name === target || entry.rlm_child_id === target,
			);
			if (byName.length === 0) {
				throw new RlmRecursionContractError(REC_ERR_UNKNOWN_TARGET.replace("%s", target), {
					clause: "ERRORS-REC-1",
				});
			}
			if (byName.length > 1) {
				throw new RlmRecursionContractError(REC_ERR_AMBIGUOUS.replace("%s", target), {
					clause: "ERRORS-REC-1",
				});
			}
			match = byName[0];
		}
		const outcome: RlmDeleteOutcome = match.status === "running" ? "skipped_running" : "deleted";
		const validated = validateDeleteOutcome(match.status, outcome);
		if (validated === "deleted") this.entries.delete(match.rlm_child_id);
		return validated;
	}

	/** INV-REC-LIFETIME-1: registry entries survive kernel restart, compaction, and parent restore. */
	serialize(): readonly RlmSubagentEntry[] {
		return [...this.entries.values()];
	}

	/** POST-REC-5: alias of serialize() for callers querying live subagents rather than snapshotting. */
	list(): readonly RlmSubagentEntry[] {
		return this.serialize();
	}

	/** INV-REC-LIFETIME-1: rebuilds a registry from a previously serialized snapshot. */
	static deserialize(entries: readonly RlmSubagentEntry[]): RlmSubagentRegistry {
		const registry = new RlmSubagentRegistry();
		for (const entry of entries) registry.register(entry);
		return registry;
	}
}

// =============================================================================
// Engine (POST-REC-1..6 / INV-REC-* / SEQ-REC-6..8 / FORBIDDEN-REC-*)
// =============================================================================

/** The context handed to childRunner once a child is admitted (F-127). */
export interface RlmRecursionChildConfig {
	readonly rlmChildId: string;
	readonly name: string;
	readonly model: string;
	readonly depth: number;
	readonly maxDepth: number;
	readonly sessionDir: string;
	readonly initialPrompt: string;
	readonly parentSessionId: string;
}

/** Caller-supplied usage to fold into the parent turn (F-131/F-132). */
export interface RlmRecursionUsageInput {
	readonly parentMessageId: string;
	readonly childTokens: { readonly input: number; readonly output: number };
	readonly childCost: number;
}

/** Usage folded into the parent's assistant turn, persisted as child_usage_attributed (INV-REC-LIFETIME-2). */
export interface RlmRecursionAttributionEvent {
	readonly parentMessageId: string;
	readonly attributedTokens: { readonly input: number; readonly output: number };
	readonly childCost: number;
}

export interface RlmRecursionEngineOptions {
	readonly parentSessionId: string;
	readonly parentArtifactsDir: string;
	readonly parentModel: string;
	/** Current recursion depth of the parent; defaults to REC_DEPTH_DEFAULT. */
	readonly depth?: number;
	/** Inherited by children unchanged; defaults to REC_MAX_DEPTH_DEFAULT. */
	readonly maxDepth?: number;
	/** Model ids the host can admit a subagent onto; defaults to [parentModel]. */
	readonly availableModels?: readonly string[];
	/** Authentication preflight for a resolved model id; defaults to always-ok. */
	readonly preflightModel?: (modelId: string) => boolean | Promise<boolean>;
	/** Best-effort name derivation from the prompt; undefined triggers REC_DEFAULT_NAME_FALLBACK (POST-REC-6). */
	readonly deriveName?: (prompt: string) => string | undefined;
	/** Generates a fresh REC-V5-shaped child id; defaults to crypto randomness. */
	readonly generateChildId?: () => string;
	/**
	 * Starts the child. Called but never awaited for its answer — the engine
	 * never blocks admission on it (FORBIDDEN-REC-1).
	 */
	readonly childRunner?: (config: RlmRecursionChildConfig) => void | Promise<unknown>;
	/** AP-1: optional error handler for asynchronous child runner failures. */
	readonly onChildRunnerError?: (err: unknown, rlmChildId: string) => void;
	/** SEQ-REC-7: fired when a child reaches a terminal status. */
	readonly onTerminalNotice?: (event: { readonly rlmChildId: string; readonly status: "completed" | "error" }) => void;
	/** SEQ-REC-7/8: fired when the parent turn closes, after any terminal notice/attribution. */
	readonly onTurnClose?: () => void;
	/** SEQ-REC-8 / INV-REC-LIFETIME-2: fired when child usage is attributed. */
	readonly onAttribution?: (event: RlmRecursionAttributionEvent) => void;
}

export class RlmRecursionEngine {
	private readonly options: RlmRecursionEngineOptions;
	private readonly registry = new RlmSubagentRegistry();
	private readonly depth: number;
	private readonly maxDepth: number;
	private readonly attributedEvents: RlmRecursionAttributionEvent[] = [];
	private disposed = false;

	constructor(options: RlmRecursionEngineOptions) {
		this.options = options;
		this.depth = options.depth ?? REC_DEPTH_DEFAULT;
		this.maxDepth = options.maxDepth ?? REC_MAX_DEPTH_DEFAULT;
	}

	private generateChildId(): string {
		if (this.options.generateChildId) return validateChildId(this.options.generateChildId());
		const hex = randomBytes(Math.ceil(REC_CHILD_ID_HEX_LEN / 2))
			.toString("hex")
			.slice(0, REC_CHILD_ID_HEX_LEN);
		return validateChildId(`${REC_CHILD_DIR_PREFIX}${hex}`);
	}

	/**
	 * POST-REC-4 / FORBIDDEN-REC-3: parent model by default, an exact
	 * case-insensitive selector otherwise; never substitutes on failure.
	 */
	private async resolveModel(requestedModel: unknown): Promise<string> {
		const selector = requestedModel === undefined ? this.options.parentModel : requestedModel;
		if (typeof selector !== "string" || selector.trim().length === 0) {
			throw new RlmRecursionContractError(REC_ERR_MODEL_UNAVAILABLE.replace("%s", String(selector)), {
				clause: "POST-REC-4",
			});
		}
		const catalog = this.options.availableModels ?? [this.options.parentModel];
		const needle = selector.trim().toLowerCase();
		const found = catalog.find(id => id.toLowerCase() === needle);
		if (found === undefined) {
			throw new RlmRecursionContractError(REC_ERR_MODEL_UNAVAILABLE.replace("%s", selector), {
				clause: "POST-REC-4",
			});
		}
		const preflightOk = this.options.preflightModel ? await this.options.preflightModel(found) : true;
		if (!preflightOk) {
			throw new RlmRecursionContractError(REC_ERR_PREFLIGHT.replace("%s", found), { clause: "POST-REC-4" });
		}
		return found;
	}

	/**
	 * PRE-REC-1 / POST-REC-1..6 / SEQ-REC-6 / ERRORS-REC-1 / FORBIDDEN-REC-1/3:
	 * admits a subagent and returns only its 4-field handle — the child's
	 * answer never appears in the return.
	 */
	async spawn(prompt: unknown, options?: RlmSpawnOptions): Promise<RlmSpawnHandle> {
		if (this.disposed) {
			throw new RlmRecursionContractError(REC_ERR_DISPOSED_PARENT, { clause: "ERRORS-REC-1" });
		}
		if (typeof prompt !== "string") {
			throw new RlmRecursionContractError(REC_ERR_PROMPT_TYPE, { clause: "PRE-REC-1" });
		}
		const kwargs = (options ?? {}) as Record<string, unknown>;
		validateRunKwargs(kwargs);

		// SEQ-REC-6: depth gate and model resolution run before admission.
		validateDepth(this.depth, this.maxDepth);
		const model = await this.resolveModel(kwargs.model);

		// POST-REC-6: fallback name is observable in the returned handle, never silent.
		const derived = this.options.deriveName?.(prompt);
		const requested = typeof kwargs.name === "string" ? kwargs.name : derived;
		const candidateName =
			requested === undefined || requested.trim().length === 0 ? REC_DEFAULT_NAME_FALLBACK : requested;
		const name = validateChildName(candidateName);

		// INV-REC-1: sibling names unique within the parent, including pending
		// spawns; a collision is disambiguated with a numeric suffix rather than
		// rejected outright.
		let disambiguated = name;
		for (let suffix = 2; this.registry.hasName(disambiguated); suffix += 1) {
			disambiguated = validateChildName(`${name}-${suffix}`);
		}
		const finalName = disambiguated;

		const rlmChildId = this.generateChildId();
		const sessionDir = join(this.options.parentArtifactsDir, rlmChildId);
		const handle = validateSpawnHandle({
			rlm_child_id: rlmChildId,
			name: finalName,
			session_dir: sessionDir,
			model,
		});

		this.registry.register({
			rlm_child_id: rlmChildId,
			active_session_id: null,
			session_id: null,
			session_name: finalName,
			session_dir: sessionDir,
			status: "running",
		});

		// POST-REC-2/3: children inherit depth+1 / max depth and a
		// [task from parent]-prefixed task; FORBIDDEN-REC-1: never awaited here.
		if (this.options.childRunner) {
			void Promise.resolve(
				this.options.childRunner({
					rlmChildId,
					name: finalName,
					model,
					depth: this.depth + 1,
					maxDepth: this.maxDepth,
					sessionDir,
					initialPrompt: `${REC_TASK_PREFIX} ${prompt}`,
					parentSessionId: this.options.parentSessionId,
				}),
			).catch((err: unknown) => {
				this.options.onChildRunnerError?.(err, rlmChildId);
			});
		}
		return handle;
	}

	/**
	 * POST-REC-5: ranked model search — exact > prefix > substring — capped
	 * at REC_MODEL_SEARCH_MAX_LIMIT.
	 */
	findModels(query: string, limit?: number): readonly string[] {
		const max = Math.max(0, Math.min(limit ?? REC_MODEL_SEARCH_DEFAULT_LIMIT, REC_MODEL_SEARCH_MAX_LIMIT));
		const models = this.options.availableModels ?? [];
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return models.slice(0, max);
		const exact: string[] = [];
		const prefix: string[] = [];
		const substring: string[] = [];
		for (const id of models) {
			const lower = id.toLowerCase();
			if (lower === needle) exact.push(id);
			else if (lower.startsWith(needle)) prefix.push(id);
			else if (lower.includes(needle)) substring.push(id);
		}
		return [...exact, ...prefix, ...substring].slice(0, max);
	}

	/** POST-REC-5: this parent's registry entries. */
	listSubagents(): readonly RlmSubagentEntry[] {
		return this.registry.serialize();
	}

	/** ERRORS-REC-1 / FORBIDDEN-REC-2: deletes/tombstones by rlm_child_id or session_name. */
	deleteSubagent(target: string): RlmDeleteOutcome {
		return this.registry.delete(target);
	}

	/** SEQ-REC-7: records a finishing child's terminal status and fires the terminal notice hook. */
	notifyChildTerminal(rlmChildId: string, status: "completed" | "error"): void {
		this.registry.complete(rlmChildId, status);
		this.options.onTerminalNotice?.({ rlmChildId, status });
	}

	/** SEQ-REC-7: closes the parent turn — called after any terminal notice/attribution have already fired. */
	closeTurn(): void {
		this.options.onTurnClose?.();
	}

	/** SEQ-REC-8 / INV-REC-LIFETIME-2: folds child usage into the parent assistant turn. */
	attributeChildUsage(usage: RlmRecursionUsageInput): void {
		const event: RlmRecursionAttributionEvent = {
			parentMessageId: usage.parentMessageId,
			attributedTokens: usage.childTokens,
			childCost: usage.childCost,
		};
		this.attributedEvents.push(event);
		this.options.onAttribution?.(event);
	}

	/** Reads back child_usage_attributed accumulated for this parent (INV-REC-LIFETIME-2). */
	childUsageAttributed(): readonly RlmRecursionAttributionEvent[] {
		return this.attributedEvents;
	}

	/** Read access to this parent's registry, e.g. for external snapshot/restore wiring. */
	get subagentRegistry(): RlmSubagentRegistry {
		return this.registry;
	}

	/** FORBIDDEN: once disposed, no further child may be spawned (ERRORS-REC-1). */
	dispose(): void {
		this.disposed = true;
	}
}
