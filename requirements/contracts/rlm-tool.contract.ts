/**
 * RLM Tool Contract — specification authority.
 *
 * WHAT the model-facing tool must guarantee (schema, result shaping,
 * notices), NOT how the tool executes cells.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0002, REQ-RLM-0005, REQ-RLM-0019, REQ-N-1, REQ-N-2;
 * F-020..F-032, F-040..F-062, F-037/F-237; A-006; IP-1, IP-9; manifest SEQ-13.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-020: the model-facing tool name. */
export const TOOL_NAME = 'ipython'
/** F-022: exact promptSnippet string. */
export const TOOL_PROMPT_SNIPPET =
  'ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration'
/** F-021: declared execution mode. */
export const TOOL_EXECUTION_MODE = 'sequential'
/** F-029: restart-notice opening tag. */
export const TOOL_RESTART_NOTICE_OPEN = '[ipython_kernel_reset]'
/** F-029: restart-notice closing tag. */
export const TOOL_RESTART_NOTICE_CLOSE = '[/ipython_kernel_reset]'
/** F-030: working messages, exact strings. */
export const TOOL_WORKING_MESSAGES: readonly string[] = [
  'Starting IPython kernel...',
  'Restoring IPython state...',
  'Preparing IPython runtime...',
] as const
/** F-028: busy-kernel UI choice labels, exact. */
export const TOOL_BUSY_CHOICES: readonly [string, string] = [
  'Wait and preserve state',
  'Kill kernel and restart',
] as const

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmToolContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmToolContractError'
  }
}

/** F-237: runtime missing from the kernel environment. */
export class RlmRuntimeMissingError extends RlmToolContractError {
  constructor(kernelGuidance: string) {
    super(
      `rlm-runtime is not installed in this IPython kernel; rebuild via ${kernelGuidance}`,
    )
    this.name = 'RlmRuntimeMissingError'
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** F-020: the tool's complete parameter schema. */
export interface RlmToolParameters {
  readonly code: string
}

/** F-031: details attached to every result. Required-key shape with
 * undefined-able optional semantics so kernel results assign directly
 * under exactOptionalPropertyTypes (matches KernelExecutionResult). */
export interface RlmToolResultDetails {
  readonly durationMs: number
  readonly status: 'ok' | 'error' | 'aborted'
  readonly errorEname: string | undefined
  readonly kernelRestarted: boolean | undefined
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * TOOL-V1: the tool schema accepts exactly one string parameter `code`
 * (F-020). Extra parameters are a contract violation.
 */
export function validateToolParameters(params: unknown): RlmToolParameters {
  if (
    typeof params !== 'object' || params === null
    || !('code' in params) || typeof (params as { code: unknown }).code !== 'string'
    || Object.keys(params).length !== 1
  ) {
    throw new RlmToolContractError(
      'TOOL-V1 violation: tool parameters must be exactly { code: string }',
    )
  }
  return params as RlmToolParameters
}

/**
 * TOOL-V2: isError must be true iff status is error or aborted (F-032).
 */
export function validateIsErrorConsistency(
  status: RlmToolResultDetails['status'],
  isError: boolean,
): boolean {
  const expected = status === 'error' || status === 'aborted'
  if (isError !== expected) {
    throw new RlmToolContractError(
      `TOOL-V2 violation: isError must be ${expected} for status ${status}, got ${isError}`,
    )
  }
  return isError
}

/**
 * TOOL-V3: restart notice text is wrapped in the exact tags, and the notice
 * appears only after an interrupt→kill→restart sequence (F-029).
 */
export function validateRestartNotice(notice: string): string {
  if (
    !notice.startsWith(TOOL_RESTART_NOTICE_OPEN)
    || !notice.endsWith(TOOL_RESTART_NOTICE_CLOSE)
  ) {
    throw new RlmToolContractError(
      'TOOL-V3 violation: restart notice must be wrapped in [ipython_kernel_reset] tags',
    )
  }
  return notice
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_TOOL_CONTRACT = {
  'PRE-TOOL-1': 'The Model invokes the tool with exactly { code: string } (F-020, TOOL-V1).',
  'POST-TOOL-1': 'Every result carries details with durationMs and status (F-031).',
  'POST-TOOL-2': 'isError is true iff status is error or aborted (F-032, TOOL-V2).',
  'POST-TOOL-3': 'A restart notice appears only after interrupt→kill→restart, wrapped in exact tags (F-029, TOOL-V3).',
  'POST-TOOL-4': 'Working messages appear at kernel start, state restore, and runtime prep, and clear on completion (F-030).',
  'POST-TOOL-5': 'The prompt contract F-040..F-062 is delivered through the tool description and system-prompt additions (REQ-RLM-0005).',
  'INV-TOOL-1': 'The tool declares executionMode "sequential"; cells never overlap (F-021, INV-KM-1).',
  'INV-TOOL-LIFETIME-1': 'From first invocation, a busy kernel offers exactly the two choices of TOOL_BUSY_CHOICES in interactive UIs, or auto-cancels in non-UI contexts (F-028).',
  'ERRORS-TOOL-1': 'RlmRuntimeMissingError names the interpreter override and rebuild path when the runtime fails to import (F-237).',
  'FORBIDDEN-TOOL-1': 'The RLM plugin SHALL NOT alter the existing eval tool, its kernel registry, or runner semantics (REQ-N-1).',
  'FORBIDDEN-TOOL-2': 'The RLM plugin SHALL NOT add mandatory main-context sections beyond the tool description adjoining the tool inventory (REQ-N-2).',
  'SEQ-TOOL-1': 'The RLM extension registers the tool wired through a KernelManager whose transport is constructed from the resolved config (REQ-RLM-0019); the first model invocation reaches the real runner with no additional wiring step (manifest SEQ-13, IP-9).',
} as const

export type RlmToolClauseId = keyof typeof RLM_TOOL_CONTRACT