/**
 * RLM Bridge Contract — specification authority.
 *
 * WHAT the host_request bridge and its handlers guarantee (wire rules,
 * unavailability string, conditional handlers including the four ported
 * engines), NOT how comms transport.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0006, REQ-RLM-0010, REQ-RLM-0015, REQ-RLM-0018;
 * F-071..F-081, F-150..F-166, F-220, F-240; Z-2 decision (a-full);
 * IP-2, IP-7; SEQ-9; A-002, A-008, A-010, A-012.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-071: the comm target name. */
export const BR_COMM_TARGET = 'host.request'
/** F-166/F-220: exact unavailability string. */
export const BR_ERR_UNAVAILABLE = 'host request type "%s" is not available in this session'
/** F-164: compact.run scheduling note, exact. */
export const BR_COMPACT_NOTE =
  'Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.'
/** F-156: refine.run scheduling note, exact. */
export const BR_REFINE_NOTE =
  'Refinement runs when the current turn ends; the harness rebuilds the system prompt and resumes you automatically'
/** F-159: accepted heartbeat update statuses. */
export const BR_HEARTBEAT_STATUSES: readonly ['pause', 'resume'] = ['pause', 'resume']
/** F-161: messaging roles (the nuclear family). */
export const BR_MESSAGE_ROLES: readonly ['parent', 'sibling', 'child'] = ['parent', 'sibling', 'child']

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmBridgeContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmBridgeContractError'
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** F-071: wire shape. `type` rides LAST so a payload cannot reroute. */
export interface HostRequestEnvelope {
  readonly payload: Record<string, unknown>
  readonly type: string
}

/** F-162: send receipt. */
export interface AgentMessageReceipt {
  readonly id: string
  readonly message: string
  readonly deliveryStatus: string
  readonly target: string
}

/** F-160: heartbeat view (snake_case over the wire). */
export interface HeartbeatView {
  readonly id: string
  readonly status: string
  readonly label: string
  readonly delivery_mode: string
  readonly instruction: string
  readonly schedule: string
  readonly created_at: string
  readonly updated_at: string
  readonly next_run_at: string | null
  readonly last_run_at: string | null
  readonly last_error: string | null
  readonly run_count: number
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * BR-V1: envelope integrity — type field last (F-071). Object-spread order
 * is observable via JSON key order.
 */
export function validateEnvelopeKeyOrder(serialized: string): HostRequestEnvelope {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(serialized) as Record<string, unknown>
  } catch (cause) {
    throw new RlmBridgeContractError(
      'BR-V1 violation: host request envelope must be valid JSON',
      { cause },
    )
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new RlmBridgeContractError(
      'BR-V1 violation: host request envelope must be a JSON object',
    )
  }
  const keys = Object.keys(parsed)
  if (keys[keys.length - 1] !== 'type' || typeof parsed.type !== 'string') {
    throw new RlmBridgeContractError(
      'BR-V1 violation: host request "type" must be the last key so payloads cannot reroute',
    )
  }
  const { type, ...payload } = parsed
  return { payload, type }
}

/**
 * BR-V2: unavailability string formatting (F-166/F-220).
 */
export function validateUnavailableString(type: string, rendered: string): string {
  const expected = BR_ERR_UNAVAILABLE.replace('%s', type)
  if (rendered !== expected) {
    throw new RlmBridgeContractError(
      `BR-V2 violation: unavailability must be exactly ${JSON.stringify(expected)}`,
    )
  }
  return rendered
}

/**
 * BR-V3: heartbeat update validation (F-159).
 */
export function validateHeartbeatUpdate(update: Readonly<{
  id: string
  status?: string
}>): string {
  if (typeof update.id !== 'string' || update.id.length === 0) {
    throw new RlmBridgeContractError('BR-V3 violation: heartbeat update requires a non-empty id')
  }
  if (
    update.status !== undefined && !BR_HEARTBEAT_STATUSES.includes(update.status as 'pause' | 'resume')
  ) {
    throw new RlmBridgeContractError(
      `BR-V3 violation: heartbeat status must be pause|resume, got ${JSON.stringify(update.status)}`,
    )
  }
  return update.id
}

/**
 * BR-V4: message targets stay inside the nuclear family (F-161).
 */
export function validateMessageRole(role: string): string {
  if (!BR_MESSAGE_ROLES.includes(role as 'parent')) {
    throw new RlmBridgeContractError(
      `BR-V4 violation: receiver_role must be parent|sibling|child, got ${JSON.stringify(role)}`,
    )
  }
  return role
}

/**
 * BR-V5: goal.create argument validation (POST-BR-5 / F-151).
 */
export function validateGoalCreate(
  objective: unknown,
  tokenBudget: unknown,
): { objective: string; tokenBudget: number } {
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new RlmBridgeContractError(
      'POST-BR-5 violation: goal.create objective must be a non-empty string',
    )
  }
  if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    throw new RlmBridgeContractError(
      'POST-BR-5 violation: goal.create token_budget must be a positive integer',
    )
  }
  return { objective, tokenBudget }
}
// =============================================================================

export const RLM_BRIDGE_CONTRACT = {
  'PRE-BR-1': 'Every wire request carries its type as the final key (F-071, BR-V1).',
  'POST-BR-1': 'Replies resolve on the control channel, never the execution channel, so an awaiting execution request never deadlocks (F-072/F-073, A-010).',
  'POST-BR-2': 'model.info is always registered; goal/compact/refine/heartbeat/agent_message/agent_observe/mcp register only when their engines are enabled (F-165, F-150..F-164).',
  'POST-BR-3': 'The four ported engines (refine loop, heartbeat scheduler, agent_message routing bus, agent_observe reader) deliver the full F-150..F-163 semantics with real machinery (REQ-RLM-0010, Z-2 a-full).',
  'POST-BR-4': 'compact.run and refine.run return scheduling notes with the exact BR note strings; they never block the calling turn (F-154/F-156).',
  'POST-BR-5': 'goal.create validates objective as string and token_budget as integer (F-151).',
  'POST-BR-6': 'agent_message.send returns a receipt; broadcast excludes receiver_role/receiver_name (F-162).',
  'INV-BR-1': 'A capability the User disables answers with the exact unavailability string (F-166, BR-V2).',
  'INV-BR-LIFETIME-1': 'Bridge futures always settle (ok, error, or unexpected); comms close on settle (F-073).',
  'SEQ-BR-9': 'Ledger mutations SHALL persist to disk AFTER each CRUD operation (SEQ-9, IP-7, cross-ref LED contract).',
  'ERRORS-BR-1': 'Type errors raise TypeError; unknown handler types answer the exact unavailability string (F-071/F-220).',
  'FORBIDDEN-BR-1': 'The bridge SHALL NOT reply on the execution channel while an execution request awaits (F-240, A-010, REQ-RLM-0006).',
  'FORBIDDEN-BR-2': 'Python SHALL NOT resolve provider credentials or run an agent loop (A-008/A-012, REQ-RLM-0018).',
  'FORBIDDEN-BR-3': 'Heartbeat status updates SHALL NOT accept values outside pause|resume (F-159, BR-V3, REQ-RLM-0010, A-002).',
} as const

export type RlmBridgeClauseId = keyof typeof RLM_BRIDGE_CONTRACT