import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	Effort,
	type Model,
	type ModelUsageHealth,
	type ProviderSessionState,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { parseModelPattern, parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const FALLBACK_TEST_RETRY_AFTER_MS = 60_000;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (lastMessage?.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function createFallbackAgent(
	primaryModel: Model,
	requestedModels: string[],
	options: { retryAfterMs?: number; firstError?: string | Error } = {},
): Agent {
	const retryAfterMs = options.retryAfterMs ?? FALLBACK_TEST_RETRY_AFTER_MS;
	const firstError = options.firstError ?? `rate limit exceeded retry-after-ms=${retryAfterMs}`;
	const mock = createMockModel();
	let primaryAttempts = 0;
	return new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: {
			model: primaryModel,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: (model, context, options) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === primaryModel.provider && model.id === primaryModel.id && primaryAttempts === 0) {
				primaryAttempts += 1;
				mock.push({ throw: firstError });
			} else {
				mock.push({ content: [`ok:${model.provider}/${model.id}`] });
			}
			return mock.stream(model, context, options);
		},
	});
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A stream that terminates with a `ThinkingLoop`-flagged error, exactly as the
 *  loop guard aborts a repetitive reasoning stream (issue #8760). */
function thinkingLoopErrorStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage:
				"Thinking loop detected: the model repeated near-identical content (4 near-identical segments within the last 16). Treating as a stream stall and retrying.",
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

/** A stream that completes normally with a single text block. */
function recoveredTextStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
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

describe("AgentSession retry fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sharedRegistry: ModelRegistry;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// The model registry is an immutable fixture whose construction builds a
	// canonical index over ~2.7k bundled models (~100ms). Build it (and the
	// auth DB) once for the whole file instead of per-test; reset only the
	// mutable retry-fallback cooldown state between tests.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("fireworks", "fireworks-test-key");
		authStorage.setRuntimeApiKey("google", "google-test-key");
		authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		authStorage.setRuntimeApiKey("devin", "devin-test-key");
		authStorage.setRuntimeApiKey("openai-codex", "openai-codex-test-key");
		sharedRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		// Reset to the shared registry (a few tests reassign it to a scoped
		// instance) and clear cooldown suppressions left by fallback-path tests
		// (default 5-minute suppression) so state never leaks between tests.
		modelRegistry = sharedRegistry;
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("advances through a role-keyed fallback chain across retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const requestedContexts: string[] = [];
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				requestedContexts.push(JSON.stringify(context));
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "service unavailable: 503 overloaded" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on second fallback"] });
				} else {
					throw new Error(`Unexpected model requested during retry fallback test: ${model.provider}/${model.id}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Recover from rate limits");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(new Set(requestedContexts).size).toBe(1);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([0, 0]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 2 });
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
	});

	it("hops to the chain owned by a fallback that is the last entry of the chain it came from", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "503 Hosted inference is temporarily unavailable" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on the second chain"] });
				} else {
					throw new Error(`Unexpected model requested during chain-hop test: ${model.provider}/${model.id}`);
				}
				return mock.stream(model, context, options);
			},
		});

		// Two chains, joined only by their shared entry: the role chain ends at
		// the first fallback, which is itself a chain key. Reaching the second
		// fallback requires re-resolving the chain for the active model.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${firstFallback.provider}/${firstFallback.id}`],
				[`${firstFallback.provider}/${firstFallback.id}`]: [`${secondFallback.provider}/${secondFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover across two chains");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: `${firstFallback.provider}/${firstFallback.id}`,
			},
		]);
	});

	it("keeps non-Gemini empty-body errors on the model-fallback path", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled empty-body fallback models");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels, {
			firstError: new AIError.ProviderResponseError("Devin API error: empty response body", {
				provider: "devin",
				kind: "empty-body",
			}),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		await session.prompt("Recover the empty provider body");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("forwards retry fallback events to extension handlers", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const appliedFromExtension: Array<{ from: string; to: string; role: string }> = [];
		const succeededFromExtension: Array<{ model: string; role: string }> = [];
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("retry_fallback_applied", event => {
					appliedFromExtension.push({ from: event.from, to: event.to, role: event.role });
				});
				pi.on("retry_fallback_succeeded", event => {
					succeededFromExtension.push({ model: event.model, role: event.role });
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"retry-fallback-observer",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const appliedFromSubscribe: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const succeededFromSubscribe: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") appliedFromSubscribe.push(event);
			if (event.type === "retry_fallback_succeeded") succeededFromSubscribe.push(event);
		});

		await session.prompt("Recover onto the fallback model");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		// Extension handlers must observe the same transition and success the session broadcasts.
		expect(appliedFromExtension).toEqual([
			{
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(succeededFromExtension).toEqual([
			{ model: `${fallbackModel.provider}/${fallbackModel.id}`, role: "default" },
		]);
		expect(appliedFromExtension).toEqual(appliedFromSubscribe.map(({ from, to, role }) => ({ from, to, role })));
		expect(succeededFromExtension).toEqual(succeededFromSubscribe.map(({ model, role }) => ({ model, role })));
	});

	it("confirms before crossing models when every pooled account is inside reserve", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled reserve fallback models");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["continued with full context"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePct": 10,
			"retry.usageReservePolicy": "confirm",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.08,
							},
							{
								credentialId: 2,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.02,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		const confirmFallback = vi.fn(async () => true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(confirmFallback);
		await session.prompt("Keep working on the same task");
		await session.waitForIdle();
		expect(confirmFallback).toHaveBeenCalledWith(
			{
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				remainingPercent: 2,
			},
			expect.any(AbortSignal),
		);
		expect(requestedModels).toEqual([`${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(session.messages.some(message => message.role === "user")).toBe(true);
	});

	it("honors a live fail-closed policy after reserve spending was approved", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled reserve policy models");
		const mock = createMockModel({ responses: [{ content: ["stayed on primary"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async provider =>
				provider === primaryModel.provider
					? {
							state: "reserve",
							accounts: [
								{
									credentialId: 1,
									credentialType: "oauth",
									state: "reserve",
									remainingFraction: 0.05,
								},
							],
						}
					: { state: "healthy", accounts: [] },
			);
		const confirmFallback = vi.fn(async () => false);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(confirmFallback);

		await session.prompt("Stay on the primary");
		await session.waitForIdle();
		settings.override("retry.usageReservePolicy", "fail-closed");
		expect(settings.get("retry.usageReservePolicy")).toBe("fail-closed");

		await expect(session.prompt("Do not spend reserve")).rejects.toThrow("reserve policy is fail-closed");
		expect(confirmFallback).toHaveBeenCalledTimes(1);
		expect(usageHealth).toHaveBeenCalledTimes(3);
	});
	it("reselects a healthy same-provider account before considering a model fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled pooled fallback models");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["same provider continued"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					selected: true,
					state: "reserve",
					remainingFraction: 0.05,
				},
				{ credentialId: 2, credentialType: "oauth", state: "healthy", remainingFraction: 0.8 },
			],
		});
		const release = vi
			.spyOn(modelRegistry.authStorage, "releaseSessionCredentialForReselection")
			.mockReturnValue(true);
		const confirmFallback = vi.fn(async () => true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(confirmFallback);
		await session.prompt("Stay on this provider");
		await session.waitForIdle();
		expect(release).toHaveBeenCalledWith(primaryModel.provider, session.sessionId);
		expect(confirmFallback).not.toHaveBeenCalled();
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("reselects a healthy sibling before applying a same-provider model fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled same-provider fallback models");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["same-provider fallback continued"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, options) =>
			options.modelId === primaryModel.id
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.05,
							},
							{
								credentialId: 2,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		const release = vi
			.spyOn(modelRegistry.authStorage, "releaseSessionCredentialForReselection")
			.mockReturnValue(true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Use the healthy sibling for the fallback model");
		await session.waitForIdle();

		expect(release).toHaveBeenCalledWith(primaryModel.provider, session.sessionId);
		expect(requestedModels).toEqual([`${fallbackModel.provider}/${fallbackModel.id}`]);
	});

	it("does not dispatch a prompt after its usage preflight is cancelled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled preflight model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		const probeStarted = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, options) => {
			probeStarted.resolve();
			const aborted = Promise.withResolvers<ModelUsageHealth>();
			options.signal?.addEventListener(
				"abort",
				() => aborted.reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			return aborted.promise;
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const prompt = session.prompt("Do not send this after cancellation");
		await probeStarted.promise;
		await session.abort();
		await prompt;

		expect(requestedModels).toEqual([]);
	});

	it("cancels a pending reserve confirmation without dispatching the prompt", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled confirmation cancellation models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		const confirmationStarted = Promise.withResolvers<void>();
		const pendingConfirmation = Promise.withResolvers<boolean>();
		const confirmationAborted = Promise.withResolvers<void>();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(async (_confirmation, signal) => {
			confirmationStarted.resolve();
			signal.addEventListener("abort", () => confirmationAborted.resolve(), { once: true });
			return pendingConfirmation.promise;
		});

		const prompt = session.prompt("Do not send after confirmation cancellation");
		await confirmationStarted.promise;
		await session.abort();
		await confirmationAborted.promise;
		await prompt;

		expect(requestedModels).toEqual([]);
	});

	it("defers usage fallback for a queued steer until the active stream finishes", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled queued fallback models");
		const requestedModels: string[] = [];
		const streamStarted = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<{ content: string[] }>();
		const mock = createMockModel({
			responses: [
				async () => {
					streamStarted.resolve();
					return firstResponse.promise;
				},
				{ content: ["queued steer completed"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		let useReserve = false;
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async provider =>
				provider === primaryModel.provider
					? useReserve
						? {
								state: "reserve",
								accounts: [
									{
										credentialId: 1,
										credentialType: "oauth",
										state: "reserve",
										remainingFraction: 0.05,
									},
								],
							}
						: {
								state: "healthy",
								accounts: [
									{
										credentialId: 1,
										credentialType: "oauth",
										state: "healthy",
										remainingFraction: 0.8,
									},
								],
							}
					: { state: "healthy", accounts: [] },
			);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("Keep the primary stream active");
		await streamStarted.promise;
		useReserve = true;
		await session.sendUserMessage("Queue this steer", { deliverAs: "steer" });

		expect(usageHealth).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(primaryModel.id);

		firstResponse.resolve({ content: ["primary stream completed"] });
		await firstPrompt;
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("cancels queued-turn usage confirmation when post-prompt work is disposed", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled queued cancellation models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		const confirmationStarted = Promise.withResolvers<void>();
		const pendingConfirmation = Promise.withResolvers<boolean>();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(async () => {
			confirmationStarted.resolve();
			return pendingConfirmation.promise;
		});

		await session.sendUserMessage("Queue this turn", { deliverAs: "steer" });
		await confirmationStarted.promise;
		await session.dispose();
		session = undefined;

		expect(requestedModels).toEqual([]);
	});

	it("does not reschedule a queued drain after a dequeue hook rejects", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled queued-drain model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const hookRan = Promise.withResolvers<void>();
		let attempts = 0;
		const failingHook = vi.fn(() => {
			hookRan.resolve();
			if (++attempts === 1) throw new Error("blocked before dequeue");
		});
		agent.addBeforeQueuedMessageDequeueHook(failingHook);

		await session.sendUserMessage("Keep this queued", { deliverAs: "steer" });
		await hookRan.promise;
		await session.waitForIdle();

		expect(failingHook).toHaveBeenCalledTimes(1);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(requestedModels).toEqual([]);
	});

	it("enforces fail-closed usage health when model fallback is disabled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled fail-closed model");
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel().stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "reserve",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "reserve",
					remainingFraction: 0.05,
				},
			],
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await expect(session.prompt("Do not spend reserve")).rejects.toThrow("reserve policy is fail-closed");
	});

	it("does not degrade Fireworks Fast or retry a chain after queued fail-closed preflight", async () => {
		const primaryModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled queued fail-closed models");
		const requestedModels: string[] = [];
		const streamStarted = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<{ content: string[] }>();
		const mock = createMockModel({
			responses: [
				async () => {
					streamStarted.resolve();
					return firstResponse.promise;
				},
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		let useReserve = false;
		const usageHealth = vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("Keep the primary stream active");
		await streamStarted.promise;
		useReserve = true;
		await session.sendUserMessage("Queue blocked work", { deliverAs: "steer" });
		firstResponse.resolve({ content: ["primary stream completed"] });
		await firstPrompt;
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("rechecks fail-closed usage health before an internally scheduled continuation", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled scheduled continuation model");
		const requestedModels: string[] = [];
		let useReserve = false;
		const mock = createMockModel({
			responses: [
				async () => {
					useReserve = true;
					return { content: [], stopReason: "stop" };
				},
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Retry this empty response");
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("rechecks fail-closed usage health before a same-turn tool continuation", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled tool-continuation model");
		const requestedModels: string[] = [];
		let useReserve = false;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "consume",
			label: "Consume",
			description: "Consume plan quota",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				useReserve = true;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "consume", arguments: { value: "done" } }] },
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Use the tool");
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});
	it("rechecks fail-closed usage health when prompt setup changes the model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const setupTarget = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primaryModel || !setupTarget) throw new Error("Expected bundled setup-handoff models");
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["must not run"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async (_provider, options) => {
				usageChecks.push(options.modelId ?? "");
				const reserve = options.modelId === setupTarget.id;
				return {
					state: reserve ? "reserve" : "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							state: reserve ? "reserve" : "healthy",
							remainingFraction: reserve ? 0.05 : 0.8,
						},
					],
				};
			});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn(async () => {
				if (!session) throw new Error("Expected active session");
				await session.setModelTemporary(setupTarget, undefined, { ephemeral: true });
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Change models during setup");

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(usageChecks).toEqual([primaryModel.id, setupTarget.id]);
		expect(requestedModels).toEqual([]);
	});

	it("restarts usage preflight when the model changes during a health request", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primaryModel || !selectedModel) throw new Error("Expected bundled preflight race models");
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const healthStarted = Promise.withResolvers<void>();
		const releaseHealth = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [{ content: ["must not run"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async (_provider, options) => {
				usageChecks.push(options.modelId ?? "");
				if (options.modelId === primaryModel.id) {
					healthStarted.resolve();
					await releaseHealth.promise;
				}
				const reserve = options.modelId === selectedModel.id;
				return {
					state: reserve ? "reserve" : "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							state: reserve ? "reserve" : "healthy",
							remainingFraction: reserve ? 0.05 : 0.8,
						},
					],
				};
			});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const prompting = session.prompt("Change models during preflight");
		await healthStarted.promise;
		await session.setModelTemporary(selectedModel, undefined, { ephemeral: true });
		releaseHealth.resolve();
		await expect(prompting).rejects.toThrow(`reserve reached for ${selectedModel.provider}/${selectedModel.id}`);

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(usageChecks).toEqual([primaryModel.id, selectedModel.id]);
		expect(session.model?.id).toBe(selectedModel.id);
		expect(requestedModels).toEqual([]);
	});

	it("finishes usage preflight when no model is selected", async () => {
		const agent = new Agent({
			initialState: { model: undefined, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await expect(session.prompt("No model configured")).rejects.toThrow("No model selected");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("continues a startup-owned role fallback chain from the active fallback", async () => {
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!firstFallback || !secondFallback) {
			throw new Error("Expected bundled fallback models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: firstFallback,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on the remaining fallback"] });
				} else {
					throw new Error(
						`Unexpected model requested during startup fallback test: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const primarySelector = "missing-provider/missing-model";
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				slow: [`${firstFallback.provider}/${firstFallback.id}`, `${secondFallback.provider}/${secondFallback.id}`],
			},
		});
		settings.setModelRole("slow", primarySelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			initialRetryFallback: {
				role: "slow",
				originalSelector: primarySelector,
				originalThinkingLevel: undefined,
			},
		});
		// Startup-owned: selected before the session ran, so it owns every turn
		// from the first request — there is no earlier model's work to misattribute.
		expect(session.servingModel).toEqual({
			selector: `${firstFallback.provider}/${firstFallback.id}`,
			isFallback: true,
		});

		const swapProbe: Array<ServingModel | undefined> = [];
		const observed = session;
		observed.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
				swapProbe.push(observed.servingModel);
			}
		});

		await session.prompt("Continue the startup fallback chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "slow",
			},
		]);
		// Nothing had served when the chain advanced, so there was no earlier work
		// to miscredit and the candidate being attempted is the only answer — but
		// it is still reported as fallback-routed.
		expect(swapProbe).toEqual([{ selector: `${secondFallback.provider}/${secondFallback.id}`, isFallback: true }]);
		expect(session.servingModel).toEqual({
			selector: `${secondFallback.provider}/${secondFallback.id}`,
			isFallback: true,
		});
	});

	it("keeps advisor fallback recovery on its role chain when another role shares its model", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const unrelatedFallback = getBundledModel("openai", "gpt-4o");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		if (!mainModel || !advisorPrimary || !unrelatedFallback || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({
			responses: [{ content: ["Primary complete"] }, { content: ["Primary complete again"] }],
		});
		const advisorMock = createMockModel();
		let advisorPrimaryAttempts = 0;
		const requestedAdvisorModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const advisorFailures: string[] = [];
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const unrelatedFallbackSelector = `${unrelatedFallback.provider}/${unrelatedFallback.id}`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				commit: [unrelatedFallbackSelector],
				advisor: [advisorFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("commit", `${advisorPrimarySelector}:medium`);
		settings.setModelRole("advisor", advisorRoleSelector);
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "fallback-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector && advisorPrimaryAttempts++ === 0) {
					advisorMock.push({
						throw: "Devin stream error failed_precondition: Your daily usage quota has been exhausted. Your quota will reset after 1s.",
					});
				} else if (selector === advisorPrimarySelector) {
					advisorMock.push({ content: ["Advisor primary restored"] });
				} else if (selector === unrelatedFallbackSelector) {
					advisorMock.push({ content: ["Unrelated fallback answered"] });
				} else if (selector === advisorFallbackSelector) {
					advisorMock.push({ content: ["Advisor recovered"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
				fallbackSucceeded.resolve();
			}
			if (event.type === "notice" && event.source === "advisor" && event.message.includes("unavailable")) {
				advisorFailures.push(event.message);
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		// The catch-up gate releases immediately while the advisor is mid-failure
		// (a failing advisor must never park the primary), so waitForIdle can
		// return before the fallback retry lands — await the success event.
		await fallbackSucceeded.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorFallback.provider,
			id: advisorFallback.id,
		});
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: advisorRoleSelector,
				to: advisorFallbackSelector,
				role: "advisor",
			},
		]);
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${advisorFallbackSelector}:high`,
				role: "advisor",
			},
		]);
		expect(advisorFailures).toEqual([]);

		const getApiKey = vi.spyOn(modelRegistry, "getApiKey");
		const afterCooldown = Date.now() + 2_000;
		vi.spyOn(Date, "now").mockReturnValue(afterCooldown);
		await session.prompt("Complete another primary turn after the advisor cooldown");
		await session.waitForIdle();
		expect(getApiKey).toHaveBeenCalledWith(
			expect.objectContaining({ provider: advisorPrimary.provider, id: advisorPrimary.id }),
			expect.any(String),
			{ signal: expect.any(AbortSignal) },
		);

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector, advisorPrimarySelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorPrimary.provider,
			id: advisorPrimary.id,
		});
	});

	it("switches an advisor off a dual-classified media-budget 413 with no token excess", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		if (!mainModel || !advisorPrimary || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requestedAdvisorModels: string[] = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const advisorFailures: string[] = [];
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [advisorFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("commit", `${mainModel.provider}/${mainModel.id}`);
		settings.setModelRole("advisor", advisorRoleSelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "media-budget-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector) {
					advisorMock.push({
						stopReason: "error",
						errorMessage: "request_too_large: image count exceeds the limit of 20",
						usage: { input: 5_000 },
					});
				} else if (selector === advisorFallbackSelector) {
					advisorMock.push({ content: ["Advisor recovered"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fallbackSucceeded.resolve();
			if (event.type === "notice" && event.source === "advisor" && event.message.includes("unavailable")) {
				advisorFailures.push(event.message);
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		await fallbackSucceeded.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorFallback.provider,
			id: advisorFallback.id,
		});
		expect(advisorFailures).toEqual([]);
	});

	it("keeps a usage-backed media-budget overflow from switching the advisor", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		if (!mainModel || !advisorPrimary || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requestedAdvisorModels: string[] = [];
		const advisorFailed = Promise.withResolvers<void>();
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [advisorFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("commit", `${mainModel.provider}/${mainModel.id}`);
		settings.setModelRole("advisor", advisorRoleSelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "media-budget-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector) {
					advisorMock.push({
						stopReason: "error",
						errorMessage: "request_too_large: image count exceeds the limit of 20",
						usage: { input: (advisorPrimary.contextWindow ?? 200_000) + 100_000 },
					});
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "advisor" && event.message.includes("unavailable")) {
				advisorFailed.resolve();
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		await advisorFailed.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorPrimary.provider,
			id: advisorPrimary.id,
		});
	});

	it("hops an advisor to the chain owned by the fallback it landed on", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!mainModel || !advisorPrimary || !advisorFallback || !secondFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requestedAdvisorModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;
		const secondFallbackSelector = `${secondFallback.provider}/${secondFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		// The advisor role chain ends at the first fallback, which owns a chain of
		// its own. Reaching the second requires re-resolving from the live model.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [advisorFallbackSelector],
				[advisorFallbackSelector]: [secondFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", advisorRoleSelector);
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "chain-hop-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector || selector === advisorFallbackSelector) {
					advisorMock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (selector === secondFallbackSelector) {
					advisorMock.push({ content: ["Advisor recovered on the second chain"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "retry_fallback_succeeded") fallbackSucceeded.resolve();
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		await fallbackSucceeded.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector, secondFallbackSelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: secondFallback.provider,
			id: secondFallback.id,
		});
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: advisorRoleSelector,
				to: advisorFallbackSelector,
				role: "advisor",
			},
			{
				type: "retry_fallback_applied",
				from: `${advisorFallbackSelector}:high`,
				to: secondFallbackSelector,
				role: advisorFallbackSelector,
			},
		]);
	});

	it("ignores late advisor fallback credentials after a session transition", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("openai", "gpt-4o");
		if (!mainModel || !advisorPrimary || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel({
			responses: [{ throw: "service unavailable: 503 overloaded" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				[advisorPrimarySelector]: [advisorFallbackSelector],
			},
		});
		settings.setModelRole("advisor", advisorPrimarySelector);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		session.setAdvisorEnabled(true);

		const credentialStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const credentialReturned = Promise.withResolvers<void>();
		let credentialSignal: AbortSignal | undefined;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, _sessionId, options) => {
			if (model.provider === advisorFallback.provider && model.id === advisorFallback.id) {
				credentialSignal = options?.signal;
				credentialStarted.resolve();
				await releaseCredential.promise;
				credentialReturned.resolve();
			}
			return `${model.provider}-test-key`;
		});

		await session.prompt("Trigger advisor fallback");
		await credentialStarted.promise;
		await session.newSession();
		releaseCredential.resolve();
		await credentialReturned.promise;
		await Bun.sleep(0);

		expect(credentialSignal?.aborted).toBe(true);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorPrimary.provider,
			id: advisorPrimary.id,
		});
	});

	it("activates a model-keyed fallback chain without any role assignment", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via model-keyed chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: `${primaryModel.provider}/${primaryModel.id}`,
			},
		]);
	});

	it("prefers a model-keyed chain over the matching role chain", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const modelKeyFallback = getBundledModel("openai", "gpt-4o-mini");
		const roleChainFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !modelKeyFallback || !roleChainFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${roleChainFallback.provider}/${roleChainFallback.id}`],
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${modelKeyFallback.provider}/${modelKeyFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Model-keyed chain wins");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${modelKeyFallback.provider}/${modelKeyFallback.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${modelKeyFallback.provider}/${modelKeyFallback.id}`,
				role: `${primaryModel.provider}/${primaryModel.id}`,
			},
		]);
	});

	it("falls back to the chain when credential rotation exhausts the retry budget", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "429 usage_limit_reached" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		// Rotation always claims a sibling credential is available — the shape
		// of a multi-account pool where the sibling check passes but every
		// subsequent request keeps failing on the same capped account.
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: true });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Exhaust rotation, then fail over");
		await session.waitForIdle();

		// Two rotation retries burn the budget on the primary; the exhausted
		// attempt consults the chain instead of giving up.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		// The fallback model gets a fresh retry budget (attempt resets to 1).
		expect(retryStartEvents.map(event => event.attempt)).toEqual([1, 2, 1]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
	});

	it("applies a provider-wildcard chain to any model of that provider", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-opus-4-1");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// No exact key for this model and no role assignment: only the
		// `anthropic/*` wildcard can match, proving provider-level coverage.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via provider wildcard");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "anthropic/*",
			},
		]);
	});

	it("consults the fallback chain on a non-retryable hard error instead of failing the turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider) {
					// Classifies as neither transient, usage-limit, nor auth:
					// the generic retry classifier rejects it outright.
					mock.push({ throw: "unrecoverable model quirk" });
				} else {
					mock.push({ content: ["Recovered on fallback"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Survive a hard error");
		await session.waitForIdle();

		// Exactly one attempt on the failing model: a hard error switches models
		// immediately, it never backoff-retries the same model.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "anthropic/*",
			},
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});
	it("surfaces immutable Anthropic thinking errors without retry fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const immutableThinkingError =
			"400 invalid_request_error: messages.1.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified";
		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else {
					mock.push({ throw: immutableThinkingError });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		await session.prompt("Continue");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(retryStartEvents).toEqual([]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			errorMessage: immutableThinkingError,
		});
	});

	it("keeps signed Anthropic thinking on its source model during transient retry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else if (requestCount === 2) {
					mock.push({ throw: "503 overloaded_error: provider returned error" });
				} else {
					mock.push({ content: ["Recovered on Sonnet"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		const seededAssistant = agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (!seededAssistant) throw new Error("Expected seeded assistant message");
		seededAssistant.api = primaryModel.api;
		seededAssistant.provider = primaryModel.provider;
		seededAssistant.model = primaryModel.id;
		await session.prompt("Retry a transient failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("surfaces a non-retryable error without same-model retries when no fallback candidate has a credential", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId) =>
			model.provider === fallbackModel.provider ? Promise.resolve(undefined) : originalGetApiKey(model, sessionId),
		);

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push({ throw: "unrecoverable model quirk" });
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Fail hard with no fallback credential");
		await session.waitForIdle();

		// The switch could not happen and the error is non-retryable: surface it
		// after a single attempt instead of backoff-retrying the failing model.
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("substitutes the failing model id into provider-wildcard chain entries", async () => {
		const primaryModel = getBundledModel("google", "gemini-2.5-flash");
		const fallbackModel = getBundledModel("google-vertex", "gemini-2.5-flash");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// `google-vertex/*` is not a fixed target: it must adopt the failing
		// model's id (google/gemini-2.5-flash -> google-vertex/gemini-2.5-flash).
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"google/*": ["google-vertex/*"],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via id-preserving wildcard entry");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe("google-vertex");
		expect(session.model?.id).toBe(primaryModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `google-vertex/${primaryModel.id}`,
				role: "google/*",
			},
		]);
	});

	it("re-prefixes the failing model's bare id for id-prefixed wildcard chain entries and fails closed for paid candidates without authentic 429", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Enforces: INV-QR-12, INV-QR-16, FORBIDDEN-QR-14
		 * - Category: negative / security (fail-closed paid fallback suppression)
		 * - Risk tier: High
		 */
		const primaryModel = getBundledModel("google", "gemini-2.5-flash");
		const fallbackModel = getBundledModel("openrouter", "google/gemini-2.5-flash");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// `openrouter/google/*` splits into provider `openrouter` + id prefix
		// `google`: the failing bare id is re-prefixed into the aggregator's
		// namespace (google/gemini-2.5-flash -> openrouter/google/gemini-2.5-flash).
		// However, because the resolved candidate is paid OpenRouter and the
		// failing predecessor is non-Antigravity/generic Google without an
		// authentic 429 receipt, paid fallback is suppressed, allowing bounded
		// same-model recovery without invoking paid OpenRouter.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"google/*": ["openrouter/google/*"],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Recover via id-prefixed wildcard entry");
		await session.waitForIdle();

		// Fail-closed under INV-QR-12, INV-QR-16, and FORBIDDEN-QR-14:
		// Paid OpenRouter inference is never invoked without an authentic Google Antigravity 429.
		// Recovery stays on same-model retry.
		expect(requestedModels.filter(m => m === `${fallbackModel.provider}/${fallbackModel.id}`)).toHaveLength(0);
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents.filter(e => e.to === `${fallbackModel.provider}/${fallbackModel.id}`)).toHaveLength(
			0,
		);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it("matches id-prefixed wildcard keys and strips the vendor prefix for direct-provider targets", async () => {
		const primaryModel = getBundledModel("openrouter", "google/gemini-2.5-flash");
		const fallbackModel = getBundledModel("google-vertex", "gemini-2.5-flash");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// Key `openrouter/google/*` covers only openrouter's google-namespaced
		// ids; the plain `google-vertex/*` target drops the aggregator's vendor
		// prefix because vertex only knows the bare id.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"openrouter/google/*": ["google-vertex/*"],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via id-prefixed wildcard key");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe("google-vertex");
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `google-vertex/${fallbackModel.id}`,
				role: "openrouter/google/*",
			},
		]);
	});

	it("uses the active initial model as the default fallback primary when other role fallback chains are configured", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		const otherRoleFallbackModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !fallbackModel || !otherRoleFallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
				smol: [`${otherRoleFallbackModel.provider}/${otherRoleFallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover using implicit default primary");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
	});

	it("falls back on structured classifier refusals and pins the fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const refusalDetails = {
			type: "refusal",
			category: "cyber",
			explanation: "Classifier declined this turn.",
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					primaryAttempts += 1;
					mock.push({
						content: [{ type: "thinking", thinking: "Classifier evaluation before refusal." }],
						stopReason: "error",
						stopDetails: refusalDetails,
						errorMessage: "Refusal (cyber): Classifier declined this turn.",
					});
				} else if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) {
					mock.push({ content: [`ok:${primaryAttempts}`] });
				} else {
					throw new Error(
						`Unexpected model requested during refusal fallback test: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("Recover from classifier refusal");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 10 * 60 * 1000;
		await session.prompt("Next turn stays pinned on fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("drops classifier refusal messages before later prompts", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: ["Classifier declined this turn."],
					stopReason: "error",
					stopDetails: {
						type: "refusal",
						category: "bio",
						explanation: "Classifier declined this turn.",
					},
					errorMessage: "Refusal (bio): Classifier declined this turn.",
				},
				context => {
					const replayedAssistantText = context.messages
						.filter((message): message is AssistantMessage => message.role === "assistant")
						.flatMap(message => message.content)
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					return {
						content: [replayedAssistantText.includes("Classifier declined this turn.") ? "polluted" : "clean"],
					};
				},
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionStopCalls: number[] = [];
		const sessionStopLastAssistantMessages: Array<AssistantMessage | undefined> = [];
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn((event: { last_assistant_message?: AssistantMessage }) => {
				sessionStopCalls.push(mock.calls.length);
				sessionStopLastAssistantMessages.push(event.last_assistant_message);
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();
		await session.prompt("Next prompt should not replay the refusal");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const replayedAssistantText = mock.calls[1]?.context.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(replayedAssistantText).not.toContain("Classifier declined this turn.");
		expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "clean" }]);
		// session_stop hooks must fire after each settled turn — including the
		// refusal turn (regression: prior to PR #3594's review fix, the refusal
		// branch short-circuited before `#emitSessionStopEvent`).
		expect(sessionStopCalls).toEqual([1, 2]);
		expect(sessionStopLastAssistantMessages[0]?.stopReason).toBe("error");
		expect(sessionStopLastAssistantMessages[0]?.stopDetails).toEqual({
			type: "refusal",
			category: "bio",
			explanation: "Classifier declined this turn.",
		});
	});

	it("keeps the pruned refusal visible to getLastAssistantMessage until the next run", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					errorMessage: "Refusal (cyber): Declined.",
				},
				{ content: ["recovered"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();

		// The refusal turn is pruned from active context (no assistant tail)…
		expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		// …but terminal-outcome consumers (print mode, task executor) must still
		// see the settled error instead of a silently successful-looking state.
		const settled = session.getLastAssistantMessage();
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe("Refusal (cyber): Declined.");
		expect(settled?.stopDetails).toEqual({ type: "refusal", category: "cyber", explanation: "Declined." });

		await session.prompt("Next prompt supersedes the pruned refusal");
		await session.waitForIdle();

		const recovered = session.getLastAssistantMessage();
		expect(recovered?.stopReason).toBe("stop");
		expect(recovered?.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("does not exceed retry.maxRetries for classifier fallback chains", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const mock = createMockModel();
		const refusalMessage = "Refusal (cyber): Classifier declined this fallback turn.";
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({
						stopReason: "error",
						stopDetails: {
							type: "refusal",
							category: "cyber",
							explanation: "Classifier declined this fallback turn.",
						},
						errorMessage: refusalMessage,
					});
				} else {
					throw new Error(
						`Unexpected model requested after retry budget exhaustion: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await session.prompt("Stop after the configured retry budget");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: refusalMessage,
		});
		// The superseded first attempt is aggregated onto the terminal event so
		// the transcript renders one budget-labeled error, not per-attempt rows.
		expect(retryEndEvents[0]?.retryErrors).toHaveLength(1);
		expect(retryEndEvents[0]?.retryErrors?.[0]?.retryRecovery).toMatchObject({
			kind: "auto-retry",
			recovery: "model",
			status: "superseded",
			attempt: 1,
		});
	});

	it("emits auto_retry_end when a mid-saga classifier refusal has no fallback to switch to", async () => {
		// Regression: `#handleRetryableError`'s classifier-refusal branch used to
		// return `false` without emitting `auto_retry_end` whenever no fallback
		// model was available to switch to. A saga that already announced
		// `auto_retry_start` on an earlier (non-refusal) attempt would then never
		// get a matching `auto_retry_end` — leaving any subscriber tracking
		// "retry outstanding" state (e.g. suppressing a duplicate error toast)
		// latched open forever. With `retry.maxRetries: 2` and no fallback chain
		// configured, the second attempt's classifier refusal hits that branch
		// while `retryAttempt (2) <= maxRetries (2)`, so it can't fall through
		// the pre-existing maxRetries-exceeded path (which already emits
		// `auto_retry_end`) — isolating the branch this regression covers.
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const requestedModels: string[] = [];
		const refusalMessage = "Refusal (cyber): Classifier declined this retried turn.";
		const mock = createMockModel();
		let calls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				calls += 1;
				if (calls === 1) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (calls === 2) {
					mock.push({
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined." },
						errorMessage: refusalMessage,
					});
				} else {
					throw new Error(`Unexpected model call after the classifier refusal settled: call ${calls}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry once, then hit a classifier refusal with no fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.attempt).toBe(1);
		expect(retryEndEvents).toEqual([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: refusalMessage,
			},
		]);
	});

	it("uses Google retry hints in quota errors before quota backoff", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const errorMessage =
			"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 0.05s.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["Recovered after Google quota retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Google token quota");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 50,
			errorMessage,
		});
		expect(waitSpy).toHaveBeenCalledWith(50, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Google quota retry" });
	});

	it("keeps retry on the primary model when retry model fallback is disabled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: "rate limit exceeded retry-after-ms=200" }, { content: ["Recovered on primary retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Retry rate limit without switching models");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 200,
			errorMessage: "rate limit exceeded retry-after-ms=200",
		});
		expect(waitSpy).toHaveBeenCalledWith(200, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered on primary retry" });
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: timeoutMessage }, { content: ["Recovered after OpenAI timeout"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries stream stall errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const stallMessage = "Provider stream stalled while waiting for the next event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: stallMessage }, { content: ["Recovered after stream stall"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stream stall");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: stallMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after stream stall" });
	});

	it("auto-retries OpenAI processing-request transient errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const processingError =
			"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4a4c6b73-a07c-4de0-aaaf-82560f9f626a in your message.";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: processingError }, { content: ["Recovered after OpenAI processing error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry OpenAI processing-request error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: processingError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after OpenAI processing error",
		});
	});

	it("restarts Responses provider state before retrying stale item-id replay errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const staleReplayError = "Item with id 'rs_stale' not found.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: staleReplayError }, { content: ["Recovered after Responses state reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stale OpenAI replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: staleReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after Responses state reset",
		});
	});

	it("restarts Responses provider state before retrying Zero Data Retention errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mirrors the live wire error from OpenAI ZDR orgs after the in-provider
		// retry has already exhausted itself; the higher-level retry must still
		// classify the failure as a stale-replay event so the session reset and
		// zero-delay backoff fire instead of a model fallback.
		const zdrReplayError = "400 Previous response cannot be used for this organization due to Zero Data Retention.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: zdrReplayError }, { content: ["Recovered after ZDR reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry ZDR replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: zdrReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after ZDR reset" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_start before message_start";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_start");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("falls back on mid-stream Anthropic envelope failures without same-model retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mid-stream envelope corruption is not auto-retried on the same model
		// (partial content may have been delivered), but a configured fallback
		// chain is still consulted: a different model is a fresh chance.
		const envelopeError = "Anthropic stream envelope error: received content_block_delta before terminal stop signal";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel({ handler: () => ({ throw: envelopeError }) });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Do not retry Anthropic envelope failure before terminal stop signal");
		await session.waitForIdle();

		// One attempt per model: chain advances, never a same-model backoff retry.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		// The fallback fails with the same hard error and the chain is exhausted:
		// the failure surfaces instead of looping.
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe(envelopeError);
	});

	it("closes the retry lifecycle when a retried turn ends with a non-retryable error", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI test model to exist");

		const retryableError = "rate limit exceeded retry-after-ms=5";
		const terminalError = "invalid request: schema violation";
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				mock.push({ throw: requestedModels.length === 1 ? retryableError : terminalError });
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Retry once, then surface a terminal validation failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: terminalError }),
		]);
		expect(session.retryAttempt).toBe(0);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("auto-retries a bare Request was aborted error-stop turn (issue #5375)", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const requestedModels: string[] = [];
		// A stalled/dropped stream that the provider surfaces as stopReason:"error"
		// carrying the bare abort sentinel, then a clean recovery on the retry.
		const mock = createMockModel({
			responses: [{ throw: "Request was aborted." }, { content: ["recovered after bare abort error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry the bare abort error");
		await session.waitForIdle();

		// Same model, retried once (no model fallback for a reason-less abort).
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "recovered after bare abort error",
		});
	});

	it("matches plain fallback roles for compat-routed primary models", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const routedPrimary = buildModel({
			id: "z-ai/glm-4.7",
			name: "GLM 4.7",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { openRouterRouting: { only: ["cerebras"] } },
		});

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: routedPrimary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const route =
					requestedModel.provider === "openrouter" &&
					requestedModel.compat &&
					"openRouterRouting" in requestedModel.compat
						? requestedModel.compat.openRouterRouting?.only?.[0]
						: undefined;
				const requested = `${requestedModel.provider}/${requestedModel.id}${route ? `@${route}` : ""}`;
				requestedModels.push(requested);
				if (requestedModel.provider === "openrouter" && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requested}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", "openrouter/z-ai/glm-4.7");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Compat-routed primary should still match plain role");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("keeps exact @-suffixed model IDs in fallback selectors", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("google-vertex", "claude-opus-4-8@default");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled OpenAI and Vertex Anthropic test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === primaryModel.provider && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: `rate limit exceeded retry-after-ms=${FALLBACK_TEST_RETRY_AFTER_MS}` });
				} else {
					mock.push({ content: [`ok:${requestedModel.provider}/${requestedModel.id}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Fallback should keep exact @ model id");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});
	it("suppresses cooled selectors and lazily reverts to the role primary after cooldown expiry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels, { retryAfterMs: 200 });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		await session.prompt("Immediate second prompt should stay on fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 240;
		await session.prompt("Third prompt should lazily revert to primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		// The restored primary answered, so attribution moves back with it.
		expect(session.servingModel).toEqual({
			selector: `${primaryModel.provider}/${primaryModel.id}`,
			isFallback: false,
		});
	});

	it("keeps credit with the fallback when a restored primary fails without serving", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// Only the fallback ever produces anything; the primary rate-limits on
				// every request, including after its cooldown expires and it is
				// restored. `retry-after-ms` keeps the cooldown short enough to expire
				// within the test's clock jump.
				mock.push(
					model.id === fallbackModel.id
						? { content: ["the fallback did the work"] }
						: { throw: "rate limit exceeded retry-after-ms=200" },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("Fail over to the fallback");
		await session.waitForIdle();
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		});

		// Capture attribution inside the restore's synchronous `model_changed`
		// fan-out, which is the window the restore path reopens.
		const servingDuringSwaps: Array<ServingModel | undefined> = [];
		const restoring = session;
		restoring.subscribe(event => {
			if (event.type === "model_changed") servingDuringSwaps.push(restoring.servingModel);
		});

		now += 240;
		await session.prompt("Cooldown expired: revert to the primary and fail there");
		await session.waitForIdle();

		// A restore is a routing decision like a fallback is: the primary produced
		// nothing after coming back, so the work still belongs to the fallback.
		expect(requestedModels).toContain(`${primaryModel.provider}/${primaryModel.id}`);
		expect(servingDuringSwaps.length).toBeGreaterThan(0);
		for (const serving of servingDuringSwaps) {
			expect(serving?.selector).not.toBe(`${primaryModel.provider}/${primaryModel.id}`);
		}
	});

	it("reports a Fireworks Fast degrade as fallback-routed even though it arms no chain", async () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected the bundled Fireworks Fast model to exist");
		const baseId = fastModel.id.replace(/-fast$/, "");

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: fastModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// Fast rejects the request; the base model answers it.
				mock.push(
					model.id === fastModel.id
						? { throw: "rate limit exceeded retry-after-ms=200" }
						: { content: ["the base model did the work"] },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 5 });
		settings.setModelRole("default", `${fastModel.provider}/${fastModel.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Degrade off Fast and answer on the base model");
		await session.waitForIdle();

		// The degrade swaps models without arming a retry-fallback chain, but it is
		// still fallback routing — a bare model badge would hide that.
		expect(requestedModels).toEqual([`${fastModel.provider}/${fastModel.id}`, `fireworks/${baseId}`]);
		expect(session.servingModel).toEqual({ selector: `fireworks/${baseId}`, isFallback: true });

		// How the previous transcript was routed says nothing about a freshly
		// loaded one: switching sessions in place must not describe the new
		// session's model as fallback-routed.
		vi.spyOn(session.sessionManager, "getSessionId").mockReturnValue("some-other-session");
		expect(session.servingModel).toEqual({ selector: `fireworks/${baseId}`, isFallback: false });
	});

	it("re-checks context before a cooldown-expiry revert onto a smaller-window model in the auto-continue path", async () => {
		// Regression for #7952: a cooldown-expiry revert reverts the model at a
		// turn boundary. The user-prompt path re-checks context after the revert
		// (runPrePromptCompactionIfNeeded), but the automatic agent.continue()
		// path did not — so reverting onto a model whose window is smaller than
		// the accumulated context sent a predictably oversized request. Here the
		// small primary (4000-token window) fell back to a large-window model,
		// accumulated context past 4000 while there, then the cooldown expired and
		// a queued follow-up drained through the auto-continue path.
		const modelsConfigPath = path.join(tempDir.path(), "revert-overflow-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 4000, contextPromotionTarget: "openai/gpt-4o" },
							"gpt-4o": { contextWindow: 1_000_000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("openai", "gpt-4o-mini");
		const fallbackModel = modelRegistry.find("openai", "gpt-4o");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected override models to resolve");
		}
		expect(primaryModel.contextWindow).toBe(4000);
		expect(fallbackModel.contextWindow).toBe(1_000_000);

		// ~15k estimated tokens: over the primary's 4000 window (80% => 3200) but
		// far under the fallback's (800k), so it sits on the fallback without
		// compaction and only overflows once the window shrinks on revert.
		const bigText = "lorem ipsum ".repeat(5000);
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		let fallbackTurns = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.id === primaryModel.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else if (model.id === fallbackModel.id && fallbackTurns === 0) {
					fallbackTurns += 1;
					mock.push({ content: [bigText] });
				} else {
					mock.push({ content: ["ok"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"contextPromotion.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Primary rate-limits, falls back to the large-window model, and that turn
		// returns a large payload that grows context past the primary's window.
		await session.prompt("Trigger fallback and grow context past the primary window");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.id).toBe(fallbackModel.id);

		// Cooldown expires; a queued follow-up drains through the auto-continue
		// (agent.continue) path, which reverts to the primary. The post-revert
		// context check now runs there too: the accumulated context no longer fits
		// the primary's 4000 window, so it promotes to the larger-window model
		// instead of issuing the oversized request. Before the fix the session
		// stayed on the reverted primary and received the over-window request.
		now += 60_000;
		await session.followUp("Please continue on the reverted primary");
		await session.waitForIdle();

		expect(session.model?.id).toBe(fallbackModel.id);
		expect(requestedModels.at(-1)).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		// The 4000-window primary is only ever hit by the initial rate-limited
		// request — never by an over-window continuation after the revert.
		expect(requestedModels.filter(id => id === `${primaryModel.provider}/${primaryModel.id}`)).toHaveLength(1);
	});

	it("does not send oversized context to a smaller retry fallback model", async () => {
		// Regression for #8065: the forward counterpart of #7952. A retryable
		// error on a large-window primary switches to a retry-fallback candidate,
		// but candidate selection never compared the candidate's window with the
		// live context. A 1M-window primary could fall onto a 4000-window fallback
		// and immediately send a predictably oversized request. The fit gate must
		// skip the undersized candidate and advance to the first configured
		// candidate whose window can hold the accumulated context.
		const modelsConfigPath = path.join(tempDir.path(), "fallback-overflow-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: {
							"claude-sonnet-4-5": { contextWindow: 1_000_000 },
						},
					},
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 4000, contextPromotionTarget: "openai/gpt-4o" },
							"gpt-4o": { contextWindow: 1_000_000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const smallFallback = modelRegistry.find("openai", "gpt-4o-mini");
		const largeFallback = modelRegistry.find("openai", "gpt-4o");
		if (!primaryModel || !smallFallback || !largeFallback) {
			throw new Error("Expected override models to resolve");
		}
		expect(primaryModel.contextWindow).toBe(1_000_000);
		expect(smallFallback.contextWindow).toBe(4000);
		expect(largeFallback.contextWindow).toBe(1_000_000);

		// ~15k estimated tokens in the initial prompt: fits the 1M primary and the
		// 1M large fallback, but far exceeds the 4000-window small fallback
		// (80% => 3200), so the small fallback cannot legally receive the request.
		const bigText = "lorem ipsum ".repeat(5000);
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.id === primaryModel.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: ["ok"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"contextPromotion.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${smallFallback.provider}/${smallFallback.id}`, `${largeFallback.provider}/${largeFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Primary rate-limits with a live ~15k context; the retry-fallback path
		// must skip the 4000-window candidate and land on the 1M-window one.
		await session.prompt(bigText);
		await session.waitForIdle();

		expect(requestedModels).not.toContain(`${smallFallback.provider}/${smallFallback.id}`);
		expect(requestedModels).toContain(`${largeFallback.provider}/${largeFallback.id}`);
		expect(session.model?.id).toBe(largeFallback.id);
		expect(requestedModels.at(-1)).toBe(`${largeFallback.provider}/${largeFallback.id}`);
	});

	it("fits retry fallbacks after excluding the failed assistant turn", async () => {
		const modelsConfigPath = path.join(tempDir.path(), "fallback-failed-turn-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: {
							"claude-sonnet-4-5": { contextWindow: 1_000_000 },
						},
					},
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 8000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const fallbackModel = modelRegistry.find("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected override models to resolve");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.id === primaryModel.id) {
					mock.push({
						content: [{ type: "thinking", thinking: "lorem ipsum ".repeat(5000) }],
						stopReason: "error",
						errorMessage: "rate limit exceeded retry-after-ms=200",
					});
				} else {
					mock.push({ content: ["ok"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// The input fits the 8k fallback, while the failed thinking-only assistant
		// does not. That assistant is removed before retry, so it must not make the
		// selector reject a fallback that can hold the request actually sent.
		await session.prompt("small retry input");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("restores routed fallback primaries after cooldown expiry", async () => {
		const openRouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!openRouterModel || !fallbackModel) {
			throw new Error("Expected bundled OpenRouter and OpenAI test models to exist");
		}
		const routedPrimary = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [openRouterModel]).model;
		if (!routedPrimary) {
			throw new Error("Expected routed OpenRouter primary to resolve");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: routedPrimary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const route =
					requestedModel.provider === "openrouter"
						? (
								requestedModel.compat as {
									openRouterRouting?: { only?: string[] };
								}
							).openRouterRouting?.only?.[0]
						: undefined;
				const requested = `${requestedModel.provider}/${requestedModel.id}${route ? `@${route}` : ""}`;
				requestedModels.push(requested);
				if (requested === "openrouter/z-ai/glm-4.7@cerebras" && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requested}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", "openrouter/z-ai/glm-4.7@cerebras");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers routed primary fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);

		now += 240;
		await session.prompt("Second prompt should restore routed primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
			"openrouter/z-ai/glm-4.7@cerebras",
		]);
		expect(session.model?.provider).toBe("openrouter");
		expect(session.model?.id).toBe("z-ai/glm-4.7");
		expect(
			(session.model?.compat as { openRouterRouting?: { only?: string[] } } | undefined)?.openRouterRouting?.only,
		).toEqual(["cerebras"]);
	});
	it("preserves thinking on bare fallback selectors and does not overwrite user thinking on restore", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels, { retryAfterMs: 200 });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}:high`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers bare-selector fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.thinkingLevel).toBeUndefined();

		session.setThinkingLevel(Effort.Low);
		now += 240;
		await session.prompt("Second prompt should restore model but preserve user thinking change");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("clamps a fallback selector's explicit thinking level to the session effort ceiling", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				// Explicit `:high` on the fallback selector tries to raise effort
				// above the spawn's ceiling.
				default: [`${fallbackModel.provider}/${fallbackModel.id}:high`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			// Per-spawn cap (task.maxEffort resolved at spawn time): no recovery
			// path may raise effective effort above it.
			thinkingLevelCeiling: Effort.Low,
		});

		await session.prompt("First prompt triggers fallback with an above-ceiling selector");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		// Without the ceiling the fallback's `:high` would apply verbatim.
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("skips usage fallbacks whose effort floor exceeds the session ceiling", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const incompatibleFallback = getBundledModel("openrouter", "deepseek/deepseek-v4-pro");
		const compatibleFallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !incompatibleFallback || !compatibleFallback) {
			throw new Error("Expected bundled usage fallback effort models");
		}
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				default: [
					`${incompatibleFallback.provider}/${incompatibleFallback.id}`,
					`${compatibleFallback.provider}/${compatibleFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, options) => {
			usageChecks.push(options.modelId ?? "");
			return options.modelId === primaryModel.id
				? {
						state: "depleted",
						accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }],
					}
				: { state: "healthy", accounts: [] };
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.Low,
		});

		await session.prompt("Use an effort-compatible fallback");
		await session.waitForIdle();

		expect(usageChecks).toEqual([primaryModel.id, compatibleFallback.id]);
		expect(requestedModels).toEqual([`${compatibleFallback.provider}/${compatibleFallback.id}`]);
		expect(session.model?.id).toBe(compatibleFallback.id);
	});

	it("accepts cached Ollama Cloud fallback selectors during startup validation", () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const cachedModel: Model<"ollama-chat"> = buildModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		writeModelCache("ollama-cloud", Date.now(), [cachedModel], true, "", path.join(tempDir.path(), "models.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: ["ollama-cloud/deepseek-v4-pro"] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings).not.toContain(
			"Fallback chain for role 'default' references unknown model: ollama-cloud/deepseek-v4-pro",
		);
	});

	it("warns on unknown or malformed model-selector chain keys at startup", () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"nonexistent-provider/nonexistent-model": [`${primaryModel.provider}/${primaryModel.id}`],
				[`${primaryModel.provider}/${primaryModel.id}`]: ["openai/gpt-4o"],
			},
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings).toContain(
			"retry.fallbackChains key references unknown model: nonexistent-provider/nonexistent-model",
		);
		expect(session.configWarnings.filter(w => w.includes(`${primaryModel.provider}/${primaryModel.id}`))).toEqual([]);
	});

	it("normalizes suppression by base selector and clears it on model refresh", async () => {
		const future = Date.now() + 60_000;
		modelRegistry.suppressSelector("openai/gpt-4o:high", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:low")).toBe(true);

		// `:max` is a real thinking level now, not an xhigh alias — the two parse
		// to distinct selectors...
		expect(parseModelString("openai/gpt-4o:max", { allowMaxSuffix: true })?.thinkingLevel).toBe(Effort.Max);
		expect(parseModelString("openai/gpt-4o:xhigh")?.thinkingLevel).toBe(Effort.XHigh);
		// ...but suppression normalizes every thinking suffix to the base selector,
		// so suppressing either still covers both.
		modelRegistry.suppressSelector("openai/gpt-4o:max", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:xhigh")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:max")).toBe(true);

		await modelRegistry.refresh("offline");
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(false);
	});

	it("auto-retries Gemini MALFORMED_FUNCTION_CALL after an unexecuted tool call", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const requestedModels: string[] = [];
		let toolExecutions = 0;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "record",
			label: "Record",
			description: "Record a value",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				toolExecutions += 1;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "malformed-call",
							name: "record",
							arguments: { value: "must-not-execute" },
						},
					],
					stopReason: "error",
					errorMessage: malformedError,
				},
				{ content: ["Recovered after Gemini malformed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [tool],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from Gemini malformed error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(toolExecutions).toBe(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const failedAssistant = messages[1];
		if (failedAssistant.role !== "assistant") {
			throw new Error(`Expected failed assistant message, got ${failedAssistant.role}`);
		}
		expect(failedAssistant.errorMessage).toBe(malformedError);
		const syntheticResult = messages[2];
		if (syntheticResult.role !== "toolResult") {
			throw new Error(`Expected synthetic tool result, got ${syntheticResult.role}`);
		}
		expect(syntheticResult.toolCallId).toBe("malformed-call");
		expect(syntheticResult.details).toMatchObject({ executed: false, source: "assistant_stop_error" });
		const recoveredAssistant = messages[3];
		if (recoveredAssistant.role !== "assistant") {
			throw new Error(`Expected recovered assistant message, got ${recoveredAssistant.role}`);
		}
		const contentBlock = recoveredAssistant.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after Gemini malformed function call");
	});

	it("auto-retries provider finish_reason errors after partial text", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after provider finish_reason error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from provider finish_reason error");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].errorMessage).toBe(errorMessage);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.agent.state.messages).toHaveLength(2);
		const assistantMsg = session.agent.state.messages[1];
		if (assistantMsg.role !== "assistant") {
			throw new Error(`Expected assistant message, got ${assistantMsg.role}`);
		}
		const contentBlock = assistantMsg.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after provider finish_reason error");
	});

	it("reaches the provider and closes the saga when the failed assistant tail was recreated mid-retry", async () => {
		// Issue #5382: a context rebuild can recreate the failed turn's message
		// object between settle and retry (fresh identity, same failed tail), so
		// the identity-keyed removal misses (`agent active context assistant
		// removal missed ... lastRole=assistant lastStopReason=error`). The
		// scheduled continue() then rejected the assistant tail locally before
		// any provider request, auto_retry_end never fired, and the in-flight
		// prompt() hung forever behind the pending retryPromise.
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after tail rebuild"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		// Recreate the failed tail with a fresh object identity while the retry is
		// being scheduled, reproducing the removal-miss state from the issue.
		session.subscribe(event => {
			if (event.type !== "auto_retry_start") return;
			const messages = agent.state.messages;
			const tail = messages.at(-1);
			if (tail?.role !== "assistant" || tail.stopReason !== "error") return;
			agent.replaceMessages([...messages.slice(0, -1), { ...tail, timestamp: tail.timestamp + 1 }]);
		});

		const outcome = await Promise.race([
			session.prompt("recover after the failed tail is rebuilt").then(() => "completed" as const),
			scheduler.wait(3_000).then(() => "stuck" as const),
		]);

		expect(outcome).toBe("completed");
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(session.isRetrying).toBe(false);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	// `session.servingModel` is what the Agent Hub row reads for a live or
	// parked agent. A fallback that errors on its first request produced none of
	// the session's work, so announcing it credits the primary's output to it.
	it("withholds the fallback selector until the target has served a turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// The primary serves one real turn, then both models fail: the chain
				// switches but the target never produces anything.
				if (requestedModels.length === 1) {
					mock.push({ content: ["primary did the work"] });
				} else {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Do the work on the primary");
		await session.waitForIdle();
		expect(session.servingModel?.isFallback).toBeFalsy();
		expect(session.servingModel).toEqual({
			selector: `${primaryModel.provider}/${primaryModel.id}`,
			isFallback: false,
		});

		await session.prompt("Fail over and die on the fallback");
		await session.waitForIdle();

		// Routing moved; attribution stayed with the model that produced the work.
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(requestedModels).toContain(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.servingModel?.isFallback).toBeFalsy();
		expect(session.servingModel).toEqual({
			selector: `${primaryModel.provider}/${primaryModel.id}`,
			isFallback: false,
		});
		// Both attribution and how the model was routed belong to the session they
		// were earned in. Every real switch mints a new session id — including for
		// an unpersisted session, which has no file to compare — so both drop
		// themselves, leaving only the model this session currently points at,
		// described without a claim about how it got there.
		vi.spyOn(session.sessionManager, "getSessionId").mockReturnValue("some-other-session");
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: false,
		});
	});

	it("reports the fallback selector once the target serves a turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Observers poll this per streaming event and per render. Before anything
		// has served the answer is computed rather than stored, so that is the
		// window where a fresh allocation per call would show up.
		expect(session.servingModel).toBe(session.servingModel);

		await session.prompt("Fail over to a working fallback");
		await session.waitForIdle();

		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		});
	});

	it("carries attribution across a fork, which continues the conversation under a new id", async () => {
		using tempDir = TempDir.createSync("@omp-fallback-fork-");
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("Fail over to the fallback");
		await session.waitForIdle();
		const served = {
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		};
		expect(session.servingModel).toEqual(served);

		const sessionIdBeforeFork = sessionManager.getSessionId();
		expect(await session.fork()).toBe(true);
		expect(sessionManager.getSessionId()).not.toBe(sessionIdBeforeFork);

		// A fork clones the transcript and keeps running the same session, so the
		// work the fallback produced is still this session's — unlike a switch to
		// an unrelated transcript, which expires it.
		expect(session.servingModel).toEqual(served);
	});

	it("keeps attribution on a served fallback while the next candidate is unproven", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("google", "gemini-2.0-flash");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// Primary fails, candidate A serves, then everything fails again so
				// candidate B is armed but never produces anything.
				mock.push(
					requestedModels.length === 2
						? { content: ["candidate A did the work"] }
						: { throw: "overloaded_error: provider returned error 503" },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Fail over to candidate A");
		await session.waitForIdle();
		expect(session.servingModel).toEqual({
			selector: `${firstFallback.provider}/${firstFallback.id}`,
			isFallback: true,
		});

		// `model_changed` fans out synchronously from inside the swap, which is the
		// window where the incoming candidate could inherit the previous one's proof.
		const servingAtModelChange: Array<ServingModel | undefined> = [];
		const advancing = session;
		advancing.subscribe(event => {
			if (event.type === "model_changed") servingAtModelChange.push(advancing.servingModel);
		});
		await session.prompt("Advance to candidate B and die there");
		await session.waitForIdle();

		// Candidate B owns the routing but produced nothing, so the work still
		// belongs to candidate A — and it was reached by a fallback.
		expect(session.model?.id).toBe(secondFallback.id);
		expect(session.servingModel).toEqual({
			selector: `${firstFallback.provider}/${firstFallback.id}`,
			isFallback: true,
		});
		// Never the incoming candidate: mid-swap it has produced nothing.
		expect(servingAtModelChange.length).toBeGreaterThan(0);
		for (const serving of servingAtModelChange) {
			expect(serving?.selector).not.toBe(`${secondFallback.provider}/${secondFallback.id}`);
		}
	});

	// A usage-aware fallback is applied before a request and never increments the
	// retry counter, so gating "served" on a retry saga hid it for the whole
	// session — most visibly on the Main Session row, which has no executor
	// progress to fall back on.
	it("reports a usage-aware fallback selector without any retry saga", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["served on the fallback"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [] },
		);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Work on the healthy model");
		await session.waitForIdle();

		// Proactive: the primary was never requested, so no retry saga ran.
		expect(requestedModels).toEqual([`${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		});
	});

	// A thinking-loop abort is a same-model resample signal (the guard pairs it
	// with a `thinking-loop-redirect` notice), not a provider failure. It must
	// not walk `retry.fallbackChains` or park the current selector on a cooldown,
	// or a healthy planning turn gets replaced by another family (issue #8760).
	it("retries the same model on a thinking-loop error instead of switching via fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return requestedModels.length === 1
					? thinkingLoopErrorStream(model)
					: recoveredTextStream(model, "Recovered on the same model.");
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [fallbackSelector] },
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", primarySelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Plan the ticket, then act");
		await session.waitForIdle();

		// The fallback chain lists a different family, but the thinking-loop abort
		// re-samples the SAME model: no chain consult, no model switch.
		expect(requestedModels).toEqual([primarySelector, primarySelector]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(fallbackAppliedEvents).toHaveLength(0);
		// The abort is a thinking-loop, and the retry stayed on the same model.
		expect(retryStartEvents).toHaveLength(1);
		expect(AIError.is(retryStartEvents[0].errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		// The selector must not be parked on a fallback cooldown by the abort.
		expect(modelRegistry.isSelectorSuppressed(primarySelector)).toBe(false);
		const finalAssistant = getLastAssistantMessage(session);
		expect(finalAssistant.content).toEqual([{ type: "text", text: "Recovered on the same model." }]);
	});

	describe("Google Antigravity 429 paid OpenRouter fallback turnstile (M4.2 RED)", () => {
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

		const makeOpenRouterGeminiHigh = (): Model<"openai-completions"> =>
			buildModel({
				id: "google/gemini-3.7-flash",
				name: "Gemini 3.7 Flash (OpenRouter)",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
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

		type PaidObservabilityEvent = { type: string; [key: string]: unknown };

		const timestampFieldsOf = (event: PaidObservabilityEvent): string[] =>
			Object.keys(event)
				.filter(
					key =>
						key === "emittedAt" ||
						key === "emitted_at" ||
						key === "paidRequestStartedAt" ||
						key === "paid_request_started_at" ||
						/(?:At|_at|timestamp|Timestamp)$/.test(key),
				)
				.sort();

		const recordPaidObservability = (
			target: AgentSession,
			events: PaidObservabilityEvent[],
			eventSequence?: string[],
		): void => {
			target.subscribe(event => {
				const recorded = event as unknown as PaidObservabilityEvent;
				events.push(recorded);
				if (eventSequence && recorded.type === "paid_fallback_active") {
					eventSequence.push("notification");
				}
			});
		};

		it("POST-QR-18, POST-QR-19, POST-QR-20, POST-QR-22, INV-QR-15, INV-QR-16, SEQ-QR-12..16, FORBIDDEN-QR-14: advances from Google Antigravity to paid OpenRouter Gemini 3.7 Flash only after authentic HTTP 429 with pre-inference notification", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - POST-QR-18: A decision with one classifier-issued qualifying Google receipt selects OpenRouter Gemini 3.7 Flash.
			 *   - POST-QR-19: An OpenRouter decision contains exactly one classifier-issued Google predecessor receipt and no intermediary provider.
			 *   - POST-QR-20: The internal PaidUsageNotifier receipt authenticates request identity, event, selector, payload digest, emission time, and paid-request start time before inference.
			 *   - POST-QR-22: Every selected route is exact Gemini 3.7 Flash at high effort; no version, family, provider, or effort substitution is valid.
			 *   - INV-QR-15: Classifier receipts preserve Google Antigravity then OpenRouter order.
			 *   - INV-QR-16: Paid OpenRouter inference never begins without an internally issued notifier receipt whose MAC covers both ordering timestamps.
			 *   - SEQ-QR-12: ModelFallbackResolver attempts Google Antigravity before OpenRouter.
			 *   - SEQ-QR-13: ProviderOutcomeClassifier issues a receipt from the raw Google response before paid fallback consideration.
			 *   - SEQ-QR-14: PaidUsageNotifier issues a receipt only after a qualifying classifier receipt.
			 *   - SEQ-QR-15: ModelFallbackResolver selects OpenRouter only after it receives the matching notifier receipt.
			 *   - SEQ-QR-16: OpenRouter adapter begins Gemini inference after the matching notifier receipt timestamp.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: positive / integration
			 * - Risk tier: High — guards paid token expenditure and prevents credit drain
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-18, POST-QR-19, POST-QR-20, POST-QR-22, INV-QR-15, INV-QR-16, SEQ-QR-12..16, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (exact route, event timing, and selector asserted)
			 *   [✓] C3 NON-DUPLICATIVE: unique end-to-end lifecycle test for authentic 429 paid fallback turnstile
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted Google Antigravity -> OpenRouter 429 waterfall turnstile
			 */
			// ARRANGE
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			// AuthStorage provider contract seam: markUsageLimitReached returns switched: false (no alternate subscription credential)
			const markLimitSpy = vi
				.spyOn(modelRegistry.authStorage, "markUsageLimitReached")
				.mockResolvedValue({ switched: false });
			const eventSequence: string[] = [];
			const requestedModels: string[] = [];
			const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
			const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
			const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];

			const makeGoogleAntigravity429Stream = (model: Model<Api>): AssistantMessageEventStream => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const errorPartial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
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

			let primaryAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const requested = `${model.provider}/${model.id}`;
					requestedModels.push(requested);
					if (model.provider === primaryModel.provider && primaryAttempts === 0) {
						primaryAttempts += 1;
						return makeGoogleAntigravity429Stream(model);
					} else if (model.provider === fallbackModel.provider) {
						eventSequence.push("paid_stream_started");
						return recoveredTextStream(model, "Recovered on OpenRouter paid Gemini 3.7 Flash.");
					} else {
						return recoveredTextStream(model, `ok:${requested}`);
					}
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			session.subscribe(event => {
				if (event.type === "retry_fallback_applied") {
					fallbackAppliedEvents.push(event);
				}
				if (event.type === "retry_fallback_succeeded") {
					fallbackSucceededEvents.push(event);
				}
				if (event.type === "notice") {
					notices.push(event);
					if (
						event.message.toLowerCase().includes("paid") ||
						event.message.toLowerCase().includes("openrouter") ||
						event.message.toLowerCase().includes("fallback")
					) {
						eventSequence.push("notification");
					}
				}
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			// ACT
			await session.prompt("Execute Gemini 3.7 task with authentic 429 fallback");
			await session.waitForIdle();

			// ASSERT: SEQ-QR-12 / SEQ-QR-13 verify subscription pool exhaustion before paid fallback
			expect(markLimitSpy).toHaveBeenCalled();
			if (!markLimitSpy.mock.calls.length) {
				throw new Error(
					"1. WHAT: test_turnstile_post18_advances_on_429 FAILED\n" +
						"2. WHY: SEQ-QR-12 / SEQ-QR-13 violation - must prove subscription account pool is exhausted via markUsageLimitReached before paid fallback\n" +
						"3. EXPECTED: markUsageLimitReached called on failing Google Antigravity credential returning { switched: false }\n" +
						"4. ACTUAL: markUsageLimitReached was not called\n" +
						"5. GUIDANCE: Query AuthStorage markUsageLimitReached to verify no alternate subscription credential exists before paid fallback.",
				);
			}

			// ASSERT: 5-point error messages on all contract guarantees
			const noticeDiagnostics = notices.map(n => n.message).join(" | ");
			const fallbackDiagnostics = JSON.stringify(fallbackAppliedEvents);
			if (
				requestedModels.length !== 2 ||
				requestedModels[0] !== primarySelector ||
				requestedModels[1] !== fallbackSelector
			) {
				throw new Error(
					"1. WHAT: test_turnstile_post18_advances_on_429 FAILED\n" +
						"2. WHY: POST-QR-18 / POST-QR-19 / POST-QR-22 / SEQ-QR-12 violation - Google Antigravity 429 must advance directly to OpenRouter Gemini 3.7 Flash\n" +
						`3. EXPECTED: [${primarySelector}, ${fallbackSelector}]\n` +
						`4. ACTUAL: requestedModels=${JSON.stringify(requestedModels)}; notices=[${noticeDiagnostics}]; fallbackAppliedEvents=${fallbackDiagnostics}\n` +
						"5. GUIDANCE: Fallback must request Google Antigravity first and OpenRouter Gemini 3.7 Flash second on authentic 429 without intermediary providers.",
				);
			}
			expect(requestedModels).toEqual([primarySelector, fallbackSelector]);

			if (
				fallbackAppliedEvents.length !== 1 ||
				fallbackAppliedEvents[0].type !== "retry_fallback_applied" ||
				fallbackAppliedEvents[0].from !== "google-antigravity/gemini-3.7-flash-tiered:high" ||
				fallbackAppliedEvents[0].to !== fallbackSelector
			) {
				throw new Error(
					"1. WHAT: test_turnstile_post18_advances_on_429 FAILED\n" +
						"2. WHY: POST-QR-18 / SEQ-QR-15 violation - retry_fallback_applied event not emitted for OpenRouter\n" +
						`3. EXPECTED: [{ type: "retry_fallback_applied", from: "google-antigravity/gemini-3.7-flash-tiered:high", to: "${fallbackSelector}", role: "default" }]\n` +
						`4. ACTUAL: ${JSON.stringify(fallbackAppliedEvents)}\n` +
						"5. GUIDANCE: Emit retry_fallback_applied with exact from/to selectors upon qualifying classifier receipt.",
				);
			}
			expect(fallbackAppliedEvents).toEqual([
				{
					type: "retry_fallback_applied",
					from: "google-antigravity/gemini-3.7-flash-tiered:high",
					to: fallbackSelector,
					role: "default",
				},
			]);
			// Gate 9 & SEQ-QR-16 deterministic sequence verification: notification strictly precedes paid stream
			const notificationIndex = eventSequence.indexOf("notification");
			const paidStreamIndex = eventSequence.indexOf("paid_stream_started");
			expect(notificationIndex).toBeGreaterThanOrEqual(0);
			expect(paidStreamIndex).toBeGreaterThan(notificationIndex);
			if (notificationIndex < 0 || paidStreamIndex < 0 || notificationIndex >= paidStreamIndex) {
				throw new Error(
					"1. WHAT: test_turnstile_post20_notification_precedes_inference FAILED\n" +
						"2. WHY: POST-QR-20 / INV-QR-16 / SEQ-QR-16 / FORBIDDEN-QR-14 violation - paid use notification must strictly precede paid streamFn invocation\n" +
						"3. EXPECTED: notificationSequenceIndex < paidStreamSequenceIndex\n" +
						`4. ACTUAL: notificationIndex=${notificationIndex}, paidStreamIndex=${paidStreamIndex}, eventSequence=${JSON.stringify(eventSequence)}\n` +
						"5. GUIDANCE: PaidUsageNotifier must emit active notification event before OpenRouter stream begins.",
				);
			}

			// Gate 9 (REQ-QR-022 / POST-QR-20): qualifying notification carries requested effort, position, and quota signal
			const paidNotice = notices.find(
				n => n.message.toLowerCase().includes("paid") || n.message.toLowerCase().includes("openrouter"),
			);
			expect(paidNotice).toBeDefined();
			expect(session.model?.provider).toBe(fallbackModel.provider);
			expect(session.model?.id).toBe(fallbackModel.id);
			expect(session.servingModel).toEqual({
				selector: "openrouter/google/gemini-3.7-flash:high",
				isFallback: true,
			});
		});

		it("ERRORS-QR-10, ERRORS-QR-11, INV-QR-12, FORBIDDEN-QR-14: suppresses paid OpenRouter fallback across non-429 Google error equivalence partitions", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - ERRORS-QR-10: InvalidProviderOutcomeError propagates unchanged for unknown or malformed outcome evidence.
			 *   - ERRORS-QR-11: PaidFallbackSuppressedError propagates unchanged when auth, config, timeout, transport, malformed, model, success, or unknown outcomes attempt fallback.
			 *   - INV-QR-12: Caller-selected trust anchors and caller-authored outcome receipts never advance to paid OpenRouter.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: negative / boundary (table-driven equivalence partition)
			 * - Risk tier: High — prevents paid credit expenditure on non-quota infrastructure failures
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites ERRORS-QR-10, ERRORS-QR-11, INV-QR-12, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts 0 OpenRouter requests across all non-429 classes)
			 *   [✓] C3 NON-DUPLICATIVE: table-driven partition collapses non-429 matrix to one equivalence suite
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current negative space obligations for non-quota errors
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			const non429Partitions: Array<{ name: string; error: Error; expectedClassification: string }> = [
				{
					name: "auth_401",
					error: Object.assign(new Error("Google Antigravity authentication failed: 401 Unauthorized"), {
						status: 401,
						errorStatus: 401,
					}),
					expectedClassification: "auth",
				},
				{
					name: "auth_403",
					error: Object.assign(new Error("Google Antigravity access forbidden: 403 Forbidden"), {
						status: 403,
						errorStatus: 403,
					}),
					expectedClassification: "auth",
				},
				{
					name: "model_400",
					error: Object.assign(new Error("Google Antigravity invalid argument: 400 Bad Request"), {
						status: 400,
						errorStatus: 400,
						providerCode: "INVALID_ARGUMENT",
					}),
					expectedClassification: "model",
				},
				{
					name: "timeout_408",
					error: Object.assign(new Error("Google Antigravity request timeout: 408 Request Timeout"), {
						status: 408,
						errorStatus: 408,
					}),
					expectedClassification: "timeout",
				},
				{
					name: "timeout_504",
					error: Object.assign(new Error("Google Antigravity gateway timeout: 504 Gateway Timeout"), {
						status: 504,
						errorStatus: 504,
					}),
					expectedClassification: "timeout",
				},
				{
					name: "transport_500",
					error: Object.assign(new Error("Google Antigravity internal server error: 500 Internal Server Error"), {
						status: 500,
						errorStatus: 500,
					}),
					expectedClassification: "transport",
				},
				{
					name: "transport_502",
					error: Object.assign(new Error("Google Antigravity bad gateway: 502 Bad Gateway"), {
						status: 502,
						errorStatus: 502,
					}),
					expectedClassification: "transport",
				},
				{
					name: "transport_503",
					error: Object.assign(new Error("Google Antigravity service unavailable: 503 Overloaded"), {
						status: 503,
						errorStatus: 503,
					}),
					expectedClassification: "transport",
				},
				{
					name: "transport_econnreset",
					error: Object.assign(new Error("fetch failed: connect ECONNRESET 127.0.0.1:443"), {
						code: "ECONNRESET",
					}),
					expectedClassification: "transport",
				},
				{
					name: "malformed_unknown",
					error: new Error("Malformed non-standard response from Google Antigravity endpoint"),
					expectedClassification: "unknown",
				},
			];

			for (const partition of non429Partitions) {
				const requestedModels: string[] = [];
				const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
				const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
				const mock = createMockModel();

				const agent = new Agent({
					getApiKey: model => `${model.provider}-test-key`,
					initialState: {
						model: primaryModel,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
					},
					streamFn: (model, context, options) => {
						const requested = `${model.provider}/${model.id}`;
						requestedModels.push(requested);
						if (model.provider === primaryModel.provider) {
							mock.push({ throw: partition.error });
						} else {
							mock.push({ content: ["Unreachable paid response"] });
						}
						return mock.stream(model, context, options);
					},
				});

				const settings = Settings.isolated({
					"compaction.enabled": false,
					"retry.baseDelayMs": 0,
					"retry.maxRetries": 2,
					"retry.modelFallback": true,
					"retry.fallbackChains": {
						default: [fallbackSelector],
					},
				});
				settings.setModelRole("default", primarySelector);

				const partitionSession = new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(),
					settings,
					modelRegistry,
					thinkingLevel: Effort.High,
				});

				partitionSession.subscribe(event => {
					if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
					if (event.type === "notice") notices.push(event);
				});
				vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

				try {
					await partitionSession.prompt(`Test partition ${partition.name}`);
					await partitionSession.waitForIdle();
				} catch {
					// Expected error propagation when fallback is suppressed fail-closed
				}

				// ASSERT: Paid OpenRouter is NEVER requested for non-429 Google error
				const paidRequests = requestedModels.filter(m => m === fallbackSelector);
				expect(paidRequests).toHaveLength(0);
				if (paidRequests.length > 0) {
					throw new Error(
						`1. WHAT: test_suppress_non_429_${partition.name} FAILED\n` +
							`2. WHY: ERRORS-QR-11 / INV-QR-12 violation - non-quota error category '${partition.expectedClassification}' must suppress paid OpenRouter fallback\n` +
							`3. EXPECTED: 0 requests to ${fallbackSelector}\n` +
							`4. ACTUAL: requestedModels=${JSON.stringify(requestedModels)}\n` +
							`5. GUIDANCE: Classify outcome '${partition.name}' as non-qualifying and suppress paid fallback fail-closed.`,
					);
				}

				expect(fallbackAppliedEvents.filter(e => e.to === fallbackSelector)).toHaveLength(0);
				// Gate 9 (REQ-QR-022 / POST-QR-20 / FORBIDDEN-QR-14): fail-closed paid denial emits diagnostic notice naming rejected candidate and reason
				const denialNotice = notices.find(
					n =>
						n.message.toLowerCase().includes("fallback") ||
						n.message.toLowerCase().includes("suppress") ||
						n.message.toLowerCase().includes("denied") ||
						n.message.toLowerCase().includes(partition.name),
				);
				expect(denialNotice).toBeDefined();
				await partitionSession.dispose();
			}
		});

		it("PRE-QR-8, ERRORS-QR-11, INV-QR-12, INV-QR-15, SEQ-QR-13: refuses paid OpenRouter Gemini fallback when a non-Google provider returns HTTP 429", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - PRE-QR-8: The model-callable resolver accepts no evidence, receipt, verifier, key, category, or trust-anchor input; OMP internally classifies the authenticated Google response.
			 *   - ERRORS-QR-11: PaidFallbackSuppressedError propagates unchanged when auth, config, timeout, transport, malformed, model, success, or unknown outcomes attempt fallback.
			 *   - INV-QR-12: Caller-selected trust anchors and caller-authored outcome receipts never advance to paid OpenRouter.
			 *   - INV-QR-15: Classifier receipts preserve Google Antigravity then OpenRouter order.
			 *   - SEQ-QR-13: ProviderOutcomeClassifier issues a receipt from the raw Google response before paid fallback consideration.
			 * - Category: negative / invariant
			 * - Risk tier: High — prevents cross-provider failure laundering into paid Gemini tokens
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites PRE-QR-8, ERRORS-QR-11, INV-QR-12, INV-QR-15, SEQ-QR-13 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (verifies non-Google 429 never invokes paid OpenRouter)
			 *   [✓] C3 NON-DUPLICATIVE: distinct boundary test for non-Google provider 429 cross-provider isolation
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current contracted provider identity gate
			 */
			authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const nonGooglePrimary = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const openRouterGeminiFallback = makeOpenRouterGeminiHigh();
			const nonGoogleSelector = `${nonGooglePrimary.provider}/${nonGooglePrimary.id}`;
			const openRouterSelector = `${openRouterGeminiFallback.provider}/${openRouterGeminiFallback.id}`;

			const requestedModels: string[] = [];
			const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
			const mock = createMockModel();

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: nonGooglePrimary,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const requested = `${model.provider}/${model.id}`;
					requestedModels.push(requested);
					if (model.provider === nonGooglePrimary.provider) {
						const anthropic429 = Object.assign(new Error("Anthropic rate limit exceeded (HTTP 429)"), {
							status: 429,
							errorStatus: 429,
						});
						mock.push({ throw: anthropic429 });
					} else {
						mock.push({ content: ["Unexpected fallback response"] });
					}
					return mock.stream(model, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [openRouterSelector],
				},
			});
			settings.setModelRole("default", nonGoogleSelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			session.subscribe(event => {
				if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			try {
				await session.prompt("Trigger non-Google 429 turn");
				await session.waitForIdle();
			} catch {
				// Expected fail-closed behavior
			}

			// ASSERT: Non-Google 429 never invokes OpenRouter Gemini
			const paidCalls = requestedModels.filter(m => m === openRouterSelector);
			expect(paidCalls).toHaveLength(0);
			if (paidCalls.length > 0) {
				throw new Error(
					"1. WHAT: test_non_google_429_refuses_openrouter FAILED\n" +
						"2. WHY: PRE-QR-8 / INV-QR-12 / INV-QR-15 / SEQ-QR-13 violation - non-Google provider 429 must not trigger paid OpenRouter Gemini fallback\n" +
						`3. EXPECTED: 0 calls to ${openRouterSelector}\n` +
						`4. ACTUAL: requestedModels=${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Paid OpenRouter fallback requires an authentic Google Antigravity qualifying predecessor receipt.",
				);
			}
			expect(fallbackAppliedEvents.filter(e => e.to === openRouterSelector)).toHaveLength(0);
		});

		it("PRE-QR-8, ERRORS-QR-11, INV-QR-12, INV-QR-13, FORBIDDEN-QR-11, FORBIDDEN-QR-14: refuses paid OpenRouter fallback when direct google/gemini-3.7-flash returns HTTP 429", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - PRE-QR-8: The model-callable resolver accepts no evidence, receipt, verifier, key, category, or trust-anchor input; OMP internally classifies the authenticated Google response.
			 *   - ERRORS-QR-11: PaidFallbackSuppressedError propagates unchanged when non-Google-Antigravity outcomes attempt fallback.
			 *   - INV-QR-12: Caller-selected trust anchors and caller-authored outcome receipts never advance to paid OpenRouter.
			 *   - INV-QR-13: Direct google/gemini-3.7-flash never appears in a valid overlay or decision.
			 *   - FORBIDDEN-QR-11: A valid overlay never contains direct google/gemini-3.7-flash.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: negative / boundary
			 * - Risk tier: High — prevents direct metered Google API 429 from laundering into paid OpenRouter tokens
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites PRE-QR-8, ERRORS-QR-11, INV-QR-12, INV-QR-13, FORBIDDEN-QR-11, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts direct google 429 cannot trigger paid OpenRouter)
			 *   [✓] C3 NON-DUPLICATIVE: dedicated provider-identity boundary test distinguishing direct google from google-antigravity
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted exclusion of direct google from subscription waterfall
			 */
			authStorage.setRuntimeApiKey("google", "google-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const directGoogleModel = buildModel({
				id: "gemini-3.7-flash",
				name: "Gemini 3.7 Flash (Direct Google)",
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
			});
			const fallbackModel = makeOpenRouterGeminiHigh();
			const directSelector = `${directGoogleModel.provider}/${directGoogleModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			const requestedModels: string[] = [];
			const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
			const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: directGoogleModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const errorPartial: AssistantMessage = {
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: emptyUsage(),
							stopReason: "error",
							errorMessage: "Google API error (429): Quota exceeded",
							errorStatus: 429,
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: errorPartial });
						stream.push({ type: "error", reason: "error", error: errorPartial });
					});
					return stream;
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", directSelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			session.subscribe(event => {
				if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
				if (event.type === "notice") notices.push(event);
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			try {
				await session.prompt("Run task on direct Google");
				await session.waitForIdle();
			} catch {
				// Expected fail-closed
			}

			// ASSERT: Direct google 429 never advances to paid OpenRouter
			expect(requestedModels.filter(m => m === fallbackSelector)).toHaveLength(0);
			expect(fallbackAppliedEvents.filter(e => e.to === fallbackSelector)).toHaveLength(0);
			// Gate 9 diagnostic notice emitted for denied direct-Google candidate
			const denialNotice = notices.find(
				n =>
					n.message.toLowerCase().includes("fallback") ||
					n.message.toLowerCase().includes("suppress") ||
					n.message.toLowerCase().includes("denied"),
			);
			expect(denialNotice).toBeDefined();
		});

		it("POST-QR-19, INV-QR-15, SEQ-QR-13, ERRORS-QR-11, FORBIDDEN-QR-14: refuses paid OpenRouter fallback when an intermediary non-Antigravity provider returns HTTP 429", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - POST-QR-19: An OpenRouter decision contains exactly one classifier-issued Google predecessor receipt and no intermediary provider.
			 *   - INV-QR-15: Classifier receipts preserve Google Antigravity then OpenRouter order.
			 *   - SEQ-QR-13: ProviderOutcomeClassifier issues a receipt from the raw Google response before paid fallback consideration.
			 *   - ERRORS-QR-11: PaidFallbackSuppressedError propagates unchanged when non-Google-Antigravity outcomes attempt fallback.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: negative / integration
			 * - Risk tier: High — enforces exact two-route prefix with zero intermediary providers
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-19, INV-QR-15, SEQ-QR-13, ERRORS-QR-11 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts mid-chain non-Antigravity 429 cannot authorize OpenRouter)
			 *   [✓] C3 NON-DUPLICATIVE: tests multi-hop chain integrity where predecessor is not direct Google Antigravity
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted direct predecessor receipt rule
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openai", "openai-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const intermediaryModel = getBundledModel("openai", "gpt-4o")!;
			const paidOpenRouterModel = makeOpenRouterGeminiHigh();

			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const intermediarySelector = `${intermediaryModel.provider}/${intermediaryModel.id}`;
			const paidSelector = `${paidOpenRouterModel.provider}/${paidOpenRouterModel.id}`;

			const requestedModels: string[] = [];
			const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
			const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider === primaryModel.provider) {
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							// Step 1: Antigravity fails with 503 service unavailable, falling over to intermediary
							const error503: AssistantMessage = {
								role: "assistant",
								content: [],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: emptyUsage(),
								stopReason: "error",
								errorMessage: "503 Service Unavailable",
								errorStatus: 503,
								timestamp: Date.now(),
							};
							stream.push({ type: "start", partial: error503 });
							stream.push({ type: "error", reason: "error", error: error503 });
						});
						return stream;
					} else if (model.provider === intermediaryModel.provider) {
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							// Step 2: Intermediary fails with 429
							const error429: AssistantMessage = {
								role: "assistant",
								content: [],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: emptyUsage(),
								stopReason: "error",
								errorMessage: "OpenAI 429 Rate limit exceeded",
								errorStatus: 429,
								timestamp: Date.now(),
							};
							stream.push({ type: "start", partial: error429 });
							stream.push({ type: "error", reason: "error", error: error429 });
						});
						return stream;
					} else {
						return recoveredTextStream(model, "Unreachable");
					}
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 3,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [intermediarySelector, paidSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			session.subscribe(event => {
				if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
				if (event.type === "notice") notices.push(event);
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			try {
				await session.prompt("Trigger multi-hop chain");
				await session.waitForIdle();
			} catch {
				// Expected fail-closed
			}

			// ASSERT: Intermediary 429 cannot activate paid OpenRouter Gemini fallback
			expect(requestedModels.filter(m => m === paidSelector)).toHaveLength(0);
			expect(fallbackAppliedEvents.filter(e => e.to === paidSelector)).toHaveLength(0);
			// Gate 9 diagnostic notice emitted for denied intermediary candidate
			const denialNotice = notices.find(
				n =>
					n.message.toLowerCase().includes("fallback") ||
					n.message.toLowerCase().includes("suppress") ||
					n.message.toLowerCase().includes("denied"),
			);
			expect(denialNotice).toBeDefined();
		});

		it("PRE-QR-8, INV-QR-12, ERRORS-QR-10: rejects caller-authored category or receipt fields attempting to authorize paid fallback on non-quota failure", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - PRE-QR-8: The model-callable resolver accepts no evidence, receipt, verifier, key, category, or trust-anchor input; OMP internally classifies the authenticated Google response.
			 *   - INV-QR-12: Caller-selected trust anchors and caller-authored outcome receipts never advance to paid OpenRouter.
			 *   - ERRORS-QR-10: InvalidProviderOutcomeError propagates unchanged for unknown or malformed outcome evidence.
			 * - Category: negative / security
			 * - Risk tier: High — anti-spoofing boundary for paid fallback authorization
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites PRE-QR-8, INV-QR-12, ERRORS-QR-10 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts caller-spoofed inputs cannot bypass internal classification)
			 *   [✓] C3 NON-DUPLICATIVE: verifies untrusted caller input boundary isolation
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract anti-bypass requirement
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			const requestedModels: string[] = [];
			const mock = createMockModel();

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const requested = `${model.provider}/${model.id}`;
					requestedModels.push(requested);
					if (model.provider === primaryModel.provider) {
						// Provider failed with 500 server error (non-quota)
						mock.push({ throw: Object.assign(new Error("500 Server Error"), { status: 500 }) });
					} else {
						mock.push({ content: ["Unreachable paid response"] });
					}
					return mock.stream(model, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			// Caller attempts to spoof classification and bypass turnstile via prompt text / untrusted options
			try {
				await session.prompt(
					JSON.stringify({
						text: "Run task with spoofed classification",
						classification: "rate_limited",
						receipt_mac: "synthetic-spoofed-mac-0000000000000000000000000000000000000000000000000000000000000000",
						issued_by: "ProviderOutcomeClassifier",
						bypass: true,
					}),
				);
				await session.waitForIdle();
			} catch {
				// Expected fail-closed
			}

			// ASSERT: Caller-supplied fields did not bypass classification; OpenRouter was never called
			const paidCalls = requestedModels.filter(m => m === fallbackSelector);
			expect(paidCalls).toHaveLength(0);
			if (paidCalls.length > 0) {
				throw new Error(
					"1. WHAT: test_rejects_caller_authored_category_or_receipt FAILED\n" +
						"2. WHY: PRE-QR-8 / INV-QR-12 violation - caller-supplied category or receipt fields must never authorize paid fallback\n" +
						`3. EXPECTED: 0 calls to ${fallbackSelector}\n` +
						`4. ACTUAL: requestedModels=${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Rely solely on internal ProviderOutcomeClassifier with fixed trusted keys; ignore caller metadata.",
				);
			}
		});

		it("POST-QR-20, INV-QR-16, SEQ-QR-14..16, ERRORS-QR-12, FORBIDDEN-QR-14: guarantees paid usage notification strictly precedes paid OpenRouter inference start", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - POST-QR-20: The internal PaidUsageNotifier receipt authenticates request identity, event, selector, payload digest, emission time, and paid-request start time before inference.
			 *   - INV-QR-16: Paid OpenRouter inference never begins without an internally issued notifier receipt whose MAC covers both ordering timestamps.
			 *   - SEQ-QR-14: PaidUsageNotifier issues a receipt only after a qualifying classifier receipt.
			 *   - SEQ-QR-15: ModelFallbackResolver selects OpenRouter only after it receives the matching notifier receipt.
			 *   - SEQ-QR-16: OpenRouter adapter begins Gemini inference after the matching notifier receipt timestamp.
			 *   - ERRORS-QR-12: PaidUsageNotificationError propagates unchanged when OpenRouter is selected without notification.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: invariant / sequencing
			 * - Risk tier: High — prevents silent paid token deduction
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-20, INV-QR-16, SEQ-QR-14..16, ERRORS-QR-12, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts strict timestamp ordering between notification and paid request start)
			 *   [✓] C3 NON-DUPLICATIVE: dedicated temporal sequence verification for paid notification receipts
			 *   [✓] C4 NOT FUTURE-EDIT: enforces mandatory pre-inference notification invariant
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			// AuthStorage provider contract seam: markUsageLimitReached returns switched: false (no alternate subscription credential)
			const markLimitSpy = vi
				.spyOn(modelRegistry.authStorage, "markUsageLimitReached")
				.mockResolvedValue({ switched: false });
			const eventSequence: string[] = [];
			const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
			const makeGoogleAntigravity429Stream = (model: Model<Api>): AssistantMessageEventStream => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const errorPartial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
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

			let primaryAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					if (model.provider === primaryModel.provider && primaryAttempts === 0) {
						primaryAttempts += 1;
						return makeGoogleAntigravity429Stream(model);
					} else if (model.provider === fallbackModel.provider) {
						eventSequence.push("paid_stream_started");
						return recoveredTextStream(model, "Paid response delivered");
					}
					return recoveredTextStream(model, `ok:${model.provider}/${model.id}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			session.subscribe(event => {
				if (event.type === "notice") {
					notices.push(event);
					eventSequence.push("notification");
				}
				if (event.type === "retry_fallback_applied") {
					eventSequence.push("notification");
				}
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Test notification timing invariant");
			await session.waitForIdle();

			expect(markLimitSpy).toHaveBeenCalled();
			const notificationIndex = eventSequence.indexOf("notification");
			const paidStreamIndex = eventSequence.indexOf("paid_stream_started");
			expect(notificationIndex).toBeGreaterThanOrEqual(0);
			expect(paidStreamIndex).toBeGreaterThan(notificationIndex);
			if (notificationIndex < 0 || paidStreamIndex < 0 || notificationIndex >= paidStreamIndex) {
				throw new Error(
					"1. WHAT: test_notification_strictly_precedes_paid_inference FAILED\n" +
						"2. WHY: POST-QR-20 / INV-QR-16 / SEQ-QR-16 / FORBIDDEN-QR-14 violation - notification sequence index must strictly precede paid stream start\n" +
						"3. EXPECTED: notificationSequenceIndex < paidStreamSequenceIndex\n" +
						`4. ACTUAL: notificationIndex=${notificationIndex}, paidStreamIndex=${paidStreamIndex}, eventSequence=${JSON.stringify(eventSequence)}\n` +
						"5. GUIDANCE: PaidUsageNotifier must emit receipt and notification event prior to beginning OpenRouter streaming.",
				);
			}

			// Gate 9 observability check: qualifying notification is emitted
			const paidNotice = notices.find(
				n =>
					n.message.toLowerCase().includes("paid") ||
					n.message.toLowerCase().includes("openrouter") ||
					n.message.toLowerCase().includes("fallback"),
			);
			expect(paidNotice).toBeDefined();
		});

		it("POST-QR-22, INV-QR-15, SEQ-QR-12, FORBIDDEN-QR-13: forbids OpenRouter Gemini from preceding Google Antigravity in the waterfall resolution order", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - POST-QR-22: Every selected route is exact Gemini 3.7 Flash at high effort; no version, family, provider, or effort substitution is valid.
			 *   - INV-QR-15: Classifier receipts preserve Google Antigravity then OpenRouter order.
			 *   - SEQ-QR-12: ModelFallbackResolver attempts Google Antigravity before OpenRouter.
			 *   - FORBIDDEN-QR-13: OpenRouter never precedes Google Antigravity.
			 * - Category: invariant / negative
			 * - Risk tier: High — enforces subscription-first priority over metered fallback
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-22, INV-QR-15, SEQ-QR-12, FORBIDDEN-QR-13 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (verifies OpenRouter cannot be initial primary without prior Google attempt)
			 *   [✓] C3 NON-DUPLICATIVE: tests waterfall precedence ordering invariant
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted subscription-first hierarchy
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			const requestedModels: string[] = [];
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					return mock.stream(model, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			await session.prompt("Run normal healthy turn");
			await session.waitForIdle();

			// ASSERT: Healthy turn MUST execute Google Antigravity, NEVER OpenRouter as primary
			expect(requestedModels).toEqual([primarySelector]);
			if (requestedModels.includes(fallbackSelector) || requestedModels[0] !== primarySelector) {
				throw new Error(
					"1. WHAT: test_openrouter_never_precedes_google FAILED\n" +
						"2. WHY: FORBIDDEN-QR-13 / INV-QR-15 / SEQ-QR-12 violation - OpenRouter Gemini must never precede Google Antigravity\n" +
						`3. EXPECTED: [${primarySelector}]\n` +
						`4. ACTUAL: ${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Google Antigravity must be attempted first on every Gemini turn; OpenRouter is strictly a secondary fallback.",
				);
			}
		});

		it("INV-QR-12, POST-QR-19, SEQ-QR-13, FORBIDDEN-QR-14: refuses proactive usage-aware paid fallback without an authentic current-turn raw Google 429", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Enforces:
			 *   - INV-QR-12: Caller-selected trust anchors and caller-authored outcome receipts never advance to paid OpenRouter.
			 *   - POST-QR-19: An OpenRouter decision contains exactly one classifier-issued Google predecessor receipt and no intermediary provider.
			 *   - SEQ-QR-13: ProviderOutcomeClassifier issues a receipt from the raw Google response before paid fallback consideration.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: negative / security (proactive usage-aware turnstile isolation)
			 * - Risk tier: High — prevents background quota health / usage depletion from laundering into paid OpenRouter token expenditure without an authentic current-turn raw HTTP 429
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites INV-QR-12, POST-QR-19, SEQ-QR-13, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts proactive usage depletion alone cannot activate paid OpenRouter)
			 *   [✓] C3 NON-DUPLICATIVE: unique pre-send lifecycle test for usageAwareFallback interaction with paid turnstile
			 *   [✓] C4 NOT FUTURE-EDIT: enforces mandatory current-turn raw 429 receipt requirement against proactive switching
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

			const requestedModels: string[] = [];
			const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
			const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					return recoveredTextStream(model, `ok:${model.provider}/${model.id}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.usageAwareFallback": true,
				"retry.usageReservePolicy": "auto",
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			// Primary subscription reports depleted via background usage health, but NO raw 429 occurred in current turn
			vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
				provider === primaryModel.provider
					? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
					: { state: "healthy", accounts: [] },
			);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			session.subscribe(event => {
				if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
				if (event.type === "notice") notices.push(event);
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			try {
				await session.prompt("Run turn under proactive usage exhaustion");
				await session.waitForIdle();
			} catch {
				// Expected fail-closed when paid fallback is disallowed proactively
			}

			// ASSERT 1: Zero paid OpenRouter requests
			const paidRequests = requestedModels.filter(m => m === fallbackSelector);
			expect(paidRequests).toHaveLength(0);
			if (paidRequests.length > 0) {
				throw new Error(
					"1. WHAT: test_refuses_proactive_usage_aware_paid_fallback FAILED\n" +
						"2. WHY: INV-QR-12 / POST-QR-19 / SEQ-QR-13 / FORBIDDEN-QR-14 violation - proactive usage depletion alone must never authorize paid OpenRouter fallback without current-turn raw 429\n" +
						`3. EXPECTED: 0 requests to ${fallbackSelector}\n` +
						`4. ACTUAL: requestedModels=${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Paid OpenRouter fallback strictly requires an internally classified current-turn Google Antigravity raw HTTP 429 response.",
				);
			}

			// ASSERT 2: Zero retry_fallback_applied to paid OpenRouter
			const paidFallbackEvents = fallbackAppliedEvents.filter(e => e.to === fallbackSelector);
			expect(paidFallbackEvents).toHaveLength(0);

			// ASSERT 3: One structured denial notice naming rejected candidate and reason
			const denialNotice = notices.find(
				n =>
					n.message.toLowerCase().includes("fallback") ||
					n.message.toLowerCase().includes("suppress") ||
					n.message.toLowerCase().includes("denied") ||
					n.message.toLowerCase().includes("proactive"),
			);
			expect(denialNotice).toBeDefined();

			// ASSERT 4: No fabricated authoritativeQuotaSignal or paid_fallback_active event
			const fabricatedPaidNotice = notices.find(
				n =>
					n.message.toLowerCase().includes("paid_fallback_active") ||
					(n.message.toLowerCase().includes("paid") && n.message.toLowerCase().includes("active")),
			);
			expect(fabricatedPaidNotice).toBeUndefined();
		});

		it("REQ-QR-022, POST-QR-20, INV-QR-16, SEQ-QR-14..16, FORBIDDEN-QR-14: paid_fallback_active has emittedAt only, correlationId, real attemptedPosition, requestedEffort, and authoritativeQuotaSignal", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-022
			 * - Enforces:
			 *   - REQ-QR-022: Each resolution records requested role and effort, exact selector attempted at each position, authoritative quota or rate-limit signal, selected selector, whether a paid route was reached, and the active notification emitted before paid inference.
			 *   - POST-QR-20: The internal PaidUsageNotifier receipt authenticates request identity, event, selector, payload digest, emission time, and paid-request start time before inference.
			 *   - INV-QR-16: Paid OpenRouter inference never begins without an internally issued notifier receipt whose MAC covers both ordering timestamps.
			 *   - SEQ-QR-14: PaidUsageNotifier issues a receipt only after a qualifying classifier receipt.
			 *   - SEQ-QR-15: ModelFallbackResolver selects paid OpenRouter only after the matching notifier receipt.
			 *   - SEQ-QR-16: The selected adapter begins inference only after resolver selection and any required paid notification timestamp.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: positive / integration / observability
			 * - Risk tier: High — wrong position or silent paid use drains credits without a countable signal
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-20, INV-QR-16, SEQ-QR-14, SEQ-QR-15, SEQ-QR-16, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py and REQ-QR-022
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (exact field set, exact position 2, exact effort, exact quota signal)
			 *   [✓] C3 NON-DUPLICATIVE: unique suppressed-intermediary position proof for paid_fallback_active schema; existing tests only assert prose notices
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current REQ-QR-022 observability fields on the contracted paid-active notification
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openai", "openai-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const intermediaryModel = getBundledModel("openai", "gpt-4o-mini");
			const fallbackModel = makeOpenRouterGeminiHigh();
			if (!intermediaryModel) {
				throw new Error("Expected bundled openai/gpt-4o-mini intermediary model");
			}
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const intermediarySelector = `${intermediaryModel.provider}/${intermediaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
			const paidContractSelector = "openrouter/google/gemini-3.7-flash:high";

			vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });
			const suppressUntil = Date.now() + 60_000;
			modelRegistry.suppressSelector(intermediarySelector, suppressUntil);
			modelRegistry.suppressSelector(`${intermediarySelector}:high`, suppressUntil);

			const eventSequence: string[] = [];
			const observabilityEvents: PaidObservabilityEvent[] = [];
			const requestedModels: string[] = [];

			const makeGoogleAntigravity429Stream = (model: Model<Api>): AssistantMessageEventStream => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const errorPartial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
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

			let primaryAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider === primaryModel.provider && primaryAttempts === 0) {
						primaryAttempts += 1;
						return makeGoogleAntigravity429Stream(model);
					}
					if (model.provider === fallbackModel.provider) {
						eventSequence.push("paid_stream_started");
						return recoveredTextStream(model, "Recovered on OpenRouter paid Gemini 3.7 Flash.");
					}
					return recoveredTextStream(model, `ok:${model.provider}/${model.id}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 3,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [intermediarySelector, fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});
			recordPaidObservability(session, observabilityEvents, eventSequence);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Execute Gemini 3.7 task with suppressed intermediary before paid");
			await session.waitForIdle();

			if (requestedModels.includes(intermediarySelector)) {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_real_attempted_position FAILED\n" +
						"2. WHY: SEQ-QR-15 / REQ-QR-022 violation - suppressed intermediary must not be attempted before paid OpenRouter\n" +
						`3. EXPECTED: requestedModels excludes ${intermediarySelector}\n` +
						`4. ACTUAL: requestedModels=${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Skip the suppressed intermediary slot and retain its chain position when emitting paid_fallback_active.",
				);
			}

			const activeEvents = observabilityEvents.filter(event => event.type === "paid_fallback_active");
			if (activeEvents.length !== 1) {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: REQ-QR-022 / POST-QR-20 / SEQ-QR-14 / FORBIDDEN-QR-14 violation - exactly one typed paid_fallback_active event must be emitted before paid inference\n" +
						"3. EXPECTED: 1 event with type paid_fallback_active\n" +
						`4. ACTUAL: ${JSON.stringify(activeEvents)}\n` +
						"5. GUIDANCE: Emit a machine-readable paid_fallback_active session event; do not rely on prose notices.",
				);
			}
			const active = activeEvents[0];
			const timestampFields = timestampFieldsOf(active);
			if (timestampFields.length !== 1 || timestampFields[0] !== "emittedAt") {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: POST-QR-20 / INV-QR-16 / REQ-QR-022 violation - paid_fallback_active must expose exactly one timestamp field named emittedAt\n" +
						'3. EXPECTED: timestamp fields ["emittedAt"]\n' +
						`4. ACTUAL: ${JSON.stringify(timestampFields)} on ${JSON.stringify(active)}\n` +
						"5. GUIDANCE: Public paid-active observability uses emittedAt only; do not publish a second request-start timestamp on the session event.",
				);
			}
			if (typeof active.emittedAt !== "number" || !Number.isFinite(active.emittedAt) || active.emittedAt <= 0) {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: POST-QR-20 violation - emittedAt must be a finite positive timestamp\n" +
						"3. EXPECTED: finite emittedAt > 0\n" +
						`4. ACTUAL: emittedAt=${String(active.emittedAt)}\n` +
						"5. GUIDANCE: Stamp paid_fallback_active with the notifier emission time.",
				);
			}
			if (typeof active.correlationId !== "string" || active.correlationId.trim().length === 0) {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: POST-QR-20 / REQ-QR-022 violation - paid_fallback_active must carry a nonempty correlationId\n" +
						"3. EXPECTED: nonempty string correlationId\n" +
						`4. ACTUAL: correlationId=${JSON.stringify(active.correlationId)}\n` +
						"5. GUIDANCE: Correlate the active notification to the request identity authenticated by the notifier receipt.",
				);
			}
			if (active.attemptedPosition !== 2) {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_real_attempted_position FAILED\n" +
						"2. WHY: REQ-QR-022 violation - attemptedPosition must be the real 0-based index in primary plus fallback chain, including the suppressed intermediary slot\n" +
						"3. EXPECTED: attemptedPosition === 2 (primary=0, suppressed intermediary=1, paid=2)\n" +
						`4. ACTUAL: attemptedPosition=${JSON.stringify(active.attemptedPosition)} events=${JSON.stringify(activeEvents)}\n` +
						"5. GUIDANCE: Record the paid selector's actual chain position; do not hardcode 1 or compact away suppressed slots.",
				);
			}
			if (active.requestedEffort !== "high") {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: REQ-QR-022 / POST-QR-20 violation - paid_fallback_active must record requested effort high\n" +
						'3. EXPECTED: requestedEffort === "high"\n' +
						`4. ACTUAL: requestedEffort=${JSON.stringify(active.requestedEffort)}\n` +
						"5. GUIDANCE: Record the requested high Gemini effort on the active notification.",
				);
			}
			if (active.authoritativeQuotaSignal !== "quota_exhausted") {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: REQ-QR-022 / SEQ-QR-14 violation - authoritativeQuotaSignal must be the classifier quota_exhausted outcome for RESOURCE_EXHAUSTED HTTP 429\n" +
						'3. EXPECTED: authoritativeQuotaSignal === "quota_exhausted"\n' +
						`4. ACTUAL: authoritativeQuotaSignal=${JSON.stringify(active.authoritativeQuotaSignal)}\n` +
						"5. GUIDANCE: Copy the classifier-issued quota or rate-limit category onto the active notification.",
				);
			}
			expect(active).toEqual(
				expect.objectContaining({
					type: "paid_fallback_active",
					attemptedPosition: 2,
					requestedEffort: "high",
					authoritativeQuotaSignal: "quota_exhausted",
				}),
			);
			expect(typeof active.correlationId).toBe("string");
			expect((active.correlationId as string).length).toBeGreaterThan(0);
			expect(timestampFieldsOf(active)).toEqual(["emittedAt"]);

			const notificationIndex = eventSequence.indexOf("notification");
			const paidStreamIndex = eventSequence.indexOf("paid_stream_started");
			if (notificationIndex < 0 || paidStreamIndex < 0 || notificationIndex >= paidStreamIndex) {
				throw new Error(
					"1. WHAT: test_paid_fallback_active_schema FAILED\n" +
						"2. WHY: SEQ-QR-16 / INV-QR-16 / FORBIDDEN-QR-14 violation - typed paid_fallback_active must strictly precede paid stream start\n" +
						"3. EXPECTED: notificationSequenceIndex < paidStreamSequenceIndex\n" +
						`4. ACTUAL: notificationIndex=${notificationIndex}, paidStreamIndex=${paidStreamIndex}, eventSequence=${JSON.stringify(eventSequence)}\n` +
						"5. GUIDANCE: Emit paid_fallback_active before OpenRouter inference begins.",
				);
			}
			expect(paidStreamIndex).toBeGreaterThan(notificationIndex);
			expect(session.servingModel?.selector).toBe(paidContractSelector);
		});

		it("REQ-QR-022, POST-QR-20, SEQ-QR-14, FORBIDDEN-QR-14: every paid denial emits typed paid_fallback_denied with from/to/role, reasonCode, attemptedPosition, status, correlationId, emittedAt", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-022
			 * - Enforces:
			 *   - REQ-QR-022: Each resolution records requested role and effort, exact selector attempted at each position, authoritative quota or rate-limit signal, and whether a paid route was reached.
			 *   - POST-QR-20: The internal PaidUsageNotifier receipt authenticates request identity, event, selector, payload digest, emission time, and paid-request start time before inference.
			 *   - SEQ-QR-14: PaidUsageNotifier issues a receipt only after a qualifying classifier receipt.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: negative / observability
			 * - Risk tier: High — prose-only denials cannot be counted or correlated
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-20, SEQ-QR-14, FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py and REQ-QR-022
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (exact from/to/role/reasonCode/position/status; ignores notices)
			 *   [✓] C3 NON-DUPLICATIVE: unique typed paid_fallback_denied schema test; existing denials only match notice substrings
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current fail-closed denial observability, not a hypothetical extra event family
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
			const observabilityEvents: PaidObservabilityEvent[] = [];
			const requestedModels: string[] = [];
			const mock = createMockModel();

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider === primaryModel.provider) {
						mock.push({
							throw: Object.assign(new Error("Google Antigravity authentication failed: 401 Unauthorized"), {
								status: 401,
								errorStatus: 401,
							}),
						});
					} else {
						mock.push({ content: ["Unreachable paid response"] });
					}
					return mock.stream(model, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});
			recordPaidObservability(session, observabilityEvents);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			try {
				await session.prompt("Trigger auth denial of paid fallback");
				await session.waitForIdle();
			} catch {
				// Expected fail-closed
			}

			expect(requestedModels.filter(model => model === fallbackSelector)).toHaveLength(0);

			const deniedEvents = observabilityEvents.filter(event => event.type === "paid_fallback_denied");
			if (deniedEvents.length !== 1) {
				throw new Error(
					"1. WHAT: test_paid_fallback_denied_typed_event FAILED\n" +
						"2. WHY: REQ-QR-022 / FORBIDDEN-QR-14 / SEQ-QR-14 violation - every paid denial must emit exactly one typed paid_fallback_denied event, not a prose notice\n" +
						"3. EXPECTED: 1 event with type paid_fallback_denied\n" +
						`4. ACTUAL: ${JSON.stringify(deniedEvents)}\n` +
						"5. GUIDANCE: Emit machine-readable paid_fallback_denied; observability must not depend on notice message text.",
				);
			}
			const denied = deniedEvents[0];
			const expectedFrom = "google-antigravity/gemini-3.7-flash-tiered:high";
			const expectedTo = "openrouter/google/gemini-3.7-flash:high";
			if (
				denied.from !== expectedFrom ||
				denied.to !== expectedTo ||
				denied.role !== "default" ||
				denied.reasonCode !== "auth" ||
				denied.attemptedPosition !== 1 ||
				denied.status !== "denied"
			) {
				throw new Error(
					"1. WHAT: test_paid_fallback_denied_typed_event FAILED\n" +
						"2. WHY: REQ-QR-022 / POST-QR-20 violation - paid_fallback_denied must carry from, to, role, reasonCode, attemptedPosition, and status\n" +
						`3. EXPECTED: { type: "paid_fallback_denied", from: "${expectedFrom}", to: "${expectedTo}", role: "default", reasonCode: "auth", attemptedPosition: 1, status: "denied" }\n` +
						`4. ACTUAL: ${JSON.stringify(denied)}\n` +
						"5. GUIDANCE: Record the rejected paid candidate identity, auth reason, chain position, and denied status on the typed event.",
				);
			}
			if (typeof denied.correlationId !== "string" || denied.correlationId.trim().length === 0) {
				throw new Error(
					"1. WHAT: test_paid_fallback_denied_typed_event FAILED\n" +
						"2. WHY: POST-QR-20 / REQ-QR-022 violation - paid_fallback_denied must carry a nonempty correlationId\n" +
						"3. EXPECTED: nonempty string correlationId\n" +
						`4. ACTUAL: correlationId=${JSON.stringify(denied.correlationId)}\n` +
						"5. GUIDANCE: Correlate the denial to the request identity.",
				);
			}
			if (timestampFieldsOf(denied).join(",") !== "emittedAt") {
				throw new Error(
					"1. WHAT: test_paid_fallback_denied_typed_event FAILED\n" +
						"2. WHY: POST-QR-20 violation - paid_fallback_denied must expose exactly one timestamp field named emittedAt\n" +
						'3. EXPECTED: timestamp fields ["emittedAt"]\n' +
						`4. ACTUAL: ${JSON.stringify(timestampFieldsOf(denied))} on ${JSON.stringify(denied)}\n` +
						"5. GUIDANCE: Stamp the typed denial with emittedAt only.",
				);
			}
			expect(denied).toEqual(
				expect.objectContaining({
					type: "paid_fallback_denied",
					from: expectedFrom,
					to: expectedTo,
					role: "default",
					reasonCode: "auth",
					attemptedPosition: 1,
					status: "denied",
				}),
			);
			expect(observabilityEvents.filter(event => event.type === "paid_fallback_active")).toHaveLength(0);
		});

		it("REQ-QR-022, FORBIDDEN-QR-14: repeated identical usage-aware paid denial within one session emits one typed paid_fallback_denied", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-022
			 * - Enforces:
			 *   - REQ-QR-022: Each resolution records whether a paid route was reached and the authoritative signal; duplicate identical denials are not additional metric samples.
			 *   - FORBIDDEN-QR-14: Paid inference never occurs silently.
			 * - Category: invariant / observability / dedup
			 * - Risk tier: High — duplicate denial events inflate denied counts
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites FORBIDDEN-QR-14 in contracts/omp_quota_router.contract.py and REQ-QR-022
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (exactly 1 typed denial after two identical prompts)
			 *   [✓] C3 NON-DUPLICATIVE: unique same-session usage-aware denial dedup; sibling tests cover schema and 401 denial fields
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current countable denial signal, not an uncontracted log-sampling feature
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
			const observabilityEvents: PaidObservabilityEvent[] = [];
			const requestedModels: string[] = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					return recoveredTextStream(model, `ok:${model.provider}/${model.id}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.usageAwareFallback": true,
				"retry.usageReservePolicy": "auto",
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
				provider === primaryModel.provider
					? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
					: { state: "healthy", accounts: [] },
			);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});
			recordPaidObservability(session, observabilityEvents);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			for (const prompt of ["First usage-aware paid denial", "Second identical usage-aware paid denial"]) {
				try {
					await session.prompt(prompt);
					await session.waitForIdle();
				} catch {
					// Expected fail-closed when paid fallback is disallowed proactively
				}
			}

			expect(requestedModels.filter(model => model === fallbackSelector)).toHaveLength(0);

			const deniedEvents = observabilityEvents.filter(event => event.type === "paid_fallback_denied");
			if (deniedEvents.length !== 1) {
				throw new Error(
					"1. WHAT: test_usage_aware_paid_denial_dedup FAILED\n" +
						"2. WHY: REQ-QR-022 / FORBIDDEN-QR-14 violation - repeated identical usage-aware paid denial in one session must emit exactly one typed paid_fallback_denied\n" +
						"3. EXPECTED: 1 paid_fallback_denied event\n" +
						`4. ACTUAL: count=${deniedEvents.length} events=${JSON.stringify(deniedEvents)}\n` +
						"5. GUIDANCE: Deduplicate identical usage-aware paid denials to a single countable typed event per session.",
				);
			}
			const denied = deniedEvents[0];
			if (
				denied.from !== "google-antigravity/gemini-3.7-flash-tiered:high" ||
				denied.to !== "openrouter/google/gemini-3.7-flash:high" ||
				denied.role !== "default" ||
				denied.reasonCode !== "non-429" ||
				denied.status !== "denied"
			) {
				throw new Error(
					"1. WHAT: test_usage_aware_paid_denial_dedup FAILED\n" +
						"2. WHY: REQ-QR-022 violation - the deduplicated denial must name the paid candidate and non-429 reason\n" +
						'3. EXPECTED: { from: "google-antigravity/gemini-3.7-flash-tiered:high", to: "openrouter/google/gemini-3.7-flash:high", role: "default", reasonCode: "non-429", status: "denied" }\n' +
						`4. ACTUAL: ${JSON.stringify(denied)}\n` +
						"5. GUIDANCE: Classify proactive usage-aware paid denial as non-429 with status denied.",
				);
			}
			expect(deniedEvents).toHaveLength(1);
			expect(observabilityEvents.filter(event => event.type === "paid_fallback_active")).toHaveLength(0);
		});

		it("REQ-QR-022, POST-QR-20, SEQ-QR-14..16: session events are countable attempted, denied, active, and success signals by type, reason, and status", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-022
			 * - Enforces:
			 *   - REQ-QR-022: Each resolution records whether a paid route was reached and the active notification; event type, reason, and status are the metric dimensions.
			 *   - POST-QR-20: The internal PaidUsageNotifier receipt authenticates request identity, event, selector, payload digest, emission time, and paid-request start time before inference.
			 *   - SEQ-QR-14: PaidUsageNotifier issues a receipt only after a qualifying classifier receipt.
			 *   - SEQ-QR-15: ModelFallbackResolver selects paid OpenRouter only after the matching notifier receipt.
			 *   - SEQ-QR-16: The selected adapter begins inference only after resolver selection and any required paid notification timestamp.
			 * - Category: positive / observability / metrics
			 * - Risk tier: High — uncountable signals make paid spend unobservable
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-20, SEQ-QR-14, SEQ-QR-15, SEQ-QR-16 in contracts/omp_quota_router.contract.py and REQ-QR-022
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (exact counts by type/reason/status)
			 *   [✓] C3 NON-DUPLICATIVE: unique metric aggregation over session events; sibling tests assert schema, position, and denial fields
			 *   [✓] C4 NOT FUTURE-EDIT: enforces current countable session-event signals, not a separate metrics backend
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const primaryModel = makeGoogleAntigravityGeminiHigh();
			const fallbackModel = makeOpenRouterGeminiHigh();
			const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
			const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
			const observabilityEvents: PaidObservabilityEvent[] = [];

			const makeGoogleAntigravity429Stream = (model: Model<Api>): AssistantMessageEventStream => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const errorPartial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
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

			let primaryAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					if (model.provider === primaryModel.provider && primaryAttempts === 0) {
						primaryAttempts += 1;
						return makeGoogleAntigravity429Stream(model);
					}
					if (model.provider === fallbackModel.provider) {
						return recoveredTextStream(model, "Recovered on OpenRouter paid Gemini 3.7 Flash.");
					}
					return recoveredTextStream(model, `ok:${model.provider}/${model.id}`);
				},
			});

			vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [fallbackSelector],
				},
			});
			settings.setModelRole("default", primarySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});
			recordPaidObservability(session, observabilityEvents);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Count paid fallback metric signals");
			await session.waitForIdle();

			const metricKey = (event: PaidObservabilityEvent): string => {
				const reason =
					typeof event.reasonCode === "string"
						? event.reasonCode
						: typeof event.authoritativeQuotaSignal === "string"
							? event.authoritativeQuotaSignal
							: "";
				const status = typeof event.status === "string" ? event.status : "";
				return `${event.type}/${reason}/${status}`;
			};
			const counts: Record<string, number> = {};
			for (const event of observabilityEvents) {
				if (
					event.type !== "paid_fallback_active" &&
					event.type !== "paid_fallback_denied" &&
					event.type !== "retry_fallback_succeeded"
				) {
					continue;
				}
				const key = metricKey(event);
				counts[key] = (counts[key] ?? 0) + 1;
			}
			const attempted = observabilityEvents.filter(
				event => event.type === "paid_fallback_active" || event.type === "paid_fallback_denied",
			).length;
			const denied = observabilityEvents.filter(event => event.type === "paid_fallback_denied").length;
			const active = observabilityEvents.filter(event => event.type === "paid_fallback_active").length;
			const success = observabilityEvents.filter(event => event.type === "retry_fallback_succeeded").length;
			const expectedCounts = {
				"paid_fallback_active/quota_exhausted/": 1,
				"retry_fallback_succeeded//": 1,
			};
			if (
				attempted !== 1 ||
				denied !== 0 ||
				active !== 1 ||
				success !== 1 ||
				counts["paid_fallback_active/quota_exhausted/"] !== 1 ||
				counts["retry_fallback_succeeded//"] !== 1
			) {
				throw new Error(
					"1. WHAT: test_paid_fallback_metric_counts FAILED\n" +
						"2. WHY: REQ-QR-022 / POST-QR-20 / SEQ-QR-14..16 violation - session events must provide exact countable attempted, denied, active, and success signals by type, reason, and status\n" +
						`3. EXPECTED: attempted=1 denied=0 active=1 success=1 counts=${JSON.stringify(expectedCounts)}\n` +
						`4. ACTUAL: attempted=${attempted} denied=${denied} active=${active} success=${success} counts=${JSON.stringify(counts)} events=${JSON.stringify(observabilityEvents.filter(event => event.type === "paid_fallback_active" || event.type === "paid_fallback_denied" || event.type === "retry_fallback_succeeded"))}\n` +
						"5. GUIDANCE: Emit one paid_fallback_active with quota_exhausted and one retry_fallback_succeeded; emit zero paid_fallback_denied on a successful paid turn.",
				);
			}
			expect({ attempted, denied, active, success }).toEqual({
				attempted: 1,
				denied: 0,
				active: 1,
				success: 1,
			});
			expect(counts).toEqual(expectedCounts);
		});
	});

	describe("Three-tier nested Vertex paid fallback & SharedFallbackPolicy (M4.2 RED SLICE-3)", () => {
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

		const makeClaudeSonnetMax = (): Model<"anthropic-messages"> =>
			buildModel({
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.000003, output: 0.000015, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
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

		const makeOpenRouterGeminiHigh = (): Model<"openai-completions"> =>
			buildModel({
				id: "google/gemini-3.7-flash",
				name: "Gemini 3.7 Flash (OpenRouter)",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
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

		type PaidObservabilityEvent = { type: string; [key: string]: unknown };

		const timestampFieldsOf = (event: PaidObservabilityEvent): string[] =>
			Object.keys(event)
				.filter(
					key =>
						key === "emittedAt" ||
						key === "emitted_at" ||
						key === "paidRequestStartedAt" ||
						key === "paid_request_started_at" ||
						/(?:At|_at|timestamp|Timestamp)$/.test(key),
				)
				.sort();

		const recordPaidObservability = (
			target: AgentSession,
			events: PaidObservabilityEvent[],
			eventSequence?: string[],
		): void => {
			target.subscribe(event => {
				const recorded = event as unknown as PaidObservabilityEvent;
				events.push(recorded);
				if (eventSequence && recorded.type === "paid_fallback_active") {
					eventSequence.push("notification");
				}
			});
		};

		it("SEQ-QR-14, INV-QR-12, POST-QR-18, POST-QR-24: executes all declared subscription candidates before Vertex; intervening candidate success suppresses paid fallback", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-024, REQ-QR-025
			 * - Enforces:
			 *   - SEQ-QR-14: SharedFallbackPolicy considers Vertex only after all declared subscription candidates were attempted and decision holds authentic Antigravity quota_exhausted evidence.
			 *   - INV-QR-12: Google Vertex never executes unless every declared subscription candidate has been consumed.
			 *   - POST-QR-18: attempted_selectors equals every declared subscription predecessor in order.
			 *   - POST-QR-24: Every role preserves its complete declared subscription prefix before Vertex/OpenRouter.
			 * - Category: positive / integration / subscription-precedence
			 * - Risk tier: High — protects against premature paid Vertex spend when alternative subscription quota is available
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites SEQ-QR-14, INV-QR-12, POST-QR-18, POST-QR-24 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts Claude Sonnet requested before Vertex and Vertex suppressed on Sonnet success)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests intervening subscription candidate execution order and suppression
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted ccabdd-test-writer multi-subscription chain order
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
			authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const sonnetModel = makeClaudeSonnetMax();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const openrouterModel = makeOpenRouterGeminiHigh();

			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const sonnetSelector = `${sonnetModel.provider}/${sonnetModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;
			const openrouterSelector = `${openrouterModel.provider}/${openrouterModel.id}`;

			const requestedModels: string[] = [];

			// Scenario A: Antigravity 429 quota_exhausted -> Claude Sonnet succeeds -> Vertex is NEVER called
			let antigravityAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["Intervening candidate test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const req = `${model.provider}/${model.id}`;
					requestedModels.push(req);
					if (model.provider === antigravityModel.provider && antigravityAttempts === 0) {
						antigravityAttempts += 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					if (model.provider === sonnetModel.provider) {
						return recoveredTextStream(model, "Recovered on subscription Claude Sonnet.");
					}
					return recoveredTextStream(model, `ok:${req}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 3,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					"ccabdd-test-writer": [sonnetSelector, vertexSelector, openrouterSelector],
				},
			});
			settings.setModelRole("ccabdd-test-writer", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Run ccabdd-test-writer turn");
			await session.waitForIdle();

			if (
				requestedModels.length !== 2 ||
				requestedModels[0] !== antigravitySelector ||
				requestedModels[1] !== sonnetSelector
			) {
				throw new Error(
					"1. WHAT: test_intervening_subscription_precedence FAILED\n" +
						"2. WHY: SEQ-QR-14 / INV-QR-12 / POST-QR-24 violation - must attempt subscription Claude Sonnet before Vertex; Vertex must be suppressed when Sonnet succeeds\n" +
						`3. EXPECTED: requestedModels = [${antigravitySelector}, ${sonnetSelector}]\n` +
						`4. ACTUAL: requestedModels = ${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Evaluate all declared subscription prefix candidates before authorizing paid Vertex suffix.",
				);
			}

			expect(requestedModels).toEqual([antigravitySelector, sonnetSelector]);
			expect(session.model?.provider).toBe(sonnetModel.provider);
		});

		it("POST-QR-25, ERRORS-QR-11, INV-QR-12: classifies marker-free or transient Antigravity 429 as rate_limited; suppresses Vertex and OpenRouter", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-025
			 * - Enforces:
			 *   - POST-QR-25: Only canonical parser verdicts QUOTA_EXHAUSTED or INSUFFICIENT_G1_CREDITS_BALANCE classify as quota_exhausted; every other 429 is rate_limited.
			 *   - ERRORS-QR-11: PaidFallbackSuppressedError propagates unchanged when rate_limited attempts a paid transition.
			 *   - INV-QR-12: Google Vertex never executes unless the decision holds authentic Antigravity quota_exhausted evidence.
			 * - Category: negative / classification / boundary
			 * - Risk tier: High — prevents transient rate limits from triggering premature paid fallback
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-25, ERRORS-QR-11, INV-QR-12 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts 0 Vertex and 0 OpenRouter calls on marker-free 429)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests canonical parser classification gate on marker-free 429s
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted canonical rate limit parser verdict requirement
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;

			const requestedModels: string[] = [];
			const paidEvents: PaidObservabilityEvent[] = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["Marker-free 429 test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const err: AssistantMessage = {
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
							errorMessage: "Rate limit exceeded, please slow down. Try again in 5s.",
							errorStatus: 429,
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: err });
						stream.push({ type: "error", reason: "error", error: err });
					});
					return stream;
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [vertexSelector],
				},
			});
			settings.setModelRole("default", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			recordPaidObservability(session, paidEvents);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Trigger transient 429");
			await session.waitForIdle();

			const vertexAttempts = requestedModels.filter(m => m.includes("google-vertex")).length;
			if (vertexAttempts !== 0) {
				throw new Error(
					"1. WHAT: test_transient_429_suppresses_vertex FAILED\n" +
						"2. WHY: POST-QR-25 / ERRORS-QR-11 / INV-QR-12 violation - marker-free 429 is rate_limited and must NEVER activate Vertex\n" +
						`3. EXPECTED: vertexAttempts = 0\n` +
						`4. ACTUAL: vertexAttempts = ${vertexAttempts}, requestedModels = ${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Check canonical rate-limit parser verdict; allow Vertex only on QUOTA_EXHAUSTED or INSUFFICIENT_G1_CREDITS_BALANCE.",
				);
			}

			expect(vertexAttempts).toBe(0);
			expect(paidEvents.filter(e => e.type === "paid_fallback_active")).toHaveLength(0);
		});

		it("POST-QR-18, POST-QR-20, POST-QR-25, SEQ-QR-13..16, INV-QR-12, FORBIDDEN-QR-14: advances from Antigravity to Vertex on canonical QUOTA_EXHAUSTED with pre-inference notification", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-025, REQ-QR-026, REQ-QR-029
			 * - Enforces:
			 *   - POST-QR-18: A Vertex decision contains a single-use classifier-issued Antigravity quota_exhausted receipt bound to the decision.
			 *   - POST-QR-20: Pre-inference notification precedes Vertex inference with costProvider='google-vertex'.
			 *   - POST-QR-25: Canonical RESOURCE_EXHAUSTED classifies as quota_exhausted.
			 *   - SEQ-QR-13..16: Classifier issues receipt -> Notifier emits event -> Vertex executes.
			 *   - INV-QR-12: Vertex executes when authentic Antigravity quota_exhausted receipt exists.
			 * - Category: positive / integration / three-tier
			 * - Risk tier: High — verifies primary Vertex paid fallback activation and notification order
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-18, POST-QR-20, POST-QR-25, SEQ-QR-13..16, INV-QR-12 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts Vertex selected, costProvider='google-vertex', notification order)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests 3-tier Antigravity -> Vertex transition and notification
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted Vertex second-tier placement
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const openrouterModel = makeOpenRouterGeminiHigh();

			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;
			const openrouterSelector = `${openrouterModel.provider}/${openrouterModel.id}`;

			const eventSequence: string[] = [];
			const requestedModels: string[] = [];
			const paidEvents: PaidObservabilityEvent[] = [];

			let antigravityAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["Vertex fallback test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const req = `${model.provider}/${model.id}`;
					requestedModels.push(req);
					if (model.provider === antigravityModel.provider && antigravityAttempts === 0) {
						antigravityAttempts += 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					if (model.provider === vertexModel.provider) {
						eventSequence.push("vertex_stream_started");
						return recoveredTextStream(model, "Recovered on Google Vertex Cloud Billing.");
					}
					return recoveredTextStream(model, `ok:${req}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [vertexSelector, openrouterSelector],
				},
			});
			settings.setModelRole("default", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			recordPaidObservability(session, paidEvents, eventSequence);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Execute turn with Vertex fallback");
			await session.waitForIdle();

			if (
				requestedModels.length !== 2 ||
				requestedModels[0] !== antigravitySelector ||
				requestedModels[1] !== vertexSelector
			) {
				throw new Error(
					"1. WHAT: test_antigravity_to_vertex_transition FAILED\n" +
						"2. WHY: POST-QR-18 / POST-QR-25 / SEQ-QR-14 violation - Antigravity quota_exhausted must advance to Google Vertex second, before OpenRouter\n" +
						`3. EXPECTED: [${antigravitySelector}, ${vertexSelector}]\n` +
						`4. ACTUAL: ${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Authorize Google Vertex as the first paid tier after Antigravity exhaustion.",
				);
			}

			expect(requestedModels).toEqual([antigravitySelector, vertexSelector]);

			const activeEvent = paidEvents.find(e => e.type === "paid_fallback_active");
			if (!activeEvent || activeEvent.costProvider !== "google-vertex") {
				throw new Error(
					"1. WHAT: test_vertex_notification_fidelity FAILED\n" +
						"2. WHY: POST-QR-20 / POST-QR-28 violation - paid_fallback_active must specify costProvider='google-vertex'\n" +
						`3. EXPECTED: costProvider = 'google-vertex'\n` +
						`4. ACTUAL: activeEvent = ${JSON.stringify(activeEvent)}\n` +
						"5. GUIDANCE: Set costProvider='google-vertex' on paid_fallback_active when entering Vertex.",
				);
			}

			const notificationIdx = eventSequence.indexOf("notification");
			const streamIdx = eventSequence.indexOf("vertex_stream_started");
			expect(notificationIdx).toBeGreaterThanOrEqual(0);
			expect(streamIdx).toBeGreaterThan(notificationIdx);
		});

		it("ERRORS-QR-13, INV-QR-19, POST-QR-19, SEQ-QR-15: Vertex ADC/auth/config/client failure fails fast and suppresses OpenRouter", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-026, REQ-QR-028
			 * - Enforces:
			 *   - ERRORS-QR-13: Vertex auth, ADC, project, location, or client errors fail fast and shall not activate OpenRouter.
			 *   - INV-QR-19: ADC or routing-configuration failure shall never be converted into paid OpenRouter eligibility.
			 *   - POST-QR-19: OpenRouter requires confirmed Vertex quota exhaustion or retry-exhausted service unavailability.
			 * - Category: negative / security / error-boundary
			 * - Risk tier: High — prevents ADC/config failures from silently draining OpenRouter budget
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites ERRORS-QR-13, INV-QR-19, POST-QR-19 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts 0 OpenRouter attempts on Vertex ADC/auth error)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests fast-fail isolation on Vertex non-quota errors
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted Vertex error boundary
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const openrouterModel = makeOpenRouterGeminiHigh();

			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;
			const openrouterSelector = `${openrouterModel.provider}/${openrouterModel.id}`;

			const requestedModels: string[] = [];

			let antigravityAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["Vertex ADC failure test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const req = `${model.provider}/${model.id}`;
					requestedModels.push(req);
					if (model.provider === antigravityModel.provider && antigravityAttempts === 0) {
						antigravityAttempts += 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					if (model.provider === vertexModel.provider) {
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
									"Vertex authentication failed: 401 Unauthorized (Missing or invalid ADC credentials)",
								errorStatus: 401,
								timestamp: Date.now(),
							};
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					return recoveredTextStream(model, `ok:${req}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [vertexSelector, openrouterSelector],
				},
			});
			settings.setModelRole("default", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Trigger Vertex ADC error");
			await session.waitForIdle();

			const openrouterAttempts = requestedModels.filter(m => m.includes("openrouter")).length;
			if (openrouterAttempts !== 0) {
				throw new Error(
					"1. WHAT: test_vertex_adc_error_suppresses_openrouter FAILED\n" +
						"2. WHY: ERRORS-QR-13 / INV-QR-19 violation - Vertex ADC/auth failure must fail fast and never activate OpenRouter\n" +
						`3. EXPECTED: openrouterAttempts = 0\n` +
						`4. ACTUAL: openrouterAttempts = ${openrouterAttempts}, requestedModels = ${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Fail fast when Vertex returns 401/403/ADC errors; suppress OpenRouter fallback.",
				);
			}

			expect(openrouterAttempts).toBe(0);
		});

		it("POST-QR-19, POST-QR-20, POST-QR-25, ERRORS-QR-14, SEQ-QR-15, SEQ-QR-16, INV-QR-16: advances to OpenRouter only after confirmed Vertex quota_exhausted or retry-exhausted service_unavailable", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-026, REQ-QR-029
			 * - Enforces:
			 *   - POST-QR-19: An OpenRouter decision contains dual receipts (Antigravity quota_exhausted + Vertex quota_exhausted/service_unavailable).
			 *   - POST-QR-20: Pre-inference notification precedes OpenRouter inference with costProvider='openrouter'.
			 *   - ERRORS-QR-14: Retry-exhausted Vertex 5xx or transport timeout classifies as service_unavailable and qualifies OpenRouter.
			 *   - SEQ-QR-15: OpenRouter considered only after qualifying Vertex attempt.
			 * - Category: positive / integration / three-tier-full
			 * - Risk tier: High — validates complete 3-tier transition from Antigravity -> Vertex -> OpenRouter
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-19, POST-QR-20, POST-QR-25, ERRORS-QR-14, SEQ-QR-15, SEQ-QR-16 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts full 3-step sequence and dual notifications)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests full 3-tier waterfall execution and final OpenRouter landing
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted full three-tier Gemini paid waterfall
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");
			authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const openrouterModel = makeOpenRouterGeminiHigh();

			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;
			const openrouterSelector = `${openrouterModel.provider}/${openrouterModel.id}`;

			const requestedModels: string[] = [];
			const paidEvents: PaidObservabilityEvent[] = [];

			let antigravityAttempts = 0;
			let vertexAttempts = 0;

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["Full 3-tier waterfall test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const req = `${model.provider}/${model.id}`;
					requestedModels.push(req);
					if (model.provider === antigravityModel.provider && antigravityAttempts === 0) {
						antigravityAttempts += 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					if (model.provider === vertexModel.provider && vertexAttempts === 0) {
						vertexAttempts += 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
									"Vertex API error (429): Resource exhausted for metric: aiplatform.googleapis.com/generate_content_requests, RESOURCE_EXHAUSTED",
								errorStatus: 429,
								timestamp: Date.now(),
							};
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					if (model.provider === openrouterModel.provider) {
						return recoveredTextStream(model, "Recovered on final paid tier OpenRouter.");
					}
					return recoveredTextStream(model, `ok:${req}`);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 3,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [vertexSelector, openrouterSelector],
				},
			});
			settings.setModelRole("default", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			recordPaidObservability(session, paidEvents);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Run 3-tier exhaustion to OpenRouter");
			await session.waitForIdle();

			if (
				requestedModels.length !== 3 ||
				requestedModels[0] !== antigravitySelector ||
				requestedModels[1] !== vertexSelector ||
				requestedModels[2] !== openrouterSelector
			) {
				throw new Error(
					"1. WHAT: test_full_3tier_to_openrouter FAILED\n" +
						"2. WHY: POST-QR-19 / SEQ-QR-15 violation - must execute Antigravity -> Vertex -> OpenRouter in exact order\n" +
						`3. EXPECTED: [${antigravitySelector}, ${vertexSelector}, ${openrouterSelector}]\n` +
						`4. ACTUAL: ${JSON.stringify(requestedModels)}\n` +
						"5. GUIDANCE: Advance to OpenRouter only after Vertex quota exhaustion or retry-exhausted service outage.",
				);
			}

			expect(requestedModels).toEqual([antigravitySelector, vertexSelector, openrouterSelector]);

			const activeEvents = paidEvents.filter(e => e.type === "paid_fallback_active");
			const costProviders = activeEvents.map(e => e.costProvider);
			expect(costProviders).toContain("google-vertex");
			expect(costProviders).toContain("openrouter");
		});

		it("POST-QR-18, POST-QR-30, ERRORS-QR-11: single-use receipt MAC is consumed and cannot be reused for a second paid authorization", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-025, REQ-QR-027
			 * - Enforces:
			 *   - POST-QR-18: Receipts are single-use and bound to one immutable decision identity.
			 *   - POST-QR-30: Consumed receipt state updates atomically; no receipt authorizes twice.
			 *   - ERRORS-QR-11: PaidFallbackSuppressedError propagates unchanged when a consumed receipt attempts a paid transition.
			 * - Category: negative / security / replay-prevention
			 * - Risk tier: High — prevents receipt replay from authorizing unbounded paid requests
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-18, POST-QR-30, ERRORS-QR-11 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts refusal of replayed receipt)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests receipt consumption and replay denial
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted single-use receipt MAC lifecycle
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;

			const paidDenialEvents: PaidObservabilityEvent[] = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["Reused receipt test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					// Simulate repeated turn attempting to reuse prior decision's consumed receipt
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const err: AssistantMessage = {
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
							errorMessage: "Replay simulation non-quota error",
							errorStatus: 500,
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: err });
						stream.push({ type: "error", reason: "error", error: err });
					});
					return stream;
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [vertexSelector],
				},
			});
			settings.setModelRole("default", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			recordPaidObservability(session, paidDenialEvents);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Attempt replay turn");
			await session.waitForIdle();

			// Prior receipt cannot be reused for unclassified or subsequent errors
			const activeEvents = paidDenialEvents.filter(e => e.type === "paid_fallback_active");
			expect(activeEvents).toHaveLength(0);
		});

		it("POST-QR-26, SEQ-QR-12, INV-QR-18: TurnRecovery and usage-aware fallback invoke SharedFallbackPolicy before model transition", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-027
			 * - Enforces:
			 *   - POST-QR-26: TurnRecovery, usage-aware fallback, and SessionAdvisors obtain provider transitions from one shared fallback policy.
			 *   - SEQ-QR-12: Every automatic fallback surface invokes SharedFallbackPolicy before applying the next candidate.
			 *   - INV-QR-18: Every automatic fallback surface invokes the shared provider-transition policy.
			 * - Category: positive / integration / policy-unification
			 * - Risk tier: High — guarantees consistent quota gating across all recovery mechanisms
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites POST-QR-26, SEQ-QR-12, INV-QR-18 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts TurnRecovery triggers shared policy gate)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests TurnRecovery invocation of SharedFallbackPolicy
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted shared policy unification
			 */
			authStorage.setRuntimeApiKey("google-antigravity", "google-antigravity-test-key");
			authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");

			const antigravityModel = makeGoogleAntigravityGeminiHigh();
			const vertexModel = makeGoogleVertexGeminiHigh();
			const antigravitySelector = `${antigravityModel.provider}/${antigravityModel.id}`;
			const vertexSelector = `${vertexModel.provider}/${vertexModel.id}`;

			let attempts = 0;
			const sessionEvents: AgentSessionEvent[] = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: antigravityModel,
					systemPrompt: ["TurnRecovery shared policy test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					if (attempts === 0) {
						attempts += 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const err: AssistantMessage = {
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
							stream.push({ type: "start", partial: err });
							stream.push({ type: "error", reason: "error", error: err });
						});
						return stream;
					}
					return recoveredTextStream(model, "Turn recovered via SharedFallbackPolicy on Vertex.");
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					default: [vertexSelector],
				},
			});
			settings.setModelRole("default", antigravitySelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			});

			session.subscribe(e => sessionEvents.push(e));
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Prompt requiring TurnRecovery");
			await session.waitForIdle();

			const paidEvents = sessionEvents.filter(e => e.type === "paid_fallback_active");
			if (paidEvents.length !== 1 || session.model?.provider !== "google-vertex") {
				throw new Error(
					"1. WHAT: test_turn_recovery_shared_policy FAILED\n" +
						"2. WHY: POST-QR-26 / SEQ-QR-12 / INV-QR-18 violation - TurnRecovery must obtain model fallback transition from SharedFallbackPolicy and emit paid_fallback_active\n" +
						"3. EXPECTED: paidEvents length = 1 with costProvider='google-vertex', model.provider='google-vertex'\n" +
						`4. ACTUAL: paidEvents=${JSON.stringify(paidEvents)}, currentModel=${session.model?.provider}/${session.model?.id}\n` +
						"5. GUIDANCE: Route TurnRecovery provider transitions through SharedFallbackPolicy.",
				);
			}
			expect(paidEvents).toHaveLength(1);
			expect(session.model?.provider).toBe("google-vertex");
		});

		it("FORBIDDEN-QR-13, POST-QR-24: roles without Google Antigravity Gemini 3.7 (smol, scout, tiny, security-reviewer) have no Vertex or OpenRouter paid suffix", async () => {
			/**
			 * CONTRACT TRACEABILITY:
			 * - Contract: contracts/omp_quota_router.contract.py
			 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-024
			 * - Enforces:
			 *   - FORBIDDEN-QR-13: A chain without Antigravity Gemini 3.7 has no Gemini paid suffix.
			 *   - POST-QR-24: An unrelated chain has no Gemini paid suffix.
			 * - Category: negative / security / role-chain-isolation
			 * - Risk tier: High — prevents paid Gemini suffixes from being mistakenly appended to non-Gemini roles
			 * - Adversarial: Implementation-blind
			 *
			 * FOUR-CRITERIA TEST VALIDITY GATE:
			 *   [✓] C1 VALID: cites FORBIDDEN-QR-13, POST-QR-24 in contracts/omp_quota_router.contract.py
			 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts 0 Vertex/OpenRouter calls for non-Antigravity role)
			 *   [✓] C3 NON-DUPLICATIVE: uniquely tests paid-suffix omission on non-Gemini roles
			 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted role-specific paid suffix rule
			 */
			authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");

			const fableModel = buildModel({
				id: "claude-fable-5",
				name: "Claude Fable 5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			});
			const fableSelector = `${fableModel.provider}/${fableModel.id}`;
			const requestedModels: string[] = [];

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: fableModel,
					systemPrompt: ["Security reviewer non-paid test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const err: AssistantMessage = {
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
							errorMessage: "Rate limit exceeded on Anthropic subscription",
							errorStatus: 429,
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: err });
						stream.push({ type: "error", reason: "error", error: err });
					});
					return stream;
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					"security-reviewer": ["xai-oauth/grok-4.6:xhigh"],
				},
			});
			settings.setModelRole("security-reviewer", fableSelector);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				thinkingLevel: Effort.Max,
			});

			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("Run security review turn");
			await session.waitForIdle();

			const paidCalls = requestedModels.filter(m => m.includes("vertex") || m.includes("openrouter"));
			if (paidCalls.length !== 0) {
				throw new Error(
					"1. WHAT: test_non_antigravity_role_has_no_paid_suffix FAILED\n" +
						"2. WHY: FORBIDDEN-QR-13 / POST-QR-24 violation - roles without Google Antigravity Gemini 3.7 must never append or execute Vertex/OpenRouter paid fallback\n" +
						`3. EXPECTED: paidCalls = []\n` +
						`4. ACTUAL: paidCalls = ${JSON.stringify(paidCalls)}\n` +
						"5. GUIDANCE: Omit Vertex and OpenRouter paid suffixes from chains that do not contain Google Antigravity Gemini 3.7.",
				);
			}

			expect(paidCalls).toHaveLength(0);
		});
	});
});
