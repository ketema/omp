/**
 * Workbench start (REQ-CTX27-16, ketema/omp#27).
 *
 * At kernel start the KernelManager runs WORKBENCH_LOAD_CELL inside the kernel (SEQ-CTX27-6). The cell runs
 * Ketema's restore.py in a private namespace, binds into the kernel's globals only the names restore.py reports as
 * restored (POST-CTX27-8), and prints one JSON report line. Failures never stop the kernel: they are reported
 * (ERRORS-CTX27-3).
 */

/** Z8: the loader, relative to the kernel process's HOME. */
export const WORKBENCH_LOADER_PATH_FROM_HOME = ".agents/skills/repl-snapshots/restore.py";

export interface WorkbenchRefusal {
	readonly record: string;
	readonly reason: string;
}

export interface WorkbenchReport {
	readonly loaded: readonly string[];
	readonly refused: readonly WorkbenchRefusal[];
	/** Why restore.py could not run, or produced output it does not define; null when it ran cleanly. */
	readonly error: string | null;
}

export const WORKBENCH_LOAD_CELL = [
	"def __omp_load_workbench():",
	"    import contextlib, io, json",
	"    from pathlib import Path",
	`    loader = Path.home() / ${JSON.stringify(WORKBENCH_LOADER_PATH_FROM_HOME)}`,
	'    report = {"loaded": [], "refused": [], "error": None}',
	'    private = {"__name__": "__omp_workbench__"}',
	"    out = io.StringIO()",
	"    try:",
	"        source = loader.read_text()",
	"        with contextlib.redirect_stdout(out):",
	"            exec(compile(source, str(loader), 'exec'), private)",
	"    except Exception as exc:",
	'        report["error"] = f"{type(exc).__name__}: {exc}"',
	"    for line in out.getvalue().splitlines():",
	"        try:",
	"            event = json.loads(line)",
	"        except ValueError:",
	'            report["error"] = f"unexpected loader output: {line[:80]}"',
	"            continue",
	'        if event.get("snapshot_restore") == "restored":',
	'            for name in event["names"]:',
	"                globals()[name] = private[name]",
	'                report["loaded"].append(name)',
	'        elif event.get("snapshot_restore") == "refused":',
	'            report["refused"].append({"record": str(event.get("record")), "reason": str(event.get("reason"))})',
	"    print(json.dumps(report))",
	"__omp_load_workbench()",
	"del __omp_load_workbench",
].join("\n");

/** Reads the report line the cell printed. A cell that failed or printed no valid report becomes a report carrying the cause. */
export function parseWorkbenchReport(result: {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly traceback?: string;
}): WorkbenchReport {
	if (result.code !== 0) {
		const cause = (result.traceback ?? result.stderr).trim().split("\n").pop() ?? "workbench cell failed";
		return { loaded: [], refused: [], error: cause };
	}
	const last = result.stdout.trim().split("\n").pop() ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(last);
	} catch {
		parsed = undefined;
	}
	if (isWorkbenchReport(parsed)) return parsed;
	return { loaded: [], refused: [], error: `no workbench report in kernel output: ${last.slice(0, 80)}` };
}

function isWorkbenchReport(value: unknown): value is WorkbenchReport {
	if (value === null || typeof value !== "object") return false;
	const { loaded, refused, error } = value as Record<string, unknown>;
	return (
		Array.isArray(loaded) &&
		loaded.every(n => typeof n === "string") &&
		Array.isArray(refused) &&
		refused.every(
			r =>
				r !== null &&
				typeof r === "object" &&
				typeof (r as Record<string, unknown>).record === "string" &&
				typeof (r as Record<string, unknown>).reason === "string",
		) &&
		(error === null || typeof error === "string")
	);
}
