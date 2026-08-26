import { describe, it } from "bun:test";
import type { AskpassResolution } from "../../../../requirements/contracts/omp_ssh_askpass_restoration.contract";
import {
	InvalidAskpassCandidateError,
	validateAskpassResolution,
} from "../../../../requirements/contracts/omp_ssh_askpass_restoration.contract";

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT VERIFICATION — NOT RED PHASE.
//
// Per skill://adversarial-test-writer, "Contract-vs-Implementation
// Distinction": `validateAskpassResolution` is the shared resolver's runtime
// validator, defined and already implemented inside the contract file itself
// (requirements/contracts/omp_ssh_askpass_restoration.contract.ts). Testing it
// proves the contract is runtime-enforceable; it does not invoke the OMP
// source-level implementation artifact (packages/coding-agent/src/exec/
// non-interactive-env.ts, packages/coding-agent/src/utils/git.ts), so these
// tests are expected to PASS today. They exist only for PRE-AR-1 / ERRORS-AR-2
// clause-coverage completeness (per task instruction: "Add a focused
// contract-validator test only if required for runtime-artifact coverage"),
// since no black-box observable of the Bash/Git builders exposes the raw
// candidate-validation precondition directly.
//
// Genuine RED coverage for this restoration lives in:
//   packages/coding-agent/test/non-interactive-env.test.ts
//   packages/coding-agent/test/utils/git-clone.test.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("validateAskpassResolution contract validator (supporting, not RED)", () => {
	it("accepts a well-formed candidate (PRE-AR-1) and resolves it as the parent source (POST-AR-1)", () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   C1 VALID: PRE-AR-1, POST-AR-1 (requirements/contracts/omp_ssh_askpass_restoration.contract.ts)
		 *   C2 VALUABLE: a validator that rejects a well-formed candidate
		 *     (PRE-AR-1), or that resolves it to the wrong path/source
		 *     (POST-AR-1), fails this.
		 *   C3 NON-DUPLICATIVE: only test asserting the validator's happy path
		 *     against a well-formed parent candidate.
		 *   C4 NOT FUTURE-EDIT: PRE-AR-1's precondition and POST-AR-1's
		 *     precedence order are satisfied today by a well-formed candidate;
		 *     this is not a hypothetical future shape.
		 * Risk tier: LOW — contract-verification only; the runtime artifact under
		 * restoration is not invoked by this test.
		 * Category: contract-verification (not RED).
		 */
		const candidate = { path: "/tmp/omp-fixture-askpass", executable: true };
		let resolution: AskpassResolution;
		try {
			resolution = validateAskpassResolution({ parent: candidate, fallbacks: [] });
		} catch (error) {
			throw new Error(
				[
					"WHAT: 'accepts a well-formed candidate' FAILED",
					"WHY: PRE-AR-1 violation - a candidate with a non-empty path and boolean executable status was rejected",
					"EXPECTED: validateAskpassResolution returns without throwing",
					`ACTUAL: threw ${String(error)}`,
					"GUIDANCE: a candidate satisfying PRE-AR-1's shape must be accepted for resolution",
				].join("\n"),
			);
		}

		if (resolution.path !== candidate.path || resolution.source !== "parent") {
			throw new Error(
				[
					"WHAT: 'resolves the well-formed candidate as the parent source' FAILED",
					"WHY: POST-AR-1 violation - resolver did not choose the executable parent candidate as the parent source",
					`EXPECTED: { path: ${JSON.stringify(candidate.path)}, source: "parent" }`,
					`ACTUAL: ${JSON.stringify(resolution)}`,
					"GUIDANCE: an executable parent candidate must resolve ahead of generic fallbacks",
				].join("\n"),
			);
		}
	});

	it("raises InvalidAskpassCandidateError citing PRE-AR-1 for a candidate with an empty path (ERRORS-AR-2)", () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   C1 VALID: ERRORS-AR-2 (requirements/contracts/omp_ssh_askpass_restoration.contract.ts)
		 *   C2 VALUABLE: a validator that silently accepts an empty-path
		 *     candidate, or raises the wrong error type/message, fails this.
		 *   C3 NON-DUPLICATIVE: only test asserting the validator's negative
		 *     (error) path for an invalid parent candidate.
		 *   C4 NOT FUTURE-EDIT: ERRORS-AR-2 states this mapping today; it is not
		 *     a hypothetical future validation rule.
		 * Risk tier: LOW — contract-verification only; the runtime artifact under
		 * restoration is not invoked by this test.
		 * Category: contract-verification (not RED).
		 */
		let thrown: unknown;
		try {
			validateAskpassResolution({ parent: { path: "", executable: true }, fallbacks: [] });
		} catch (error) {
			thrown = error;
		}

		if (!(thrown instanceof InvalidAskpassCandidateError)) {
			throw new Error(
				[
					"WHAT: 'raises InvalidAskpassCandidateError citing PRE-AR-1 for an empty path' FAILED",
					"WHY: ERRORS-AR-2 violation - an invalid candidate did not raise InvalidAskpassCandidateError",
					"EXPECTED: instanceof InvalidAskpassCandidateError",
					`ACTUAL: ${thrown === undefined ? "no error thrown" : String(thrown)}`,
					"GUIDANCE: reject a candidate whose PRE-AR-1 precondition (non-empty path) fails",
				].join("\n"),
			);
		}
		if (!thrown.message.includes("PRE-AR-1")) {
			throw new Error(
				[
					"WHAT: 'raises InvalidAskpassCandidateError citing PRE-AR-1 for an empty path' FAILED",
					"WHY: ERRORS-AR-2 violation - the raised error did not cite its PRE-AR-1 clause identifier",
					'EXPECTED: error.message includes "PRE-AR-1"',
					`ACTUAL: ${JSON.stringify(thrown.message)}`,
					"GUIDANCE: the raised error must identify the violated clause by ID",
				].join("\n"),
			);
		}
	});
});
