/**
 * CONTRACT VERIFICATION (supporting tests — NOT RED).
 *
 * These exercise the executable validators that live INSIDE the contract
 * authority (contracts/rlm-native-tool.contract.ts), not the host session
 * implementation. They prove FORBIDDEN-NATIVE-2 is runtime-enforceable and that
 * its read-only predicate classifies every tool-selection class correctly. They
 * pass at RED time by construction and do NOT satisfy the RED requirement — the
 * RED signal lives in native_tool_scope.spec.ts, which drives a live session.
 *
 * CONTRACT AUTHORITY RECORD: see native_tool_scope.spec.ts (same authority file:
 * contracts/rlm-native-tool.contract.ts — PRE 1, POST 2, INV 1, FORBIDDEN 2,
 * ERRORS 1, validators 4).
 *
 * CLAUSE REGISTRY (clauses exercised by THIS file):
 * - PRE-NATIVE-1:       "...the session is not a read-only tool selection
 *                       (isReadOnlyToolSelection(toolNames) is false; an explicit
 *                       toolNames list omitting 'write' is read-only, while an
 *                       absent list is the full default set)."
 * - FORBIDDEN-NATIVE-2: "A read-only session (isReadOnlyToolSelection(toolNames)
 *                       is true) SHALL NOT surface ipython in
 *                       getActiveToolNames() ..."
 * - ERROR (RlmNativeToolContractError): carries the violated `clauseId`.
 *
 * EQUIVALENCE PARTITION RECORD (isReadOnlyToolSelection input domain):
 *   Class A — undefined (no explicit list): NOT read-only. Representative:
 *             `undefined`. This is the on-point boundary between "caller
 *             restricted the tools" and "caller did not".
 *   Class B — explicit list CONTAINING "write": NOT read-only. Representative:
 *             ["read", "write"].
 *   Class C — explicit list OMITTING "write": read-only. Interior
 *             representative: ["read", "grep", "glob", "web_search"]. Boundary
 *             representative: [] (smallest explicit list — the off-point that a
 *             length-based misreading of the predicate would get wrong).
 *
 * RISK TIER: HIGH — this predicate is the gate that decides whether an
 * arbitrary-Python tool may be presented to a session. Misclassifying Class A as
 * read-only silently strips the tool from every default session; misclassifying
 * Class C as not-read-only re-opens the privilege escalation the clause forbids.
 *
 * TEST PYRAMID LEVEL: Unit — the behavior is derivable from the contract alone.
 */

import { describe, expect, test } from "bun:test";

import {
  assertIpythonAbsentForReadOnly,
  isReadOnlyToolSelection,
  NATIVE_TOOL_NAME,
  RlmNativeToolContractError,
} from "../../../contracts/rlm-native-tool.contract.ts";

/** 5-point failure message (CL11-D). Point 5 is behavioral: WHAT, never HOW. */
const fivePoint = (points: {
  what: string;
  why: string;
  expected: string;
  actual: string;
  guidance: string;
}): string =>
  [
    `1. WHAT: ${points.what} FAILED`,
    `2. WHY: ${points.why}`,
    `3. EXPECTED: ${points.expected}`,
    `4. ACTUAL: ${points.actual}`,
    `5. GUIDANCE: ${points.guidance}`,
  ].join("\n");

describe("read-only tool-selection predicate (CONTRACT VERIFICATION — PRE-NATIVE-1)", () => {
  test("PRE-NATIVE-1: an absent tool list is the full default set, not a read-only selection", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-NATIVE-1 — "...an explicit toolNames list omitting 'write'
     *   is read-only, while an absent list is the full default set."
     * - Category: boundary (Class A — the undefined/explicit boundary)
     * - Risk tier: HIGH — classifying Class A as read-only would strip the native
     *   tool from every unrestricted session
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites PRE-NATIVE-1, present in the contract authority
     *   [x] C2 VALUABLE: NO — exact boolean on a deterministic input; the most
     *       plausible wrong predicate (`!toolNames?.includes("write")`, which is
     *       `true` for undefined) fails this and only this test
     *   [x] C3 NON-DUPLICATIVE: the only test observing the undefined input
     *   [x] C4 NOT FUTURE-EDIT: the predicate already branches on undefined today
     */
    expect(
      isReadOnlyToolSelection(undefined),
      fivePoint({
        what: "absent tool list classified as a read-only selection",
        why: "PRE-NATIVE-1 violation — a session that never restricted its tools was treated as read-only",
        expected: "isReadOnlyToolSelection(undefined) === false",
        actual: `isReadOnlyToolSelection(undefined) === ${isReadOnlyToolSelection(undefined)}`,
        guidance:
          "Read-only status must be decided by what an explicit tool list contains; the absence of a list is the full default grant and must never be read as a denial.",
      }),
    ).toBe(false);
  });

  test("PRE-NATIVE-1: an explicit tool list containing write is not a read-only selection", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-NATIVE-1 — read-only is "an explicit toolNames list
     *   omitting 'write'"
     * - Category: positive (Class B — explicit list containing "write")
     * - Risk tier: HIGH — misclassifying Class B denies the native tool to
     *   sessions that hold a full write grant
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites PRE-NATIVE-1
     *   [x] C2 VALUABLE: NO — exact boolean; a predicate keyed on "is there any
     *       explicit list at all" rather than on the write grant fails here
     *   [x] C3 NON-DUPLICATIVE: the only Class B representative
     *   [x] C4 NOT FUTURE-EDIT: bounds the predicate's existing membership test
     */
    const writeGrantingSelection = ["read", "write"];

    expect(
      isReadOnlyToolSelection(writeGrantingSelection),
      fivePoint({
        what: "write-granting tool list classified as a read-only selection",
        why: "PRE-NATIVE-1 violation — a session explicitly granted write was treated as read-only",
        expected: `isReadOnlyToolSelection(${JSON.stringify(writeGrantingSelection)}) === false`,
        actual: `isReadOnlyToolSelection(${JSON.stringify(writeGrantingSelection)}) === ${isReadOnlyToolSelection(writeGrantingSelection)}`,
        guidance:
          "A tool list that grants write is not a denial of writes; only the omission of that grant makes a session read-only.",
      }),
    ).toBe(false);
  });

  test("PRE-NATIVE-1: an explicit tool list omitting write is a read-only selection", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-NATIVE-1 — read-only is "an explicit toolNames list
     *   omitting 'write'"
     * - Category: positive (Class C interior representative)
     * - Risk tier: HIGH — misclassifying Class C re-opens the escalation
     *   FORBIDDEN-NATIVE-2 forbids
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites PRE-NATIVE-1
     *   [x] C2 VALUABLE: NO — exact boolean on a deterministic input
     *   [x] C3 NON-DUPLICATIVE: the only Class C interior representative
     *   [x] C4 NOT FUTURE-EDIT: bounds the predicate's existing membership test
     */
    const readOnlySelection = ["read", "grep", "glob", "web_search"];

    expect(
      isReadOnlyToolSelection(readOnlySelection),
      fivePoint({
        what: "write-omitting tool list not classified as a read-only selection",
        why: "PRE-NATIVE-1 violation — a session explicitly denied write was not treated as read-only",
        expected: `isReadOnlyToolSelection(${JSON.stringify(readOnlySelection)}) === true`,
        actual: `isReadOnlyToolSelection(${JSON.stringify(readOnlySelection)}) === ${isReadOnlyToolSelection(readOnlySelection)}`,
        guidance:
          "An explicit tool list that omits the write grant denotes a session denied working-tree writes, and must be recognized as such before any tool is presented to it.",
      }),
    ).toBe(true);
  });

  test("PRE-NATIVE-1: an empty explicit tool list is a read-only selection", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-NATIVE-1 — read-only is "an explicit toolNames list
     *   omitting 'write'"; the empty list omits it
     * - Category: boundary (Class C off-point — smallest explicit list)
     * - Risk tier: HIGH — a length-based reading of the predicate ("no names
     *   means no restriction") would hand the native tool to a session that was
     *   granted nothing at all
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites PRE-NATIVE-1
     *   [x] C2 VALUABLE: NO — this boundary is the single input that separates
     *       "explicit but empty" from "absent"; a falsy-length guard fails only
     *       here
     *   [x] C3 NON-DUPLICATIVE: distinct from the Class C interior case — they
     *       fail on different wrong predicates
     *   [x] C4 NOT FUTURE-EDIT: bounds the predicate's existing undefined check
     */
    expect(
      isReadOnlyToolSelection([]),
      fivePoint({
        what: "empty explicit tool list not classified as a read-only selection",
        why: "PRE-NATIVE-1 violation — an explicit list that grants nothing was treated as the full default set",
        expected: "isReadOnlyToolSelection([]) === true",
        actual: `isReadOnlyToolSelection([]) === ${isReadOnlyToolSelection([])}`,
        guidance:
          "Emptiness of an explicit tool list is still an explicit denial of write; only the complete absence of a list is the full default grant.",
      }),
    ).toBe(true);
  });
});

describe("read-only native-tool gate (CONTRACT VERIFICATION — FORBIDDEN-NATIVE-2)", () => {
  test("FORBIDDEN-NATIVE-2: the gate rejects a read-only surface that exposes the native tool, naming the clause", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: FORBIDDEN-NATIVE-2 + ERROR (RlmNativeToolContractError carries
     *   the violated clauseId)
     * - Category: error
     * - Risk tier: HIGH — a gate that cannot reject is decorative (CL11-A)
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-2
     *   [x] C2 VALUABLE: NO — asserts the exact error type, the exact clauseId,
     *       and that the message names the offending tool; a silently-passing or
     *       mis-attributed gate fails it
     *   [x] C3 NON-DUPLICATIVE: the only test observing the rejecting branch
     *   [x] C4 NOT FUTURE-EDIT: the validator already evaluates this branch
     */
    const readOnlySelection = ["read", "grep", "glob", "web_search"];
    const violatingSurface = { activeToolNames: ["read", "grep", "glob", "web_search", NATIVE_TOOL_NAME] };

    let caught: unknown = null;
    try {
      assertIpythonAbsentForReadOnly(readOnlySelection, violatingSurface);
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      fivePoint({
        what: "read-only gate accepted a surface exposing the native Python tool",
        why: "FORBIDDEN-NATIVE-2 violation — the enforcement check did not reject a read-only session that exposes the arbitrary-Python tool",
        expected: "a contract error is raised for a read-only selection whose active tools include the native tool",
        actual: `raised = ${caught === null ? "nothing" : String(caught)}`,
        guidance:
          "The obligation must be enforced, not merely described: an exposed arbitrary-Python tool in a write-denied session has to produce an observable, attributable failure.",
      }),
    ).toBeInstanceOf(RlmNativeToolContractError);

    expect(
      (caught as RlmNativeToolContractError).clauseId,
      fivePoint({
        what: "read-only gate reported the wrong clause",
        why: "FORBIDDEN-NATIVE-2 violation — the raised error does not attribute the failure to the clause that was violated",
        expected: 'the raised error carries clauseId "FORBIDDEN-NATIVE-2"',
        actual: `clauseId = ${JSON.stringify((caught as RlmNativeToolContractError).clauseId)}`,
        guidance:
          "Every enforcement failure must name the obligation it enforces so the violation is traceable without reading the check.",
      }),
    ).toBe("FORBIDDEN-NATIVE-2");

    expect(
      (caught as Error).message.includes(NATIVE_TOOL_NAME),
      fivePoint({
        what: "read-only gate failure does not name the exposed tool",
        why: "FORBIDDEN-NATIVE-2 violation — the diagnostic omits the tool whose exposure caused the failure",
        expected: `the failure message names ${NATIVE_TOOL_NAME}`,
        actual: `message = ${JSON.stringify((caught as Error).message)}`,
        guidance:
          "A rejection has to identify which tool breached the denial, so the report is actionable without re-deriving the surface.",
      }),
    ).toBe(true);
  });

  test("FORBIDDEN-NATIVE-2: the gate accepts a read-only surface without the native tool", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: FORBIDDEN-NATIVE-2 (compliant branch)
     * - Category: positive
     * - Risk tier: HIGH — a gate that rejects compliant surfaces would block the
     *   very fix the clause demands
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-2
     *   [x] C2 VALUABLE: NO — an always-throwing gate fails here while passing
     *       the rejection test, so the pair pins both branches
     *   [x] C3 NON-DUPLICATIVE: complementary branch to the rejection test
     *   [x] C4 NOT FUTURE-EDIT: bounds the validator's existing accepting path
     */
    const readOnlySelection = ["read", "grep", "glob", "web_search"];
    const compliantSurface = { activeToolNames: ["read", "grep", "glob", "web_search"] };

    let caught: unknown = null;
    try {
      assertIpythonAbsentForReadOnly(readOnlySelection, compliantSurface);
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      fivePoint({
        what: "read-only gate rejected a compliant surface",
        why: "FORBIDDEN-NATIVE-2 violation — a read-only session with no arbitrary-Python tool was reported as a violation",
        expected: "no error is raised when a read-only selection's active tools exclude the native tool",
        actual: `raised = ${caught === null ? "nothing" : String(caught)}`,
        guidance:
          "The obligation is satisfied by absence; a surface that already excludes the arbitrary-Python tool must be accepted without complaint.",
      }),
    ).toBeNull();
  });

  test("FORBIDDEN-NATIVE-2: the gate is scoped by the read-only predicate and does not fire for an absent tool list", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: FORBIDDEN-NATIVE-2 ("A read-only session ... SHALL NOT ...")
     *   read together with PRE-NATIVE-1 (an absent list is NOT read-only)
     * - Category: negative (scope boundary)
     * - Risk tier: HIGH — a gate that fires for every session would contradict
     *   POST-NATIVE-1, which requires the tool present for default sessions
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-2 and PRE-NATIVE-1
     *   [x] C2 VALUABLE: NO — dropping the predicate guard from the gate leaves
     *       the predicate tests passing and fails only this one
     *   [x] C3 NON-DUPLICATIVE: observes the gate's scoping, not the predicate's
     *       return value
     *   [x] C4 NOT FUTURE-EDIT: the validator already performs this scope check
     */
    const fullDefaultSurface = { activeToolNames: ["read", "write", "bash", NATIVE_TOOL_NAME] };

    let caught: unknown = null;
    try {
      assertIpythonAbsentForReadOnly(undefined, fullDefaultSurface);
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      fivePoint({
        what: "read-only gate fired for a session with no explicit tool list",
        why: "FORBIDDEN-NATIVE-2 violation — the read-only prohibition was applied to a session holding the full default grant, contradicting POST-NATIVE-1",
        expected: "no error is raised when the session has no explicit tool list, even if the native tool is present",
        actual: `raised = ${caught === null ? "nothing" : String(caught)}`,
        guidance:
          "The prohibition applies only to sessions that explicitly denied write; sessions holding the full default grant are required to expose the native Python tool, so the gate must not reach them.",
      }),
    ).toBeNull();
  });

  test("FORBIDDEN-NATIVE-2: the gate fails loud on a read-only surface it cannot inspect", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: FORBIDDEN-NATIVE-2 + ERROR (RlmNativeToolContractError) —
     *   enforcement must not fail open (CL9-A: no silent fallback)
     * - Category: error (fault injection at the enforcement boundary)
     * - Risk tier: HIGH — a gate that passes an uninspectable surface would let
     *   the escalation through whenever the surface shape changes
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-2
     *   [x] C2 VALUABLE: NO — injects the fault at the earliest point the check
     *       could be bypassed (the surface it reads) and asserts the exact error
     *       type and clause attribution
     *   [x] C3 NON-DUPLICATIVE: no other test injects an unreadable surface
     *   [x] C4 NOT FUTURE-EDIT: the validator already inspects the surface shape
     */
    const readOnlySelection = ["read", "grep", "glob", "web_search"];
    const uninspectableSurface = { someOtherShape: ["read"] };

    let caught: unknown = null;
    try {
      assertIpythonAbsentForReadOnly(readOnlySelection, uninspectableSurface);
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      fivePoint({
        what: "read-only gate accepted a surface it could not inspect",
        why: "FORBIDDEN-NATIVE-2 violation — enforcement failed open when the tool surface was not readable",
        expected: "a contract error is raised when a read-only session's tool surface cannot be inspected",
        actual: `raised = ${caught === null ? "nothing" : String(caught)}`,
        guidance:
          "An unverifiable surface is not a compliant one: when the prohibition cannot be checked, the outcome must be an observable failure, never silent acceptance.",
      }),
    ).toBeInstanceOf(RlmNativeToolContractError);

    expect(
      (caught as RlmNativeToolContractError).clauseId,
      fivePoint({
        what: "uninspectable-surface rejection reported the wrong clause",
        why: "FORBIDDEN-NATIVE-2 violation — the raised error does not attribute the failure to the clause being enforced",
        expected: 'the raised error carries clauseId "FORBIDDEN-NATIVE-2"',
        actual: `clauseId = ${JSON.stringify((caught as RlmNativeToolContractError).clauseId)}`,
        guidance:
          "Every enforcement failure must name the obligation it enforces so the violation is traceable without reading the check.",
      }),
    ).toBe("FORBIDDEN-NATIVE-2");
  });
});
