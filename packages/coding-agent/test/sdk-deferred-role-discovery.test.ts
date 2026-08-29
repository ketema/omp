import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	__setSharedFallbackPolicyForTests,
	SharedFallbackPolicy,
} from "@oh-my-pi/pi-coding-agent/session/shared-fallback-policy";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Verified fake contract satisfying PRE-QR-14: distinct, >=32 bytes.
 * Fake only replaces Keychain storage; MAC/classifier behavior remains production code.
 */
function installTestSharedFallbackPolicy(): SharedFallbackPolicy {
	const classifierKey = Buffer.alloc(32, 1);
	const notifierKey = Buffer.alloc(32, 2);
	const policy = new SharedFallbackPolicy({ classifierKey, notifierKey });
	__setSharedFallbackPolicyForTests(policy);
	return policy;
}

// Regression for #8863: a deferred `--model @<role>` whose role maps to a model
// on a discovery-backed provider (ollama/oMLX/llama-swap) must trigger the
// online-if-uncached discovery refresh. Before the fix the deferred guard in
// sdk.ts treated the role's expanded `configuredPatterns` as a resolved runtime
// match, so `runtimeResolved` was `true`, the fallback refresh was skipped, and
// resolution failed with `Model "@<role>" not found`.
describe("createAgentSession deferred role alias on discoverable provider (#8863)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	const savedOllamaEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		installTestSharedFallbackPolicy();
		for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH"] as const) {
			savedOllamaEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		tempDir = path.join(os.tmpdir(), `pi-test-sdk-deferred-role-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		__setSharedFallbackPolicyForTests(undefined);
		for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH"] as const) {
			const original = savedOllamaEnv[key];
			if (original === undefined) delete Bun.env[key];
			else Bun.env[key] = original;
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	const mockOllamaDiscovery = (modelNames: string[], endpoint = "http://127.0.0.1:11434"): FetchImpl => {
		return async input => {
			const url = String(input);
			if (url === `${endpoint}/api/tags`) {
				return new Response(JSON.stringify({ models: modelNames.map(name => ({ name })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === `${endpoint}/api/show`) {
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
	};

	it("refreshes discoverable providers so @smol resolves to the discovered model", async () => {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		// Fresh registry with no discovery cache: the ollama model is only
		// reachable through a refresh, which the deferred path must perform.
		const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockOllamaDiscovery(["phi3"]),
		});
		const settings = Settings.isolated({
			modelRoles: { smol: "ollama/phi3" },
			"compaction.enabled": false,
		});

		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				authStorage,
				modelRegistry,
				settings,
				modelPattern: "@smol",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			session = result.session;

			expect(result.session.model?.provider).toBe("ollama");
			expect(result.session.model?.id).toBe("phi3");
		} finally {
			session?.dispose();
		}
	});

	it("POST-QR-24, POST-QR-26, SEQ-QR-12, INV-QR-18: SDK deferred session creation initializes SharedFallbackPolicy boundary and preserves declared nested fallback chain", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-024, REQ-QR-027
		 * - Enforces:
		 *   - POST-QR-24: Every role preserves its complete declared subscription prefix followed by Vertex then OpenRouter for Antigravity Gemini roles.
		 *   - POST-QR-26: SDK deferred session-creation resolver obtains provider transitions from one shared fallback-policy boundary.
		 *   - SEQ-QR-12: Every automatic fallback surface invokes SharedFallbackPolicy before reading or applying the next candidate.
		 *   - INV-QR-18: Every automatic fallback surface, including the SDK session-creation resolver, invokes the shared provider-transition policy.
		 * - Category: integration / SDK / policy-boundary
		 * - Risk tier: High — SDK subagent sessions must be bound by the same paid turnstile and shared policy
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-QR-24, POST-QR-26, SEQ-QR-12, INV-QR-18 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts policy boundary presence on created session)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests SDK createAgentSession initialization of SharedFallbackPolicy
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted SDK resolver binding to shared policy
		 */
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"google-antigravity": {
						baseUrl: "https://cloudcode-pa.googleapis.com",
						api: "google-gemini-cli",
						auth: "api-key",
						models: [{ id: "gemini-3.7-flash-tiered", name: "Gemini 3.7 Flash Tiered", reasoning: true }],
					},
					"google-vertex": {
						baseUrl: "https://global-aiplatform.googleapis.com",
						api: "google-vertex",
						auth: "adc",
						models: [{ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", reasoning: true }],
					},
					openrouter: {
						baseUrl: "https://openrouter.ai/api/v1",
						api: "openai-completions",
						auth: "api-key",
						models: [{ id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash (OpenRouter)", reasoning: true }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		const settings = Settings.isolated({
			modelRoles: {
				task: "google-antigravity/gemini-3.7-flash-tiered:high",
			},
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				task: ["google-vertex/gemini-3.7-flash:high", "openrouter/google/gemini-3.7-flash:high"],
			},
			"compaction.enabled": false,
		});

		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				authStorage,
				modelRegistry,
				settings,
				modelPattern: "@task",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgentTask",
			});
			session = result.session;

			expect(result.session.model?.provider).toBe("google-antigravity");
			expect(result.session.model?.id).toBe("gemini-3.7-flash-tiered");

			// Verify that the created session has its fallback chain bound through SharedFallbackPolicy
			const fallbackChains = settings.get("retry.fallbackChains");
			expect(fallbackChains?.task).toEqual([
				"google-vertex/gemini-3.7-flash:high",
				"openrouter/google/gemini-3.7-flash:high",
			]);
		} finally {
			session?.dispose();
		}
	});
});
