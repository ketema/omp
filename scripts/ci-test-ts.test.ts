/**
 * Dispatch tests for scripts/ci-test-ts.ts (POST-CI-RLM-SELECTION-1,
 * contracts/rlm-session-isolation.contract.ts).
 *
 * These run the script's REAL `--dry-run` dispatch in a child process and assert
 * the commands it actually plans. They do not match workflow/config text. The
 * execution half of the gate (POST-CI-RLM-EXECUTION-1) is evidenced by the real
 * GitHub Actions job log, not by this file.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

interface PlannedCommand {
	readonly label: string;
	readonly command: string;
}

async function plan(mode: string): Promise<PlannedCommand[]> {
	const env: Record<string, string | undefined> = { ...process.env };
	// A shard or pool-width override would change what the dry run prints.
	delete env.OMP_TEST_SHARD;
	delete env.OMP_TEST_CONCURRENCY;
	const proc = Bun.spawn(["bun", "scripts/ci-test-ts.ts", mode, "--dry-run"], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`ci-test-ts.ts ${mode} --dry-run exited ${exitCode}: ${(stderr || stdout).trim().slice(0, 400)}`);
	}
	const planned: PlannedCommand[] = [];
	const lines = stdout.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith("==> ")) continue;
		const next = lines[i + 1] ?? "";
		if (!next.startsWith("$ ")) continue;
		planned.push({ label: lines[i].slice(4), command: next.slice(2) });
	}
	return planned;
}

const labels = (commands: readonly PlannedCommand[]): string[] => commands.map(c => c.label);

describe("POST-CI-RLM-SELECTION-1: mode 'rlm' dispatches the whole RLM TS package", () => {
	test("plans exactly one `bun test` for packages/rlm with no file filter, name filter or exclusion", async () => {
		const planned = await plan("rlm");
		expect(labels(planned), "POST-CI-RLM-SELECTION-1 violation: mode 'rlm' must plan exactly packages/rlm").toEqual([
			"packages/rlm",
		]);
		const tokens = planned[0].command.split(" ");
		expect(tokens.slice(0, 2)).toEqual(["bun", "test"]);
		// Everything after `bun test` must be a runner-appended knob; a path, --grep/-t or --exclude would narrow selection.
		const narrowing = tokens.slice(2).filter(token => !/^--(parallel|timeout)=\d+$/.test(token));
		expect(
			narrowing,
			"POST-CI-RLM-SELECTION-1 violation: the rlm command carries a selection-narrowing argument",
		).toEqual([]);
	}, 60_000);

	test("the specs the gate is owed - real SessionManager, default path, atomicity - live under the selected package", () => {
		for (const spec of ["session_transition.spec.ts", "session_isolation.spec.ts", "session_atomicity.spec.ts"]) {
			expect(fs.existsSync(path.join(repoRoot, "packages/rlm/tests", spec)), `${spec} must be selected`).toBe(true);
		}
	});

	test("no spec in the selected package can skip silently (.skip / skipIf / .todo / .only)", () => {
		const dir = path.join(repoRoot, "packages/rlm/tests");
		const offenders: string[] = [];
		for (const file of fs.readdirSync(dir)) {
			if (!/\.(spec|test)\.ts$/.test(file)) continue;
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			if (/\b(?:test|it|describe)\.(?:skip|skipIf|todo|only)\b/.test(text)) offenders.push(file);
		}
		expect(offenders, "a skip/only/todo would let the gate go green without executing the case").toEqual([]);
	});
});

describe("POST-CI-RLM-SELECTION-1: existing selections are neither broadened nor weakened", () => {
	test("'workspace' and 'native' plan exactly the packages they planned before, and not packages/rlm", async () => {
		const workspace = labels(await plan("workspace"));
		const native = labels(await plan("native"));
		expect(workspace).toEqual([
			"packages/omptype",
			"packages/utils",
			"packages/catalog",
			"packages/ai",
			"packages/snapcompact",
			"packages/agent",
			"packages/mnemopi",
		]);
		expect(native).toEqual([
			"packages/natives",
			"packages/tui",
			"packages/collab-web",
			"packages/typescript-edit-benchmark",
		]);
	}, 60_000);

	test("'all' and 'local-ts' still select every existing workspace/native package AND now select packages/rlm", async () => {
		const existing = [...labels(await plan("workspace")), ...labels(await plan("native"))];
		for (const mode of ["all", "local-ts"]) {
			const selected = labels(await plan(mode));
			for (const label of existing) {
				expect(selected, `${mode} dropped ${label}`).toContain(label);
			}
			expect(selected, `POST-CI-RLM-SELECTION-1 violation: ${mode} never selects packages/rlm`).toContain(
				"packages/rlm",
			);
		}
	}, 120_000);
});

describe("POST-CI-RLM-SELECTION-1: mode 'rlm-python' dispatches the pinned Python recovery/quarantine suite", () => {
	test("plans one `uv run --locked` against the rlm-runtime uv project with its test group", async () => {
		const planned = await plan("rlm-python");
		expect(planned.length, "POST-CI-RLM-SELECTION-1 violation: mode 'rlm-python' must plan exactly one command").toBe(
			1,
		);
		const tokens = planned[0].command.split(" ");
		expect(tokens.slice(0, 2)).toEqual(["uv", "run"]);
		expect(tokens, "lock drift must fail the job, not be silently re-resolved").toContain("--locked");
		const projectIdx = tokens.indexOf("--project");
		expect(projectIdx).toBeGreaterThan(-1);
		const project = tokens[projectIdx + 1];
		const groupIdx = tokens.indexOf("--group");
		expect(groupIdx).toBeGreaterThan(-1);
		expect(tokens[groupIdx + 1]).toBe("test");
		// The things it points at must really exist: a pinned project with a lock, and a runner script.
		expect(fs.existsSync(path.join(repoRoot, project, "pyproject.toml"))).toBe(true);
		expect(fs.existsSync(path.join(repoRoot, project, "uv.lock"))).toBe(true);
		const script = tokens.find(token => token.endsWith(".py"));
		expect(script, "the command must run a Python runner script").toBeDefined();
		expect(fs.existsSync(path.join(repoRoot, script ?? "missing.py"))).toBe(true);
	}, 60_000);
});
