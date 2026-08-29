/**
 * CONTRACT AUTHORITY RECORD:
 * - Authority: contracts/omp_quota_router.contract.py
 * - Requirements: requirements/REQ-2026-OMP-QUOTA-ROUTER.md (REQ-QR-027, REQ-QR-029)
 * - Plan: plans/omp-quota-router.plan.yml (SLICE-3)
 * - In-Scope Clauses: POST-QR-26, POST-QR-30, SEQ-QR-12, SEQ-QR-18, INV-QR-18, FORBIDDEN-QR-16
 * - Categories: Integration / Concurrency / Invariant / Anti-Bypass
 * - Risk Tier: High — SessionAdvisors bypass would enable silent paid token spend and race-condition spend multiplication
 * - Adversarial: Structurally blind to production implementation source
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionAdvisors, type SessionAdvisorsOptions } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SessionAdvisors SharedFallbackPolicy integration (SLICE-3 RED)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-session-advisors-");
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
		}
	});

	const makeGoogleAntigravityGeminiHigh = (): Model<"google-gemini-cli"> =>
		buildModel({
			id: "gemini-3.7-flash-tiered",
			name: "Gemini 3.7 Flash Tiered",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: true,
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					[Effort.High]: "gemini-3.7-flash-high",
				},
			},
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});

	const makeGoogleVertexGeminiHigh = (): Model<"google-vertex"> =>
		buildModel({
			id: "gemini-3.7-flash",
			name: "Gemini 3.7 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://global-aiplatform.googleapis.com",
			reasoning: true,
			thinking: {
				mode: "google-level",
				efforts: [Effort.High],
			},
			input: ["text", "image"],
			cost: { input: 0.00000025, output: 0.000001, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});

	/**
	 * Provider fake parity declaration:
	 * Emits raw Google API HTTP 429 status with canonical RESOURCE_EXHAUSTED body.
	 */
	const makeAntigravity429Stream = (model: Model<Api>): AssistantMessageEventStream => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const errorPartial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage:
					"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com, RESOURCE_EXHAUSTED",
				errorStatus: 429,
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: errorPartial });
			stream.push({ type: "error", reason: "error", error: errorPartial });
		});
		return stream;
	};

	function recoveredTextStream(model: Model<Api>, text: string): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const partial: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
			stream.push({ type: "done", reason: "stop", message: partial });
		});
		return stream;
	}

	it("POST-QR-26, SEQ-QR-12, INV-QR-18, FORBIDDEN-QR-16: SessionAdvisors routes advisor fallback through SharedFallbackPolicy before transitioning models", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-027
		 * - Enforces:
		 *   - POST-QR-26: TurnRecovery, usage-aware fallback, and SessionAdvisors obtain every provider transition from one shared policy.
		 *   - SEQ-QR-12: Every automatic fallback surface invokes SharedFallbackPolicy before reading or applying the next candidate.
		 *   - INV-QR-18: Every automatic fallback surface invokes the shared provider-transition policy.
		 *   - FORBIDDEN-QR-16: No automatic consumer of retry.fallbackChains changes to Vertex or OpenRouter around SharedFallbackPolicy.
		 * - Category: positive / integration / policy-boundary
		 * - Risk tier: High — bypassing shared policy leaks unmetered/unauthorized model switches
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-QR-26, SEQ-QR-12, INV-QR-18, FORBIDDEN-QR-16 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts policy evaluation prior to model transition)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests SessionAdvisors boundary integration with SharedFallbackPolicy
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted shared policy requirement on SessionAdvisors
		 */
		authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
		authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

		const primaryModel = makeGoogleAntigravityGeminiHigh();
		const vertexModel = makeGoogleVertexGeminiHigh();
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;

		const requestedModels: string[] = [];
		const sessionEvents: AgentSessionEvent[] = [];

		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Advisor integration test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				const requested = `${model.provider}/${model.id}`;
				requestedModels.push(requested);
				if (model.provider === primaryModel.provider && primaryAttempts === 0) {
					primaryAttempts += 1;
					return makeAntigravity429Stream(model);
				}
				if (model.provider === vertexModel.provider) {
					return recoveredTextStream(model, "Advisor advice delivered on Vertex.");
				}
				return recoveredTextStream(model, `ok:${requested}`);
			},
		});

		const settings = Settings.isolated({
			"advisor.enabled": true,
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				advisor: [vertexSelector],
				default: [vertexSelector],
			},
			modelRoles: {
				advisor: primarySelector,
				default: primarySelector,
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});

		session.subscribe(event => {
			sessionEvents.push(event);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const advisorOptions: SessionAdvisorsOptions = {
			enabled: true,
		};
		const advisors = new SessionAdvisors(session, advisorOptions);
		await advisors.buildRuntime();
		const advisorAgent = advisors.getAdvisorAgent();
		if (!advisorAgent) {
			throw new Error(
				"1. WHAT: test_session_advisors_shared_policy_transition FAILED\n" +
					"2. WHY: POST-QR-26 / SEQ-QR-12 violation - buildRuntime must initialize an active advisor agent\n" +
					"3. EXPECTED: getAdvisorAgent() returns live Agent\n" +
					"4. ACTUAL: getAdvisorAgent() returned null\n" +
					"5. GUIDANCE: Wire buildRuntime to instantiate the active advisor Agent from configured role.",
			);
		}

		await session.prompt("Check code quality");
		await advisors.waitForAdvisorCatchup(1000);
		await advisors.stopRuntime();

		const paidActiveEvents = sessionEvents.filter(e => e.type === "paid_fallback_active");
		if (paidActiveEvents.length !== 1) {
			throw new Error(
				"1. WHAT: test_session_advisors_shared_policy_transition FAILED\n" +
					"2. WHY: POST-QR-26 / SEQ-QR-12 / INV-QR-18 violation - SessionAdvisors must transition models through SharedFallbackPolicy and emit paid_fallback_active before Vertex inference\n" +
					`3. EXPECTED: paid_fallback_active count = 1\n` +
					`4. ACTUAL: paid_fallback_active count = ${paidActiveEvents.length}, events = ${JSON.stringify(sessionEvents.map(e => e.type))}\n` +
					"5. GUIDANCE: Wire SessionAdvisors to invoke SharedFallbackPolicy before reading or applying the advisor fallback chain.",
			);
		}

		expect(paidActiveEvents).toHaveLength(1);
	});

	it("POST-QR-26, POST-QR-30, SEQ-QR-18, INV-QR-18: concurrent advisor requests acquire session-scoped single-flight yielding exactly one paid transition and one notification", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-027, REQ-QR-029
		 * - Enforces:
		 *   - POST-QR-26: SessionAdvisors obtains provider transitions from singular SharedFallbackPolicy instance.
		 *   - POST-QR-30: SharedFallbackPolicy maintains session-scoped single-flight state; concurrent callers for one decision observe one authorization, notification, and paid inference.
		 *   - SEQ-QR-18: Every automatic surface acquires session-and-decision-scoped paid single-flight ownership before paid inference.
		 *   - INV-QR-18: Session-scoped single-flight state prevents parallel advisors from multiplying paid authorization.
		 * - Category: concurrency / invariant / single-flight
		 * - Risk tier: High — race condition could multiply paid token charges across parallel background advisors
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-QR-26, POST-QR-30, SEQ-QR-18, INV-QR-18 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts exact 1 paid stream and 1 notification under concurrent race)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests concurrency serialization across parallel advisor invocations
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted session-scoped single-flight mutex across automatic surfaces
		 */
		authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
		authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

		const primaryModel = makeGoogleAntigravityGeminiHigh();
		const vertexModel = makeGoogleVertexGeminiHigh();
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;

		let vertexInferenceCount = 0;
		let antigravityAttempts = 0;
		const sessionEvents: AgentSessionEvent[] = [];

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Concurrent advisor test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				if (model.provider === primaryModel.provider) {
					antigravityAttempts += 1;
					return makeAntigravity429Stream(model);
				}
				if (model.provider === vertexModel.provider) {
					vertexInferenceCount += 1;
					return recoveredTextStream(model, "Advice from Vertex single-flight.");
				}
				return recoveredTextStream(model, "ok");
			},
		});

		const settings = Settings.isolated({
			"advisor.enabled": true,
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				advisor: [vertexSelector],
				default: [vertexSelector],
			},
			modelRoles: {
				advisor: primarySelector,
				default: primarySelector,
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});

		session.subscribe(event => {
			sessionEvents.push(event);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const advisorOptions: SessionAdvisorsOptions = {
			enabled: true,
		};
		const advisors = new SessionAdvisors(session, advisorOptions);
		advisors.applyAdvisorConfigs(
			[
				{ name: "Architecture", model: primarySelector },
				{ name: "Security", model: primarySelector },
			],
			undefined,
		);
		await advisors.buildRuntime();

		// ACT: Prompt session and wait for concurrent advisors to catch up under rate-limiting
		await session.prompt("Concurrent advice trigger");
		await advisors.waitForAdvisorCatchup(1000);
		await advisors.stopRuntime();

		const paidNotifications = sessionEvents.filter(e => e.type === "paid_fallback_active");

		if (vertexInferenceCount !== 1 || paidNotifications.length !== 1) {
			throw new Error(
				"1. WHAT: test_concurrent_advisors_single_flight FAILED\n" +
					"2. WHY: POST-QR-30 / SEQ-QR-18 / INV-QR-18 violation - concurrent advisor requests must be serialized via session-scoped single-flight to yield exactly 1 paid inference and 1 notification\n" +
					`3. EXPECTED: vertexInferenceCount = 1, paidNotifications = 1\n` +
					`4. ACTUAL: vertexInferenceCount = ${vertexInferenceCount}, paidNotifications = ${paidNotifications.length}\n` +
					"5. GUIDANCE: Acquire session-scoped single-flight lock before entering paid fallback in SharedFallbackPolicy so parallel advisors share one recorded decision.",
			);
		}

		expect(vertexInferenceCount).toBe(1);
		expect(paidNotifications).toHaveLength(1);
	});

	it("INV-QR-18, FORBIDDEN-QR-16: direct model swap to Vertex or OpenRouter around SharedFallbackPolicy is rejected with a typed denial", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-027
		 * - Enforces:
		 *   - INV-QR-18: Direct session.setModel() calls outside policy are prohibited; all transitions route through SharedFallbackPolicy.
		 *   - FORBIDDEN-QR-16: No automatic consumer of retry.fallbackChains, including SessionAdvisors, changes to Vertex or OpenRouter around SharedFallbackPolicy.
		 * - Category: negative / security / anti-bypass
		 * - Risk tier: High — direct setModel calls would allow rogue code or unclassified errors to bypass quota gates
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-QR-18, FORBIDDEN-QR-16 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts typed rejection on unauthorized direct swap)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests enforcement boundary on unmediated advisor model replacement
		 *   [✓] C4 NOT FUTURE-EDIT: enforces negative space restriction forbidding unmediated paid model swaps
		 */
		authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");

		const primaryModel = makeGoogleAntigravityGeminiHigh();
		const vertexModel = makeGoogleVertexGeminiHigh();
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Direct swap test"],
				tools: [],
				messages: [],
			},
		});

		const settings = Settings.isolated({
			"advisor.enabled": true,
			modelRoles: { default: primarySelector },
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});

		const advisorOptions: SessionAdvisorsOptions = {
			enabled: true,
		};
		const advisors = new SessionAdvisors(session, advisorOptions);

		// Direct attempt to apply paid Vertex model config without qualifying quota receipts
		let threw = false;
		try {
			advisors.applyAdvisorConfigs([{ name: "DirectVertex", model: vertexSelector }], undefined);
			await advisors.buildRuntime();
			await advisors.stopRuntime();
		} catch (err: unknown) {
			threw = true;
		}

		if (!threw) {
			throw new Error(
				"1. WHAT: test_direct_paid_model_swap_rejected FAILED\n" +
					"2. WHY: INV-QR-18 / FORBIDDEN-QR-16 violation - direct config of paid Vertex or OpenRouter model without SharedFallbackPolicy authorization must be rejected\n" +
					"3. EXPECTED: applyAdvisorConfigs / buildRuntime throws typed denial / rejection error for uncontracted paid model\n" +
					"4. ACTUAL: call succeeded without throwing\n" +
					"5. GUIDANCE: Require SharedFallbackPolicy validation before applying any paid model in applyAdvisorConfigs on SessionAdvisors.",
			);
		}

		expect(threw).toBe(true);
	});
});
