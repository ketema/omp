/**
 * RLM bridge engines — refine loop, heartbeat scheduler, agent_message
 * routing bus, and agent_observe reader. These are the four engines omp
 * lacks; SLICE-7 ports them from prime-agent's implementations so
 * host_request dispatch answers real machinery instead of the F-166
 * unavailability string wherever a capability is enabled (Z-2 a-full).
 *
 * Implements requirements/contracts/rlm-bridge.contract.ts (SLICE-7 slice
 * of the bridge). All constants, exceptions, structural types, and
 * validators used by this slice are redeclared independently here (no
 * import of the contract); tests import both this file and the contract
 * to assert alignment.
 *
 * Traceability: REQ-RLM-0010; F-150..F-166; Z-2 (a-full); POST-BR-3;
 * FORBIDDEN-BR-3.
 */

import { randomBytes } from "node:crypto";

// =============================================================================
// Constants (redeclared; aligned with contract BR_*, F-150..F-166)
// =============================================================================

/** F-071: the comm target name. */
export const BR_COMM_TARGET = "host.request";
/** F-166/F-220: exact unavailability string. */
export const BR_ERR_UNAVAILABLE = 'host request type "%s" is not available in this session';
/** F-164: compact.run scheduling note, exact. */
export const BR_COMPACT_NOTE =
	"Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.";
/** F-156: refine.run scheduling note, exact. */
export const BR_REFINE_NOTE =
	"Refinement runs when the current turn ends; the harness rebuilds the system prompt and resumes you automatically";
/** F-159: accepted heartbeat update statuses. */
export const BR_HEARTBEAT_STATUSES: readonly ["pause", "resume"] = ["pause", "resume"];
/** F-161: messaging roles (the nuclear family). */
export const BR_MESSAGE_ROLES: readonly ["parent", "sibling", "child"] = ["parent", "sibling", "child"];

// =============================================================================
// Exceptions (redeclared; aligned with contract)
// =============================================================================

export class RlmBridgeContractError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RlmBridgeContractError";
	}
}

// =============================================================================
// Structural types (redeclared; aligned with contract)
// =============================================================================

/**
 * F-160: heartbeat view (snake_case over the wire). `interval` mirrors
 * `schedule` verbatim from create/update input — both are populated so
 * callers can read either the contract-declared wire field or the raw
 * scheduling expression they supplied.
 */
export interface HeartbeatView {
	readonly id: string;
	readonly status: string;
	readonly label: string;
	readonly delivery_mode: string;
	readonly instruction: string;
	readonly schedule: string;
	readonly interval: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly next_run_at: string | null;
	readonly last_run_at: string | null;
	readonly last_error: string | null;
	readonly run_count: number;
}

/** F-162: send receipt. */
export interface AgentMessageReceipt {
	readonly id: string;
	readonly message: string;
	readonly deliveryStatus: string;
	readonly target: string;
}

/** F-161/F-163: the nuclear family — parent, siblings, direct children only. */
export interface AgentFamily {
	readonly parent?: string;
	readonly siblings?: readonly string[];
	readonly children?: readonly string[];
}

/** F-161: one family roster entry. */
export interface AgentDescriptor {
	readonly name: string;
	readonly role: "parent" | "sibling" | "child";
}

// =============================================================================
// Validators (redeclared; behavior aligned with contract BR-V3/BR-V4)
// =============================================================================

/**
 * BR-V3: heartbeat update validation (F-159). Also the FORBIDDEN-BR-3
 * enforcement point: status, when present, is structurally limited to
 * pause|resume by BR_HEARTBEAT_STATUSES.
 */
export function validateHeartbeatUpdate(update: Readonly<{ id: string; status?: string }>): string {
	if (typeof update.id !== "string" || update.id.length === 0) {
		throw new RlmBridgeContractError("BR-V3 violation: heartbeat update requires non-empty id");
	}
	if (update.status !== undefined && !BR_HEARTBEAT_STATUSES.includes(update.status as "pause" | "resume")) {
		throw new RlmBridgeContractError(
			`BR-V3 violation: heartbeat status must be pause|resume, got ${JSON.stringify(update.status)}`,
		);
	}
	return update.id;
}

/**
 * BR-V4: message targets stay inside the nuclear family (F-161).
 */
export function validateMessageRole(role: string): string {
	if (!BR_MESSAGE_ROLES.includes(role as "parent" | "sibling" | "child")) {
		throw new RlmBridgeContractError(
			`BR-V4 violation: receiver_role must be parent|sibling|child, got ${JSON.stringify(role)}`,
		);
	}
	return role;
}

/** Resolves a family member's name to its role, or undefined outside the family. */
function resolveFamilyRole(family: AgentFamily, name: string): "parent" | "sibling" | "child" | undefined {
	if (family.parent === name) return "parent";
	if (family.siblings?.includes(name)) return "sibling";
	if (family.children?.includes(name)) return "child";
	return undefined;
}

// =============================================================================
// RefineEngine (F-155/F-156, POST-BR-3/POST-BR-4)
// =============================================================================

export interface RefineStatusView {
	readonly pending: boolean;
	readonly in_flight: boolean;
}

export interface RefineRunPayload {
	readonly global?: unknown;
}

export interface RefineRunResult {
	readonly scheduled: boolean;
	readonly note: string;
}

/**
 * F-155/F-156, POST-BR-3/POST-BR-4: refine loop — status query and
 * scheduling. Scheduling never blocks the calling turn; it flips internal
 * state to in_flight and returns the exact BR_REFINE_NOTE.
 */
export class RefineEngine {
	private pending = false;
	private inFlight = false;

	/** F-155, POST-BR-3: idle until a refine pass has been scheduled. */
	async status(): Promise<RefineStatusView> {
		return { pending: this.pending, in_flight: this.inFlight };
	}

	/**
	 * F-156, POST-BR-4: schedules a refine pass; `global`, when provided,
	 * must be boolean (ERRORS-BR-1). Returns { scheduled, note } with the
	 * exact BR_REFINE_NOTE and never blocks the calling turn.
	 */
	async run(payload: RefineRunPayload = {}): Promise<RefineRunResult> {
		if (payload.global !== undefined && typeof payload.global !== "boolean") {
			throw new RlmBridgeContractError(
				`ERRORS-BR-1 violation: refine.run global must be boolean, got ${JSON.stringify(payload.global)}`,
			);
		}
		this.pending = true;
		this.inFlight = true;
		return { scheduled: true, note: BR_REFINE_NOTE };
	}
}

// =============================================================================
// HeartbeatEngine (F-157..F-160, POST-BR-3, FORBIDDEN-BR-3, BR-V3)
// =============================================================================

export interface HeartbeatListPayload {
	readonly include_inactive?: boolean;
}

export interface HeartbeatListResult {
	readonly heartbeats: readonly HeartbeatView[];
}

export interface HeartbeatCreatePayload {
	readonly instruction: string;
	readonly interval?: string;
	readonly label?: string;
}

export interface HeartbeatUpdatePayload {
	readonly id: string;
	readonly status?: string;
	readonly instruction?: string;
	readonly interval?: string;
	readonly label?: string;
}

export interface HeartbeatDeletePayload {
	readonly id: string;
}

export interface HeartbeatDeleteResult {
	readonly deleted: true;
}

export interface HeartbeatEngineOptions {
	readonly generateId?: () => string;
	readonly now?: () => string;
}

const HEARTBEAT_ID_PREFIX = "hb-";
const HEARTBEAT_ID_HEX_LEN = 8;
const HEARTBEAT_STATUS_ACTIVE = "active";
const HEARTBEAT_STATUS_INACTIVE = "pause";
const HEARTBEAT_DELIVERY_MODE = "interval";

/**
 * F-157..F-160, POST-BR-3: heartbeat CRUD. FORBIDDEN-BR-3 is enforced
 * structurally: `update` routes every status change through
 * validateHeartbeatUpdate, whose only accepted values are
 * BR_HEARTBEAT_STATUSES — no other code path mutates `status`.
 */
export class HeartbeatEngine {
	private readonly entries = new Map<string, HeartbeatView>();
	private readonly options: HeartbeatEngineOptions;

	constructor(options: HeartbeatEngineOptions = {}) {
		this.options = options;
	}

	private generateId(): string {
		if (this.options.generateId) return this.options.generateId();
		const hex = randomBytes(Math.ceil(HEARTBEAT_ID_HEX_LEN / 2))
			.toString("hex")
			.slice(0, HEARTBEAT_ID_HEX_LEN);
		return `${HEARTBEAT_ID_PREFIX}${hex}`;
	}

	/** F-157, POST-BR-3: heartbeats array, paused ones hidden unless include_inactive. */
	async list(payload: HeartbeatListPayload = {}): Promise<HeartbeatListResult> {
		const includeInactive = payload.include_inactive === true;
		const all = [...this.entries.values()];
		const heartbeats = includeInactive ? all : all.filter(entry => entry.status !== HEARTBEAT_STATUS_INACTIVE);
		return { heartbeats };
	}

	/** F-158, POST-BR-3: instruction required; interval/label optional. */
	async create(payload: HeartbeatCreatePayload): Promise<HeartbeatView> {
		if (typeof payload.instruction !== "string" || payload.instruction.trim().length === 0) {
			throw new RlmBridgeContractError(
				"F-158 violation: rlm_heartbeat.create requires a non-empty instruction string",
			);
		}
		const now = this.options.now ? this.options.now() : new Date().toISOString();
		const interval = payload.interval ?? "";
		const entry: HeartbeatView = {
			id: this.generateId(),
			status: HEARTBEAT_STATUS_ACTIVE,
			label: payload.label ?? "",
			delivery_mode: HEARTBEAT_DELIVERY_MODE,
			instruction: payload.instruction,
			schedule: interval,
			interval,
			created_at: now,
			updated_at: now,
			next_run_at: null,
			last_run_at: null,
			last_error: null,
			run_count: 0,
		};
		this.entries.set(entry.id, entry);
		return entry;
	}

	/** F-159, POST-BR-3, FORBIDDEN-BR-3, BR-V3: id required; >=1 field besides id. */
	async update(payload: HeartbeatUpdatePayload): Promise<HeartbeatView> {
		const id = validateHeartbeatUpdate(payload);
		const existing = this.entries.get(id);
		if (existing === undefined) {
			throw new RlmBridgeContractError(`F-159 violation: no heartbeat with id ${JSON.stringify(id)}`);
		}
		const { id: _id, ...fields } = payload;
		if (Object.keys(fields).length === 0) {
			throw new RlmBridgeContractError(
				"F-159 violation: rlm_heartbeat.update requires at least one field besides id",
			);
		}
		const interval = payload.interval ?? existing.interval;
		const status =
			payload.status === undefined
				? existing.status
				: payload.status === "resume"
					? HEARTBEAT_STATUS_ACTIVE
					: payload.status;
		const updated: HeartbeatView = {
			...existing,
			status,
			instruction: payload.instruction ?? existing.instruction,
			schedule: interval,
			interval,
			label: payload.label ?? existing.label,
			updated_at: this.options.now ? this.options.now() : new Date().toISOString(),
		};
		this.entries.set(id, updated);
		return updated;
	}

	/** F-160, POST-BR-3: id required; deletes returning { deleted: true }, or null when absent. */
	async delete(payload: HeartbeatDeletePayload): Promise<HeartbeatDeleteResult | null> {
		if (!this.entries.has(payload.id)) return null;
		this.entries.delete(payload.id);
		return { deleted: true };
	}
}

// =============================================================================
// AgentMessageEngine (F-161/F-162, POST-BR-3/POST-BR-6, BR-V4)
// =============================================================================

export interface AgentMessageSendPayload {
	readonly target: string;
	readonly message: string;
	readonly receiver_role?: string;
}

export interface AgentMessageEngineOptions {
	/** F-161: the nuclear family — parent, siblings, direct children only. */
	readonly family?: AgentFamily;
	readonly generateId?: () => string;
	/** Fired once a message has been recorded as delivered. */
	readonly onDeliver?: (receipt: AgentMessageReceipt) => void;
}

const AGENT_MESSAGE_ID_PREFIX = "msg-";
const AGENT_MESSAGE_ID_HEX_LEN = 8;
const AGENT_MESSAGE_DELIVERY_STATUS = "delivered";

/**
 * F-161/F-162, POST-BR-3/POST-BR-6: agent_message routing bus — family
 * roster and validated send. POST-BR-6: the receipt is always the
 * 4-field shape; receiver_role/receiver_name never ride along.
 */
export class AgentMessageEngine {
	private readonly family: AgentFamily;
	private readonly options: AgentMessageEngineOptions;
	private readonly deliveries: AgentMessageReceipt[] = [];

	constructor(options: AgentMessageEngineOptions = {}) {
		this.options = options;
		this.family = options.family ?? {};
	}

	/** Every receipt recorded by a successful send, in delivery order. */
	get deliveredMessages(): readonly AgentMessageReceipt[] {
		return this.deliveries;
	}

	private generateId(): string {
		if (this.options.generateId) return this.options.generateId();
		const hex = randomBytes(Math.ceil(AGENT_MESSAGE_ID_HEX_LEN / 2))
			.toString("hex")
			.slice(0, AGENT_MESSAGE_ID_HEX_LEN);
		return `${AGENT_MESSAGE_ID_PREFIX}${hex}`;
	}

	/** F-161, POST-BR-3: parent/siblings/direct children only. */
	async listAgents(): Promise<readonly AgentDescriptor[]> {
		const agents: AgentDescriptor[] = [];
		if (this.family.parent !== undefined) agents.push({ name: this.family.parent, role: "parent" });
		for (const name of this.family.siblings ?? []) agents.push({ name, role: "sibling" });
		for (const name of this.family.children ?? []) agents.push({ name, role: "child" });
		return agents;
	}

	/**
	 * F-162, POST-BR-6, BR-V4, ERRORS-BR-1: target/message required
	 * non-empty strings; target must resolve to a family member (BR-V4),
	 * and an explicit receiver_role, when given, is validated the same
	 * way.
	 */
	async send(payload: AgentMessageSendPayload): Promise<AgentMessageReceipt> {
		if (typeof payload.target !== "string" || payload.target.length === 0) {
			throw new RlmBridgeContractError("ERRORS-BR-1 violation: agent_message.send requires a non-empty target");
		}
		if (typeof payload.message !== "string" || payload.message.length === 0) {
			throw new RlmBridgeContractError("ERRORS-BR-1 violation: agent_message.send requires a non-empty message");
		}
		validateMessageRole(resolveFamilyRole(this.family, payload.target) ?? "");
		if (payload.receiver_role !== undefined) {
			validateMessageRole(payload.receiver_role);
		}
		const receipt: AgentMessageReceipt = {
			id: this.generateId(),
			target: payload.target,
			message: payload.message,
			deliveryStatus: AGENT_MESSAGE_DELIVERY_STATUS,
		};
		this.deliveries.push(receipt);
		this.options.onDeliver?.(receipt);
		return receipt;
	}
}

// =============================================================================
// AgentObserveEngine (F-163, POST-BR-3)
// =============================================================================

export interface AgentObserveRecentPayload {
	readonly target: string;
	readonly limit?: number;
	readonly max_chars?: number;
}

export interface AgentObserveEngineOptions {
	/** F-163: observable targets are bounded to the family. */
	readonly family?: AgentFamily;
	/** Backing transcript lines for a target, oldest first. */
	readonly lines?: (target: string) => readonly string[];
}

const AGENT_OBSERVE_DEFAULT_LIMIT = 20;
const AGENT_OBSERVE_DEFAULT_MAX_CHARS = 4000;

/**
 * F-163, POST-BR-3: agent_observe reader — lists observable targets and
 * returns their most recent lines bounded by both a line count and a
 * total character budget.
 */
export class AgentObserveEngine {
	private readonly family: AgentFamily;
	private readonly options: AgentObserveEngineOptions;

	constructor(options: AgentObserveEngineOptions = {}) {
		this.options = options;
		this.family = options.family ?? {};
	}

	/** F-163, POST-BR-3: observable targets, bounded to the family. */
	async list(): Promise<readonly string[]> {
		const names: string[] = [];
		if (this.family.parent !== undefined) names.push(this.family.parent);
		names.push(...(this.family.siblings ?? []));
		names.push(...(this.family.children ?? []));
		return names;
	}

	/** F-163, POST-BR-3: recent lines for target, bounded by limit and max_chars. */
	async recent(payload: AgentObserveRecentPayload): Promise<readonly string[]> {
		if (typeof payload.target !== "string" || payload.target.length === 0) {
			throw new RlmBridgeContractError("F-163 violation: agent_observe.recent requires a non-empty target");
		}
		if (resolveFamilyRole(this.family, payload.target) === undefined) {
			throw new RlmBridgeContractError(
				`F-163 violation: agent_observe target ${JSON.stringify(payload.target)} is not observable`,
			);
		}
		const limit = payload.limit ?? AGENT_OBSERVE_DEFAULT_LIMIT;
		const maxChars = payload.max_chars ?? AGENT_OBSERVE_DEFAULT_MAX_CHARS;
		const source = this.options.lines?.(payload.target) ?? [];
		const bounded = limit > 0 ? source.slice(-limit) : [];
		let budget = Math.max(0, maxChars);
		const result: string[] = [];
		for (let i = bounded.length - 1; i >= 0; i -= 1) {
			const line = bounded[i] as string;
			if (line.length > budget) break;
			budget -= line.length;
			result.unshift(line);
		}
		return result;
	}
}

// =============================================================================
// RlmBridgeRouter (POST-BR-3, INV-BR-1, ERRORS-BR-1, cross-ref POST-BR-2)
// =============================================================================

export interface RlmBridgeRouterOptions {
	/** Always-on when provided (F-165); omitted only in tests that don't need it. */
	readonly modelInfo?: unknown;
	readonly refine?: RefineEngine;
	readonly heartbeat?: HeartbeatEngine;
	readonly agentMessage?: AgentMessageEngine;
	readonly agentObserve?: AgentObserveEngine;
}

/**
 * Dispatches host_request types onto the four ported engines (plus
 * model.info) per POST-BR-3. INV-BR-1/ERRORS-BR-1: a disabled or unknown
 * type always answers the exact BR_ERR_UNAVAILABLE string.
 */
export class RlmBridgeRouter {
	private readonly options: RlmBridgeRouterOptions;

	constructor(options: RlmBridgeRouterOptions = {}) {
		this.options = options;
	}

	/**
	 * ERRORS-BR-1: a non-string/empty type or non-object payload raises
	 * TypeError. POST-BR-2/POST-BR-3/INV-BR-1: routes to the enabled
	 * engine's handler; a disabled or unknown type throws
	 * RlmBridgeContractError with the exact unavailability string.
	 */
	async dispatch(type: string, payload: unknown): Promise<unknown> {
		if (typeof type !== "string" || type.length === 0) {
			throw new TypeError("ERRORS-BR-1 violation: host_request type must be a non-empty string");
		}
		if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
			throw new TypeError("ERRORS-BR-1 violation: host_request payload must be a plain object");
		}
		const body = (payload ?? {}) as Record<string, unknown>;

		switch (type) {
			case "model.info":
				if (this.options.modelInfo === undefined) return this.unavailable(type);
				return this.options.modelInfo;
			case "refine.status":
				if (this.options.refine === undefined) return this.unavailable(type);
				return this.options.refine.status();
			case "refine.run":
				if (this.options.refine === undefined) return this.unavailable(type);
				return this.options.refine.run(body as RefineRunPayload);
			case "rlm_heartbeat.list":
				if (this.options.heartbeat === undefined) return this.unavailable(type);
				return this.options.heartbeat.list(body as HeartbeatListPayload);
			case "rlm_heartbeat.create":
				if (this.options.heartbeat === undefined) return this.unavailable(type);
				return this.options.heartbeat.create(body as unknown as HeartbeatCreatePayload);
			case "rlm_heartbeat.update":
				if (this.options.heartbeat === undefined) return this.unavailable(type);
				return this.options.heartbeat.update(body as unknown as HeartbeatUpdatePayload);
			case "rlm_heartbeat.delete":
				if (this.options.heartbeat === undefined) return this.unavailable(type);
				return this.options.heartbeat.delete(body as unknown as HeartbeatDeletePayload);
			case "agent_message.list_agents":
				if (this.options.agentMessage === undefined) return this.unavailable(type);
				return this.options.agentMessage.listAgents();
			case "agent_message.send":
				if (this.options.agentMessage === undefined) return this.unavailable(type);
				return this.options.agentMessage.send(body as unknown as AgentMessageSendPayload);
			case "agent_observe.list":
				if (this.options.agentObserve === undefined) return this.unavailable(type);
				return this.options.agentObserve.list();
			case "agent_observe.recent":
				if (this.options.agentObserve === undefined) return this.unavailable(type);
				return this.options.agentObserve.recent(body as unknown as AgentObserveRecentPayload);
			default:
				return this.unavailable(type);
		}
	}

	private unavailable(type: string): never {
		throw new RlmBridgeContractError(BR_ERR_UNAVAILABLE.replace("%s", type));
	}
}
