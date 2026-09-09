import { describe, expect, it } from "bun:test";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } from "@oh-my-pi/pi-coding-agent/exec/non-interactive-env";
import {
	DISABLED_ASKPASS_PATH,
	SSH_ASKPASS_DISPLAY_VALUE,
	SSH_ASKPASS_REQUIRE_VALUE,
} from "../../../requirements/contracts/omp_ssh_askpass_restoration.contract";

describe("buildNonInteractiveEnv", () => {
	it("defaults Windows child-process encoding to UTF-8 when inherited env is unset", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "win32");

		expect(env.PYTHONIOENCODING).toBe("utf-8");
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	it("preserves inherited Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { PYTHONUTF8: "0", LANG: "de_DE.UTF-8" }, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("preserves per-command Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv({ PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8" }, {}, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBe("0");
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBe("en_US.UTF-8");
	});

	it("preserves inherited Windows LC category locales as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { LC_CTYPE: "en_US.UTF-8" }, "win32");

		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not force UTF-8 encoding defaults on non-Windows platforms", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not invent a bogus GPG_TTY", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env).not.toHaveProperty("GPG_TTY");
	});

	it("preserves per-command GPG_TTY overrides", () => {
		const env = buildNonInteractiveEnv({ GPG_TTY: "/dev/pts/7" }, {}, "linux");

		expect(env.GPG_TTY).toBe("/dev/pts/7");
	});

	it("uses an executable SSH askpass rejector on POSIX", async () => {
		if (process.platform === "win32") return;
		const proc = Bun.spawn([NON_INTERACTIVE_ENV.SSH_ASKPASS], {
			stdout: "ignore",
			stderr: "ignore",
		});

		expect(await proc.exited).toBe(1);
	});

	it("injects clap-compatible CI=true by default", () => {
		expect(buildNonInteractiveEnv(undefined, {}, "linux").CI).toBe("true");
		expect(buildNonInteractiveEnv(undefined, {}, "win32").CI).toBe("true");
	});

	it("drops CI when PI_BASH_NO_CI or its legacy alias is set", () => {
		expect(buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: "1" }, "linux")).not.toHaveProperty("CI");
		expect(buildNonInteractiveEnv(undefined, { CLAUDE_BASH_NO_CI: "1" }, "linux")).not.toHaveProperty("CI");
		expect(buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: "1" }, "win32")).not.toHaveProperty("CI");
	});

	it("lets a per-command CI override win over the opt-out", () => {
		expect(buildNonInteractiveEnv({ CI: "0" }, { PI_BASH_NO_CI: "1" }, "linux").CI).toBe("0");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// REQ-2026-OMP-SSH-ASKPASS-RESTORATION — SLICE-1 (source-level resolver)
//
// Deferred to SLICE-2, execution-verified only (a live macOS LaunchAgent and a
// real FIDO/YubiKey assertion are required; no test double reproduces OpenSSH's
// native notification lifecycle without live hardware, so writing one would
// fail Criterion 2/4 of the Four-Criteria Test Validity Gate):
//   POST-AR-4      — Native OpenSSH starts Yubi Askpass with SSH_ASKPASS_PROMPT=none
//                     before a selected FIDO user-presence assertion.
//   SEQ-AR-1       — The macOS LaunchAgent exports Yubi Askpass before OMP starts.
//   SEQ-AR-4       — Yubi Askpass starts its audible cue before visual/PIN UI.
//   ERRORS-AR-1    — MissingYubiAskpassError during LaunchAgent validation.
//   FORBIDDEN-AR-3 — Native notification mode emits no secret material.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildNonInteractiveEnv askpass resolver restoration", () => {
	async function makeAskpassFixture(mode: number): Promise<{ dir: string; path: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-askpass-"));
		const fixturePath = path.join(dir, "fixture-askpass");
		await fs.writeFile(fixturePath, "#!/bin/sh\nexit 0\n");
		await fs.chmod(fixturePath, mode);
		return { dir, path: fixturePath };
	}

	function discoverExecutableGenericAskpassFallback(): string | undefined {
		const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(dir => dir.length > 0);
		for (const dir of pathDirs) {
			const candidate = path.join(dir, "ssh-askpass");
			try {
				accessSync(candidate, fsConstants.X_OK);
				if (statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {}
		}
		return undefined;
	}

	const executableGenericAskpassFallback = discoverExecutableGenericAskpassFallback();
	const skipFallbackDependentRegression =
		process.platform !== "win32" && executableGenericAskpassFallback === undefined;
	const fallbackDependentRegressionName = skipFallbackDependentRegression
		? "rejects a non-executable parent SSH_ASKPASS and still applies the native askpass environment (POST-AR-5 skip: no executable generic askpass fallback is discoverable)"
		: "rejects a non-executable parent SSH_ASKPASS and still applies the native askpass environment";

	it("prefers a valid executable parent SSH_ASKPASS, retains its path, and applies the native askpass environment", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   C1 VALID: POST-AR-1, POST-AR-2, POST-AR-5, FORBIDDEN-AR-1, SEQ-AR-2
		 *     (requirements/contracts/omp_ssh_askpass_restoration.contract.ts)
		 *   C2 VALUABLE: a resolver that ignores the executable parent, or a
		 *     builder that drops SSH_ASKPASS_REQUIRE/DISPLAY, fails every assertion.
		 *   C3 NON-DUPLICATIVE: only test asserting buildNonInteractiveEnv's
		 *     parent-preference decision at the Bash-builder surface.
		 *   C4 NOT FUTURE-EDIT: bounds the resolver's current decision path — the
		 *     exact regression c430acd792 fixed and 312b41bf54 dropped.
		 * Risk tier: HIGH — FORBIDDEN-AR-1 guards the regression that silently
		 * disabled FIDO/YubiKey git-push authentication for every non-interactive
		 * child process. Adversarial: Implementation-blind.
		 * POST-AR-5: this valid-parent resolver regression remains runnable
		 * even when no executable generic askpass fallback is discoverable.
		 */
		if (process.platform === "win32") return;
		const fixture = await makeAskpassFixture(0o755);
		try {
			const env = buildNonInteractiveEnv({ SSH_ASKPASS: fixture.path }, {}, process.platform);

			if (env.SSH_ASKPASS !== fixture.path) {
				throw new Error(
					[
						"WHAT: 'prefers a valid executable parent SSH_ASKPASS' FAILED",
						"WHY: POST-AR-1 violation - resolver did not choose the executable parent SSH_ASKPASS",
						`EXPECTED: env.SSH_ASKPASS === ${JSON.stringify(fixture.path)}`,
						`ACTUAL: env.SSH_ASKPASS === ${JSON.stringify(env.SSH_ASKPASS)}`,
						"GUIDANCE: resolve an executable parent candidate before any generic fallback",
					].join("\n"),
				);
			}
			if (env.SSH_ASKPASS === DISABLED_ASKPASS_PATH) {
				throw new Error(
					[
						"WHAT: 'prefers a valid executable parent SSH_ASKPASS' FAILED",
						"WHY: FORBIDDEN-AR-1 violation - a valid parent askpass helper was replaced by /usr/bin/false",
						`EXPECTED: env.SSH_ASKPASS !== ${JSON.stringify(DISABLED_ASKPASS_PATH)}`,
						`ACTUAL: env.SSH_ASKPASS === ${JSON.stringify(env.SSH_ASKPASS)}`,
						"GUIDANCE: never force the disabled sentinel over a usable parent candidate",
					].join("\n"),
				);
			}
			if (env.SSH_ASKPASS_REQUIRE !== SSH_ASKPASS_REQUIRE_VALUE) {
				throw new Error(
					[
						"WHAT: 'prefers a valid executable parent SSH_ASKPASS' FAILED",
						'WHY: POST-AR-2 violation - SSH_ASKPASS_REQUIRE was not set to "force" for a resolved helper',
						`EXPECTED: env.SSH_ASKPASS_REQUIRE === ${JSON.stringify(SSH_ASKPASS_REQUIRE_VALUE)}`,
						`ACTUAL: env.SSH_ASKPASS_REQUIRE === ${JSON.stringify(env.SSH_ASKPASS_REQUIRE)}`,
						"GUIDANCE: apply the native askpass environment whenever a helper resolves",
					].join("\n"),
				);
			}
			if (env.DISPLAY !== SSH_ASKPASS_DISPLAY_VALUE) {
				throw new Error(
					[
						"WHAT: 'prefers a valid executable parent SSH_ASKPASS' FAILED",
						'WHY: POST-AR-2 violation - DISPLAY was not set to "ssh-askpass" for a resolved helper',
						`EXPECTED: env.DISPLAY === ${JSON.stringify(SSH_ASKPASS_DISPLAY_VALUE)}`,
						`ACTUAL: env.DISPLAY === ${JSON.stringify(env.DISPLAY)}`,
						"GUIDANCE: apply the native askpass environment whenever a helper resolves",
					].join("\n"),
				);
			}
		} finally {
			await fs.rm(fixture.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(skipFallbackDependentRegression)(fallbackDependentRegressionName, async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   C1 VALID: PRE-AR-1, POST-AR-2, POST-AR-5, SEQ-AR-2
		 *     (requirements/contracts/omp_ssh_askpass_restoration.contract.ts)
		 *   C2 VALUABLE: a resolver that selects the broken parent path, or a
		 *     builder that skips SSH_ASKPASS_REQUIRE/DISPLAY once the parent is
		 *     rejected, fails this when a generic fallback is discoverable.
		 *   C3 NON-DUPLICATIVE: distinct equivalence class (invalid parent) from
		 *     the valid-parent test above; same surface, different input partition.
		 *   C4 NOT FUTURE-EDIT: PRE-AR-1 forbids selecting an unusable candidate
		 *     today, and POST-AR-2's native environment applies to whichever path
		 *     resolves; neither is a hypothetical future rule. This test does not
		 *     assert which concrete fallback path is chosen: POST-AR-1 names only
		 *     a precedence order (parent, then generic fallback, then disabled),
		 *     not a fixed fallback value, and buildNonInteractiveEnv's public
		 *     signature (inherited, opts, platform) has no parameter to inject a
		 *     controllable generic-fallback candidate — asserting equality with
		 *     the module's own default constant would pin an implementation
		 *     value the contract does not name as "the generic fallback".
		 * POST-AR-5: skip this fallback-dependent regression only when no
		 * executable generic askpass fallback is discoverable; do not assert
		 * native environment values from a disabled resolver. The valid-parent
		 * test above is not skipped.
		 * Risk tier: MEDIUM — exercised whenever the configured parent helper is
		 * broken; failure degrades to a missing prompt, not data loss.
		 * Adversarial: Implementation-blind.
		 */
		if (process.platform === "win32") return;
		const fixture = await makeAskpassFixture(0o644);
		try {
			const env = buildNonInteractiveEnv({ SSH_ASKPASS: fixture.path }, {}, process.platform);

			if (env.SSH_ASKPASS === fixture.path) {
				throw new Error(
					[
						"WHAT: 'rejects a non-executable parent SSH_ASKPASS' FAILED",
						"WHY: PRE-AR-1 violation - resolver selected a non-executable candidate as SSH_ASKPASS",
						`EXPECTED: env.SSH_ASKPASS !== ${JSON.stringify(fixture.path)}`,
						`ACTUAL: env.SSH_ASKPASS === ${JSON.stringify(env.SSH_ASKPASS)}`,
						"GUIDANCE: an unusable candidate must not be selected as the resolved helper",
					].join("\n"),
				);
			}
			if (env.SSH_ASKPASS_REQUIRE !== SSH_ASKPASS_REQUIRE_VALUE) {
				throw new Error(
					[
						"WHAT: 'still applies the native askpass environment' FAILED",
						'WHY: POST-AR-2 violation - SSH_ASKPASS_REQUIRE was not set to "force" once the resolver moved past the rejected parent',
						`EXPECTED: env.SSH_ASKPASS_REQUIRE === ${JSON.stringify(SSH_ASKPASS_REQUIRE_VALUE)}`,
						`ACTUAL: env.SSH_ASKPASS_REQUIRE === ${JSON.stringify(env.SSH_ASKPASS_REQUIRE)}`,
						"GUIDANCE: apply the native askpass environment to whichever path the resolver returns",
					].join("\n"),
				);
			}
			if (env.DISPLAY !== SSH_ASKPASS_DISPLAY_VALUE) {
				throw new Error(
					[
						"WHAT: 'still applies the native askpass environment' FAILED",
						'WHY: POST-AR-2 violation - DISPLAY was not set to "ssh-askpass" once the resolver moved past the rejected parent',
						`EXPECTED: env.DISPLAY === ${JSON.stringify(SSH_ASKPASS_DISPLAY_VALUE)}`,
						`ACTUAL: env.DISPLAY === ${JSON.stringify(env.DISPLAY)}`,
						"GUIDANCE: apply the native askpass environment to whichever path the resolver returns",
					].join("\n"),
				);
			}
		} finally {
			await fs.rm(fixture.dir, { recursive: true, force: true });
		}
	});
});

it("filters expanded dotenv values while preserving matching and empty launcher values", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-"));
	try {
		await Bun.write(
			path.join(tmp, ".env"),
			[
				"BASE=loaded-by-omp",
				"EMPTY_PARENT_VAR=project-secret",
				"TEST_ENV_FROM_DOTENV=$BASE-suffix",
				"NODE_ENV=development",
				"export EXPORTED_SECRET=exported",
				"COMMENTED_SECRET=secret # trailing comment",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(tmp, ".env.local"),
			"CONVEX_DEPLOYMENT=anonymous:root-local\nCONVEX_URL=http://127.0.0.1:3210\n",
		);
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = [
			`import { getShellConfig } from ${JSON.stringify(procmgrPath)};`,
			"const env = getShellConfig().env;",
			"console.log(JSON.stringify({",
			"	project: env.TEST_ENV_FROM_DOTENV ?? null,",
			"	deployment: env.CONVEX_DEPLOYMENT ?? null,",
			"	url: env.CONVEX_URL ?? null,",
			"	inherited: env.OMP_TEST_INHERITED_MARKER ?? null,",
			"	empty: env.EMPTY_PARENT_VAR ?? null,",
			"	matching: env.NODE_ENV ?? null,",
			"	exported: env.EXPORTED_SECRET ?? null,",
			"	commented: env.COMMENTED_SECRET ?? null,",
			"}));",
		].join("\n");
		const bunArgSets = process.platform === "linux" ? [[], ["--no-env-file"]] : [["--no-env-file"]];
		for (const bunArgs of bunArgSets) {
			const proc = Bun.spawn([process.execPath, ...bunArgs, "--no-install", "--eval", script], {
				cwd: tmp,
				env: {
					HOME: process.env.HOME ?? "",
					EMPTY_PARENT_VAR: "",
					OMP_TEST_INHERITED_MARKER: "keep-me",
					NODE_ENV: "development",
					PATH: process.env.PATH ?? "",
					SHELL: process.env.SHELL ?? "/bin/bash",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const payload: {
				project: string | null;
				deployment: string | null;
				url: string | null;
				inherited: string | null;
				empty: string | null;
				matching: string | null;
				exported: string | null;
				commented: string | null;
			} = JSON.parse(stdout);
			expect(payload).toEqual({
				project: null,
				deployment: null,
				url: null,
				inherited: "keep-me",
				matching: "development",
				empty: "",
				exported: null,
				commented: null,
			});
		}
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});
