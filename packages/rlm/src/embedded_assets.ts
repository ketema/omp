import * as fs from "node:fs";
import { dirname, join } from "node:path";
import runnerSource from "../python/rlm_kernel_runner.py" with { type: "text" };
import rlmRuntimePyprojectSource from "../python/rlm-runtime/pyproject.toml" with { type: "text" };
import rlmRuntimeInitSource from "../python/rlm-runtime/src/rlm/__init__.py" with { type: "text" };

export const EMBEDDED_RUNNER_SOURCE: string = runnerSource;
export const EMBEDDED_RLM_INIT_SOURCE: string = rlmRuntimeInitSource;
export const EMBEDDED_RLM_PYPROJECT_SOURCE: string = rlmRuntimePyprojectSource;

export const EMBEDDED_RUNTIME_SOURCES: Readonly<Record<string, string>> = Object.freeze({
	"runner.py": runnerSource,
	"rlm/__init__.py": rlmRuntimeInitSource,
});

export interface ExtractedAssets {
	readonly runnerScriptPath: string;
	readonly runtimePackagePath: string;
}

/**
 * Atomically writes content to targetPath if missing or modified,
 * avoiding partial writes or file corruption under concurrency.
 */
function writeIfChanged(targetPath: string, content: string, mode?: number): void {
	try {
		if (fs.existsSync(targetPath)) {
			const existing = fs.readFileSync(targetPath, "utf8");
			if (existing === content) {
				return;
			}
		}
	} catch {
		// Read error — proceed to overwrite atomically
	}
	fs.mkdirSync(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tempPath, content, mode !== undefined ? { mode } : undefined);
	fs.renameSync(tempPath, targetPath);
}

/**
 * Ensures the physical Python runner script and rlm-runtime package exist on disk
 * in the specified agent/target directory, extracted from the compiled bundle.
 */
export function ensureExtractedAssets(agentDir: string): ExtractedAssets {
	fs.mkdirSync(agentDir, { recursive: true });

	const runnerScriptPath = join(agentDir, "rlm_kernel_runner.py");
	writeIfChanged(runnerScriptPath, EMBEDDED_RUNNER_SOURCE, 0o755);

	const runtimePackagePath = join(agentDir, "rlm-runtime");
	const pyprojectPath = join(runtimePackagePath, "pyproject.toml");
	const initPath = join(runtimePackagePath, "src", "rlm", "__init__.py");

	writeIfChanged(pyprojectPath, EMBEDDED_RLM_PYPROJECT_SOURCE);
	writeIfChanged(initPath, EMBEDDED_RLM_INIT_SOURCE);

	return { runnerScriptPath, runtimePackagePath };
}
