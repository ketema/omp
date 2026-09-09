/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).
 *
 * Imports BOTH the contract authority (requirements/contracts/
 * rlm-tool.contract.ts) and the implementation (packages/rlm/src/tool.ts),
 * asserting value equality. The implementation redeclares its own values
 * and never imports the contract (Contract-Implementation Independence).
 *
 * At RED time ../src/tool.ts does not exist: this file fails with a
 * module-resolution error, which is the canonical RED signal.
 */

import { describe, expect, test } from "bun:test"

import {
  RlmRuntimeMissingError as ContractRuntimeMissingError,
  TOOL_BUSY_CHOICES as CONTRACT_BUSY_CHOICES,
  TOOL_EXECUTION_MODE as CONTRACT_EXECUTION_MODE,
  TOOL_NAME as CONTRACT_TOOL_NAME,
  TOOL_PROMPT_SNIPPET as CONTRACT_PROMPT_SNIPPET,
  TOOL_RESTART_NOTICE_CLOSE as CONTRACT_NOTICE_CLOSE,
  TOOL_RESTART_NOTICE_OPEN as CONTRACT_NOTICE_OPEN,
  TOOL_WORKING_MESSAGES as CONTRACT_WORKING_MESSAGES,
} from "../../../requirements/contracts/rlm-tool.contract.ts"
import {
  RlmRuntimeMissingError,
  TOOL_BUSY_CHOICES,
  TOOL_EXECUTION_MODE,
  TOOL_NAME,
  TOOL_PROMPT_SNIPPET,
  TOOL_RESTART_NOTICE_CLOSE,
  TOOL_RESTART_NOTICE_OPEN,
  TOOL_WORKING_MESSAGES,
} from "../src/tool.ts"

describe("tool contract-implementation alignment", () => {
  test("identity and mode constants match the contract authority", () => {
    expect(TOOL_NAME).toBe(CONTRACT_TOOL_NAME)
    expect(TOOL_PROMPT_SNIPPET).toBe(CONTRACT_PROMPT_SNIPPET)
    expect(TOOL_EXECUTION_MODE).toBe(CONTRACT_EXECUTION_MODE)
  })

  test("restart-notice tags match the contract authority exactly", () => {
    expect(TOOL_RESTART_NOTICE_OPEN).toBe(CONTRACT_NOTICE_OPEN)
    expect(TOOL_RESTART_NOTICE_CLOSE).toBe(CONTRACT_NOTICE_CLOSE)
  })

  test("working messages match the contract authority exactly, in order", () => {
    expect([...TOOL_WORKING_MESSAGES]).toEqual([...CONTRACT_WORKING_MESSAGES])
  })

  test("busy choices match the contract authority exactly, in order", () => {
    expect([...TOOL_BUSY_CHOICES]).toEqual([...CONTRACT_BUSY_CHOICES])
  })

  test("runtime-missing error message matches the contract shape (ERRORS-TOOL-1)", () => {
    const guidance = "the interpreter override and rebuild path"
    expect(new RlmRuntimeMissingError(guidance).message).toBe(
      new ContractRuntimeMissingError(guidance).message,
    )
  })
})
