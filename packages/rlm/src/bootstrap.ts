/**
 * RLM kernel environment bootstrap.
 *
 * Implements the contract at requirements/contracts/rlm-bootstrap.contract.ts.
 * All constants are redeclared independently (no import from the contract);
 * alignment tests import both sides and assert equality.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

// =============================================================================
// Constants (redeclared; aligned with contract BOOT_*)
// =============================================================================

export const SCHEMA_VERSION = 8;
export const PYTHON_VERSION = "3.11";
export const BASE_PACKAGES: readonly string[] = ["ipykernel", "rlm-runtime", "dill"];
export const EXTRAS_PACKAGES: readonly string[] = [
	"requests",
	"httpx",
	"pyyaml",
	"tomli",
	"python-dotenv",
	"pandas",
	"numpy",
	"scipy",
	"beautifulsoup4",
	"lxml",
	"pydantic",
	"tyro",
];
export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 100;
export const RUNTIME_IDENTITY_KIND = "sha256";

const MANIFEST_FILE = ".bootstrap-version";
const LOCK_FILE = ".bootstrap.lock";

const CRUD_METHODS: readonly string[] = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
];

const ENTRY_FIELDS: readonly string[] = [
	"id",
	"kind",
	"title",
	"content",
	"path",
	"scope",
	"reference",
	"arguments",
	"metadata",
	"source",
	"created_at",
	"updated_at",
	"version",
];

/** POST-BOOT-3: the probe a candidate interpreter must run. It imports
 * ipykernel and the rlm runtime, then reports the four readiness
 * dimensions the host evaluates. */
const READY_CHECK_PROBE = [
	"import ipykernel",
	"import rlm",
	"print('rlm_callable=' + str(callable(getattr(rlm, 'run', None))))",
	"print('background_absent=' + str(not hasattr(rlm, 'background')))",
	"print('crud=' + ','.join(m for m in [",
	...CRUD_METHODS.map(m => `    '${m}',`),
	"] if hasattr(getattr(rlm, 'harness', None), m)))",
	"print('entry_fields=' + ','.join(f for f in [",
	...ENTRY_FIELDS.map(f => `    '${f}',`),
	"] if f in rlm.HarnessEntry.__dataclass_fields__))",
].join("\n");

// =============================================================================
// Errors
// =============================================================================

export class RlmBootstrapError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RlmBootstrapError";
	}
}

export class UvMissingError extends RlmBootstrapError {
	constructor() {
		super("uv is required to set up the Python kernel");
		this.name = "UvMissingError";
	}
}

// =============================================================================
// Types
// =============================================================================

export interface InterpreterConfig {
	readonly pythonOverride?: string;
	readonly venvDir: string;
	readonly xdgDir: string;
}

export interface KernelSession {
	readonly sessionDir: string;
	readonly harnessDir: string;
	readonly globalHarnessDir: string;
	readonly agentDir: string;
	readonly depth: number;
	readonly maxDepth: number;
}

export interface KernelCaps {
	readonly maxOutputChars: number;
	readonly snapshotMaxBytes: number;
}

export interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface BootstrapDeps {
	readonly runner: { run(cmd: string, args: readonly string[]): Promise<RunResult> };
	exists(path: string): boolean;
}

export interface ManagedVenvDeps extends BootstrapDeps {
	readonly runtimeSources: Readonly<Record<string, string>>;
	readonly skills: readonly string[];
	/** When set, the rlm-runtime base package installs from this
	 * local package path instead of an index (the runtime is bundled with
	 * the repo, not published). */
	readonly runtimePackagePath?: string;
	readTextFile(path: string): string | null;
}

export interface BootstrapVersionManifest {
	readonly schema: number;
	readonly ipykernel: string;
	readonly runtime: string;
	readonly snapshot: string;
	readonly extraUvArgs: readonly string[];
	readonly pythonSkills: readonly string[];
	/** BOOT-V1: installed package set recorded for fast-path validation. */
	readonly packages?: readonly string[] | undefined;
}

interface LockFileContents {
	readonly pid: number;
	readonly acquiredAt: number;
}

// =============================================================================
// POST-BOOT-3 — ready-check evaluation over probe output
// =============================================================================

export function runReadyCheck(probeOutput: string): boolean {
	const lines = probeOutput
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	const field = (prefix: string): string[] | undefined => {
		const line = lines.find(l => l.startsWith(prefix));
		if (line === undefined) return undefined;
		return line
			.slice(prefix.length)
			.split(",")
			.map(s => s.trim())
			.filter(s => s.length > 0);
	};
	if (!lines.includes("rlm_callable=true")) return false;
	if (!lines.includes("background_absent=true")) return false;
	const crud = field("crud=");
	if (crud === undefined || !CRUD_METHODS.every(m => crud.includes(m))) return false;
	const entryFields = field("entry_fields=");
	if (entryFields === undefined || !ENTRY_FIELDS.every(f => entryFields.includes(f))) return false;
	return true;
}

// =============================================================================
// PRE-BOOT-1 — interpreter resolution with an evaluated probe
// =============================================================================

/** Runs the probe on a candidate; returns true only when the process
 * exited zero AND the evaluated output passed the ready check. Throws the
 * ipykernel-named error when the probe failed importing ipykernel. */
async function probeInterpreter(
	pythonPath: string,
	deps: BootstrapDeps,
	options: { nameOnIpykernelFailure?: string } = {},
): Promise<boolean> {
	const result = await deps.runner.run(pythonPath, ["-c", READY_CHECK_PROBE]);
	if (result.code !== 0) {
		if (result.stderr.includes("ipykernel")) {
			throw new RlmBootstrapError(
				`${options.nameOnIpykernelFailure ?? "Interpreter"} at ${pythonPath} failed readiness check: ipykernel not available`,
			);
		}
		return false;
	}
	return runReadyCheck(result.stdout);
}

export async function resolveInterpreter(config: InterpreterConfig, deps: BootstrapDeps): Promise<string> {
	// PRE-BOOT-1 + INV-BOOT-LIFETIME-1: the explicit override is first and
	// is ALWAYS validated — the probe runs wherever any venv exists or not
	if (config.pythonOverride !== undefined && config.pythonOverride !== "") {
		const override = config.pythonOverride;
		const admitted = await probeInterpreter(override, deps, {
			nameOnIpykernelFailure: "Override interpreter",
		});
		if (!admitted) {
			throw new RlmBootstrapError(
				`Override interpreter at ${override} failed the readiness check (evaluated probe output)`,
			);
		}
		return override;
	}

	const managedPython = join(config.venvDir, "bin", "python");
	if (deps.exists(managedPython)) {
		// A candidate that cannot even be probed (EACCES, arch mismatch) or is
		// rejected by the probe is demoted when a fallback exists; with no
		// fallback the failure errors loudly with this candidate named
		try {
			if (await probeInterpreter(managedPython, deps)) return managedPython;
		} catch (candidateError) {
			if (!deps.exists(join(config.xdgDir, "bin", "python"))) throw candidateError;
		}
	}

	const xdgPython = join(config.xdgDir, "bin", "python");
	if (deps.exists(xdgPython) && (await probeInterpreter(xdgPython, deps))) {
		return xdgPython;
	}

	throw new RlmBootstrapError(
		`No suitable interpreter found: managed venv (${config.venvDir}) and XDG fallback (${config.xdgDir}) missing or failed readiness`,
	);
}

// =============================================================================
// INV-BOOT-2 — bounded kernel env (exact set, cross-validated by SAFE-V1)
// =============================================================================

export function buildKernelEnv(session: KernelSession, caps: KernelCaps): Record<string, string> {
	return {
		RLM_DEPTH: String(session.depth),
		RLM_MAX_DEPTH: String(session.maxDepth),
		RLM_SESSION_DIR: session.sessionDir,
		RLM_HARNESS_STATE_DIR: session.harnessDir,
		RLM_GLOBAL_HARNESS_STATE_DIR: session.globalHarnessDir,
		OMP_RLM_AGENT_DIR: session.agentDir,
		RLM_MAX_OUTPUT_CHARS: String(caps.maxOutputChars),
		RLM_SNAPSHOT_MAX_BYTES: String(caps.snapshotMaxBytes),
	};
}

// =============================================================================
// Manifest
// =============================================================================

export function parseBootstrapManifest(text: string): BootstrapVersionManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new RlmBootstrapError("bootstrap manifest is not valid JSON", { cause });
	}
	const m = parsed as Partial<BootstrapVersionManifest> | null;
	if (
		m === null ||
		typeof m !== "object" ||
		m.schema !== SCHEMA_VERSION ||
		typeof m.ipykernel !== "string" ||
		typeof m.runtime !== "string" ||
		typeof m.snapshot !== "string" ||
		!Array.isArray(m.extraUvArgs) ||
		!Array.isArray(m.pythonSkills)
	) {
		throw new RlmBootstrapError(`bootstrap manifest must be schema ${SCHEMA_VERSION} with all fields`);
	}
	const manifest: BootstrapVersionManifest = {
		schema: m.schema,
		ipykernel: m.ipykernel,
		runtime: m.runtime,
		snapshot: m.snapshot,
		extraUvArgs: m.extraUvArgs,
		pythonSkills: m.pythonSkills,
		packages: Array.isArray(m.packages) ? m.packages : undefined,
	};
	return manifest;
}

// =============================================================================
// POST-BOOT-2 — runtime identity
// =============================================================================

export function runtimeIdentityHash(sources: Readonly<Record<string, string>>): string {
	const hash = createHash(RUNTIME_IDENTITY_KIND);
	for (const name of Object.keys(sources).sort()) {
		hash.update(name);
		hash.update("\0");
		hash.update(sources[name] ?? "");
		hash.update("\0");
	}
	return hash.digest("hex");
}

// =============================================================================
// INV-BOOT-1 — bootstrap lock
// =============================================================================

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		return true; // EPERM etc.: treat as alive — never steal an uncertain holder
	}
}

export interface BootstrapLock {
	release(): void;
}

export function acquireBootstrapLock(lockDir: string, clock: { now(): number }): BootstrapLock {
	const lockPath = join(lockDir, LOCK_FILE);
	fs.mkdirSync(lockDir, { recursive: true });

	// Atomic acquisition attempt: exclusive-create decides fresh races
	let handle: number;
	try {
		handle = fs.openSync(lockPath, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// An existing lock: apply holder semantics using CONTENT when
		// readable, and the file's mtime when not (a crash between create and
		// write, or a concurrent mid-write reader, must not enable an instant
		// steal)
		let existing: Partial<LockFileContents> | null = null;
		let stampSource: "content" | "mtime" = "content";
		try {
			existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockFileContents>;
		} catch {
			existing = null;
			stampSource = "mtime";
		}
		const pidIsLive = stampSource === "content" && typeof existing?.pid === "number" && isPidAlive(existing.pid);
		const stamp =
			stampSource === "content"
				? typeof existing?.acquiredAt === "number"
					? existing.acquiredAt
					: 0
				: Math.floor(fs.statSync(lockPath).mtimeMs);
		const age = clock.now() - stamp;
		if (pidIsLive) {
			// A live holder is never stolen, regardless of lock age (F-195)
			throw new RlmBootstrapError(`bootstrap lock held by live pid ${existing?.pid}`);
		}
		if (age < LOCK_STALE_MS) {
			// Dead or unreadable holder with a fresh stamp (covers cross-PID-
			// namespace views and mid-write crashes): block until stale
			throw new RlmBootstrapError(
				`bootstrap lock held by dead pid ${existing?.pid ?? "?"} (age ${age}ms < ${LOCK_STALE_MS}ms); retry after the stale threshold`,
			);
		}
		// Stale: atomic takeover — rename() replaces the stale lock in one
		// syscall. Two concurrent takeovers serialize at the filesystem: each
		// writes its unique temp then renames over the target; the loser's
		// rename lands on the winner's live lock and is detected on release
		// mismatch below. This is the classic atomic-replace lock promote.
		const unique = `${lockPath}.takeover-${process.pid}-${clock.now()}`;
		fs.writeFileSync(unique, JSON.stringify({ pid: process.pid, acquiredAt: clock.now() }));
		try {
			fs.renameSync(unique, lockPath);
		} catch (renameError) {
			try {
				fs.unlinkSync(unique);
			} catch {
				// temp already gone
			}
			throw new RlmBootstrapError("bootstrap lock takeover failed", { cause: renameError });
		}
		return {
			release() {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					// already removed — nothing to release
				}
			},
		};
	}
	fs.writeSync(handle, JSON.stringify({ pid: process.pid, acquiredAt: clock.now() }));
	fs.closeSync(handle);
	return {
		release() {
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// already removed — nothing to release
			}
		},
	};
}

// =============================================================================
// Managed venv bootstrap (POST-BOOT-1/2, ERRORS-BOOT-1/2, INV-BOOT-1)
// =============================================================================

function uvUnresolvable(result: RunResult): boolean {
	return result.code === 127 || /command not found|not found/i.test(result.stderr);
}

export interface ManagedVenvResult {
	readonly interpreterPath: string;
	readonly warnings: readonly string[];
}

export async function bootstrapManagedVenv(
	config: InterpreterConfig,
	deps: ManagedVenvDeps,
): Promise<ManagedVenvResult> {
	const lock = acquireBootstrapLock(config.venvDir, { now: () => Date.now() });
	try {
		const pythonPath = join(config.venvDir, "bin", "python");
		const manifestPath = join(config.venvDir, MANIFEST_FILE);
		const currentIdentity = runtimeIdentityHash(deps.runtimeSources);

		// POST-BOOT-2 + BOOT-V1: unchanged runtime identity AND a complete
		// recorded package set AND an existing interpreter skips install
		const manifestText = deps.readTextFile(manifestPath);
		if (manifestText !== null && deps.exists(pythonPath)) {
			try {
				const manifest = parseBootstrapManifest(manifestText);
				const required = [...BASE_PACKAGES, ...EXTRAS_PACKAGES];
				const recorded = manifest.packages ?? [];
				const packageSetComplete = required.every(p => recorded.includes(p));
				if (manifest.runtime === currentIdentity && packageSetComplete) {
					return { interpreterPath: pythonPath, warnings: [] };
				}
			} catch {
				// unparseable manifest: rebuild below
			}
		}

		// POST-BOOT-1: fresh install — full base+extras set, no trims (Z-4).
		// --allow-existing: the bootstrap lock lives INSIDE venvDir (created by
		// acquireBootstrapLock before this runs), so the directory already
		// exists; uv must build into it rather than refuse it. Verified: the
		// venv is created and the lock file survives (slice-4 live-tier fix).
		const venvResult = await deps.runner.run("uv", [
			"venv",
			config.venvDir,
			"--python",
			PYTHON_VERSION,
			"--allow-existing",
		]);
		if (uvUnresolvable(venvResult)) throw new UvMissingError();
		if (venvResult.code !== 0) {
			throw new RlmBootstrapError(
				`creating venv failed (${venvResult.stderr}); first-time installs need internet access`,
			);
		}

		const packages: string[] = [...BASE_PACKAGES, ...EXTRAS_PACKAGES].map(p =>
			p === "rlm-runtime" && deps.runtimePackagePath !== undefined ? deps.runtimePackagePath : p,
		);
		const installResult = await deps.runner.run("uv", ["pip", "install", "--python", pythonPath, ...packages]);
		if (uvUnresolvable(installResult)) throw new UvMissingError();
		if (installResult.code !== 0) {
			// F-198: name the internet requirement for first-time installs
			throw new RlmBootstrapError(
				`installing kernel packages failed (${installResult.stderr}); first-time installs need internet access`,
			);
		}

		// ERRORS-BOOT-2: per-skill editable installs (real uv shape); failures
		// warn naming the skill
		const warnings: string[] = [];
		for (const skill of deps.skills) {
			const skillResult = await deps.runner.run("uv", ["pip", "install", "--python", pythonPath, "-e", skill]);
			if (uvUnresolvable(skillResult)) throw new UvMissingError();
			if (skillResult.code !== 0) {
				warnings.push(`Python skill ${skill} failed to install and will be unavailable`);
			}
		}

		fs.mkdirSync(config.venvDir, { recursive: true });
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: SCHEMA_VERSION,
				ipykernel: "installed",
				runtime: currentIdentity,
				snapshot: "v1",
				extraUvArgs: [],
				pythonSkills: deps.skills,
				packages: [...BASE_PACKAGES, ...EXTRAS_PACKAGES].sort(),
			}),
		);

		return { interpreterPath: pythonPath, warnings };
	} finally {
		lock.release();
	}
}
