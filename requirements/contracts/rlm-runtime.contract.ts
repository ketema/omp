/**
 * RLM Runtime Contract — specification authority.
 *
 * WHAT the kernel-side Python runtime (packages/rlm/python/rlm-runtime,
 * importable module `rlm`) must guarantee: in-kernel skill wrapping, the
 * unavailable-skill shim, the lazy MCP integration surface, and the
 * host_request caller that routes typed requests to the host bridge. NOT how
 * the host dispatches those requests (bridge contract) nor how the transport
 * carries the frames (transport contract).
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0020, REQ-RLM-0021, REQ-RLM-0022, REQ-RLM-0006
 * (host_request caller), REQ-N-3; F-026/F-027 (skill wrapping/shim),
 * F-071/F-072/F-073 (host_request), F-080 (lazy MCP exports), F-164
 * (mcp.refresh/mcp.config); IP-2; A-012 (trust boundary).
 *
 * Added by the 2026-08-17 constitutional-refactor (MCP + in-kernel skills
 * disconnect matrix B1..B5).
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-027: run/call error template for an unavailable skill (%s = name, %s = import error). */
export const RT_UNAVAILABLE_RUN_ERROR =
  'Python skill %s is unavailable in this IPython kernel. Import error: %s'

/** F-027: repr prefix that identifies an unavailable-skill shim. */
export const RT_UNAVAILABLE_REPR_PREFIX = '<unavailable Python skill '

/** F-080: names the rlm module exposes lazily via __getattr__ (never hard-imported). */
export const RT_MCP_LAZY_EXPORTS: readonly ['McpIntegration', 'McpToolError', 'NotEnabled'] = [
  'McpIntegration',
  'McpToolError',
  'NotEnabled',
]

/** F-071: host_request reply statuses the caller must settle. */
export const RT_HOST_REPLY_STATUSES: readonly ['ok', 'error', 'unexpected'] = [
  'ok',
  'error',
  'unexpected',
]

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmRuntimeContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmRuntimeContractError'
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** F-073: the reply envelope the host_request caller settles against. */
export interface RtHostReply {
  readonly status: (typeof RT_HOST_REPLY_STATUSES)[number]
  /** Present on status 'ok'; the reply payload minus the status key. */
  readonly data?: Readonly<Record<string, unknown>>
  /** Present on status 'error'. */
  readonly error?: string
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * PRE-RT-1 / ERRORS-RT-1: host_request argument validation (F-071).
 * type must be a non-empty str; payload must be a dict (object) or None.
 */
export function validateHostRequestArgs(type: unknown, payload: unknown): string {
  if (typeof type !== 'string' || type.length === 0) {
    throw new RlmRuntimeContractError(
      'PRE-RT-1 violation: host_request type must be a non-empty str',
    )
  }
  if (
    payload !== null
    && payload !== undefined
    && (typeof payload !== 'object' || Array.isArray(payload))
  ) {
    throw new RlmRuntimeContractError(
      'PRE-RT-1 violation: host_request payload must be a dict or None',
    )
  }
  return type
}

/**
 * POST-RT-2 / ERRORS-RT-2: unavailable-skill run error matches the exact
 * template (F-027).
 */
export function validateUnavailableSkillRunError(
  name: string,
  importError: string,
  rendered: string,
): string {
  const expected = RT_UNAVAILABLE_RUN_ERROR.replace('%s', name).replace('%s', importError)
  if (rendered !== expected) {
    throw new RlmRuntimeContractError(
      `POST-RT-2 violation: unavailable-skill run error must be exactly ${JSON.stringify(expected)}`,
    )
  }
  return rendered
}

/**
 * POST-RT-2: unavailable-skill repr identifies the shim and carries the name
 * and the import error (F-027).
 */
export function validateUnavailableSkillRepr(
  name: string,
  importError: string,
  rendered: string,
): string {
  if (
    !rendered.startsWith(RT_UNAVAILABLE_REPR_PREFIX)
    || !rendered.includes(name)
    || !rendered.includes(importError)
  ) {
    throw new RlmRuntimeContractError(
      'POST-RT-2 violation: unavailable-skill repr must start with '
      + `${JSON.stringify(RT_UNAVAILABLE_REPR_PREFIX)} and contain the name and import error`,
    )
  }
  return rendered
}

/**
 * POST-RT-3: the lazy MCP export surface is exactly the three names (F-080).
 */
export function validateMcpLazyExports(exports: readonly string[]): readonly string[] {
  for (const name of RT_MCP_LAZY_EXPORTS) {
    if (!exports.includes(name)) {
      throw new RlmRuntimeContractError(
        `POST-RT-3 violation: rlm must lazily export ${name} (F-080)`,
      )
    }
  }
  return exports
}

/**
 * POST-RT-5: a host reply carries a known status (F-073). Unknown statuses
 * settle the future as 'unexpected', never silently as ok.
 */
export function validateHostReplyStatus(status: unknown): (typeof RT_HOST_REPLY_STATUSES)[number] {
  if (typeof status !== 'string' || !(RT_HOST_REPLY_STATUSES as readonly string[]).includes(status)) {
    return 'unexpected'
  }
  return status as (typeof RT_HOST_REPLY_STATUSES)[number]
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_RUNTIME_CONTRACT = {
  'PRE-RT-1': 'host_request rejects a non-str/empty type and a non-dict payload with TypeError before any frame is sent (F-071).',
  'POST-RT-1': 'Each installed Python skill with a callable run imported into the kernel is wrapped into a callable module whose __call__ awaits run (awaitable or not), copies __signature__ and __doc__ from run, and is cached in sys.modules (F-026, REQ-RLM-0020).',
  'POST-RT-2': 'A skill that fails to import is bound to a shim whose repr identifies it as unavailable (RT_UNAVAILABLE_REPR_PREFIX) and whose run/__call__ raises carrying the recorded import error (RT_UNAVAILABLE_RUN_ERROR) (F-027, REQ-RLM-0021).',
  'POST-RT-3': 'rlm exposes McpIntegration, McpToolError, and NotEnabled lazily via __getattr__ so importing rlm never requires the optional mcp SDK (F-080, REQ-RLM-0022).',
  'POST-RT-4': 'McpIntegration discovers and invokes MCP tools by routing every request — including credential resolution and token refresh — through host_request to the host bridge; mcp.refresh failure throws and mcp.config returns resolved url/headers honoring the host override (F-164, REQ-RLM-0022).',
  'POST-RT-5': 'host_request settles the awaiting future exactly once — ok, error, or unexpected — on a host_reply frame distinct from the execution done frame, suspending the in-flight cell without deadlocking it (F-072/F-073, REQ-RLM-0006).',
  'INV-RT-LIFETIME-1': 'Every host_request future settles (ok, error, or unexpected) from first use through kernel shutdown; no future is left pending (cross-ref INV-BR-LIFETIME-1).',
  'ERRORS-RT-1': 'host_request with a non-str/empty type or a non-dict payload raises TypeError; a host error or unexpected reply raises RuntimeError (F-071/F-073).',
  'ERRORS-RT-2': 'Calling an unavailable skill run/__call__ raises RuntimeError carrying the recorded import error (F-027).',
  'FORBIDDEN-RT-1': 'The rlm runtime and McpIntegration SHALL NOT read credentials, auth stores, or tokens from the filesystem or environment in the Python process; all credential resolution routes through host_request to the host (REQ-N-3, REQ-RLM-0017, F-207, cross-ref FORBIDDEN-BR-2).',
  'FORBIDDEN-RT-2': 'Skill wrapping SHALL NOT alter a module that has no callable run and SHALL NOT re-wrap an already-wrapped module (F-026 idempotence).',
} as const

export type RlmRuntimeClauseId = keyof typeof RLM_RUNTIME_CONTRACT
