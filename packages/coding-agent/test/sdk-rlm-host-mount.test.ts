/**
 * RLM Host Mount Tests — RED phase.
 *
 * Enforces `requirements/contracts/rlm-host-mount.contract.ts`.
 * Exercises the host session assembly surface in packages/coding-agent/src/sdk.ts.
 *
 * CONTRACT-IMPLEMENTATION INDEPENDENCE:
 * - Imports contract authority: requirements/contracts/rlm-host-mount.contract.ts
 * - Imports implementation: @oh-my-pi/pi-coding-agent/sdk
 * - Tests assert implementation satisfies contract clauses.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	HOST_MOUNT_TOOL_NAME,
	RLM_HOST_MOUNT_CONTRACT,
	assertMountedIpython,
} from "../../../requirements/contracts/rlm-host-mount.contract";

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

describe("RLM host mount contract", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-rlm-host-mount-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-rlm-host-mount-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
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

	it("POST-MOUNT-1: registers ipython tool in unrestricted session inventory", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites POST-MOUNT-1 in rlm-host-mount.contract.ts
		 * [✓] C2 VALUABLE: fails if implementation omits ipython or misconfigures factory
		 * [✓] C3 NON-DUPLICATIVE: tests host session construction in coding-agent
		 * [✓] C4 NOT FUTURE-EDIT: bounds existing createAgentSession / createTools path
		 *
		 * CONTRACT TRACEABILITY:
		 * - Enforces: POST-MOUNT-1: After unrestricted session construction, the model-facing tool inventory includes a tool named ipython (REQ-RLM-0002).
		 * - Risk tier: HIGH — missing tool breaks the entire RLM capability for the model.
		 */
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			const allToolNames = session.getAllToolNames();
			const tool = session.getToolByName(HOST_MOUNT_TOOL_NAME);

			assert5Point(allToolNames.includes(HOST_MOUNT_TOOL_NAME), {
				what: "test_post_mount_1_registers_ipython FAILED",
				why: `POST-MOUNT-1 violation: registered tools do not include ${HOST_MOUNT_TOOL_NAME}`,
				expected: RLM_HOST_MOUNT_CONTRACT["POST-MOUNT-1"].text,
				actual: `allToolNames=${JSON.stringify(allToolNames)}`,
				guidance: `Host session assembly must register the ${HOST_MOUNT_TOOL_NAME} tool on the session ExtensionAPI before model turns`,
			});

			expect(tool).toBeDefined();

			// Exercise contract validator
			assertMountedIpython({ toolNames: allToolNames });
		} finally {
			await session.dispose();
		}
	});

	it("SEQ-MOUNT-1: registers ipython tool on ExtensionAPI before first model turn", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites SEQ-MOUNT-1 in rlm-host-mount.contract.ts
		 * [✓] C2 VALUABLE: fails if inline extension registration fails to execute
		 * [✓] C3 NON-DUPLICATIVE: tests sequencing of tool availability at session creation
		 * [✓] C4 NOT FUTURE-EDIT: bounds existing initialization lifecycle
		 *
		 * CONTRACT TRACEABILITY:
		 * - Enforces: SEQ-MOUNT-1: TypeScript host MUST register the ipython tool on the session ExtensionAPI BEFORE the first model turn.
		 * - Risk tier: HIGH — sequencing failure prevents model from knowing tool exists.
		 */
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			const tool = session.getToolByName(HOST_MOUNT_TOOL_NAME);
			const isRegistered = tool !== undefined && tool.name === HOST_MOUNT_TOOL_NAME;

			assert5Point(isRegistered, {
				what: "test_seq_mount_1_extension_api_tool_present FAILED",
				why: `SEQ-MOUNT-1 violation: tool ${HOST_MOUNT_TOOL_NAME} not available on initialized session`,
				expected: RLM_HOST_MOUNT_CONTRACT["SEQ-MOUNT-1"].text,
				actual: `tool=${tool ? tool.name : "undefined"}`,
				guidance: `Host must execute the RLM extension factory during session construction so ${HOST_MOUNT_TOOL_NAME} is present before turns begin`,
			});
		} finally {
			await session.dispose();
		}
	});

	it("FORBIDDEN-MOUNT-1: unrestricted session does not omit ipython", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites FORBIDDEN-MOUNT-1 in rlm-host-mount.contract.ts
		 * [✓] C2 VALUABLE: negative-space test bounding tool omission
		 * [✓] C3 NON-DUPLICATIVE: validates omission boundary
		 * [✓] C4 NOT FUTURE-EDIT: bounds existing toolset
		 *
		 * CONTRACT TRACEABILITY:
		 * - Enforces: FORBIDDEN-MOUNT-1: An unrestricted session SHALL NOT omit ipython from the model-facing tool inventory.
		 * - Risk tier: HIGH — omission causes model to fall back to eval/bash without warning.
		 */
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			const allToolNames = session.getAllToolNames();
			const omitted = !allToolNames.includes(HOST_MOUNT_TOOL_NAME);

			assert5Point(!omitted, {
				what: "test_forbidden_mount_1_unrestricted_session_does_not_omit_ipython FAILED",
				why: `FORBIDDEN-MOUNT-1 violation: unrestricted session omitted ${HOST_MOUNT_TOOL_NAME} from inventory`,
				expected: RLM_HOST_MOUNT_CONTRACT["FORBIDDEN-MOUNT-1"].text,
				actual: `omitted=${omitted}, tools=${JSON.stringify(allToolNames)}`,
				guidance: `Ensure the RLM extension is mounted whenever restrictToolNames is false`,
			});
		} finally {
			await session.dispose();
		}
	});
});
