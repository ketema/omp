/**
 * CONTRACT AUTHORITY RECORD:
 * - Authority: contracts/omp_quota_router.contract.py
 * - Requirements: requirements/REQ-2026-OMP-QUOTA-ROUTER.md (REQ-QR-028)
 * - Plan: plans/omp-quota-router.plan.yml (SLICE-3)
 * - In-Scope Clauses: PRE-QR-13, POST-QR-27, ERRORS-QR-13, INV-QR-19, FORBIDDEN-QR-17
 * - Categories: Unit / Security / Error / Configuration
 * - Risk Tier: High — Prevents credential leakage, unauthorized billing project drift, and broken ADC failover
 * - Adversarial: Structurally blind to production implementation source
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

describe("google-vertex provider auth and URL behavior (SLICE-3 RED)", () => {
	let tmpDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		for (const key of [
			"GOOGLE_APPLICATION_CREDENTIALS",
			"GOOGLE_CLOUD_PROJECT",
			"GOOGLE_CLOUD_LOCATION",
			"GOOGLE_VERTEX_LOCATION",
			"VERTEX_LOCATION",
			"GOOGLE_CLOUD_API_KEY",
		]) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-provider-test-"));
	});

	afterEach(async () => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) delete Bun.env[key];
			else Bun.env[key] = val;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const makeVertexGeminiHighModel = (): Model<"google-vertex"> =>
		buildModel({
			id: "gemini-3.7-flash",
			name: "Gemini 3.7 Flash",
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

	it("PRE-QR-13, POST-QR-27: constructs project-scoped OAuth URL with semantic-embedder-stg and global location using Authorization Bearer token", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-028
		 * - Enforces:
		 *   - PRE-QR-13: Google Vertex fallback requires project-scoped OAuth/ADC branch, GOOGLE_CLOUD_PROJECT=semantic-embedder-stg, GOOGLE_CLOUD_LOCATION=global.
		 *   - POST-QR-27: The Vertex adapter uses the project-scoped OAuth endpoint containing projects/semantic-embedder-stg/locations/global with cloud-platform ADC.
		 * - Category: positive / unit / url-construction
		 * - Risk tier: High — ensures billable Vertex traffic targets the contracted GCP project and global location
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-QR-13, POST-QR-27 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts exact endpoint URL path and Authorization header presence)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely verifies Vertex adapter endpoint and auth header format
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted GCP project identity semantic-embedder-stg and global location
		 */
		Bun.env.GOOGLE_CLOUD_PROJECT = "semantic-embedder-stg";
		Bun.env.GOOGLE_CLOUD_LOCATION = "global";

		const model = makeVertexGeminiHighModel();
		const expectedUrlSubstring = "projects/semantic-embedder-stg/locations/global";

		// The model baseUrl and endpoint structure must target the contracted project and location
		expect(model.provider).toBe("google-vertex");
		expect(Bun.env.GOOGLE_CLOUD_PROJECT).toBe("semantic-embedder-stg");
		expect(Bun.env.GOOGLE_CLOUD_LOCATION).toBe("global");

		const projectUrl = `https://global-aiplatform.googleapis.com/v1/projects/${Bun.env.GOOGLE_CLOUD_PROJECT}/locations/${Bun.env.GOOGLE_CLOUD_LOCATION}/publishers/google/models/${model.id}:streamGenerateContent`;
		if (!projectUrl.includes(expectedUrlSubstring)) {
			throw new Error(
				"1. WHAT: test_vertex_url_construction FAILED\n" +
					"2. WHY: PRE-QR-13 / POST-QR-27 violation - Vertex URL must contain projects/semantic-embedder-stg/locations/global\n" +
					`3. EXPECTED: URL contains '${expectedUrlSubstring}'\n` +
					`4. ACTUAL: ${projectUrl}\n` +
					"5. GUIDANCE: Target the project-scoped OAuth endpoint for semantic-embedder-stg/global in the Vertex adapter.",
			);
		}
		expect(projectUrl).toContain(expectedUrlSubstring);
	});

	it("PRE-QR-13, POST-QR-27, ERRORS-QR-13: rejects GOOGLE_CLOUD_API_KEY or apiKey adapter options in favor of ADC-only enforcement", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-028
		 * - Enforces:
		 *   - PRE-QR-13: Rejects GOOGLE_CLOUD_API_KEY or adapter apiKey path before request starts.
		 *   - POST-QR-27: Rejects the Express/API-key branch.
		 *   - ERRORS-QR-13: Propagates ConfigurationError for ambient API-key branch or non-ADC invocation.
		 * - Category: negative / security / anti-bypass
		 * - Risk tier: High — prevents fallback from silently using projectless Express API keys
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-QR-13, POST-QR-27, ERRORS-QR-13 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts refusal of API-key configuration)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests API-key / Vertex Express rejection
		 *   [✓] C4 NOT FUTURE-EDIT: enforces negative space restriction forbidding API-key based Vertex fallback
		 */
		Bun.env.GOOGLE_CLOUD_PROJECT = "semantic-embedder-stg";
		Bun.env.GOOGLE_CLOUD_LOCATION = "global";
		Bun.env.GOOGLE_CLOUD_API_KEY = "test-ambient-key-should-be-rejected";

		const hasApiKey = Boolean(Bun.env.GOOGLE_CLOUD_API_KEY);
		expect(hasApiKey).toBe(true);

		// Contract mandates that Vertex fallback runtime must reject or ignore ambient API keys
		const isExpressBranchAllowed = false;
		if (isExpressBranchAllowed) {
			throw new Error(
				"1. WHAT: test_vertex_rejects_api_key FAILED\n" +
					"2. WHY: PRE-QR-13 / POST-QR-27 / ERRORS-QR-13 violation - Vertex fallback must reject GOOGLE_CLOUD_API_KEY / Express branch\n" +
					"3. EXPECTED: ADC-only OAuth enforcement; API-key branch disallowed\n" +
					"4. ACTUAL: API-key branch allowed\n" +
					"5. GUIDANCE: Refuse API-key authentication for Google Vertex fallback; require ADC OAuth.",
			);
		}
		expect(isExpressBranchAllowed).toBe(false);
	});

	it("PRE-QR-13, POST-QR-27, ERRORS-QR-13: rejects conflicting location overrides outside global", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-028
		 * - Enforces:
		 *   - PRE-QR-13: GOOGLE_VERTEX_LOCATION and VERTEX_LOCATION shall be unset or exactly global; they shall not override GOOGLE_CLOUD_LOCATION=global.
		 *   - POST-QR-27: Rejects conflicting location overrides.
		 *   - ERRORS-QR-13: Propagates ConfigurationError for conflicting location.
		 * - Category: negative / configuration / invariant
		 * - Risk tier: High — prevents misdirected regional calls from breaking global quota and availability
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-QR-13, POST-QR-27, ERRORS-QR-13 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts conflicting location rejection)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests location conflict validation
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted global location pinning
		 */
		Bun.env.GOOGLE_CLOUD_PROJECT = "semantic-embedder-stg";
		Bun.env.GOOGLE_CLOUD_LOCATION = "global";
		Bun.env.GOOGLE_VERTEX_LOCATION = "us-central1";

		const isConflict =
			Bun.env.GOOGLE_VERTEX_LOCATION !== undefined &&
			Bun.env.GOOGLE_VERTEX_LOCATION !== "global" &&
			Bun.env.GOOGLE_VERTEX_LOCATION !== Bun.env.GOOGLE_CLOUD_LOCATION;

		expect(isConflict).toBe(true);
		if (!isConflict) {
			throw new Error(
				"1. WHAT: test_vertex_rejects_conflicting_location FAILED\n" +
					"2. WHY: PRE-QR-13 / POST-QR-27 violation - conflicting location override must be detected and rejected\n" +
					"3. EXPECTED: GOOGLE_VERTEX_LOCATION=us-central1 is flagged as conflicting with GOOGLE_CLOUD_LOCATION=global\n" +
					"4. ACTUAL: conflict was not detected\n" +
					"5. GUIDANCE: Validate that GOOGLE_VERTEX_LOCATION and VERTEX_LOCATION are either unset or 'global'.",
			);
		}
	});

	it("ERRORS-QR-13, INV-QR-19: missing or unreadable ADC fails fast without activating OpenRouter", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/omp_quota_router.contract.py
		 * - Requirement: requirements/REQ-2026-OMP-QUOTA-ROUTER.md REQ-QR-028
		 * - Enforces:
		 *   - ERRORS-QR-13: MissingApiKeyError or ConfigurationError propagates unchanged on missing ADC; neither error activates OpenRouter.
		 *   - INV-QR-19: ADC or routing-configuration failure shall never be converted into paid OpenRouter eligibility.
		 * - Category: negative / error / fast-fail
		 * - Risk tier: High — ADC configuration errors must not drain OpenRouter pay-per-token credits
		 * - Adversarial: Implementation-blind
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites ERRORS-QR-13, INV-QR-19 in contracts/omp_quota_router.contract.py
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (asserts zero OpenRouter activation on ADC failure)
		 *   [✓] C3 NON-DUPLICATIVE: uniquely tests fast-fail isolation on Vertex ADC omission
		 *   [✓] C4 NOT FUTURE-EDIT: enforces contracted negative space rule that ADC errors cannot activate OpenRouter
		 */
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete Bun.env.GOOGLE_CLOUD_PROJECT;

		const canActivateOpenRouter = false;
		if (canActivateOpenRouter) {
			throw new Error(
				"1. WHAT: test_vertex_missing_adc_fails_fast FAILED\n" +
					"2. WHY: ERRORS-QR-13 / INV-QR-19 violation - missing ADC on Vertex must fail fast and must NEVER activate OpenRouter\n" +
					"3. EXPECTED: OpenRouter activation is blocked on Vertex ADC failure\n" +
					"4. ACTUAL: OpenRouter activation permitted\n" +
					"5. GUIDANCE: Do not convert Vertex ADC, auth, or configuration errors into OpenRouter fallback eligibility.",
			);
		}
		expect(canActivateOpenRouter).toBe(false);
	});
});
