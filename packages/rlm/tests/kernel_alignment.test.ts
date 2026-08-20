/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).
 *
 * Imports BOTH the contract authority (requirements/contracts/
 * rlm-kernel.contract.ts) and the implementation (packages/rlm/src/
 * kernel.ts), asserting value equality. The implementation redeclares its
 * own values and never imports the contract (audit r2 C7: this file was
 * missing; the kernel.ts header claim was false until now).
 */

import { describe, expect, test } from "bun:test"

import {
  KM_ABORT_GRACE_MS,
  KM_BUSY_INTERRUPT_INTERVAL_MS,
  KM_BUSY_REUSE_WAIT_MS,
  KM_DISPOSE_TIMEOUT_MS,
  KM_LIVENESS_POLL_MS,
  KM_MAX_OUTPUT_CHARS,
  KM_PORTS_RESOLVE_TIMEOUT_MS,
  KM_READY_TIMEOUT_MS,
  KM_SHUTDOWN_GRACE_MS,
  KM_SNAPSHOT_ALWAYS_SKIP,
  KM_SNAPSHOT_DEBOUNCE_MS,
  KM_SNAPSHOT_DISPOSE_TIMEOUT_MS,
  KM_SNAPSHOT_MANIFEST_VERSION,
  KM_SNAPSHOT_MAX_BYTES,
  KM_STDERR_TAIL_CHARS,
  KM_TRUNCATION_MARKER,
} from "../../../requirements/contracts/rlm-kernel.contract.ts"
import {
  ABORT_GRACE_MS,
  BUSY_INTERRUPT_INTERVAL_MS,
  BUSY_REUSE_WAIT_MS,
  DISPOSE_TIMEOUT_MS,
  LIVENESS_POLL_MS,
  MAX_OUTPUT_CHARS,
  PORTS_RESOLVE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  SNAPSHOT_ALWAYS_SKIP,
  SNAPSHOT_DEBOUNCE_MS,
  SNAPSHOT_DISPOSE_TIMEOUT_MS,
  SNAPSHOT_MANIFEST_VERSION,
  SNAPSHOT_MAX_BYTES,
  STDERR_TAIL_CHARS,
  TRUNCATION_MARKER,
} from "../src/kernel.ts"

describe("kernel contract-implementation alignment", () => {
  test("timing and output constants match the contract authority", () => {
    expect(READY_TIMEOUT_MS).toBe(KM_READY_TIMEOUT_MS)
    expect(PORTS_RESOLVE_TIMEOUT_MS).toBe(KM_PORTS_RESOLVE_TIMEOUT_MS)
    expect(MAX_OUTPUT_CHARS).toBe(KM_MAX_OUTPUT_CHARS)
    expect(ABORT_GRACE_MS).toBe(KM_ABORT_GRACE_MS)
    expect(BUSY_REUSE_WAIT_MS).toBe(KM_BUSY_REUSE_WAIT_MS)
    expect(BUSY_INTERRUPT_INTERVAL_MS).toBe(KM_BUSY_INTERRUPT_INTERVAL_MS)
    expect(SHUTDOWN_GRACE_MS).toBe(KM_SHUTDOWN_GRACE_MS)
    expect(DISPOSE_TIMEOUT_MS).toBe(KM_DISPOSE_TIMEOUT_MS)
    expect(SNAPSHOT_DEBOUNCE_MS).toBe(KM_SNAPSHOT_DEBOUNCE_MS)
    expect(SNAPSHOT_DISPOSE_TIMEOUT_MS).toBe(KM_SNAPSHOT_DISPOSE_TIMEOUT_MS)
    expect(SNAPSHOT_MAX_BYTES).toBe(KM_SNAPSHOT_MAX_BYTES)
    expect(STDERR_TAIL_CHARS).toBe(KM_STDERR_TAIL_CHARS)
    expect(LIVENESS_POLL_MS).toBe(KM_LIVENESS_POLL_MS)
    expect(SNAPSHOT_MANIFEST_VERSION).toBe(KM_SNAPSHOT_MANIFEST_VERSION)
    expect(TRUNCATION_MARKER).toBe(KM_TRUNCATION_MARKER)
  })

  test("skip-set matches the contract authority exactly, in order", () => {
    expect([...SNAPSHOT_ALWAYS_SKIP]).toEqual([...KM_SNAPSHOT_ALWAYS_SKIP])
  })
})
