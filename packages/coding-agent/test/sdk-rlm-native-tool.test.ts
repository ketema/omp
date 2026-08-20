/**
 * RLM Native Tool Tests — RED phase.
 *
 * Enforces `requirements/contracts/rlm-native-tool.contract.ts`.
 * Exercises top-level native tool presentation in packages/coding-agent/src/sdk.ts
 * and tools configuration in packages/coding-agent/src/tools/essential-tools.ts and xdev.ts.
 *
 * CONTRACT-IMPLEMENTATION INDEPENDENCE:
 * - Imports contract authority: requirements/contracts/rlm-native-tool.contract.ts
 * - Imports implementation: @oh-my-pi/pi-coding-agent/sdk, essential-tools.ts, xdev.ts
 * - Tests assert implementation satisfies contract clauses.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { defaultLoadModeForToolName } from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	assertActiveIpython,
	assertEssentialLoadMode,
	NATIVE_TOOL_LOAD_MODE,
	NATIVE_TOOL_NAME,
	RLM_NATIVE_TOOL_CONTRACT,
} from "../../../requirements/contracts/rlm-native-tool.contract";

function assert5Point(
	condition: boolean,
	details: {
		what: string;
		why: string;
		expected: string;
		actual: string;
		guidance: string;
	},
): void {
	if (!condition) {
		const message =
			`\n1. WHAT: ${details.what}\n` +
			`2. WHY: ${details.why}\n` +
			`3. EXPECTED: ${details.expected}\n` +
			`4. ACTUAL: ${details.actual}\n` +
			`5. GUIDANCE: ${details.guidance}\n`;
		throw new Error(message);
	}
}

describe("RLM native top-level tool contract", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-rlm-native-tool-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-rlm-native-tool-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	it("POST-NATIVE-1: ipython is present in top-level active tools getActiveToolNames()", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites POST-NATIVE-1 in rlm-native-tool.contract.ts
		 * [✓] C2 VALUABLE: fails if ipython is excluded from active tools array
		 * [✓] C3 NON-DUPLICATIVE: tests top-level active tools presentation
		 * [✓] C4 NOT FUTURE-EDIT: bounds existing getActiveToolNames surface
		 *
		 * CONTRACT TRACEABILITY:
		 * - Enforces: POST-NATIVE-1: After unrestricted session initialization, ipython is present in the top-level active tools array getActiveToolNames() (REQ-RLM-0002).
		 * - Risk tier: HIGH — omission causes model to fall back to legacy eval/bash without warning.
		 */
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			const activeToolNames = session.getActiveToolNames();
			const hasIpython = activeToolNames.includes(NATIVE_TOOL_NAME);

			assert5Point(hasIpython, {
				what: "test_post_native_1_active_tool_names FAILED",
				why: `POST-NATIVE-1 violation: active tools do not include ${NATIVE_TOOL_NAME}`,
				expected: RLM_NATIVE_TOOL_CONTRACT["POST-NATIVE-1"].text,
				actual: `activeToolNames=${JSON.stringify(activeToolNames)}`,
				guidance: `Add ${NATIVE_TOOL_NAME} to ESSENTIAL_BUILTIN_TOOL_NAMES and XDEV_KEEP_TOP_LEVEL so it remains in getActiveToolNames()`,
			});

			expect(session.getToolByName(NATIVE_TOOL_NAME)).toBeDefined();

			// Exercise contract validator
			assertActiveIpython({ activeToolNames });
		} finally {
			await session.dispose();
		}
	});

	it("POST-NATIVE-2: defaultLoadModeForToolName evaluates to 'essential' and is not mountable as xdev device", () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites POST-NATIVE-2 in rlm-native-tool.contract.ts
		 * [✓] C2 VALUABLE: fails if loadMode defaults to discoverable
		 * [✓] C3 NON-DUPLICATIVE: tests essential-tools load mode adapter logic
		 * [✓] C4 NOT FUTURE-EDIT: bounds existing defaultLoadModeForToolName surface
		 *
		 * CONTRACT TRACEABILITY:
		 * - Enforces: POST-NATIVE-2: defaultLoadModeForToolName('ipython') evaluates to 'essential'.
		 * - Risk tier: HIGH — discoverable load mode unmounts tool from active callable schema.
		 */
		const mode = defaultLoadModeForToolName(NATIVE_TOOL_NAME);
		const mountable = isMountableUnderXdev({ name: NATIVE_TOOL_NAME, loadMode: mode });

		assert5Point(mode === NATIVE_TOOL_LOAD_MODE, {
			what: "test_post_native_2_load_mode_essential FAILED",
			why: `POST-NATIVE-2 violation: default load mode is '${mode}', expected '${NATIVE_TOOL_LOAD_MODE}'`,
			expected: RLM_NATIVE_TOOL_CONTRACT["POST-NATIVE-2"].text,
			actual: `mode='${mode}', mountable=${mountable}`,
			guidance: `Pin ${NATIVE_TOOL_NAME} to '${NATIVE_TOOL_LOAD_MODE}' in ESSENTIAL_BUILTIN_TOOL_NAMES and XDEV_KEEP_TOP_LEVEL`,
		});

		assert5Point(!mountable, {
			what: "test_post_native_2_not_mountable_under_xdev FAILED",
			why: `POST-NATIVE-2 violation: ${NATIVE_TOOL_NAME} is considered mountable under xdev`,
			expected: `${NATIVE_TOOL_NAME} is not mountable under xdev`,
			actual: `mountable=${mountable}`,
			guidance: `Add ${NATIVE_TOOL_NAME} to XDEV_KEEP_TOP_LEVEL in xdev.ts`,
		});

		// Exercise contract validator
		assertEssentialLoadMode(mode);
	});

	it("FORBIDDEN-NATIVE-1: ipython is never unmounted or demoted to discoverable-only", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites FORBIDDEN-NATIVE-1 in rlm-native-tool.contract.ts
		 * [✓] C2 VALUABLE: negative-space test asserting demotion/omission is absent
		 * [✓] C3 NON-DUPLICATIVE: validates xdev mounted list does not capture ipython
		 * [✓] C4 NOT FUTURE-EDIT: bounds existing active toolset
		 *
		 * CONTRACT TRACEABILITY:
		 * - Enforces: FORBIDDEN-NATIVE-1: An unrestricted session SHALL NOT unmount ipython from the top-level active tool array or demote ipython to discoverable-only status.
		 * - Risk tier: HIGH — demotion makes tool unreachable directly.
		 */
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			const mounted = session.getMountedXdevToolNames();
			const active = session.getActiveToolNames();
			const isMountedAsDevice = mounted.includes(NATIVE_TOOL_NAME);

			assert5Point(!isMountedAsDevice, {
				what: "test_forbidden_native_1_not_mounted_as_device FAILED",
				why: `FORBIDDEN-NATIVE-1 violation: ${NATIVE_TOOL_NAME} was unmounted to xd:// device list`,
				expected: RLM_NATIVE_TOOL_CONTRACT["FORBIDDEN-NATIVE-1"].text,
				actual: `mounted=${JSON.stringify(mounted)}, active=${JSON.stringify(active)}`,
				guidance: `Keep ${NATIVE_TOOL_NAME} in top-level active tools, not in mounted xdev tools`,
			});
		} finally {
			await session.dispose();
		}
	});
});
