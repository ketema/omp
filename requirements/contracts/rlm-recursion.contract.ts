/**
 * RLM Recursion Contract — specification authority.
 *
 * WHAT rlm.run delegation must guarantee (depth gate, kwargs/name/model
 * validation, admission handles, registry, attribution), NOT how children
 * execute.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0008, REQ-RLM-0009, REQ-RLM-0014, REQ-N-5;
 * F-070, F-110..F-147, F-226..F-234, F-250..F-258; IP-3, IP-4;
 * SEQ-6..SEQ-8; A-009, A-013, A-014.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-250: default recursion depth (root). */
export const REC_DEPTH_DEFAULT = 0
/** F-251: default max depth. */
export const REC_MAX_DEPTH_DEFAULT = 1
/** F-257: child name length cap. */
export const REC_NAME_MAX_CHARS = 64
/** F-120/F-256: model-search default limit. */
export const REC_MODEL_SEARCH_DEFAULT_LIMIT = 8
/** F-120/F-256: model-search hard cap. */
export const REC_MODEL_SEARCH_MAX_LIMIT = 20
/** F-122: child directory prefix. */
export const REC_CHILD_DIR_PREFIX = 'sub-'
/** F-122: child id hex length. */
export const REC_CHILD_ID_HEX_LEN = 8
/** F-125: task seeding prefix, exact. */
export const REC_TASK_PREFIX = '[task from parent]'
/** F-114: fallback slug when name derivation fails. */
export const REC_DEFAULT_NAME_FALLBACK = 'worker'

// Exact error strings (F-226..F-234)
export const REC_ERR_DEPTH = 'RLM recursion depth limit reached (RLM_DEPTH=%d, RLM_MAX_DEPTH=%d)'
export const REC_ERR_KWARGS = 'Unsupported rlm.run kwargs: %s'
export const REC_ERR_PROMPT_TYPE = 'rlm.run prompt must be a string'
export const REC_ERR_MODEL_UNAVAILABLE =
  'Requested subagent model "%s" is unavailable, unauthenticated, or expired'
export const REC_ERR_PREFLIGHT =
  'Requested subagent model "%s" failed authentication preflight'
export const REC_ERR_INVALID_HANDLE = 'rlm.run returned an invalid spawn handle'
export const REC_ERR_UNKNOWN_TARGET =
  'No direct RLM subagent matches "%s" in the current parent session'
export const REC_ERR_AMBIGUOUS = 'RLM subagent selector "%s" is ambiguous'
export const REC_ERR_DISPOSED_PARENT =
  'Cannot spawn a subagent after its parent was disposed'

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmRecursionContractError extends Error {
  /** CL12-E traceability: the violated clause, carried separately so thrown
   * messages can remain byte-exact reference behavior strings. */
  readonly clause: string | undefined
  constructor(message: string, options?: { cause?: unknown; clause?: string }) {
    super(message, options)
    this.name = 'RlmRecursionContractError'
    this.clause = options?.clause
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** F-070: the admission handle. Python mirrors this frozen dataclass. */
export interface RlmSpawnHandle {
  readonly rlm_child_id: string
  readonly name: string
  readonly session_dir: string
  readonly model: string
}

/** F-141: registry status enum. */
export type RlmSubagentStatus = 'running' | 'completed' | 'error'

/** F-140: one registry entry. */
export interface RlmSubagentEntry {
  readonly rlm_child_id: string
  readonly active_session_id: string | null
  readonly session_id: string | null
  readonly session_name: string
  readonly session_dir: string
  readonly status: RlmSubagentStatus
}

/** F-144: delete outcome. */
export type RlmDeleteOutcome = 'deleted' | 'skipped_running'

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * REC-V1: depth gate. Throws with the exact F-228 string when depth is
 * exhausted (F-110).
 */
export function validateDepth(depth: number, maxDepth: number): void {
  if (depth >= maxDepth) {
    throw new RlmRecursionContractError(
      REC_ERR_DEPTH.replace('%d', String(depth)).replace('%d', String(maxDepth)),
      { clause: 'REC-V1' },
    )
  }
}

/**
 * REC-V2: kwargs whitelist. Only name and model; sorted in the error (F-111/F-227).
 */
export function validateRunKwargs(kwargs: Record<string, unknown>): void {
  const unsupported = Object.keys(kwargs)
    .filter(k => k !== 'name' && k !== 'model')
    .sort()
  if (unsupported.length > 0) {
    throw new RlmRecursionContractError(
      REC_ERR_KWARGS.replace('%s', unsupported.join(', ')),
      { clause: 'REC-V2' },
    )
  }
}

/**
 * REC-V3: child name validation. String, trimmed, non-empty, ≤64 (F-113).
 */
export function validateChildName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > REC_NAME_MAX_CHARS) {
    throw new RlmRecursionContractError(
      `REC-V3 violation: rlm.run name must be a non-empty string of at most ${REC_NAME_MAX_CHARS} characters`,
      { clause: 'REC-V3' },
    )
  }
  return name.trim()
}

/**
 * REC-V4: spawn handle integrity. All four fields non-empty strings (F-124/F-226).
 */
export function validateSpawnHandle(handle: unknown): RlmSpawnHandle {
  const h = handle as Partial<RlmSpawnHandle> | null
  if (
    h === null || typeof h !== 'object'
    || typeof h.rlm_child_id !== 'string' || h.rlm_child_id.length === 0
    || typeof h.name !== 'string' || h.name.length === 0
    || typeof h.session_dir !== 'string' || h.session_dir.length === 0
    || typeof h.model !== 'string' || h.model.length === 0
  ) {
    throw new RlmRecursionContractError(REC_ERR_INVALID_HANDLE, { clause: 'REC-V4' })
  }
  return h as RlmSpawnHandle
}

/**
 * REC-V5: child id shape. `sub-` + exactly 8 lowercase hex chars (F-122).
 */
export function validateChildId(id: string): string {
  if (!new RegExp(`^${REC_CHILD_DIR_PREFIX}[0-9a-f]{${REC_CHILD_ID_HEX_LEN}}$`).test(id)) {
    throw new RlmRecursionContractError(
      `REC-V5 violation: child id must be ${REC_CHILD_DIR_PREFIX} + 8 lowercase hex chars, got ${JSON.stringify(id)}`,
      { clause: 'REC-V5' },
    )
  }
  return id
}

/**
 * REC-V6: delete outcome consistency. A running child yields skipped_running;
 * anything else must be deleted (F-144).
 */
export function validateDeleteOutcome(
  status: RlmSubagentStatus,
  outcome: RlmDeleteOutcome,
): RlmDeleteOutcome {
  const expected: RlmDeleteOutcome = status === 'running' ? 'skipped_running' : 'deleted'
  if (outcome !== expected) {
    throw new RlmRecursionContractError(
      `REC-V6 violation: outcome must be ${expected} for status ${status}, got ${outcome}`,
      { clause: 'REC-V6' },
    )
  }
  return outcome
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_RECURSION_CONTRACT = {
  'PRE-REC-1': 'rlm.run prompt is a string; kwargs ⊆ { name, model } (F-112/F-111, REC-V1/V2).',
  'POST-REC-1': 'A successful spawn returns after admission with a 4-field handle; the child answer never appears in the return (F-123, REQ-N-5).',
  'POST-REC-2': 'Children receive RLM_DEPTH+1, inherited max depth, and their own session dir (F-127).',
  'POST-REC-3': 'Child tasks carry the exact [task from parent] prefix (F-125, REC task prefix constant).',
  'POST-REC-4': 'Model resolution uses the parent model by default and an exact case-insensitive selector otherwise, failing loud with REC_ERR_MODEL_UNAVAILABLE / REC_ERR_PREFLIGHT (F-116..F-119).',
  'POST-REC-5': 'find_models returns at most REC_MODEL_SEARCH_MAX_LIMIT entries, ranked exact > prefix > substring (F-120/F-121).',
  'POST-REC-6': 'When name derivation fails, the admission handle carries the fallback name REC_DEFAULT_NAME_FALLBACK so the fallback is observable in the returned handle, never silent (F-114, CL15-D).',
  'INV-REC-1': 'Sibling names are unique within the parent, including pending spawns (F-115).',
  'INV-REC-LIFETIME-1': 'The parent-scoped registry survives kernel restart, compaction, and parent restore (F-146, A-014).',
  'INV-REC-LIFETIME-2': 'Child usage is folded into the parent assistant turn and persisted as child_usage_attributed (F-131/F-132, A-013).',
  'SEQ-REC-6': 'The TypeScript host SHALL run the depth gate and model resolution BEFORE child admission (SEQ-6, IP-3, F-110).',
  'SEQ-REC-7': 'A finishing child SHALL deliver a parent reply or a terminal notice BEFORE parent turn accounting closes (SEQ-7, IP-4, F-129).',
  'SEQ-REC-8': 'The TypeScript host SHALL attribute child usage into the parent assistant turn BEFORE transcript finalization (SEQ-8, IP-4, F-131).',
  'ERRORS-REC-1': 'Depth exhaustion, unsupported kwargs, invalid names, unavailable models, failed preflight, invalid handles, unknown/ambiguous delete targets, and disposed parents raise with the exact REC_ERR_* strings (F-226..F-234).',
  'FORBIDDEN-REC-1': 'The TypeScript host SHALL NOT return a child answer as the spawn return value (REQ-N-5).',
  'FORBIDDEN-REC-2': 'Deletion SHALL NOT erase child transcripts or artifacts; it tombstones and removes from messaging/observation only (F-144, REQ-RLM-0009, A-014).',
  'FORBIDDEN-REC-3': 'The TypeScript host SHALL NOT substitute a different model on unavailability (F-118, REQ-RLM-0008, A-009).',
} as const

export type RlmRecursionClauseId = keyof typeof RLM_RECURSION_CONTRACT