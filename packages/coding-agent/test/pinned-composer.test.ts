import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VIEWPORT_SETTING_PATH } from "../../../requirements/contracts/pinned-composer.contract";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("Composer pinned viewport wiring (SEQ-1, SEQ-5, POST-8, FORBIDDEN-3, INV-2)", () => {
	it("SEQ-1: Composer.start unconditionally enters TUI pinned mode", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.start()
		 * - Enforces: SEQ-1: Composer.start SHALL call TUI.enterPinned after ui.start
		 * - Category: integration
		 * - Risk tier: High — interactive session must always start in pinned mode
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause SEQ-1 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: tests Composer startup lifecycle wiring to TUI.enterPinned
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		await initTheme();
		const term = new VirtualTerminal(80, 16, 100);
		const composer = new Composer({
			terminal: term,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		try {
			composer.start({ playWelcomeIntro: false });
			await term.waitForRender();
			expect(composer.ui.isPinned()).toBe(
				true,
				`1. WHAT: Composer.start did not enter pinned mode
2. WHY: SEQ-1 violation - Composer.start must enter pinned mode unconditionally
3. EXPECTED: composer.ui.isPinned() === true
4. ACTUAL: composer.ui.isPinned() === false
5. GUIDANCE: Call TUI.enterPinned after ui.start during Composer interactive startup`,
			);
		} finally {
			composer.stop();
		}
	});

	it("SEQ-5 / POST-8: Composer.renderFrame hands TUI only pinnedScroll and pinnedDock, omitting HistoryBatch", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame()
		 * - Enforces: SEQ-5 / POST-8: Composer.renderFrame SHALL hand TUI only pinnedScroll and pinnedDock; every interactive frame SHALL omit retired native-scrollback batches
		 * - Category: integration
		 * - Risk tier: High — emitting HistoryBatch during interactive frame corrupts terminal output
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause SEQ-5 and POST-8 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: validates TerminalFramePlan output shape from Composer
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		await initTheme();
		const term = new VirtualTerminal(80, 16, 100);
		const composer = new Composer({
			terminal: term,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		try {
			composer.start({ playWelcomeIntro: false });
			await term.waitForRender();
			const plan = composer.renderFrame({ columns: 80, rows: 16 });
			expect(plan.history).toBeUndefined(
				`1. WHAT: Composer.renderFrame emitted HistoryBatch in pinned mode
2. WHY: SEQ-5 / POST-8 violation - interactive pinned frames must not produce HistoryBatch
3. EXPECTED: plan.history === undefined
4. ACTUAL: ${JSON.stringify(plan.history)}
5. GUIDANCE: Do not include history batches in interactive pinned frame plans`,
			);
			expect(plan.viewport).toEqual(
				[],
				`1. WHAT: Composer.renderFrame populated normal viewport in pinned mode
2. WHY: SEQ-5 violation - pinned mode must use pinnedScroll and pinnedDock instead of normal viewport
3. EXPECTED: []
4. ACTUAL: ${JSON.stringify(plan.viewport)}
5. GUIDANCE: Pinned frame plans must route content to pinnedScroll and pinnedDock`,
			);
			expect(plan.pinnedDock !== undefined).toBe(
				true,
				`1. WHAT: Composer.renderFrame omitted pinnedDock
2. WHY: SEQ-5 violation - pinned frame plan must include pinnedDock
3. EXPECTED: plan.pinnedDock !== undefined
4. ACTUAL: undefined
5. GUIDANCE: Supply pinnedDock rows in TerminalFramePlan`,
			);
			expect(plan.pinnedScroll !== undefined).toBe(
				true,
				`1. WHAT: Composer.renderFrame omitted pinnedScroll
2. WHY: SEQ-5 violation - pinned frame plan must include pinnedScroll
3. EXPECTED: plan.pinnedScroll !== undefined
4. ACTUAL: undefined
5. GUIDANCE: Supply pinnedScroll rows in TerminalFramePlan`,
			);
		} finally {
			composer.stop();
		}
	});

	it("FORBIDDEN-3: SETTINGS_SCHEMA SHALL NOT contain tui.viewport setting", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: SETTINGS_SCHEMA
		 * - Enforces: FORBIDDEN-3: SETTINGS_SCHEMA SHALL NOT contain tui.viewport; interactive sessions have no unpinned mode
		 * - Category: forbidden
		 * - Risk tier: High — offering unpinned viewport setting violates product invariant (always pinned)
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause FORBIDDEN-3 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: checks schema definition absence for viewport setting
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const schemaRecord = SETTINGS_SCHEMA as Record<string, unknown>;
		const hasViewportSetting = VIEWPORT_SETTING_PATH in schemaRecord;
		expect(hasViewportSetting).toBe(
			false,
			`1. WHAT: SETTINGS_SCHEMA contains forbidden setting '${VIEWPORT_SETTING_PATH}'
2. WHY: FORBIDDEN-3 violation - SETTINGS_SCHEMA SHALL NOT contain tui.viewport; interactive sessions have no unpinned mode
3. EXPECTED: '${VIEWPORT_SETTING_PATH}' is absent from SETTINGS_SCHEMA
4. ACTUAL: '${VIEWPORT_SETTING_PATH}' exists in SETTINGS_SCHEMA: ${JSON.stringify(schemaRecord[VIEWPORT_SETTING_PATH])}
5. GUIDANCE: Remove '${VIEWPORT_SETTING_PATH}' configuration definition from SETTINGS_SCHEMA`,
		);
	});

	it("INV-2: implementation files SHALL NOT import the contract module", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Architectural Invariant
		 * - Enforces: INV-2: implementation SHALL NOT import this contract module
		 * - Category: architectural-invariant
		 * - Risk tier: High — coupling implementation to contract violates DbC independence
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-2 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: audits production source files for contract import isolation
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const worktreeRoot = path.resolve(__dirname, "../../..");
		const implementationFiles = [
			path.join(worktreeRoot, "packages/tui/src/pinned-viewport.ts"),
			path.join(worktreeRoot, "packages/tui/src/tui.ts"),
			path.join(worktreeRoot, "packages/coding-agent/src/modes/composer.ts"),
			path.join(worktreeRoot, "packages/coding-agent/src/config/settings-schema.ts"),
		];

		for (const filePath of implementationFiles) {
			const content = fs.readFileSync(filePath, "utf-8");
			const importsContract =
				content.includes("pinned-composer.contract") ||
				content.includes("requirements/contracts") ||
				/from\s+["'].*pinned-composer\.contract.*["']/.test(content);
			expect(importsContract).toBe(
				false,
				`1. WHAT: Implementation file ${path.relative(worktreeRoot, filePath)} imports contract module
2. WHY: INV-2 violation - implementation SHALL NOT import this contract module
3. EXPECTED: No contract imports in production implementation files
4. ACTUAL: Found contract reference in ${path.relative(worktreeRoot, filePath)}
5. GUIDANCE: Remove contract imports from implementation; tests must serve as the bridge`,
			);
		}
	});
});
