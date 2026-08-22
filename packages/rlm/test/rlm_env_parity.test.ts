// SPDX-License-Identifier: LicenseRef-CCABDD-Proprietary
// packages/rlm/test/rlm_env_parity.test.ts
//
// CCABDD M4.2 RED PHASE — GH ketema/omp#8, Slice 1 (RLM shell environment parity).
// Author: ccabdd-test-writer. Structurally BLIND to packages/rlm/src/* content —
// only the module paths below were read (via package.json "exports", which is
// package metadata, not implementation source).
//
// ===========================================================================
// CONTRACT AUTHORITY RECORD (CL11-C)
// ===========================================================================
// File: packages/rlm/contracts/rlm_env_parity.contract.ts
// Authority: singular source for RLM kernel environment parity behavior.
// PRE clauses:       1  (PRE-ENV-01)
// POST clauses:      3  (POST-ENV-01, POST-ENV-02, POST-ENV-03)
// INV clauses:       2  (INV-ENV-01, INV-ENV-02)
// SEQ clauses:       2  (SEQ-ENV-01, SEQ-ENV-02)
// ERRORS clauses:    1  (ERRORS-ENV-01)
// FORBIDDEN clauses: 1  (FORBIDDEN-ENV-01)
//
// KNOWN DRIFT (reported, not silently resolved): the coordinator's task
// message enumerated clause IDs (PRE-ENV-02, POST-ENV-04, POST-ENV-05,
// ERR-ENV-01, ERR-ENV-02, and alternate meanings for INV-ENV-01/02) that do
// NOT exist verbatim in the authoritative contract file above. Per the
// Four-Criteria Test Validity Gate, Criterion 1 (VALID), a clause ID must
// exist in contracts/ at audit time — none of those five IDs do, and the
// contract's actual INV-ENV-01/02 text differs from the coordinator's
// paraphrase. This file cites ONLY the ten clause IDs that exist in
// CONTRACT_RLM_ENV_PARITY above (verified verbatim, see clause registry at
// packages/rlm/contracts/rlm_env_parity.contract.ts:71-121). The plan file
// (plans/rlm_shell_parity.plan.yml) independently lists the same ten IDs,
// corroborating the contract over the task message. Credential isolation
// and RLM_* session/caps injection — behaviors the coordinator described
// under invented IDs — ARE genuinely contracted, and are tested below under
// their real IDs: POST-ENV-01 (allowlist exclusion) and POST-ENV-03
// (RLM_* injection), respectively.
//
// ===========================================================================
// STRUCTURE
// ===========================================================================
// Section A — CONTRACT VERIFICATION (NOT RED): exercises the contract file's
//   OWN runtime validators (validateKernelInputs, validateKernelEnvOutput).
//   These pass today because the contract file already exists. They prove
//   the contract is enforceable but do NOT satisfy the RED completion gate.
// Section B — RED PHASE: exercises buildKernelEnv, the IMPLEMENTATION
//   artifact (packages/rlm/src/bootstrap.ts, not yet written). MUST fail.
// Section C — RED PHASE (SEQ): exercises the integration wiring
//   (RlmHost.start() from bootstrap.ts, createTransport() from
//   transport.ts). MUST fail.
//
// Sections B/C resolve the implementation via dynamic import() behind small
// getX() helpers instead of static top-level imports. Reason: a static
// `import { buildKernelEnv } from "../src/bootstrap"` for a not-yet-existing
// export throws a module-level SyntaxError that aborts the ENTIRE test
// file (including Section A, which must independently pass today). The
// getX() helpers isolate that failure to the individual RED test that
// needs the missing symbol, with a message naming exactly which export is
// absent — still a legitimate "implementation-missing" RED failure.
//
// IMPORT / SHAPE ASSUMPTIONS (flag to coordinator before GREEN if wrong):
//   - `buildKernelEnv` and `RlmHost` are exported from "../src/bootstrap"
//     (file location confirmed via package.json exports["./bootstrap"];
//     symbol names taken from REQ-2026-RLM-SHELL-PARITY §3.5/§6, which name
//     `buildKernelEnv` and `RlmHost.start()` explicitly).
//   - `createTransport` is exported from "../src/transport" (file location
//     confirmed via package.json exports["./transport"]; symbol name taken
//     from REQ-2026-RLM-SHELL-PARITY §3.5 SEQ-2, which names `createTransport()`
//     and the terminal call `spawnFn(interpreter, args, { env })` explicitly).
//   - `spawnFn` is assumed constructor-injectable on `RlmHost`'s options
//     object (single opts arg). `createTransport` uses a two-argument DI
//     shape agreed with the coordinator: createTransport(opts, { spawn })
//     — the first arg carries transport config (interpreter/args/env), the
//     second carries only the injected spawn double, keeping config and
//     test seams separated. SEQ tests MUST inject doubles at construction
//     time (SEQ Test Self-Check) and `spawnFn`/`spawn` is the only named
//     seam the requirements manifest gives for observing the terminal
//     subprocess call. If the real DI shape differs, Section C tests will
//     fail with a shape/type mismatch rather than a clean "export missing"
//     error — still a valid RED failure (implementation absent), but the
//     coordinator should confirm the DI contract before GREEN.
//
// FOUR-CRITERIA TEST VALIDITY GATE — applied to every test below:
//   C1 VALID: cites a clause ID present in CONTRACT_RLM_ENV_PARITY today.
//   C2 VALUABLE: fails the "can impl-wrong still pass?" question (exact
//     values / exact call args asserted, never existence-only or type-only).
//   C3 NON-DUPLICATIVE: no two tests assert the same observable on the same
//     input-equivalence class through the same surface.
//   C4 NOT FUTURE-EDIT THEATER: every assertion binds to a mechanism the
//     contract already describes (allowlist filtering, fallback, RLM_*
//     precedence, non-mutation) — none manufacture a hypothetical
//     uncontracted restriction.

import { describe, expect, it, mock } from "bun:test";
import {
	CONTRACT_RLM_ENV_PARITY,
	FALLBACK_POSIX_PATH,
	type KernelCapsInput,
	KernelEnvironmentError,
	type KernelSessionInput,
	SAFE_SHELL_ENV_KEYS,
	validateKernelEnvOutput,
	validateKernelInputs,
} from "../contracts/rlm_env_parity.contract";

// ---------------------------------------------------------------------------
// Object Mother — produces a contract-valid session/caps pair, overridable
// per test so each ARRANGE block stays readable in place (DAMP).
// ---------------------------------------------------------------------------

function makeValidSession(overrides: Partial<KernelSessionInput> = {}): KernelSessionInput {
	return {
		depth: 0,
		maxDepth: 4,
		sessionDir: "/tmp/rlm-session-mother",
		harnessDir: "/tmp/rlm-harness-mother",
		globalHarnessDir: "/tmp/rlm-global-harness-mother",
		agentDir: "/tmp/rlm-agent-mother",
		...overrides,
	};
}

function makeValidCaps(overrides: Partial<KernelCapsInput> = {}): KernelCapsInput {
	return {
		maxOutputChars: 20000,
		snapshotMaxBytes: 1048576,
		...overrides,
	};
}

const CREDENTIAL_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"] as const;

// ---------------------------------------------------------------------------
// Implementation resolution (Sections B/C only) — see "STRUCTURE" note above.
// ---------------------------------------------------------------------------

type BuildKernelEnvFn = (
	session: KernelSessionInput,
	caps: KernelCapsInput,
	hostEnv?: Record<string, string | undefined>,
) => Record<string, string>;

// Minimal double for the RlmTransportProcess DI seam: only the members
// RlmHost.start()/createTransport().start() touch are stubbed so the SEQ
// tests don't throw on missing event-listener registration. Shape is
// test-local (not imported from src) to preserve implementation
// blindness — it mirrors what SEQ-ENV-01/02 require the returned process
// to expose, not a copy of src/transport.ts's declaration.
type MockTransportProcess = {
	pid: number;
	onStdout: (cb: (line: string) => void) => () => void;
	onStderr: () => () => void;
	onExit: () => () => void;
	kill: () => void;
	stdin: { write: (chunk: string) => boolean };
};

function makeMockTransportProcess(pid: number): MockTransportProcess {
	return {
		pid,
		// SEQ-ENV-02: transport.start() awaits a readiness handshake before resolving, so the
		// mock must emit a readiness frame on the first registered stdout listener (queued as a
		// microtask so the listener is registered — via transport.start()'s call to onStdout —
		// before delivery, mirroring the real subprocess's async stdout stream).
		onStdout: (cb: (line: string) => void) => {
			queueMicrotask(() => {
				cb(JSON.stringify({ type: "ready", protocol: 1, pyVersion: "3.11" }));
			});
			return () => {};
		},
		onStderr: () => () => {},
		onExit: () => () => {},
		kill: () => {},
		stdin: { write: () => true },
	};
}

type SpawnFn = (interpreter: string, args: string[], opts: { env: Record<string, string> }) => MockTransportProcess;

type RlmHostCtor = new (opts: {
	session: KernelSessionInput;
	caps: KernelCapsInput;
	hostEnv?: Record<string, string | undefined>;
	spawnFn: SpawnFn;
}) => { start(): Promise<void> };

type CreateTransportFn = (
	opts: {
		interpreter: string;
		args: string[];
		env: Record<string, string>;
	},
	deps: { spawn: SpawnFn },
) => { start(): Promise<void> };

// Exception (ts-no-dynamic-import): these three getX() functions are DI/test
// seams that intentionally exercise a module-loading boundary — the whole
// point of RED phase is that the named export does not exist yet, so a
// static `import { buildKernelEnv } from "../src/bootstrap"` would throw a
// module-level SyntaxError and abort every test in this file, including the
// already-passing Section A contract-verification tests (see "STRUCTURE"
// note above). Each getX() is called from 2+ test bodies, satisfying the
// tiny-function exception for a shared DI boundary.

async function getBuildKernelEnv(): Promise<BuildKernelEnvFn> {
	const bootstrap = (await import("../src/bootstrap")) as unknown as Record<string, unknown>;
	const fn = bootstrap.buildKernelEnv;
	if (typeof fn !== "function") {
		throw new Error(
			"RED (PRE-ENV-01/POST-ENV-*/INV-ENV-*/ERRORS-ENV-01/FORBIDDEN-ENV-01): " +
				'packages/rlm/src/bootstrap.ts does not export a "buildKernelEnv" function yet.',
		);
	}
	// Boundary cast: runtime shape verified above; static signature is the GREEN target.
	return fn as unknown as BuildKernelEnvFn;
}

async function getRlmHost(): Promise<RlmHostCtor> {
	const bootstrap = (await import("../src/bootstrap")) as unknown as Record<string, unknown>;
	const ctor = bootstrap.RlmHost;
	if (typeof ctor !== "function") {
		throw new Error('RED (SEQ-ENV-01): packages/rlm/src/bootstrap.ts does not export an "RlmHost" class yet.');
	}
	return ctor as unknown as RlmHostCtor;
}

async function getCreateTransport(): Promise<CreateTransportFn> {
	const transport = (await import("../src/transport")) as unknown as Record<string, unknown>;
	const fn = transport.createTransport;
	if (typeof fn !== "function") {
		throw new Error(
			'RED (SEQ-ENV-02): packages/rlm/src/transport.ts does not export a "createTransport" function yet.',
		);
	}
	return fn as unknown as CreateTransportFn;
}

// Exception (ts-no-dynamic-import): same DI/test-seam rationale as the three
// getX() helpers above — "KernelEnvironmentError" does not exist on
// src/bootstrap.ts yet, so a static `import { KernelEnvironmentError } from
// "../src/bootstrap"` would throw a module-level SyntaxError and abort this
// entire test file, including the already-passing Section A tests.
async function getImplKernelEnvironmentError(): Promise<new (...args: never[]) => Error> {
	const bootstrap = (await import("../src/bootstrap")) as unknown as Record<string, unknown>;
	const ctor = bootstrap.KernelEnvironmentError;
	if (typeof ctor !== "function") {
		throw new Error(
			"RED (ERRORS-ENV-01, CL11-F bridge): packages/rlm/src/bootstrap.ts does not export a " +
				'"KernelEnvironmentError" constructor yet.',
		);
	}
	// Boundary cast: runtime shape verified above; the CL11-F identity assertion in
	// the ERRORS-ENV-01 tests proves this is the contract's class, not a duplicate.
	return ctor as unknown as new (
		...args: never[]
	) => Error;
}

// ===========================================================================
// SECTION A — CONTRACT VERIFICATION (NOT RED)
// These exercise packages/rlm/contracts/rlm_env_parity.contract.ts directly.
// They pass today. They do NOT count toward the RED completion gate.
// ===========================================================================

describe("CONTRACT VERIFICATION (not RED) — validateKernelInputs", () => {
	it("contract_pre_env_01_valid_session_and_caps_do_not_throw", () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01 | Category: positive | Risk: Low
		const session = makeValidSession();
		const caps = makeValidCaps();
		expect(() => validateKernelInputs(session, caps)).not.toThrow();
	});

	it("contract_pre_env_01_null_session_throws_kernel_environment_error", () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01 | Category: negative | Risk: Medium
		const caps = makeValidCaps();
		let caught: unknown;
		try {
			validateKernelInputs(null as unknown as KernelSessionInput, caps);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(KernelEnvironmentError);
		expect((caught as KernelEnvironmentError).clauseId).toBe(
			"PRE-ENV-01",
			`PRE-ENV-01 violation: null session must raise clauseId "PRE-ENV-01"\n` +
				`EXPECTED: clauseId === "PRE-ENV-01"\n` +
				`ACTUAL: clauseId === ${JSON.stringify((caught as KernelEnvironmentError)?.clauseId)}\n` +
				`GUIDANCE: invalid session must be reported as PRE-ENV-01, not silently coerced`,
		);
	});

	it("contract_pre_env_01_string_session_throws", () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01 | Category: negative | Risk: Medium
		const caps = makeValidCaps();
		expect(() => validateKernelInputs("not-a-session" as unknown as KernelSessionInput, caps)).toThrow(
			KernelEnvironmentError,
		);
	});

	it("contract_pre_env_01_null_caps_throws", () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01 | Category: negative | Risk: Medium
		const session = makeValidSession();
		let caught: unknown;
		try {
			validateKernelInputs(session, null as unknown as KernelCapsInput);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(KernelEnvironmentError);
		expect((caught as KernelEnvironmentError).clauseId).toBe(
			"PRE-ENV-01",
			`PRE-ENV-01 violation: null caps must raise clauseId "PRE-ENV-01"\n` +
				`EXPECTED: clauseId === "PRE-ENV-01"\n` +
				`ACTUAL: clauseId === ${JSON.stringify((caught as KernelEnvironmentError)?.clauseId)}\n` +
				`GUIDANCE: invalid caps must be reported as PRE-ENV-01, not silently coerced`,
		);
	});

	it("contract_pre_env_01_numeric_caps_throws", () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01 | Category: boundary | Risk: Medium
		const session = makeValidSession();
		expect(() => validateKernelInputs(session, 42 as unknown as KernelCapsInput)).toThrow(KernelEnvironmentError);
	});
});

describe("CONTRACT VERIFICATION (not RED) — validateKernelEnvOutput", () => {
	it("contract_post_env_01_present_non_empty_path_does_not_throw", () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-01 | Category: positive | Risk: Low
		expect(() =>
			validateKernelEnvOutput({
				PATH: "/usr/bin:/bin",
				RLM_DEPTH: "0",
				RLM_MAX_DEPTH: "4",
				RLM_SESSION_DIR: "/tmp",
			}),
		).not.toThrow();
	});

	it("contract_post_env_01_missing_path_throws_with_clause_id", () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-01 | Category: negative | Risk: High
		let caught: unknown;
		try {
			validateKernelEnvOutput({ RLM_DEPTH: "0", RLM_MAX_DEPTH: "4", RLM_SESSION_DIR: "/tmp" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(KernelEnvironmentError);
		expect((caught as KernelEnvironmentError).clauseId).toBe(
			"POST-ENV-01",
			`POST-ENV-01 violation: missing PATH must raise clauseId "POST-ENV-01"\n` +
				`EXPECTED: clauseId === "POST-ENV-01"\n` +
				`ACTUAL: clauseId === ${JSON.stringify((caught as KernelEnvironmentError)?.clauseId)}\n` +
				`GUIDANCE: absent PATH must be flagged as a POST-ENV-01 violation`,
		);
	});

	it("contract_post_env_01_whitespace_only_path_throws", () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-01 | Category: boundary | Risk: High
		expect(() =>
			validateKernelEnvOutput({ PATH: "   ", RLM_DEPTH: "0", RLM_MAX_DEPTH: "4", RLM_SESSION_DIR: "/tmp" }),
		).toThrow(KernelEnvironmentError);
	});

	it("contract_post_env_03_missing_rlm_star_vars_throws_with_clause_id", () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-03 | Category: negative | Risk: High
		let caught: unknown;
		try {
			validateKernelEnvOutput({ PATH: "/usr/bin" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(KernelEnvironmentError);
		expect((caught as KernelEnvironmentError).clauseId).toBe(
			"POST-ENV-03",
			`POST-ENV-03 violation: missing RLM_* vars must raise clauseId "POST-ENV-03"\n` +
				`EXPECTED: clauseId === "POST-ENV-03"\n` +
				`ACTUAL: clauseId === ${JSON.stringify((caught as KernelEnvironmentError)?.clauseId)}\n` +
				`GUIDANCE: absent RLM_DEPTH/RLM_MAX_DEPTH/RLM_SESSION_DIR must be flagged as POST-ENV-03`,
		);
	});
});

// ===========================================================================
// SECTION B — RED PHASE: buildKernelEnv (packages/rlm/src/bootstrap.ts)
// These MUST fail until GREEN implements buildKernelEnv.
// ===========================================================================

describe("RED — buildKernelEnv PRE-ENV-01 / ERRORS-ENV-01", () => {
	it("red_pre_env_01_valid_inputs_return_plain_string_dictionary", async () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01 | Category: positive | Risk: Medium
		// Adversarial: implementation-blind — invokes buildKernelEnv as a black box.
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const env = buildKernelEnv(session, caps, { PATH: "/usr/bin:/bin" });
		expect(typeof env).toBe(
			"object",
			`PRE-ENV-01 violation: valid inputs must not throw and must yield an object\n` +
				`EXPECTED: typeof env === "object"\n` +
				`ACTUAL: typeof env === ${JSON.stringify(typeof env)}\n` +
				`GUIDANCE: satisfying PRE-ENV-01 must produce a usable environment dictionary`,
		);
		for (const [key, value] of Object.entries(env)) {
			expect(typeof value).toBe(
				"string",
				`PRE-ENV-01 violation: every environment value must be a plain string\n` +
					`EXPECTED: typeof env["${key}"] === "string"\n` +
					`ACTUAL: typeof env["${key}"] === ${JSON.stringify(typeof value)}\n` +
					`GUIDANCE: buildKernelEnv must coerce every value to string before returning`,
			);
		}
	});

	it("red_pre_env_01_and_errors_env_01_null_session_throws_kernel_environment_error", async () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01, ERRORS-ENV-01 | Category: error | Risk: Medium
		// CL11-F (Contract-Implementation Independence): bootstrap.ts must NOT import from the
		// contract file, so ImplKernelEnvironmentError and the contract's KernelEnvironmentError are
		// independently declared classes with no JS reference equality. Verified structurally and
		// behaviorally below (instanceof the impl's own class, `.name`, `.clauseId`) instead of via
		// `.toBe(KernelEnvironmentError)` referential identity, which CL11-F forbids by construction.
		const buildKernelEnv = await getBuildKernelEnv();
		const ImplKernelEnvironmentError = await getImplKernelEnvironmentError();
		const caps = makeValidCaps();
		let caught: unknown;
		try {
			buildKernelEnv(null as unknown as KernelSessionInput, caps, { PATH: "/usr/bin" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(
			ImplKernelEnvironmentError,
			`ERRORS-ENV-01 violation: invalid session must raise bootstrap.ts's exported KernelEnvironmentError\n` +
				`EXPECTED: instanceof bootstrap.ts's exported KernelEnvironmentError\n` +
				`ACTUAL: ${caught instanceof Error ? caught.constructor.name : JSON.stringify(caught)}\n` +
				`GUIDANCE: buildKernelEnv must call/re-throw the contract's KernelEnvironmentError on invalid session`,
		);
		expect((caught as { name?: unknown } | undefined)?.name).toBe(
			"KernelEnvironmentError",
			`ERRORS-ENV-01 violation (CL11-F structural check): thrown error's name must be "KernelEnvironmentError"\n` +
				`EXPECTED: name === "KernelEnvironmentError"\n` +
				`ACTUAL: name === ${JSON.stringify((caught as { name?: unknown } | undefined)?.name)}\n` +
				`GUIDANCE: bootstrap.ts's KernelEnvironmentError must set its .name to "KernelEnvironmentError"`,
		);
		expect((caught as KernelEnvironmentError).clauseId).toBe(
			"PRE-ENV-01",
			`ERRORS-ENV-01 violation: thrown error's clauseId must be "PRE-ENV-01"\n` +
				`EXPECTED: clauseId === "PRE-ENV-01"\n` +
				`ACTUAL: clauseId === ${JSON.stringify((caught as KernelEnvironmentError)?.clauseId)}\n` +
				`GUIDANCE: preserve the PRE-ENV-01 clauseId end-to-end through buildKernelEnv`,
		);
	});

	it("red_pre_env_01_and_errors_env_01_invalid_caps_throws_kernel_environment_error", async () => {
		// CONTRACT TRACEABILITY: Enforces PRE-ENV-01, ERRORS-ENV-01 | Category: error | Risk: Medium
		const buildKernelEnv = await getBuildKernelEnv();
		const ImplKernelEnvironmentError = await getImplKernelEnvironmentError();
		const session = makeValidSession();
		let caught: unknown;
		try {
			buildKernelEnv(session, "not-caps" as unknown as KernelCapsInput, { PATH: "/usr/bin" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(
			ImplKernelEnvironmentError,
			`ERRORS-ENV-01 violation: invalid caps must raise bootstrap.ts's exported KernelEnvironmentError\n` +
				`EXPECTED: instanceof bootstrap.ts's exported KernelEnvironmentError\n` +
				`ACTUAL: ${caught instanceof Error ? caught.constructor.name : JSON.stringify(caught)}\n` +
				`GUIDANCE: buildKernelEnv must call/re-throw the contract's KernelEnvironmentError on invalid caps`,
		);
		expect((caught as KernelEnvironmentError).clauseId).toBe(
			"PRE-ENV-01",
			`ERRORS-ENV-01 violation: thrown error's clauseId must be "PRE-ENV-01" for invalid caps\n` +
				`EXPECTED: clauseId === "PRE-ENV-01"\n` +
				`ACTUAL: clauseId === ${JSON.stringify((caught as KernelEnvironmentError)?.clauseId)}\n` +
				`GUIDANCE: invalid caps must raise the same PRE-ENV-01 clause as invalid session`,
		);
	});
});

describe("RED — buildKernelEnv POST-ENV-01 (safe shell allowlist)", () => {
	it("red_post_env_01_all_safe_shell_keys_pass_through_with_exact_values", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-01 | Category: positive | Risk: Medium
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const hostEnv: Record<string, string> = {};
		for (const key of SAFE_SHELL_ENV_KEYS) {
			hostEnv[key] = `sentinel-${key}-value`;
		}
		const env = buildKernelEnv(session, caps, hostEnv);
		for (const key of SAFE_SHELL_ENV_KEYS) {
			expect(env[key]).toBe(
				hostEnv[key],
				`POST-ENV-01 violation: safe shell key "${key}" must pass through unchanged\n` +
					`EXPECTED: env["${key}"] === ${JSON.stringify(hostEnv[key])}\n` +
					`ACTUAL: env["${key}"] === ${JSON.stringify(env[key])}\n` +
					`GUIDANCE: every SAFE_SHELL_ENV_KEYS entry present in hostEnv must be copied verbatim`,
			);
		}
	});

	it("red_post_env_01_credential_and_non_allowlisted_keys_are_excluded", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-01 | Category: negative (security) | Risk: High
		// Grounded in REQ-2026-RLM-SHELL-PARITY §5.5 Rejected Alternatives: unfiltered
		// process.env inheritance was explicitly rejected because it "[e]xposes raw
		// API keys and cloud tokens to model-generated code" — the allowlist's
		// defining property is that anything outside SAFE_SHELL_ENV_KEYS is dropped.
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const excludedKeys = [...CREDENTIAL_ENV_KEYS, "RLM_UNRELATED_CUSTOM_VAR"];
		const hostEnv: Record<string, string> = { PATH: "/usr/bin:/bin" };
		for (const key of excludedKeys) {
			hostEnv[key] = "leaked-secret-value";
		}
		const env = buildKernelEnv(session, caps, hostEnv);
		for (const key of excludedKeys) {
			expect(key in env).toBe(
				false,
				`POST-ENV-01 violation: non-allowlisted key "${key}" leaked into kernel environment\n` +
					`EXPECTED: "${key}" absent from returned environment (not in SAFE_SHELL_ENV_KEYS)\n` +
					`ACTUAL: env["${key}"] === ${JSON.stringify(env[key])}\n` +
					`GUIDANCE: buildKernelEnv must copy ONLY SAFE_SHELL_ENV_KEYS entries from hostEnv`,
			);
		}
	});
});

describe("RED — buildKernelEnv POST-ENV-02 / INV-ENV-01 (PATH fallback and non-emptiness)", () => {
	it("red_post_env_02_undefined_host_path_falls_back_to_fallback_posix_path", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-02 | Category: boundary | Risk: High
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const env = buildKernelEnv(session, caps, { HOME: "/home/user" });
		expect(env.PATH).toBe(
			FALLBACK_POSIX_PATH,
			`POST-ENV-02 violation: undefined host PATH must fall back to FALLBACK_POSIX_PATH\n` +
				`EXPECTED: env.PATH === ${JSON.stringify(FALLBACK_POSIX_PATH)}\n` +
				`ACTUAL: env.PATH === ${JSON.stringify(env.PATH)}\n` +
				`GUIDANCE: an absent host PATH must be replaced with the contract's FALLBACK_POSIX_PATH`,
		);
	});

	it("red_post_env_02_empty_string_host_path_falls_back_to_fallback_posix_path", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-02 | Category: boundary | Risk: High
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const env = buildKernelEnv(session, caps, { PATH: "" });
		expect(env.PATH).toBe(
			FALLBACK_POSIX_PATH,
			`POST-ENV-02 violation: empty-string host PATH must fall back to FALLBACK_POSIX_PATH\n` +
				`EXPECTED: env.PATH === ${JSON.stringify(FALLBACK_POSIX_PATH)}\n` +
				`ACTUAL: env.PATH === ${JSON.stringify(env.PATH)}\n` +
				`GUIDANCE: an empty host PATH is equivalent to an absent one and must also fall back`,
		);
	});

	it("red_inv_env_01_path_is_always_a_non_empty_string_across_host_variants", async () => {
		// CONTRACT TRACEABILITY: Enforces INV-ENV-01 | Category: invariant (property) | Risk: High
		// Distinct from POST-ENV-02 above: this checks the universal non-emptiness
		// guarantee across the whole input domain, not one specific fallback value.
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const hostEnvVariants: Array<Record<string, string | undefined>> = [
			{},
			{ PATH: undefined },
			{ PATH: "" },
			{ PATH: "/custom/bin:/opt/bin" },
		];
		for (const hostEnv of hostEnvVariants) {
			const env = buildKernelEnv(session, caps, hostEnv);
			expect(typeof env.PATH === "string" && env.PATH.length > 0).toBe(
				true,
				`WHAT: red_inv_env_01_path_is_always_a_non_empty_string_across_host_variants FAILED\n` +
					`WHY: INV-ENV-01 violation - PATH must always be a non-empty string\n` +
					`EXPECTED: typeof env.PATH === "string" && env.PATH.length > 0\n` +
					`ACTUAL: env.PATH === ${JSON.stringify(env.PATH)} for hostEnv ${JSON.stringify(hostEnv)}\n` +
					`GUIDANCE: no code path may return an empty, undefined, or missing PATH`,
			);
		}
	});
});

describe("RED — buildKernelEnv POST-ENV-03 (session + caps RLM_* injection)", () => {
	it("red_post_env_03_session_fields_inject_distinct_rlm_star_variables", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-03 | Category: positive | Risk: High
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession({
			depth: 2,
			maxDepth: 7,
			sessionDir: "/sentinel/session-dir",
			harnessDir: "/sentinel/harness-dir",
			globalHarnessDir: "/sentinel/global-harness-dir",
			agentDir: "/sentinel/agent-dir",
		});
		const caps = makeValidCaps();
		const env = buildKernelEnv(session, caps, { PATH: "/usr/bin" });
		const expected: Record<string, string> = {
			RLM_DEPTH: "2",
			RLM_MAX_DEPTH: "7",
			RLM_SESSION_DIR: "/sentinel/session-dir",
			RLM_HARNESS_DIR: "/sentinel/harness-dir",
			RLM_GLOBAL_HARNESS_DIR: "/sentinel/global-harness-dir",
			RLM_AGENT_DIR: "/sentinel/agent-dir",
		};
		for (const [key, value] of Object.entries(expected)) {
			expect(env[key]).toBe(
				value,
				`POST-ENV-03 violation: session field must inject "${key}"\n` +
					`EXPECTED: env["${key}"] === ${JSON.stringify(value)}\n` +
					`ACTUAL: env["${key}"] === ${JSON.stringify(env[key])}\n` +
					`GUIDANCE: each KernelSessionInput field must map to its distinct RLM_* variable`,
			);
		}
	});

	it("red_post_env_03_caps_fields_inject_distinct_rlm_star_variables", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-03 | Category: positive | Risk: High
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps({ maxOutputChars: 65536, snapshotMaxBytes: 999999 });
		const env = buildKernelEnv(session, caps, { PATH: "/usr/bin" });
		expect(env.RLM_MAX_OUTPUT_CHARS).toBe(
			"65536",
			`POST-ENV-03 violation: caps.maxOutputChars must inject RLM_MAX_OUTPUT_CHARS\n` +
				`EXPECTED: env.RLM_MAX_OUTPUT_CHARS === "65536"\n` +
				`ACTUAL: env.RLM_MAX_OUTPUT_CHARS === ${JSON.stringify(env.RLM_MAX_OUTPUT_CHARS)}\n` +
				`GUIDANCE: KernelCapsInput.maxOutputChars must map to RLM_MAX_OUTPUT_CHARS`,
		);
		expect(env.RLM_SNAPSHOT_MAX_BYTES).toBe(
			"999999",
			`POST-ENV-03 violation: caps.snapshotMaxBytes must inject RLM_SNAPSHOT_MAX_BYTES\n` +
				`EXPECTED: env.RLM_SNAPSHOT_MAX_BYTES === "999999"\n` +
				`ACTUAL: env.RLM_SNAPSHOT_MAX_BYTES === ${JSON.stringify(env.RLM_SNAPSHOT_MAX_BYTES)}\n` +
				`GUIDANCE: KernelCapsInput.snapshotMaxBytes must map to RLM_SNAPSHOT_MAX_BYTES`,
		);
	});

	it("red_post_env_03_zero_depth_is_not_dropped_by_falsy_coercion", async () => {
		// CONTRACT TRACEABILITY: Enforces POST-ENV-03 | Category: boundary | Risk: High
		// Adversarial: depth=0 is a plausible bug magnet for `if (session.depth)` guards.
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession({ depth: 0 });
		const caps = makeValidCaps();
		const env = buildKernelEnv(session, caps, { PATH: "/usr/bin" });
		expect(env.RLM_DEPTH).toBe(
			"0",
			`POST-ENV-03 violation: depth=0 must still inject RLM_DEPTH="0"\n` +
				`EXPECTED: env.RLM_DEPTH === "0"\n` +
				`ACTUAL: env.RLM_DEPTH === ${JSON.stringify(env.RLM_DEPTH)}\n` +
				`GUIDANCE: use presence/definedness checks, never truthiness, for numeric session fields`,
		);
	});
});

describe("RED — buildKernelEnv INV-ENV-02 (RLM_* strict precedence over collisions)", () => {
	it("red_inv_env_02_rlm_star_wins_over_colliding_host_keys_for_every_internal_variable", async () => {
		// CONTRACT TRACEABILITY: Enforces INV-ENV-02 | Category: invariant (property) | Risk: High
		// Property-based across the full RLM_* key domain, not just one sampled key —
		// distinct surface from POST-ENV-03 above, which only checks plain injection
		// without a colliding host value present.
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession({
			depth: 1,
			maxDepth: 3,
			sessionDir: "/real/session-dir",
			harnessDir: "/real/harness-dir",
			globalHarnessDir: "/real/global-harness-dir",
			agentDir: "/real/agent-dir",
		});
		const caps = makeValidCaps({ maxOutputChars: 111, snapshotMaxBytes: 222 });
		const expected: Record<string, string> = {
			RLM_DEPTH: "1",
			RLM_MAX_DEPTH: "3",
			RLM_SESSION_DIR: "/real/session-dir",
			RLM_HARNESS_DIR: "/real/harness-dir",
			RLM_GLOBAL_HARNESS_DIR: "/real/global-harness-dir",
			RLM_AGENT_DIR: "/real/agent-dir",
			RLM_MAX_OUTPUT_CHARS: "111",
			RLM_SNAPSHOT_MAX_BYTES: "222",
		};
		const hostEnv: Record<string, string> = { PATH: "/usr/bin" };
		for (const key of Object.keys(expected)) {
			hostEnv[key] = "HOST-COLLISION-SHOULD-NOT-WIN";
		}
		const env = buildKernelEnv(session, caps, hostEnv);
		for (const [key, value] of Object.entries(expected)) {
			expect(env[key]).toBe(
				value,
				`WHAT: red_inv_env_02_rlm_star_wins_over_colliding_host_keys_for_every_internal_variable FAILED\n` +
					`WHY: INV-ENV-02 violation - "${key}" must retain internal precedence over a colliding host key\n` +
					`EXPECTED: env["${key}"] === ${JSON.stringify(value)}\n` +
					`ACTUAL: env["${key}"] === ${JSON.stringify(env[key])}\n` +
					`GUIDANCE: internal RLM_* assignment must be applied AFTER copying host env, not before`,
			);
		}
	});
});

describe("RED — buildKernelEnv FORBIDDEN-ENV-01 (no host env mutation)", () => {
	it("red_forbidden_env_01_does_not_mutate_the_passed_hostenv_object", async () => {
		// CONTRACT TRACEABILITY: Enforces FORBIDDEN-ENV-01 | Category: negative-space | Risk: High
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const hostEnv: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/home/user" };
		const hostEnvSnapshot = JSON.stringify(hostEnv);
		buildKernelEnv(session, caps, hostEnv);
		expect(JSON.stringify(hostEnv)).toBe(
			hostEnvSnapshot,
			`FORBIDDEN-ENV-01 violation: the hostEnv argument object was mutated\n` +
				`EXPECTED: hostEnv unchanged after buildKernelEnv returns\n` +
				`ACTUAL: hostEnv === ${JSON.stringify(hostEnv)}\n` +
				`GUIDANCE: buildKernelEnv must copy hostEnv into a new object, never write back to it`,
		);
	});

	it("red_forbidden_env_01_does_not_mutate_the_global_process_env", async () => {
		// CONTRACT TRACEABILITY: Enforces FORBIDDEN-ENV-01 | Category: negative-space | Risk: High
		// Distinct surface from the test above: this guards the GLOBAL process.env,
		// not the local hostEnv argument — a caller could pass a snapshot copy of
		// process.env and a buggy implementation could still write to the real
		// process.env global directly.
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const processEnvKeysBefore = new Set(Object.keys(process.env));
		buildKernelEnv(session, caps, { ...process.env, PATH: process.env.PATH ?? "/usr/bin" });
		const leakedKeys = Object.keys(process.env).filter(k => !processEnvKeysBefore.has(k));
		expect(leakedKeys).toEqual(
			[],
			`FORBIDDEN-ENV-01 violation: buildKernelEnv must not write to the global process.env\n` +
				`EXPECTED: no new keys added to process.env\n` +
				`ACTUAL: leaked keys = ${JSON.stringify(leakedKeys)}\n` +
				`GUIDANCE: RLM_* variables belong only in the returned dictionary, never in process.env`,
		);
	});
});

// ===========================================================================
// SECTION C — RED PHASE (SEQ): integration wiring
// packages/rlm/src/bootstrap.ts (RlmHost.start()) and
// packages/rlm/src/transport.ts (createTransport()).
// These MUST fail until GREEN wires buildKernelEnv into the spawn path.
// ===========================================================================

describe("RED — SEQ-ENV-01 (RlmHost.start() invokes buildKernelEnv before transport spawn)", () => {
	it("red_seq_env_01_spawned_env_matches_build_kernel_env_pure_computation", async () => {
		// CONTRACT TRACEABILITY: Enforces SEQ-ENV-01 | Category: integration (SEQ) | Risk: High
		// SEQ Test Self-Check:
		//  [x] constructs the PARENT object (RlmHost) via its real constructor
		//  [x] verifies SEQ behavior through the parent's observable side effect
		//      (the env object actually delivered to spawnFn), not a direct call
		//      to buildKernelEnv
		//  [x] does not call any internal method directly
		//  [x] spawnFn is injected at construction time, never swapped afterward
		const RlmHost = await getRlmHost();
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession({ depth: 1, maxDepth: 5 });
		const caps = makeValidCaps();
		const hostEnv = { PATH: "/usr/bin:/bin", HOME: "/home/user" };
		const spawnFn = mock(() => makeMockTransportProcess(1234));

		const host = new RlmHost({ session, caps, hostEnv, spawnFn });
		await host.start();

		expect(spawnFn).toHaveBeenCalledTimes(
			1,
			`SEQ-ENV-01 violation: RlmHost.start() must trigger exactly one subprocess spawn\n` +
				`EXPECTED: spawnFn called exactly once\n` +
				`ACTUAL: called ${spawnFn.mock.calls.length} time(s)\n` +
				`GUIDANCE: RlmHost.start() must create exactly one kernel transport per call`,
		);

		const deliveredEnv = spawnFn.mock.calls[0]?.[2]?.env as Record<string, string> | undefined;
		const expectedEnv = buildKernelEnv(session, caps, hostEnv);
		expect(deliveredEnv).toEqual(
			expectedEnv,
			`SEQ-ENV-01 violation: env delivered to spawnFn must equal buildKernelEnv(session, caps, hostEnv)\n` +
				`EXPECTED: ${JSON.stringify(expectedEnv)}\n` +
				`ACTUAL: ${JSON.stringify(deliveredEnv)}\n` +
				`GUIDANCE: RlmHost.start() must call buildKernelEnv and pass its exact output onward`,
		);
	});
});

describe("RED — SEQ-ENV-02 (createTransport passes buildKernelEnv output unchanged to spawnFn)", () => {
	it("red_seq_env_02_transport_start_invokes_spawn_fn_with_env_unchanged", async () => {
		// CONTRACT TRACEABILITY: Enforces SEQ-ENV-02 | Category: integration (SEQ) | Risk: High
		// SEQ Test Self-Check:
		//  [x] constructs the PARENT object (the transport, via createTransport())
		//  [x] verifies SEQ behavior via the transport's own .start() lifecycle,
		//      not by calling spawnFn directly
		//  [x] spawnFn injected at construction time
		const createTransport = await getCreateTransport();
		const buildKernelEnv = await getBuildKernelEnv();
		const session = makeValidSession();
		const caps = makeValidCaps();
		const env = buildKernelEnv(session, caps, { PATH: "/usr/bin:/bin" });
		const spawnFn = mock(() => makeMockTransportProcess(5678));
		const interpreter = "python3";
		const args = ["-u", "-m", "omp_rlm_kernel"];

		const transport = createTransport({ interpreter, args, env }, { spawn: spawnFn });
		await transport.start();

		expect(spawnFn).toHaveBeenCalledTimes(
			1,
			`SEQ-ENV-02 violation: transport.start() must invoke spawnFn exactly once\n` +
				`EXPECTED: spawnFn called exactly once\n` +
				`ACTUAL: called ${spawnFn.mock.calls.length} time(s)\n` +
				`GUIDANCE: createTransport's returned transport must spawn its subprocess exactly once on start()`,
		);
		expect(spawnFn.mock.calls[0]?.[2]?.env).toEqual(
			env,
			`SEQ-ENV-02 violation: spawnFn must receive the exact env object from buildKernelEnv unchanged\n` +
				`EXPECTED: ${JSON.stringify(env)}\n` +
				`ACTUAL: ${JSON.stringify(spawnFn.mock.calls[0]?.[2]?.env)}\n` +
				`GUIDANCE: createTransport must forward the exact env object from buildKernelEnv without alteration`,
		);
	});
});

// ===========================================================================
// CLAUSE COVERAGE REPORT
// ===========================================================================
// PRE-ENV-01:       contract_pre_env_01_* (x5), red_pre_env_01_* (x3)          ✓
// POST-ENV-01:      contract_post_env_01_* (x3), red_post_env_01_* (x2)       ✓
// POST-ENV-02:      red_post_env_02_* (x2)                                    ✓
// POST-ENV-03:      contract_post_env_03_* (x1), red_post_env_03_* (x3)       ✓
// INV-ENV-01:       red_inv_env_01_* (x1, property across 4 host variants)    ✓
// INV-ENV-02:       red_inv_env_02_* (x1, property across 8 RLM_* keys)       ✓
// SEQ-ENV-01:       red_seq_env_01_* (x1, integration through RlmHost)        ✓
// SEQ-ENV-02:       red_seq_env_02_* (x1, integration through createTransport)✓
// ERRORS-ENV-01:    red_pre_env_01_and_errors_env_01_* (x2)                   ✓
// FORBIDDEN-ENV-01: red_forbidden_env_01_* (x2, arg + global-state surfaces)  ✓
// Referenced clause registry (all 10 IDs used above): CONTRACT_RLM_ENV_PARITY.
void CONTRACT_RLM_ENV_PARITY;
