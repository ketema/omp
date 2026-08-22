// SPDX-License-Identifier: LicenseRef-CCABDD-Proprietary
// packages/rlm/contracts/rlm_env_parity.contract.ts
//
// Authoritative behavioral contract for RLM kernel environment parity (CL11).
// Defines the Safe Shell Allowlist, internal overrides, and transport spawn handoff.

export const FALLBACK_POSIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin" as const;

/** Safe non-credential shell environment variables passed to the kernel */
export const SAFE_SHELL_ENV_KEYS: readonly string[] = Object.freeze([
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TERM",
]);

export class KernelEnvironmentError extends Error {
	readonly clauseId: string;
	constructor(message: string, clauseId: string) {
		super(`${clauseId}: ${message}`);
		this.name = "KernelEnvironmentError";
		this.clauseId = clauseId;
	}
}

export interface KernelSessionInput {
	readonly depth: number;
	readonly maxDepth: number;
	readonly sessionDir: string;
	readonly harnessDir: string;
	readonly globalHarnessDir: string;
	readonly agentDir: string;
}

export interface KernelCapsInput {
	readonly maxOutputChars: number;
	readonly snapshotMaxBytes: number;
}

/** Pure validator for PRE-ENV-01: session and caps are valid objects */
export function validateKernelInputs(session: KernelSessionInput, caps: KernelCapsInput, hostEnv?: Record<string, string | undefined>): void {
	if (!session || typeof session !== "object") {
		throw new KernelEnvironmentError("session must be a valid object", "PRE-ENV-01");
	}
	if (!caps || typeof caps !== "object") {
		throw new KernelEnvironmentError("caps must be a valid object", "PRE-ENV-01");
	}
}

/** Pure validator for POST-ENV-01 / POST-ENV-02: environment contains non-empty PATH */
export function validateKernelEnvOutput(env: Record<string, string>): void {
	if (!env.PATH || typeof env.PATH !== "string" || env.PATH.trim() === "") {
		throw new KernelEnvironmentError("PATH must be non-empty string", "POST-ENV-01");
	}
	if (!env.RLM_DEPTH || !env.RLM_MAX_DEPTH || !env.RLM_SESSION_DIR) {
		throw new KernelEnvironmentError("RLM_* internal variables must be present", "POST-ENV-03");
	}
}

export interface ContractClause {
	readonly id: string;
	readonly description: string;
	readonly verification: "test" | "execution" | "tool";
}

export const CONTRACT_RLM_ENV_PARITY: Readonly<Record<string, ContractClause>> = Object.freeze({
	"PRE-ENV-01": {
		id: "PRE-ENV-01",
		description: "session and caps must be valid non-null objects",
		verification: "test",
	},
	"POST-ENV-01": {
		id: "POST-ENV-01",
		description: "env inherits safe shell variables (PATH, HOME, SHELL, USER, TMPDIR, etc.) from hostEnv",
		verification: "test",
	},
	"POST-ENV-02": {
		id: "POST-ENV-02",
		description: "FALLBACK_POSIX_PATH is assigned if host PATH is undefined or empty",
		verification: "test",
	},
	"POST-ENV-03": {
		id: "POST-ENV-03",
		description: "internal RLM_* variables strictly override colliding host environment keys",
		verification: "test",
	},
	"INV-ENV-01": {
		id: "INV-ENV-01",
		description: "PATH in returned dictionary is always a non-empty string",
		verification: "test",
	},
	"INV-ENV-02": {
		id: "INV-ENV-02",
		description: "internal RLM_* variables take strict precedence over colliding keys",
		verification: "test",
	},
	"SEQ-ENV-01": {
		id: "SEQ-ENV-01",
		description: "RlmHost.start() calls buildKernelEnv(session, caps, hostEnv) before KernelTransport spawn",
		verification: "test",
	},
	"SEQ-ENV-02": {
		id: "SEQ-ENV-02",
		description: "createTransport receives buildKernelEnv output and passes it unchanged to spawnFn({ env })",
		verification: "test",
	},
	"ERRORS-ENV-01": {
		id: "ERRORS-ENV-01",
		description: "throws KernelEnvironmentError with clauseId PRE-ENV-01 on null/invalid session or caps",
		verification: "test",
	},
	"FORBIDDEN-ENV-01": {
		id: "FORBIDDEN-ENV-01",
		description: "buildKernelEnv shall not mutate the global host process.env",
		verification: "test",
	},
});
