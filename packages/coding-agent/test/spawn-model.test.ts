import { afterEach, describe, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "../src/config/settings";
import { runEvalAgent } from "../src/eval/agent-bridge";
import * as taskDiscovery from "../src/task/discovery";
import * as taskExecutor from "../src/task/executor";
import { taskSchema } from "../src/task/types";
import type { ExecutorOptions } from "../src/task/executor";
import type { AgentDefinition, SingleResult } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { CONTRACT_SPAWN_MODEL, MODEL_FIELD } from "../../../requirements/contracts/spawn-model.contract";

type ClauseId = keyof typeof CONTRACT_SPAWN_MODEL;

function describeActual(value: unknown): string {
	const serialized = JSON.stringify(value);
	return serialized ?? String(value);
}

function assertContract(
	condition: boolean,
	{
		testName,
		clauseId,
		expected,
		actual,
		guidance,
	}: {
		testName: string;
		clauseId: ClauseId;
		expected: string;
		actual: string;
		guidance: string;
	},
): asserts condition {
	if (condition) return;
	throw new Error(
		[
			`WHAT: ${testName} FAILED`,
			`WHY: ${clauseId} violation - ${CONTRACT_SPAWN_MODEL[clauseId].text}`,
			`EXPECTED: ${expected}`,
			`ACTUAL: ${actual}`,
			`GUIDANCE: ${guidance}`,
		].join("\n"),
	);
}

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["@task"],
} satisfies AgentDefinition;

function makeEvalSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": false,
		}),
		taskDepth: 0,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "parent/session-model",
		getModelString: () => "fallback/model",
		getArtifactsDir: () => null,
		getSessionId: () => "spawn-model-test-session",
		getEvalSessionId: () => "spawn-model-test-eval",
	};
}

function successfulChild(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("optional per-invocation spawn model", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a supplied model through taskSchema unknown-key deletion", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Enforces: FORBIDDEN-1: Unknown-key deletion SHALL NOT drop a supplied model field.
		 * - Category: boundary
		 * - Risk tier: Medium — a valid operator selector otherwise disappears before spawn.
		 * - Adversarial: contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites FORBIDDEN-1 in spawn-model.contract.ts.
		 * [✓] C2 VALUABLE: a parser that deletes model fails the exact-value assertion.
		 * [✓] C3 NON-DUPLICATIVE: owns the task wire-schema surface.
		 * [✓] C4 NOT FUTURE-EDIT: enforces the current contracted negative obligation.
		 */
		const testName = "keeps a supplied model through taskSchema unknown-key deletion";
		const parsed = taskSchema({ task: "x", [MODEL_FIELD]: "xai/grok" });

		assertContract(!(parsed instanceof type.errors), {
			testName,
			clauseId: "FORBIDDEN-1",
			expected: "the task wire schema accepts a supplied non-empty model selector",
			actual: parsed instanceof type.errors ? parsed.summary : describeActual(parsed),
			guidance: "Accept a valid supplied selector at the task wire boundary.",
		});
		assertContract(Reflect.get(parsed, MODEL_FIELD) === "xai/grok", {
			testName,
			clauseId: "FORBIDDEN-1",
			expected: 'parsed.model === "xai/grok"',
			actual: describeActual(Reflect.get(parsed, MODEL_FIELD)),
			guidance: "Preserve the supplied selector after wire-schema normalization.",
		});
	});

	it("forwards an eval agent model into the child request before execution", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Enforces: POST-2: eval agent() passes its supplied model to the structured child request.
		 * - Enforces: SEQ-2: runEvalAgent forwards model before child start.
		 * - Category: integration
		 * - Risk tier: Medium — eval callers otherwise cannot select their intended child model.
		 * - Adversarial: contract-governed, implementation-aware
		 * - Double type: Spy at the executor boundary, following the established agent-bridge policy seam.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 * [✓] Invokes the actual runEvalAgent public lifecycle path.
		 * [✓] Observes the child request at its pre-execution boundary.
		 * [✓] Does not call the structured callee directly.
		 * [✓] Installs the spy before the lifecycle path begins.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 * [✓] C1 VALID: cites POST-2 and SEQ-2 in spawn-model.contract.ts.
		 * [✓] C2 VALUABLE: stripping or failing to forward model makes modelOverride differ exactly.
		 * [✓] C3 NON-DUPLICATIVE: owns the eval bridge-to-child surface.
		 * [✓] C4 NOT FUTURE-EDIT: enforces the current contracted handoff.
		 */
		const testName = "forwards an eval agent model into the child request before execution";
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => successfulChild(options));

		await runEvalAgent({ prompt: "inspect the model handoff", model: "xai/grok" }, { session: makeEvalSession() });

		assertContract(runSpy.mock.calls.length === 1, {
			testName,
			clauseId: "SEQ-2",
			expected: "one child execution begins for the eval agent invocation",
			actual: `${runSpy.mock.calls.length} child executions`,
			guidance: "Start exactly one child for this single eval agent invocation.",
		});
		const childRequest = runSpy.mock.calls[0]?.[0];
		assertContract(
			Array.isArray(childRequest?.modelOverride) &&
				childRequest.modelOverride.length === 1 &&
				childRequest.modelOverride[0] === "xai/grok",
			{
				testName,
				clauseId: "POST-2",
				expected: 'child request modelOverride === ["xai/grok"]',
				actual: describeActual(childRequest?.modelOverride),
				guidance: "Forward the supplied eval selector unchanged into the child request.",
			},
		);
	});
});
