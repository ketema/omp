import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; selectedImages: ImageContent[]; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) =>
			options.branch ?? { selectedText: "branched text", selectedImages: [], cancelled: false },
	};
}

describe("RPC subagent registry", () => {
	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		registry.clear();

		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({
					branch: { selectedText: "Branch text", selectedImages: [], cancelled: false },
				}),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", selectedImages: [], cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(0);
		expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({
			type: "paid_fallback_active",
			request_id: "req-123",
			selector: "openrouter/google/gemini-3.7-flash:high",
			event_name: "paid_fallback_active",
			event_payload_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			emitted_at: 1700000000,
			paid_request_started_at: 1700000001,
		});
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => {
			sessionEventTypes.push(event.type);
			sessionEvents.push(event as unknown as { type: string; [key: string]: unknown });
		});

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(await client.getSubagentMessages({ sessionFile: "/tmp/subagent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
		// RPC integration obligation (INV-QR-12/15/16, SEQ-QR-14..16, FORBIDDEN-QR-14):
		// Verify that RPC client forwards paid_fallback_active session frames with authenticated receipt fields.
		expect(sessionEventTypes).toContain("paid_fallback_active");
		const paidFallbackFrame = sessionEvents.find(e => e.type === "paid_fallback_active");
		expect(paidFallbackFrame).toMatchObject({
			type: "paid_fallback_active",
			request_id: "req-123",
			selector: "openrouter/google/gemini-3.7-flash:high",
			event_name: "paid_fallback_active",
			event_payload_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			emitted_at: 1700000000,
			paid_request_started_at: 1700000001,
		});
	});

	test("REQ-QR-022, POST-QR-20, INV-QR-16, SEQ-QR-14..16, FORBIDDEN-QR-14: forwards paid_fallback_active and paid_fallback_denied session events verbatim", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-022
		 * - Enforces:
		 *   - REQ-QR-022: Each resolution records requested effort, position, quota signal, and whether a paid route was reached.
		 *   - POST-QR-20: The internal PaidUsageNotifier receipt authenticates request identity, event, selector, payload digest, emission time, and paid-request start time before inference.
		 *   - INV-QR-16: Paid OpenRouter inference never begins without an internally issued notifier receipt whose MAC covers both ordering timestamps.
		 *   - SEQ-QR-14: PaidUsageNotifier issues a receipt only after a qualifying classifier receipt.
		 *   - SEQ-QR-15: ModelFallbackResolver selects paid OpenRouter only after the matching notifier receipt.
		 *   - SEQ-QR-16: The selected adapter begins inference only after resolver selection and any required paid notification timestamp.
		 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
		 * - Category: integration / observability
		 * - Risk tier: High — dropped RPC frames hide paid spend from remote clients
		 * - Adversarial: Implementation-blind
		 * - Mock Contract: stub CLI writes exact session frames; RpcClient must forward them unchanged
		 * - Double type: Fake (in-process RPC child writing contracted session frames)
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-QR-20, INV-QR-16, SEQ-QR-14, SEQ-QR-15, SEQ-QR-16, FORBIDDEN-QR-14 and REQ-QR-022
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (exact verbatim objects for active and denied)
		 *   [✓] C3 NON-DUPLICATIVE: unique RPC forwarding surface for typed denied + camelCase active schema; existing test covers snake_case receipt frame dispatch
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current session-event forwarding, not a new metrics channel
		 */
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-paid-observability-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		const activeFrame = {
			type: "paid_fallback_active",
			correlationId: "corr-active-1",
			attemptedPosition: 2,
			requestedEffort: "high",
			authoritativeQuotaSignal: "quota_exhausted",
			emittedAt: 1700000000,
			from: "google-antigravity/gemini-3.7-flash-tiered:high",
			to: "openrouter/google/gemini-3.7-flash:high",
			role: "default",
		};
		const deniedFrame = {
			type: "paid_fallback_denied",
			from: "google-antigravity/gemini-3.7-flash-tiered:high",
			to: "openrouter/google/gemini-3.7-flash:high",
			role: "default",
			reasonCode: "non-429",
			attemptedPosition: 1,
			status: "denied",
			correlationId: "corr-denied-1",
			emittedAt: 1700000002,
		};
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write(${JSON.stringify(activeFrame)});
		write(${JSON.stringify(deniedFrame)});
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
		client.onSessionEvent(event => {
			sessionEvents.push(event as unknown as { type: string; [key: string]: unknown });
		});

		await client.start();
		await client.promptAndWait("Forward paid observability frames");

		const active = sessionEvents.find(event => event.type === "paid_fallback_active");
		const denied = sessionEvents.find(event => event.type === "paid_fallback_denied");
		if (!active || JSON.stringify(active) !== JSON.stringify(activeFrame)) {
			throw new Error(
				"1. WHAT: test_rpc_forwards_paid_fallback_active_verbatim FAILED\n" +
					"2. WHY: REQ-QR-022 / POST-QR-20 / SEQ-QR-14..16 / FORBIDDEN-QR-14 violation - RPC must forward paid_fallback_active verbatim with emittedAt, correlationId, attemptedPosition, requestedEffort, and authoritativeQuotaSignal\n" +
					`3. EXPECTED: ${JSON.stringify(activeFrame)}\n` +
					`4. ACTUAL: ${JSON.stringify(active)}\n` +
					"5. GUIDANCE: Forward the typed paid_fallback_active session event unchanged; do not drop camelCase observability fields or require a second timestamp.",
			);
		}
		if (!denied || JSON.stringify(denied) !== JSON.stringify(deniedFrame)) {
			throw new Error(
				"1. WHAT: test_rpc_forwards_paid_fallback_denied_verbatim FAILED\n" +
					"2. WHY: REQ-QR-022 / POST-QR-20 / SEQ-QR-14 / FORBIDDEN-QR-14 violation - RPC must forward paid_fallback_denied verbatim with from, to, role, reasonCode, attemptedPosition, status, correlationId, and emittedAt\n" +
					`3. EXPECTED: ${JSON.stringify(deniedFrame)}\n` +
					`4. ACTUAL: ${JSON.stringify(denied)}\n` +
					"5. GUIDANCE: Forward typed paid denials over RPC; observability must not depend on prose notices.",
			);
		}
		const activeTimestampKeys = Object.keys(active)
			.filter(
				key =>
					/(?:At|_at|timestamp|Timestamp)$/.test(key) || key === "emitted_at" || key === "paid_request_started_at",
			)
			.sort();
		if (activeTimestampKeys.join(",") !== "emittedAt") {
			throw new Error(
				"1. WHAT: test_rpc_forwards_paid_fallback_active_verbatim FAILED\n" +
					"2. WHY: POST-QR-20 / INV-QR-16 violation - forwarded paid_fallback_active must have exactly one timestamp field emittedAt\n" +
					'3. EXPECTED: ["emittedAt"]\n' +
					`4. ACTUAL: ${JSON.stringify(activeTimestampKeys)}\n` +
					"5. GUIDANCE: Do not forward a second paid-request start timestamp on the session event.",
			);
		}
		expect(active).toEqual(activeFrame);
		expect(denied).toEqual(deniedFrame);
	});
	test("POST-QR-28, POST-QR-29, REQ-QR-029: RPC forwards paid_fallback_active with costProvider, decision correlationId, and canonical effort-qualified selectors", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-029
		 * - Enforces:
		 *   - POST-QR-28: Typed active and denial events record one emittedAt, one immutable decision identity as correlationId, role, effective effort-qualified from/to selectors, actual chain position, exact classified signal, status, receipt-consumption outcome, selected outcome, and costProvider.
		 *   - POST-QR-29: Every denial reason uses the same canonical effective selector formatter and identical denials are deduplicated without collapsing distinct decisions.
		 * - Category: integration / RPC / observability
		 * - Risk tier: High — RPC clients (CLI/UI) require costProvider and canonical correlationId for accurate spend attribution
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-QR-28, POST-QR-29, REQ-QR-029 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts exact forwarded schema with costProvider and correlationId)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests SLICE-3 costProvider and 3-tier selector fields over RPC transport
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted RPC event schema for 3-tier Vertex paid fallback
		 */
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-vertex-observability-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		const vertexActiveFrame = {
			type: "paid_fallback_active",
			correlationId: "corr-vertex-slice3-1",
			attemptedPosition: 2,
			requestedEffort: "high",
			authoritativeQuotaSignal: "quota_exhausted",
			costProvider: "google-vertex",
			emittedAt: 1700000010,
			from: "google-antigravity/gemini-3.7-flash-tiered:high",
			to: "google-vertex/gemini-3.7-flash:high",
			role: "task",
		};
		const vertexDeniedFrame = {
			type: "paid_fallback_denied",
			from: "google-vertex/gemini-3.7-flash:high",
			to: "openrouter/google/gemini-3.7-flash:high",
			role: "task",
			reasonCode: "adc_missing",
			attemptedPosition: 2,
			status: "denied",
			correlationId: "corr-vertex-slice3-2",
			emittedAt: 1700000012,
		};
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write(${JSON.stringify(vertexActiveFrame)});
		write(${JSON.stringify(vertexDeniedFrame)});
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
		client.onSessionEvent(event => {
			sessionEvents.push(event as unknown as { type: string; [key: string]: unknown });
		});

		await client.start();
		await client.promptAndWait("Forward Vertex paid observability frames");

		const active = sessionEvents.find(event => event.type === "paid_fallback_active");
		const denied = sessionEvents.find(event => event.type === "paid_fallback_denied");

		if (active?.costProvider !== "google-vertex" || active?.to !== "google-vertex/gemini-3.7-flash:high") {
			throw new Error(
				"1. WHAT: test_rpc_forwards_vertex_paid_observability FAILED\n" +
					"2. WHY: POST-QR-28 / REQ-QR-029 violation - RPC must forward paid_fallback_active with costProvider='google-vertex' and exact Vertex selector\n" +
					`3. EXPECTED: costProvider='google-vertex', to='google-vertex/gemini-3.7-flash:high'\n` +
					`4. ACTUAL: active=${JSON.stringify(active)}\n` +
					"5. GUIDANCE: Include costProvider on the forwarded paid_fallback_active session event.",
			);
		}

		expect(active).toEqual(vertexActiveFrame);
		expect(denied).toEqual(vertexDeniedFrame);
	});
});
