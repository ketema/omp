/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT for the RLM native tool.
 *
 * Imports BOTH the contract authority (contracts/rlm-native-tool.contract.ts)
 * and the real host surface, asserting they agree. The implementation
 * redeclares its own predicate and never imports the contract (CL11-F); this
 * file is the bridge that makes the two copies observably equivalent.
 *
 * Closes audit findings:
 *   #5 POST-NATIVE-2 named defaultLoadModeForToolName('ipython') but no test
 *      called it; the enforcing test read a different observable.
 *   #6 the implementation's predicate was exercised at the session surface by
 *      only two inputs, so a mutation of its copy passed every test.
 *   #7 INV-NATIVE-1 spans "through session disposal" but every observation
 *      was a single post-initialization instant.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultLoadModeForToolName } from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";

import {
	NATIVE_TOOL_LOAD_MODE,
	NATIVE_TOOL_NAME,
	isReadOnlyToolSelection,
} from "../../../contracts/rlm-native-tool.contract.ts";

const fivePoint = (p: {
	what: string;
	why: string;
	expected: string;
	actual: string;
	guidance: string;
}): string =>
	[
		`1. WHAT: ${p.what} FAILED`,
		`2. WHY: ${p.why}`,
		`3. EXPECTED: ${p.expected}`,
		`4. ACTUAL: ${p.actual}`,
		`5. GUIDANCE: ${p.guidance}`,
	].join("\n");

describe("POST-NATIVE-2 at the observable the clause names (audit #5)", () => {
	test("POST-NATIVE-2: defaultLoadModeForToolName('ipython') evaluates to the contracted mode", () => {
		// The clause names this resolver literally. Reading the registered
		// tool's loadMode instead left the named observable unobserved: an
		// implementation declaring the mode on the registration satisfied the
		// old test while this resolver still answered "discoverable".
		const resolved = defaultLoadModeForToolName(NATIVE_TOOL_NAME);
		expect(
			resolved,
			fivePoint({
				what: "the resolver the clause names does not answer with the contracted mode",
				why: "POST-NATIVE-2 violation — the named resolver returned a different presentation mode",
				expected: `defaultLoadModeForToolName("${NATIVE_TOOL_NAME}") === "${NATIVE_TOOL_LOAD_MODE}"`,
				actual: `defaultLoadModeForToolName("${NATIVE_TOOL_NAME}") === ${JSON.stringify(resolved)}`,
				guidance:
					"The value the specification names must be the value the system resolves; satisfying it by a different route leaves the named obligation unobserved.",
			}),
		).toBe(NATIVE_TOOL_LOAD_MODE);
	});
});

describe("PRE-NATIVE-1 contract/implementation predicate alignment (audit #6)", () => {
	// Every selection class, asserted at the SESSION surface, which runs the
	// implementation's own copy of the predicate. The contract's copy is a
	// DIFFERENT artifact (CL11-F), so agreement must be observed, not assumed.
	const classes: ReadonlyArray<{ label: string; toolNames: string[] | undefined }> = [
		{ label: "Class A — absent list (full default grant)", toolNames: undefined },
		{ label: "Class B — grants write", toolNames: ["read", "write"] },
		{ label: "Class C — grants read, omits write", toolNames: ["read", "grep"] },
		{ label: "Class D — write-capable, omits read", toolNames: ["bash", "edit"] },
		{ label: "Class E — empty explicit list", toolNames: [] },
	];

	for (const { label, toolNames } of classes) {
		test(`PRE-NATIVE-1: ${label} — host placement matches the contract predicate`, async () => {
			const contractSaysReadOnly = isReadOnlyToolSelection(toolNames);
			const { session } = await createAgentSession({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "rlm-native-align-")), toolNames });
			try {
				const active = session.getActiveToolNames();
				const mounted = session.getMountedXdevToolNames?.() ?? [];
				const reachable = active.includes(NATIVE_TOOL_NAME) || mounted.includes(NATIVE_TOOL_NAME);
				expect(
					reachable,
					fivePoint({
						what: `host placement disagrees with the contract predicate for ${label}`,
						why: "PRE-NATIVE-1 / FORBIDDEN-NATIVE-2 violation — the implementation's predicate copy classified this selection differently from the contract's",
						expected: `reachable === ${!contractSaysReadOnly} (contract says read-only = ${contractSaysReadOnly})`,
						actual: `reachable = ${reachable}; active = ${JSON.stringify(active)}; devices = ${JSON.stringify(mounted)}`,
						guidance:
							"A session must reach the native tool on exactly the selections the specification does not classify as write-denied; the two classifications must agree for every selection class.",
					}),
				).toBe(!contractSaysReadOnly);
			} finally {
				await session.dispose();
			}
		});
	}
});

describe("INV-NATIVE-1 survives mid-session reselection (audit #7)", () => {
	test("INV-NATIVE-1: the native tool remains top-level after a mid-session tool reselection", async () => {
		// The invariant spans "through session disposal". applyActiveToolsByName
		// rebuilds the active set from a caller-supplied NAME list and does not
		// re-apply the initialization-time pin, so the invariant has a live
		// falsification path that no single post-init observation can see.
		const { session } = await createAgentSession({
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "rlm-native-align-")),
		});
		try {
			const before = session.getActiveToolNames();
			expect(before).toContain(NATIVE_TOOL_NAME);

			if (!("setActiveToolsByName" in session)) {
				throw new Error(
					"INV-NATIVE-1 test cannot run: no setActiveToolsByName reselection path on the session surface",
				);
			}
			const reselect = session.setActiveToolsByName;
			if (typeof reselect !== "function") {
				throw new Error("INV-NATIVE-1 test cannot run: setActiveToolsByName is not callable");
			}
			await reselect.call(session, ["read", "write"]);

			const after = session.getActiveToolNames();
			expect(
				after.includes(NATIVE_TOOL_NAME),
				fivePoint({
					what: "the native tool disappeared after a mid-session reselection",
					why: "INV-NATIVE-1 violation — the invariant held at initialization but not through the session lifetime",
					expected: `ipython still present in getActiveToolNames() after reselection`,
					actual: `before = ${JSON.stringify(before)}; after = ${JSON.stringify(after)}`,
					guidance:
						"A lifetime invariant must survive every path that rebuilds the active tool set, not only the initialization path; a caller-supplied name list must not be able to retire a tool the specification pins.",
				}),
			).toBe(true);
		} finally {
			await session.dispose();
		}
	});
});
