/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).
 *
 * Imports BOTH the contract authority (requirements/contracts/
 * rlm-bootstrap.contract.ts) and the implementation (packages/rlm/src/
 * bootstrap.ts), asserting value equality. The implementation redeclares
 * its own values and never imports the contract.
 *
 * This is NOT RED-phase behavior testing (that is bootstrap.spec.ts); it
 * is the independence bridge that fails on drift between the two sides.
 */

import { describe, expect, test } from "bun:test"

import {
  BOOT_BASE_PACKAGES,
  BOOT_EXTRAS_PACKAGES,
  BOOT_FORK_READY_TIMEOUT_MS,
  BOOT_FORK_SPAWN_TIMEOUT_MS,
  BOOT_LOCK_RETRY_MS,
  BOOT_LOCK_STALE_MS,
  BOOT_PYTHON_VERSION,
  BOOT_RUNTIME_IDENTITY_KIND,
  BOOT_SCHEMA_VERSION,
} from "../../../requirements/contracts/rlm-bootstrap.contract.ts"
import {
  BASE_PACKAGES,
  EXTRAS_PACKAGES,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  PYTHON_VERSION,
  RUNTIME_IDENTITY_KIND,
  SCHEMA_VERSION,
} from "../src/bootstrap.ts"

describe("bootstrap contract-implementation alignment", () => {
  test("numeric and identity constants match the contract authority", () => {
    expect(SCHEMA_VERSION).toBe(BOOT_SCHEMA_VERSION)
    expect(PYTHON_VERSION).toBe(BOOT_PYTHON_VERSION)
    expect(LOCK_STALE_MS).toBe(BOOT_LOCK_STALE_MS)
    expect(LOCK_RETRY_MS).toBe(BOOT_LOCK_RETRY_MS)
    expect(RUNTIME_IDENTITY_KIND).toBe(BOOT_RUNTIME_IDENTITY_KIND)
  })

  test("package sets match the contract authority exactly (Z-4 full extras)", () => {
    expect([...BASE_PACKAGES].sort()).toEqual([...BOOT_BASE_PACKAGES].sort())
    expect([...EXTRAS_PACKAGES].sort()).toEqual([...BOOT_EXTRAS_PACKAGES].sort())
  })

  test("fork budgets exported by the contract remain available to SLICE-3", () => {
    // Readiness/spawn budgets belong to the kernel-manager slice, but the
    // contract carries them; alignment keeps them importable without the
    // implementation redeclaring them yet (no drift possible for constants
    // the implementation does not copy).
    expect(BOOT_FORK_READY_TIMEOUT_MS).toBe(30_000)
    expect(BOOT_FORK_SPAWN_TIMEOUT_MS).toBe(10_000)
  })
})
