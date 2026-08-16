import { $which } from "@oh-my-pi/pi-utils";
import { existsSync } from "node:fs";

/** Portable command that rejects credential prompts without assuming an FHS layout. */
export const REJECT_PROMPT_COMMAND = $which("false") ?? "false";

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
	// SSH_ASKPASS is resolved in buildNonInteractiveEnv: keep a real askpass
	// (YubiKey / ed25519-sk GUI) from the parent; only force false when none exists.
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
const DISABLED_ASKPASS = "/usr/bin/false";

const KNOWN_ASKPASS_PATHS = [
	"/opt/homebrew/opt/ssh-askpass/bin/ssh-askpass",
	"/opt/homebrew/bin/ssh-askpass",
	"/usr/local/opt/ssh-askpass/bin/ssh-askpass",
] as const;

/** True when path is a usable askpass binary (not the harness dummy). */
export function isUsableSshAskpass(path: string | undefined): boolean {
	if (!path) return false;
	if (path === DISABLED_ASKPASS || path === "false" || path === "true") return false;
	return existsSync(path);
}

/**
 * Prefer parent/myomp/LaunchAgent askpass so ed25519-sk can show a GUI dialog.
 * Fall back to known Homebrew paths, then the non-interactive dummy.
 */
export function resolveSshAskpass(...sources: Array<Record<string, string | undefined> | undefined>): string {
	for (const source of sources) {
		const candidate = source?.SSH_ASKPASS;
		if (isUsableSshAskpass(candidate)) return candidate as string;
	}
	for (const path of KNOWN_ASKPASS_PATHS) {
		if (existsSync(path)) return path;
	}
	return DISABLED_ASKPASS;
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
	const base =
		baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(NON_INTERACTIVE_ENV) : NON_INTERACTIVE_ENV;

	const sshAskpass = resolveSshAskpass(overrides, baseEnv);
	const withAskpass: Record<string, string> = { ...base, SSH_ASKPASS: sshAskpass };

	// When a real askpass is active, prefer GUI prompts for FIDO/sk keys.
	// Do not invent SSH_ASKPASS_REQUIRE if the parent already set it.
	if (sshAskpass !== DISABLED_ASKPASS) {
		const require = overrides?.SSH_ASKPASS_REQUIRE ?? baseEnv.SSH_ASKPASS_REQUIRE ?? "prefer";
		withAskpass.SSH_ASKPASS_REQUIRE = require;
		if (!withAskpass.DISPLAY && !overrides?.DISPLAY) {
			const display = baseEnv.DISPLAY ?? "ssh-askpass";
			withAskpass.DISPLAY = display;
		}
	}

	if (platform !== "win32") {
		return overrides ? { ...withAskpass, ...overrides, SSH_ASKPASS: sshAskpass } : withAskpass;
	}

	const env: Record<string, string> = { ...withAskpass };
	for (const group of WINDOWS_UTF8_ENV_DEFAULT_GROUPS) {
		if (hasEnvGroupValue(baseEnv, group, platform) || hasEnvGroupValue(overrides, group, platform)) {
			continue;
		}
		for (const [key, value] of group) {
			env[key] = value;
		}
	}
	return overrides ? { ...env, ...overrides, SSH_ASKPASS: sshAskpass } : env;
}
