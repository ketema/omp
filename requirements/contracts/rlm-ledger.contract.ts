/**
 * RLM Ledger Contract — specification authority (TypeScript, per user
 * directive; the Python implementation redeclares its own values and never
 * imports this file; alignment tests import both).
 *
 * WHAT the harness ledger guarantees (kinds, CRUD semantics, durability,
 * re-sync, overview shape), NOT how the Python store persists.
 *
 * Traceability: REQ-RLM-0007, REQ-RLM-0018; F-090..F-108; IP-7;
 * SEQ-9/SEQ-10; A-008.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-090: ledger kinds, fixed order. */
export const LED_KINDS: readonly ['prompt', 'memory', 'skill', 'subagent'] = [
  'prompt', 'memory', 'skill', 'subagent',
] as const
/** F-091: scopes. */
export const LED_SCOPES: readonly ['local', 'global'] = ['local', 'global'] as const
/** F-107: on-disk schema version. */
export const LED_SCHEMA_VERSION = 1
/** F-097: auto-id slug max length. */
export const LED_ID_MAX_CHARS = 80
/** F-104: entries per kind in overview. */
export const LED_OVERVIEW_PER_KIND = 20
/** F-104: content truncation in overview. */
export const LED_OVERVIEW_TRUNCATE_CHARS = 120
/** F-104: refinements shown in overview. */
export const LED_OVERVIEW_REFINEMENTS = 5
/** F-100: session-local ledger file, relative to session dir. */
export const LED_LOCAL_FILE = 'harness/harness_state.json'
/** F-100: global ledger file, relative to agent dir. */
export const LED_GLOBAL_FILE = 'harness/harness_state.json'
/** F-092: default entry version. */
export const LED_ENTRY_VERSION_DEFAULT = 1
/** F-105: refinement id prefix. */
export const LED_REFINEMENT_PREFIX = 'refine_'

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmLedgerContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmLedgerContractError'
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** F-092: one ledger entry. snake_case over the wire and on disk. */
export interface HarnessEntry {
  readonly id: string
  readonly kind: (typeof LED_KINDS)[number]
  readonly title: string
  readonly content: string
  readonly path: string
  readonly scope: (typeof LED_SCOPES)[number]
  readonly reference: Record<string, unknown> | null
  readonly arguments: Record<string, unknown> | null
  readonly metadata: Record<string, unknown> | null
  readonly source: string
  readonly created_at: string
  readonly updated_at: string
  readonly version: number
}

/** F-093: one refinement event. */
export interface RefinementEvent {
  readonly id: string
  readonly trigger: string
  readonly changes: string
  readonly evidence: string
  readonly outcome: string
  readonly created_at: string
}

/** F-106/F-107: on-disk state file. */
export interface HarnessStateFile {
  readonly schema: 1
  readonly entries: Record<string, Record<string, unknown>>
  readonly refinements: RefinementEvent[]
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * LED-V1: kind membership (F-090).
 */
export function validateKind(kind: string): string {
  if (!LED_KINDS.includes(kind as 'prompt')) {
    throw new RlmLedgerContractError(
      `LED-V1 violation: kind must be one of ${LED_KINDS.join('|')}, got ${JSON.stringify(kind)}`,
    )
  }
  return kind
}

/**
 * LED-V2: create-if-absent / update-delete-if-exists semantics (F-095).
 */
export function validateCrudPrecondition(
  operation: 'create' | 'update' | 'delete',
  exists: boolean,
): void {
  const ok = operation === 'create' ? !exists : exists
  if (!ok) {
    throw new RlmLedgerContractError(
      `LED-V2 violation: ${operation} on ${exists ? 'an existing' : 'a missing'} entry violates create-if-absent rules`,
    )
  }
}

/**
 * LED-V3: auto-slug shape (F-097).
 */
export function validateSlugId(id: string): string {
  if (!/^[a-z0-9_]+$/.test(id) || id.length > LED_ID_MAX_CHARS) {
    throw new RlmLedgerContractError(
      `LED-V3 violation: id must be a slug of [a-z0-9_] at most ${LED_ID_MAX_CHARS} chars, got ${JSON.stringify(id)}`,
    )
  }
  return id
}

/**
 * LED-V4: overview truncation (F-104). Content longer than 120 chars
 * renders as its first 117 characters followed by '...'.
 */
export function validateOverviewTruncation(content: string, rendered: string): string {
  const expected = content.length > LED_OVERVIEW_TRUNCATE_CHARS
    ? `${content.slice(0, LED_OVERVIEW_TRUNCATE_CHARS - 3)}...`
    : content
  if (rendered !== expected) {
    throw new RlmLedgerContractError('LED-V4 violation: overview content truncation mismatch')
  }
  return rendered
}

/**
 * LED-V5: state file shape (F-107).
 */
export function validateStateFile(candidate: unknown): HarnessStateFile {
  const s = candidate as Partial<HarnessStateFile> | null
  if (
    s === null || typeof s !== 'object'
    || s.schema !== LED_SCHEMA_VERSION
    || typeof s.entries !== 'object' || s.entries === null
    || !Array.isArray(s.refinements)
  ) {
    throw new RlmLedgerContractError(
      'LED-V5 violation: state file must be schema 1 with entries object and refinements array',
    )
  }
  return s as HarnessStateFile
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_LEDGER_CONTRACT = {
  'PRE-LED-1': 'CRUD operations name a valid kind and respect create-if-absent rules (F-090/F-095, LED-V1/V2).',
  'POST-LED-1': 'Every mutation saves to disk immediately after the CRUD completes (F-096, SEQ-9).',
  'POST-LED-2': 'Updates preserve omitted path/reference/arguments/metadata and bump version and updated_at (F-099).',
  'POST-LED-3': 'record_refinement mints ids refine_0001… sequential (F-105).',
  'POST-LED-4': 'Overview renders at most 20 entries/kind with the +N marker, 120-char truncation, [scope:id] lines, and the last 5 refinements (F-104, LED-V4).',
  'INV-LED-1': 'Auto-generated ids are slugs ≤80 chars (F-097, LED-V3); a title that slugifies to the empty string SHALL be rejected, never persisted under an empty id; an explicit id SHALL be a non-empty, non-whitespace string (empty and whitespace-only ids are equally invalid).',
  'INV-LED-3': 'An entry lives in exactly one store, selected at creation by its scope; the scope of an existing entry SHALL NOT change via update (scope is immutable post-create; moving stores is not an update).',
  'INV-LED-4': 'list(kind) and overview() render both scopes: the store stamps each loaded entry with the scope of its owning store, so every listed entry carries a scope field; overview renders global entries as [global:id] lines (F-104 scope lines).',
  'INV-LED-2': 'Host-written and kernel-written state never clobber each other: the store reflects external modification before the next kernel-side access, where access includes reads AND mutations (a create/update/delete must not overwrite concurrent external writes it never saw) (F-098, SEQ-10).',
  'INV-LED-LIFETIME-1': 'From first load through session end, a corrupt or unreadable state file yields an empty state AND emits a corruption notice naming the affected file, so the data loss is observable to the Model and User; the notice channel for this slice is the module logger (logger rlm_ledger); SLICE-4 wires model-visible delivery; the next save rewrites the file cleanly (F-108, CL15-D).',
  'INV-LED-LIFETIME-2': 'The `global_` kwarg routes entries to the global scope because `global` is a reserved word (F-107); the global store SHALL have a distinct file from the local store — constructing a HarnessState whose local and global files resolve to the same path (after path resolution, so symlinked directories cannot alias one file) is a configuration error and SHALL raise.',
  'ERRORS-LED-1': 'Duplicate create, missing update/delete, and unknown kinds raise ValueError-equivalents naming the violated rule (F-095). The load boundary validates file structure at every level (file, kind bucket, entry, refinement row): corrupt units degrade to WARNING + skip, never a raw exception; entries with malformed field values are retained and raise the domain error naming the entry when accessed through get/list/overview or mutated through update — delete is the remediation path and SHALL succeed on malformed entries. Every public surface validates its arguments (string ids/titles/paths, dict-or-None structured fields, boolean global_, unhashable selectors) and raises the domain error — never a raw TypeError or AttributeError.',
  'FORBIDDEN-LED-1': 'The ledger SHALL NOT lose an omitted field on update (F-099, REQ-RLM-0007, A-008).',
  'FORBIDDEN-LED-2': 'The Python store SHALL NOT run an agent loop or resolve provider credentials (A-008, REQ-RLM-0018).',
} as const

export type RlmLedgerClauseId = keyof typeof RLM_LEDGER_CONTRACT