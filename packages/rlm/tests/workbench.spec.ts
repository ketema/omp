/**
 * Workbench start tests (ketema/omp#27, SLICE-2 item 1a).
 *
 * Targets the IMPLEMENTATION: the real KernelManager over the real transport and Ketema's real
 * restore.py, in a temporary HOME. No test doubles.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: contracts/context_efficiency_enforcement.contract.ts
 * - SEQ-CTX27-6, POST-CTX27-8, ERRORS-CTX27-3 (batch 1); POST-CTX27-9, ERRORS-CTX27-3 notice (batch 2)
 *
 * Skips truthfully when the managed kernel interpreter or restore.py is absent on this host.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";

import {
	expectedWorkbenchNotice,
	validateWorkbenchReport,
	WORKBENCH_LOADER_PATH_FROM_HOME,
} from "../../../contracts/context_efficiency_enforcement.contract.ts";
import { buildKernelEnv, type KernelCaps, type KernelSession } from "../src/bootstrap.ts";
import { KernelManagerAdapter } from "../src/extension.ts";
import { type KernelClock, KernelManager } from "../src/kernel.ts";
import { createRlmToolDefinition } from "../src/tool.ts";
import { createTransport } from "../src/transport.ts";

const REAL_HOME = os.homedir();
const KERNEL_PYTHON = join(REAL_HOME, ".omp", "agent", "kernel-venv", "bin", "python");
const REAL_LOADER = join(REAL_HOME, WORKBENCH_LOADER_PATH_FROM_HOME);
const liveTest = fs.existsSync(KERNEL_PYTHON) && fs.existsSync(REAL_LOADER) ? test : test.skip;

/** Globals restore.py itself defines; none may reach the kernel namespace (POST-CTX27-8). */
const LOADER_INTERNALS = ["ROOT", "MANIFEST", "fail", "check_mode", "LZMA_MAGIC"];

const clock: KernelClock = {
	now: () => Date.now(),
	schedule(fn: () => void, ms: number): () => void {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};

/** A temporary HOME holding a copy of Ketema's restore.py and an empty, correctly-moded snapshot folder. */
function makeHome(): string {
	const home = fs.mkdtempSync(join(os.tmpdir(), "omp-workbench-"));
	const loader = join(home, WORKBENCH_LOADER_PATH_FROM_HOME);
	fs.mkdirSync(dirname(loader), { recursive: true });
	fs.copyFileSync(REAL_LOADER, loader);
	const snapDir = join(home, ".omp", "agent", "repl-snapshots");
	fs.mkdirSync(snapDir, { recursive: true });
	fs.chmodSync(snapDir, 0o700);
	return home;
}

/** Writes one trusted snapshot `wb-probe-v1` binding `wb_probe() -> 42`, in restore.py's manifest schema. */
function writeProbeSnapshot(home: string, overrides: { sha256?: string } = {}): void {
	const snapDir = join(home, ".omp", "agent", "repl-snapshots");
	const file = join(snapDir, "wb_probe.dill");
	const script = [
		"import dill, platform, sys",
		"def wb_probe():",
		"    return 42",
		"open(sys.argv[1], 'wb').write(dill.dumps({'wb_probe': wb_probe}, protocol=4, recurse=True))",
		"print('.'.join(platform.python_version_tuple()[:2]), dill.__version__)",
	].join("\n");
	const proc = Bun.spawnSync([KERNEL_PYTHON, "-c", script, file]);
	if (proc.exitCode !== 0) throw new Error(`fixture: snapshot write failed: ${proc.stderr.toString()}`);
	const [pythonVersion, dillVersion] = proc.stdout.toString().trim().split(" ");
	fs.chmodSync(file, 0o600);
	const blob = fs.readFileSync(file);
	const manifest = {
		schema_version: 1,
		snapshots: [
			{
				id: "wb-probe-v1",
				file: "wb_probe.dill",
				names: ["wb_probe"],
				expected_types: { wb_probe: "callable" },
				python_version: pythonVersion,
				dill_version: dillVersion,
				byte_size: blob.length,
				sha256: overrides.sha256 ?? createHash("sha256").update(blob).digest("hex"),
				compression: "raw",
				auto_restore: true,
			},
		],
	};
	const manifestPath = join(snapDir, "manifest.json");
	fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
	fs.chmodSync(manifestPath, 0o600);
}

/** The real start path: transport + KernelManager, with the kernel process's HOME set to `home`. */
function makeStack(home: string) {
	const artifactsDir = join(home, "artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true });
	const session: KernelSession = {
		sessionDir: artifactsDir,
		harnessDir: join(artifactsDir, "harness"),
		globalHarnessDir: join(home, ".omp", "agent", "harness"),
		agentDir: join(home, ".omp", "agent"),
		depth: 0,
		maxDepth: 1,
	};
	const caps: KernelCaps = { maxOutputChars: 65536, snapshotMaxBytes: 256 * 1024 * 1024 };
	const env = { ...buildKernelEnv(session, caps), HOME: home };
	const transport = createTransport({ interpreter: KERNEL_PYTHON, env, cwd: home, artifactsDir });
	return { transport, manager: new KernelManager(transport, { clock, artifactsDir }) };
}

describe("workbench loads at kernel start (REQ-CTX27-16)", () => {
	liveTest(
		"SEQ-CTX27-6 / POST-CTX27-8: the first cell already sees the restored helper, and only the helper",
		async () => {
			// Risk tier: HIGH — every fresh session depends on this; Ketema's test session found an empty workbench.
			const home = makeHome();
			writeProbeSnapshot(home);
			const { manager } = makeStack(home);
			try {
				const first = await manager.execute(
					`import json\nprint(json.dumps({"probe": wb_probe(), "leaked": sorted(n for n in ${JSON.stringify(LOADER_INTERNALS)} if n in globals())}))`,
				);
				expect(
					first.status,
					"SEQ-CTX27-6 violation: the first cell could not call the helper restore.py restores\n" +
						"EXPECTED: status ok — wb_probe is bound before the first cell runs\n" +
						`ACTUAL: status=${first.status} ename=${first.errorEname} traceback=${first.traceback}\n` +
						"GUIDANCE: kernel start must run restore.py inside the kernel before any cell executes",
				).toBe("ok");
				expect(
					JSON.parse(first.stdout.trim()),
					"POST-CTX27-8 violation: helper result or namespace is wrong\n" +
						'EXPECTED: {"probe":42,"leaked":[]} — the helper works and no restore.py global is bound\n' +
						`ACTUAL: ${first.stdout.trim()}\n` +
						"GUIDANCE: bind only the names restore.py restored",
				).toEqual({ probe: 42, leaked: [] });
				expect(
					validateWorkbenchReport(manager.workbenchReport()),
					"POST-CTX27-8 violation: the workbench report does not list exactly the restored names\n" +
						'EXPECTED: {"loaded":["wb_probe"],"refused":[],"error":null}\n' +
						"GUIDANCE: report what restore.py restored",
				).toEqual({ loaded: ["wb_probe"], refused: [], error: null });
			} finally {
				await manager.dispose({ snapshot: false });
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		60_000,
	);

	liveTest(
		"ERRORS-CTX27-3: a refused snapshot is reported and the kernel still runs cells",
		async () => {
			// Risk tier: HIGH — a bad snapshot must never leave a fresh session without a working kernel.
			const home = makeHome();
			writeProbeSnapshot(home, { sha256: "0".repeat(64) });
			const { manager } = makeStack(home);
			try {
				const first = await manager.execute(`print(2 + 2, "wb_probe" in globals())`);
				expect(
					{ status: first.status, stdout: first.stdout.trim() },
					"ERRORS-CTX27-3 violation: the kernel is not usable after restore.py refused a snapshot\n" +
						'EXPECTED: {"status":"ok","stdout":"4 False"}\n' +
						`ACTUAL: status=${first.status} stdout=${first.stdout.trim()} traceback=${first.traceback}\n` +
						"GUIDANCE: a refusal must not stop kernel start or bind the refused names",
				).toEqual({ status: "ok", stdout: "4 False" });
				expect(
					validateWorkbenchReport(manager.workbenchReport()),
					"ERRORS-CTX27-3 violation: the refused record is not reported with its reason\n" +
						'EXPECTED: {"loaded":[],"refused":[{"record":"wb-probe-v1","reason":"sha256 mismatch"}],"error":null}\n' +
						"GUIDANCE: report every record restore.py refused, with restore.py's reason",
				).toEqual({ loaded: [], refused: [{ record: "wb-probe-v1", reason: "sha256 mismatch" }], error: null });
			} finally {
				await manager.dispose({ snapshot: false });
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		60_000,
	);
});

/** A tool-call context with no UI: the kernel start and the first cell run without any prompt. */
const toolContext = {
	hasUI: false,
	setWorkingMessage: (_message?: string): void => {},
	ui: { select: async (): Promise<string | undefined> => undefined },
};

/** The real tool path: tool definition over the real adapter, kernel and transport. */
function makeTool(home: string) {
	const { transport, manager } = makeStack(home);
	return { manager, tool: createRlmToolDefinition({ kernel: new KernelManagerAdapter(transport, manager) }) };
}

describe("workbench notice on the first ipython call (REQ-CTX27-18)", () => {
	liveTest(
		"POST-CTX27-9: the first ipython call shows exactly one notice naming the loaded helper",
		async () => {
			// Risk tier: HIGH — the notice is how Ketema and the model learn what is on the workbench.
			const home = makeHome();
			writeProbeSnapshot(home);
			const { manager, tool } = makeTool(home);
			try {
				const first = await tool.execute(
					"call-1",
					{ code: "print('cell-output')" },
					undefined,
					undefined,
					toolContext,
				);
				const text = first.content.map(part => part.text).join("\n");
				const expected = expectedWorkbenchNotice(validateWorkbenchReport(manager.workbenchReport()));
				expect(
					expected,
					"POST-CTX27-9 oracle check: the contracted notice for a clean load of one helper is not the agreed line\n" +
						'EXPECTED: "Workbench ready: wb_probe"\n' +
						`ACTUAL: ${JSON.stringify(expected)}\n` +
						"GUIDANCE: the notice lists the loaded helper names",
				).toBe("Workbench ready: wb_probe");
				expect(
					{
						notices: text.split("Workbench ready:").length - 1,
						exact: text.split(expected).length - 1,
						ranCell: text.includes("cell-output"),
					},
					"POST-CTX27-9 violation: the first ipython call does not show exactly one workbench notice\n" +
						'EXPECTED: {"notices":1,"exact":1,"ranCell":true} — one notice, equal to the contracted line, and the cell still ran\n' +
						`ACTUAL: first call text=${JSON.stringify(text)}\n` +
						"GUIDANCE: the first call of a session reports what the workbench loaded, once",
				).toEqual({ notices: 1, exact: 1, ranCell: true });
			} finally {
				await manager.dispose({ snapshot: false });
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		60_000,
	);

	liveTest(
		"ERRORS-CTX27-3: a missing restore.py is named in the single notice and the cell still runs",
		async () => {
			// Risk tier: HIGH — a fresh session with no loader must say so, not look like an empty workbench.
			const home = makeHome();
			fs.rmSync(join(home, WORKBENCH_LOADER_PATH_FROM_HOME));
			const { manager, tool } = makeTool(home);
			try {
				const first = await tool.execute("call-1", { code: "print(2 + 2)" }, undefined, undefined, toolContext);
				const text = first.content.map(part => part.text).join("\n");
				const report = validateWorkbenchReport(manager.workbenchReport());
				const expected = expectedWorkbenchNotice(report);
				expect(
					report.error,
					"ERRORS-CTX27-3 precondition: the kernel did not record why the loader could not run\n" +
						"EXPECTED: a non-empty cause in the report's error\n" +
						`ACTUAL: ${JSON.stringify(report.error)}\n` +
						"GUIDANCE: a missing loader is reported as a cause, not as an empty workbench",
				).not.toBeNull();
				expect(
					{
						notices: text.split("Workbench ready:").length - 1,
						exact: text.split(expected).length - 1,
						ranCell: text.includes("4"),
					},
					"ERRORS-CTX27-3 violation: the first ipython call does not name the loader failure in one notice\n" +
						'EXPECTED: {"notices":1,"exact":1,"ranCell":true} — one notice that names the cause, and the cell still ran\n' +
						`ACTUAL: first call text=${JSON.stringify(text)} expected notice=${JSON.stringify(expected)}\n` +
						"GUIDANCE: when the loader cannot run the session still starts, and the notice says why",
				).toEqual({ notices: 1, exact: 1, ranCell: true });
			} finally {
				await manager.dispose({ snapshot: false });
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
