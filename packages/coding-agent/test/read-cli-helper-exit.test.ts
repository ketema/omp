import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const PROBE_DEADLINE_MS = 25_000;

function evidence(what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		"2. WHY: SEQ-RAWIO-2 violation",
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: A one-shot CLI command must stop the Raw-I/O Helper before returning so the process can exit",
	].join("\n");
}

describe("one-shot omp read stops the Raw-I/O Helper (SEQ-RAWIO-2)", () => {
	let root: string;
	let target: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-helper-exit-"));
		target = path.join(root, "plain.txt");
		await fs.mkdir(path.join(root, "agent"));
		await Bun.write(target, "ordinary file read through the helper\n");
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	async function readProbe(testRuntime: boolean): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
		/* CAR: contracts/raw_io_helper.contract.ts SEQ-RAWIO-2, verification=test; regression for PR #51 CI job
		 * 125480713459. HIGH-risk process-lifecycle boundary: a probe that never exits hangs the CI shard.
		 * C1: clause says a one-shot CLI stops the helper before returning; C2: today the helper child stays
		 * referenced under PI_TEST_RUNTIME=1 (the CI shard runner sets it) so the process hangs; C3: unlike
		 * read-cli-skill, this test fixes the environment explicitly instead of inheriting it; C4: real CLI,
		 * real helper, real process exit, no doubles. The unmarked run is the positive control for the probe.
		 */
		const probePath = path.join(root, "probe.ts");
		await Bun.write(
			probePath,
			[
				`import { runCli } from ${JSON.stringify(url.pathToFileURL(CLI_ENTRY).href)};`,
				`await runCli(["read", ${JSON.stringify(target)}]);`,
			].join("\n"),
		);
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			HOME: root,
			USERPROFILE: root,
			NO_COLOR: "1",
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
		};
		if (testRuntime) env.PI_TEST_RUNTIME = "1";
		else delete env.PI_TEST_RUNTIME;
		const proc = Bun.spawn([process.execPath, probePath], { cwd: root, stdout: "pipe", stderr: "pipe", env });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, PROBE_DEADLINE_MS);
		const stdout = new Response(proc.stdout).text();
		const [exitCode, output] = await Promise.all([proc.exited, stdout]);
		clearTimeout(timer);
		return { exitCode, output, timedOut };
	}

	it("exits with code 0 and prints the file when the helper child is held referenced (PI_TEST_RUNTIME=1)", async () => {
		const marked = await readProbe(true);
		expect(
			{
				timedOut: marked.timedOut,
				exitCode: marked.exitCode,
				printed: marked.output.includes("ordinary file read"),
			},
			evidence("referenced-helper CLI exit", "prompt exit 0 after printing the file", marked),
		).toEqual({ timedOut: false, exitCode: 0, printed: true });
	}, 60_000);

	it("positive control: the same probe exits 0 without the test-runtime marker", async () => {
		const plain = await readProbe(false);
		expect(
			{ timedOut: plain.timedOut, exitCode: plain.exitCode, printed: plain.output.includes("ordinary file read") },
			evidence("unmarked CLI exit control", "prompt exit 0 after printing the file", plain),
		).toEqual({ timedOut: false, exitCode: 0, printed: true });
	}, 60_000);
});
