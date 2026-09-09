import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	DISABLED_ASKPASS_PATH,
	SSH_ASKPASS_DISPLAY_VALUE,
	SSH_ASKPASS_REQUIRE_VALUE,
} from "../../../../requirements/contracts/omp_ssh_askpass_restoration.contract";

// Regression coverage for #1589: `git.clone({ sha })` used to hardcode
// `--depth 1`, producing a shallow clone whose object store never contained
// non-tip commits. The subsequent `git checkout <sha>` then failed with
// "shallow clone may not contain this commit".

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

function gitRun(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

describe("git.clone with options.sha", () => {
	let tmpRoot: string;
	let upstreamUrl: string;
	let firstSha: string;
	let tipSha: string;

	beforeAll(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-clone-test-"));
		const upstream = path.join(tmpRoot, "upstream");
		await fs.mkdir(upstream, { recursive: true });

		// `file://` is required: local-path clones ignore `--depth`, which would
		// mask the bug. See git-clone(1) "GIT URLS" / "LOCAL PROTOCOL".
		upstreamUrl = url.pathToFileURL(upstream).href;

		gitRun(upstream, ["init", "-q", "-b", "main"]);
		gitRun(upstream, ["commit", "-q", "--allow-empty", "-m", "first"]);
		firstSha = gitRun(upstream, ["rev-parse", "HEAD"]);
		gitRun(upstream, ["commit", "-q", "--allow-empty", "-m", "second"]);
		gitRun(upstream, ["commit", "-q", "--allow-empty", "-m", "third"]);
		tipSha = gitRun(upstream, ["rev-parse", "HEAD"]);
	});

	afterAll(async () => {
		await removeWithRetries(tmpRoot);
	});

	test("checks out a non-tip SHA (regression for #1589)", async () => {
		const target = path.join(tmpRoot, "clone-non-tip");
		await git.clone(upstreamUrl, target, { sha: firstSha });
		expect(gitRun(target, ["rev-parse", "HEAD"])).toBe(firstSha);
	});

	test("still succeeds when SHA happens to be the tip", async () => {
		const target = path.join(tmpRoot, "clone-tip");
		await git.clone(upstreamUrl, target, { sha: tipSha });
		expect(gitRun(target, ["rev-parse", "HEAD"])).toBe(tipSha);
	});

	test("cleans up the target directory when SHA does not exist", async () => {
		const target = path.join(tmpRoot, "clone-missing");
		await expect(git.clone(upstreamUrl, target, { sha: "0".repeat(40) })).rejects.toThrow(/Failed to checkout SHA/);
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("does not configure an SSH wrapper via core.sshCommand after a clone (FORBIDDEN-AR-2)", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   C1 VALID: FORBIDDEN-AR-2 (requirements/contracts/omp_ssh_askpass_restoration.contract.ts)
		 *   C2 VALUABLE: an implementation that adds an SSH wrapper via
		 *     core.sshCommand to force askpass selection makes this fail.
		 *   C3 NON-DUPLICATIVE: only test asserting the absence of a
		 *     core.sshCommand override after a real clone.
		 *   C4 NOT FUTURE-EDIT: core.sshCommand is explicitly named in
		 *     FORBIDDEN-AR-2 as a disallowed mechanism for this restoration; this
		 *     bounds the clone path git.clone already performs, it does not
		 *     defend against an unnamed hypothetical future addition.
		 * Risk tier: MEDIUM — an SSH wrapper would silently reroute every git
		 * SSH transport; git.clone already exercises the config-writing path.
		 * Adversarial: Implementation-blind.
		 */
		const target = path.join(tmpRoot, "clone-no-ssh-wrapper");
		await git.clone(upstreamUrl, target, { sha: tipSha });

		const result = Bun.spawnSync({
			cmd: ["git", "config", "--local", "--get", "core.sshCommand"],
			cwd: target,
			stdout: "ignore",
			stderr: "ignore",
		});
		if (result.exitCode === 0) {
			throw new Error(
				[
					"WHAT: 'does not configure an SSH wrapper via core.sshCommand' FAILED",
					"WHY: FORBIDDEN-AR-2 violation - a core.sshCommand override was written by the clone path",
					"EXPECTED: `git config --local --get core.sshCommand` exits non-zero (key absent in the cloned repository's local config)",
					`ACTUAL: exit code ${result.exitCode} (key present)`,
					"GUIDANCE: resolve askpass without adding an SSH wrapper or core.sshCommand override",
				].join("\n"),
			);
		}
	});
});

describe("OMP internal Git environment askpass restoration (POST-AR-3 / SEQ-AR-3)", () => {
	test("retains a resolved parent SSH_ASKPASS and applies the native askpass environment across a real internal Git child, without replacing it with /usr/bin/false (POST-AR-3, SEQ-AR-3, FORBIDDEN-AR-1)", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   C1 VALID: POST-AR-3, SEQ-AR-3, FORBIDDEN-AR-1
		 *     (requirements/contracts/omp_ssh_askpass_restoration.contract.ts)
		 *   C2 VALUABLE: a Git environment builder that drops the resolved
		 *     parent SSH_ASKPASS, skips SSH_ASKPASS_REQUIRE/DISPLAY, or forces
		 *     /usr/bin/false over a valid parent candidate fails every
		 *     assertion below.
		 *   C3 NON-DUPLICATIVE: distinct surface from the Bash-builder test in
		 *     non-interactive-env.test.ts (buildNonInteractiveEnv) — that
		 *     test's own C3 explicitly scopes itself to "the Bash-builder
		 *     surface", leaving the internal Git surface uncovered until this
		 *     test. Also distinct from the core.sshCommand test above: that
		 *     test asserts an absence (no SSH wrapper config key written);
		 *     this test asserts the resolved env values the spawned Git child
		 *     actually receives.
		 *   C4 NOT FUTURE-EDIT: bounds the resolver's current decision path for
		 *     the internal Git child — the same regression class 312b41bf54
		 *     introduced for the Bash builder, applied to the Git builder.
		 * Risk tier: HIGH — FORBIDDEN-AR-1/POST-AR-3 guard the regression that
		 * silently disabled FIDO/YubiKey git-push authentication for every
		 * internal Git child process.
		 * Adversarial: Implementation-blind.
		 *
		 * ARCHITECTURE (isolated child-process integration; no exported
		 * production seam): the internal Git environment builder is a private
		 * function with no public parameter to inject an environment map. The
		 * only black-box observable is the environment of the literal `git`
		 * child it spawns. This test therefore:
		 *   1. Spawns an ISOLATED child Bun process with a fully explicit,
		 *      literal `env` object. `Bun.spawn`'s `env` REPLACES rather than
		 *      merges with the parent's `process.env` (verified directly: an
		 *      `env` object containing one custom key produces a child whose
		 *      own `process.env` contains only that key). "No process.env
		 *      pollution" and "no reliance on ambient askpass/color
		 *      variables" cash out to exactly this: this test process's own
		 *      `process.env` is never read or written, and the child never
		 *      inherits it.
		 *   2. Puts a fake `git` executable first on that child's PATH. The
		 *      fake is a PROCESS-BOUNDARY RECORDER, not a Git implementation:
		 *      it writes only SSH_ASKPASS / SSH_ASKPASS_REQUIRE / DISPLAY from
		 *      its own received environment to a temp output file, then
		 *      `exec`s the real git binary (resolved via `Bun.which`, never
		 *      hardcoded) with the original arguments untouched — so the
		 *      "minimal valid status output" a real `git status` produces
		 *      flows back unmodified. This test asserts nothing about that
		 *      output's shape. Parity scope: the fake reproduces zero Git
		 *      behavior; it observes three environment variables and forwards.
		 *   3. Invokes only the existing PUBLIC `git.status.summary(cwd)` —
		 *      no private production symbol is imported or exported.
		 *   4. Isolates Git config lookup (`GIT_CONFIG_GLOBAL`/
		 *      `GIT_CONFIG_SYSTEM` = /dev/null, isolated `HOME`) so the
		 *      assertions below do not depend on this machine's or CI's
		 *      global Git configuration.
		 *   5. Never sets `FORCE_COLOR` in the child's env (left absent) and
		 *      never sets `SSH_ASKPASS_REQUIRE`/`DISPLAY` as inputs — those
		 *      are exactly the two values POST-AR-3 requires the builder to
		 *      produce, so their presence in the recorded output is solely
		 *      attributable to the builder under test.
		 */
		if (process.platform === "win32") return;

		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-askpass-child-"));
		const driverPath = path.join(
			path.dirname(url.fileURLToPath(import.meta.url)),
			`.tmp-askpass-git-child-driver-${crypto.randomUUID()}.mjs`,
		);
		try {
			// Real Git repository the internal Git child operates on. Set up
			// with the real system `git` directly via this file's own gitRun
			// helper — test scaffolding, not the path under test.
			const repoDir = path.join(workDir, "repo");
			await fs.mkdir(repoDir, { recursive: true });
			gitRun(repoDir, ["init", "-q", "-b", "main"]);

			// Executable fixture representing a valid parent SSH_ASKPASS helper.
			const askpassPath = path.join(workDir, "fixture-askpass");
			await fs.writeFile(askpassPath, "#!/bin/sh\nexit 0\n");
			await fs.chmod(askpassPath, 0o755);

			// Temp PATH directory holding the fake `git` recorder.
			const binDir = path.join(workDir, "bin");
			await fs.mkdir(binDir, { recursive: true });
			const recorderPath = path.join(binDir, "git");
			const recordFile = path.join(workDir, "recorded-env.txt");
			const realGitPath = Bun.which("git");
			if (realGitPath === null) {
				throw new Error(
					"Test fixture precondition failed: no real `git` resolvable via Bun.which to build the recorder fixture",
				);
			}
			await fs.writeFile(
				recorderPath,
				[
					"#!/bin/sh",
					"{",
					"  printf 'SSH_ASKPASS=%s\\n' \"${SSH_ASKPASS:-__OMP_TEST_UNSET__}\"",
					"  printf 'SSH_ASKPASS_REQUIRE=%s\\n' \"${SSH_ASKPASS_REQUIRE:-__OMP_TEST_UNSET__}\"",
					"  printf 'DISPLAY=%s\\n' \"${DISPLAY:-__OMP_TEST_UNSET__}\"",
					`} > ${JSON.stringify(recordFile)}`,
					`exec ${JSON.stringify(realGitPath)} "$@"`,
					"",
				].join("\n"),
			);
			await fs.chmod(recorderPath, 0o755);

			// Child driver: invokes only the PUBLIC git.status.summary — no
			// private production symbol is imported. Lives beside this test
			// file so Bun's module resolution reaches the workspace
			// node_modules the same way this test file's own import does.
			await fs.writeFile(
				driverPath,
				[
					'import * as git from "@oh-my-pi/pi-coding-agent/utils/git";',
					"const cwd = process.argv[2];",
					"try {",
					"\tawait git.status.summary(cwd);",
					'\tprocess.stdout.write("OK\\n");',
					"\tprocess.exit(0);",
					"} catch (error) {",
					"\tprocess.stdout.write(`ERR:${error && error.message ? error.message : String(error)}\\n`);",
					"\tprocess.exit(1);",
					"}",
					"",
				].join("\n"),
			);

			const child = Bun.spawn({
				cmd: [process.execPath, driverPath, repoDir],
				env: {
					PATH: `${binDir}:/usr/bin:/bin`,
					HOME: workDir,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					SSH_ASKPASS: askpassPath,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [childStdout, childStderr, childExitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);

			if (childExitCode !== 0) {
				throw new Error(
					[
						"WHAT: 'retains a resolved parent SSH_ASKPASS ... internal Git child' FAILED",
						"WHY: SEQ-AR-3 violation - the public git.status.summary(cwd) call did not complete",
						"EXPECTED: the isolated child process exits 0",
						`ACTUAL: exit code ${childExitCode}; stdout=${JSON.stringify(childStdout)} stderr=${JSON.stringify(childStderr.slice(0, 500))}`,
						"GUIDANCE: the internal Git child must run to completion under a resolved askpass environment",
					].join("\n"),
				);
			}

			const recordedRaw = await fs.readFile(recordFile, "utf8");
			const recorded = Object.fromEntries(
				recordedRaw
					.trim()
					.split("\n")
					.map(line => {
						const eq = line.indexOf("=");
						return [line.slice(0, eq), line.slice(eq + 1)];
					}),
			);

			if (recorded.SSH_ASKPASS !== askpassPath) {
				throw new Error(
					[
						"WHAT: 'retains a resolved parent SSH_ASKPASS ... internal Git child' FAILED",
						"WHY: POST-AR-3 violation - internal Git environment did not retain the resolved parent askpass path",
						`EXPECTED: recorded SSH_ASKPASS === ${JSON.stringify(askpassPath)}`,
						`ACTUAL: recorded SSH_ASKPASS === ${JSON.stringify(recorded.SSH_ASKPASS)}`,
						"GUIDANCE: the internal Git child's environment must carry the same resolved askpass path as the shared resolver produced",
					].join("\n"),
				);
			}
			if (recorded.SSH_ASKPASS === DISABLED_ASKPASS_PATH) {
				throw new Error(
					[
						"WHAT: 'retains a resolved parent SSH_ASKPASS ... internal Git child' FAILED",
						"WHY: FORBIDDEN-AR-1 violation - a valid parent askpass helper was replaced by /usr/bin/false in the internal Git environment",
						`EXPECTED: recorded SSH_ASKPASS !== ${JSON.stringify(DISABLED_ASKPASS_PATH)}`,
						`ACTUAL: recorded SSH_ASKPASS === ${JSON.stringify(recorded.SSH_ASKPASS)}`,
						"GUIDANCE: never force the disabled sentinel over a usable parent candidate in the internal Git environment",
					].join("\n"),
				);
			}
			if (recorded.SSH_ASKPASS_REQUIRE !== SSH_ASKPASS_REQUIRE_VALUE) {
				throw new Error(
					[
						"WHAT: 'retains a resolved parent SSH_ASKPASS ... internal Git child' FAILED",
						'WHY: POST-AR-3 violation - internal Git environment did not set SSH_ASKPASS_REQUIRE to "force"',
						`EXPECTED: recorded SSH_ASKPASS_REQUIRE === ${JSON.stringify(SSH_ASKPASS_REQUIRE_VALUE)}`,
						`ACTUAL: recorded SSH_ASKPASS_REQUIRE === ${JSON.stringify(recorded.SSH_ASKPASS_REQUIRE)}`,
						"GUIDANCE: apply the native askpass environment to the internal Git child whenever a helper resolves",
					].join("\n"),
				);
			}
			if (recorded.DISPLAY !== SSH_ASKPASS_DISPLAY_VALUE) {
				throw new Error(
					[
						"WHAT: 'retains a resolved parent SSH_ASKPASS ... internal Git child' FAILED",
						'WHY: POST-AR-3 violation - internal Git environment did not set DISPLAY to "ssh-askpass"',
						`EXPECTED: recorded DISPLAY === ${JSON.stringify(SSH_ASKPASS_DISPLAY_VALUE)}`,
						`ACTUAL: recorded DISPLAY === ${JSON.stringify(recorded.DISPLAY)}`,
						"GUIDANCE: apply the native askpass environment to the internal Git child whenever a helper resolves",
					].join("\n"),
				);
			}
		} finally {
			await fs.rm(driverPath, { force: true });
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});
});
