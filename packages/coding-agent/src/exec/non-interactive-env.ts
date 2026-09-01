import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

export const DISABLED_ASKPASS_PATH = "/usr/bin/false" as const;
export const YUBI_ASKPASS_PATH = "$HOME/bin/yubi-askpass" as const;
export const SSH_ASKPASS_REQUIRE_VALUE = "force" as const;
export const SSH_ASKPASS_DISPLAY_VALUE = "ssh-askpass" as const;

export type AskpassSource = "parent" | "fallback" | "disabled";

export interface AskpassCandidate {
	readonly path: string;
	readonly executable: boolean;
}

export interface AskpassResolutionInput {
	readonly parent: AskpassCandidate | undefined;
	readonly fallbacks: readonly AskpassCandidate[];
}

export interface AskpassResolution {
	readonly path: string;
	readonly source: AskpassSource;
}

export class InvalidAskpassCandidateError extends Error {
	constructor(message: string) {
		super(`PRE-AR-1 violation: ${message}`);
		this.name = "InvalidAskpassCandidateError";
	}
}

export const NATIVE_ASKPASS_ENVIRONMENT = (askpassPath: string) =>
	Object.freeze({
		SSH_ASKPASS: askpassPath,
		SSH_ASKPASS_REQUIRE: SSH_ASKPASS_REQUIRE_VALUE,
		DISPLAY: SSH_ASKPASS_DISPLAY_VALUE,
	});

/** Portable command that rejects credential prompts without assuming an FHS layout. */
export const REJECT_PROMPT_COMMAND = $which("false") ?? "false";

function isExecutableAskpassHelper(candidate: string | undefined): candidate is string {
	if (typeof candidate !== "string" || candidate.trim().length === 0 || !path.isAbsolute(candidate)) return false;
	if (candidate === REJECT_PROMPT_COMMAND || ["false", "true"].includes(path.basename(candidate))) return false;
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isUsableAskpassCandidate(candidate: AskpassCandidate | undefined): candidate is AskpassCandidate {
	return (
		candidate !== undefined &&
		candidate.path !== DISABLED_ASKPASS_PATH &&
		candidate.path !== "false" &&
		candidate.path !== "true" &&
		candidate.executable
	);
}

function validateAskpassCandidate(candidate: AskpassCandidate, source: AskpassSource): void {
	if (
		typeof candidate.path !== "string" ||
		candidate.path.trim().length === 0 ||
		typeof candidate.executable !== "boolean"
	) {
		throw new InvalidAskpassCandidateError(`${source} candidate must have a non-empty path and executable flag.`);
	}
}

/** Resolves an executable parent helper before executable generic fallbacks. */
export function resolveAskpass(input: AskpassResolutionInput): AskpassResolution {
	if (input.parent !== undefined) validateAskpassCandidate(input.parent, "parent");
	for (const fallback of input.fallbacks) validateAskpassCandidate(fallback, "fallback");

	if (isUsableAskpassCandidate(input.parent)) return { path: input.parent.path, source: "parent" };
	const fallback = input.fallbacks.find(isUsableAskpassCandidate);
	return fallback === undefined
		? { path: DISABLED_ASKPASS_PATH, source: "disabled" }
		: { path: fallback.path, source: "fallback" };
}

/** Resolves the parent helper before known executable generic fallbacks. */
export function resolveAskpassPath(baseEnv: Record<string, string | undefined> = Bun.env): string {
	const parentAskpass = baseEnv.SSH_ASKPASS;
	const fallback = $which("ssh-askpass", { PATH: baseEnv.PATH }) ?? undefined;
	return resolveAskpass({
		parent:
			parentAskpass === undefined
				? undefined
				: { path: parentAskpass, executable: isExecutableAskpassHelper(parentAskpass) },
		fallbacks: fallback === undefined ? [] : [{ path: fallback, executable: isExecutableAskpassHelper(fallback) }],
	}).path;
}

/** Resolved askpass path plus native OpenSSH values when a real helper resolves. */
export function resolveAskpassEnvironment(
	baseEnv: Record<string, string | undefined> = Bun.env,
): Readonly<Record<string, string>> {
	const askpassPath = resolveAskpassPath(baseEnv);
	return askpassPath === DISABLED_ASKPASS_PATH
		? Object.freeze({ SSH_ASKPASS: DISABLED_ASKPASS_PATH })
		: NATIVE_ASKPASS_ENVIRONMENT(askpassPath);
}

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	// Disable pagers so commands don't block on interactive views.
	PAGER: "cat",
	GIT_PAGER: "cat",
	MANPAGER: "cat",
	SYSTEMD_PAGER: "cat",
	BAT_PAGER: "cat",
	DELTA_PAGER: "cat",
	GH_PAGER: "cat",
	GLAB_PAGER: "cat",
	PSQL_PAGER: "cat",
	MYSQL_PAGER: "cat",
	AWS_PAGER: "",
	HOMEBREW_PAGER: "cat",
	LESS: "FRX",
	// Disable terminal features that can block the process.
	TERM: "dumb",
	NO_COLOR: "1",
	PYTHONUNBUFFERED: "1",
	// Disable editor and terminal credential prompts.
	GIT_EDITOR: "true",
	VISUAL: "true",
	EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
	CI: "true",
	AGENT: "1",
	// Package manager defaults for unattended execution.
	npm_config_yes: "true",
	npm_config_update_notifier: "false",
	npm_config_fund: "false",
	npm_config_audit: "false",
	npm_config_progress: "false",
	PNPM_DISABLE_SELF_UPDATE_CHECK: "true",
	PNPM_UPDATE_NOTIFIER: "false",
	YARN_ENABLE_TELEMETRY: "0",
	YARN_ENABLE_PROGRESS_BARS: "0",
	// Cross-language/tooling non-interactive defaults.
	CARGO_TERM_PROGRESS_WHEN: "never",
	DEBIAN_FRONTEND: "noninteractive",
	PIP_NO_INPUT: "1",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	TF_INPUT: "0",
	TF_IN_AUTOMATION: "1",
	GH_PROMPT_DISABLED: "1",
	COMPOSER_NO_INTERACTION: "1",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
};

const WINDOWS_UTF8_ENV_DEFAULT_GROUPS: ReadonlyArray<ReadonlyArray<readonly [key: string, value: string]>> = [
	[
		["PYTHONIOENCODING", "utf-8"],
		["PYTHONUTF8", "1"],
	],
	[
		["LANG", "C.UTF-8"],
		["LC_ALL", "C.UTF-8"],
	],
];

function hasEnvValue(
	env: Record<string, string | undefined> | undefined,
	key: string,
	platform: NodeJS.Platform,
): boolean {
	if (!env) return false;
	if (platform !== "win32") return env[key] !== undefined;

	for (const [existingKey, value] of Object.entries(env)) {
		if (value !== undefined && existingKey.toLowerCase() === key.toLowerCase()) {
			return true;
		}
	}
	return false;
}

function hasLocaleEnvValue(env: Record<string, string | undefined> | undefined, platform: NodeJS.Platform): boolean {
	if (!env) return false;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
		if (normalizedKey === "LANG" || normalizedKey.startsWith("LC_")) return true;
	}
	return false;
}

function hasEnvGroupValue(
	env: Record<string, string | undefined> | undefined,
	group: ReadonlyArray<readonly [key: string, value: string]>,
	platform: NodeJS.Platform,
): boolean {
	if (group.some(([key]) => key === "LC_ALL") && hasLocaleEnvValue(env, platform)) return true;
	for (const [key] of group) {
		if (hasEnvValue(env, key, platform)) return true;
	}
	return false;
}

/** Copy of the base env with `CI` removed, for the `PI_BASH_NO_CI` opt-out. */
function withoutCI(env: Readonly<Record<string, string>>): Record<string, string> {
	const { CI: _ci, ...rest } = env;
	return rest;
}

/** Builds the per-command environment for non-interactive child processes. */
export function buildNonInteractiveEnv(
	overrides?: Record<string, string>,
	baseEnv: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	// `PI_BASH_NO_CI` (and its legacy alias) opts out of the automatic `CI=true`
	// injection. Mirrors the session-env gate in `procmgr.ts` so the opt-out
	// reaches the per-command env, which otherwise overrides the session value.
	const askpassEnv = resolveAskpassEnvironment({ ...baseEnv, ...overrides });
	const base =
		baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(NON_INTERACTIVE_ENV) : NON_INTERACTIVE_ENV;
	if (platform !== "win32") {
		return { ...base, ...overrides, ...askpassEnv };
	}

	const env: Record<string, string> = { ...base, ...overrides, ...askpassEnv };
	for (const group of WINDOWS_UTF8_ENV_DEFAULT_GROUPS) {
		if (hasEnvGroupValue(baseEnv, group, platform) || hasEnvGroupValue(overrides, group, platform)) {
			continue;
		}
		for (const [key, value] of group) {
			env[key] = value;
		}
	}
	return env;
}
