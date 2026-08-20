import * as fs from "node:fs";
import { join } from "node:path";
import runnerSource from "../python/rlm_kernel_runner.py" with { type: "text" };
import rlmRuntimePyprojectSource from "../python/rlm-runtime/pyproject.toml" with { type: "text" };
import rlmRuntimeInitSource from "../python/rlm-runtime/src/rlm/__init__.py" with { type: "text" };

export const EMBEDDED_RUNNER_SOURCE = runnerSource;
export const EMBEDDED_RLM_INIT_SOURCE = rlmRuntimeInitSource;
export const EMBEDDED_RLM_PYPROJECT_SOURCE = rlmRuntimePyprojectSource;

export const EMBEDDED_RUNTIME_SOURCES: Record<string, string> = {
	"runner.py": runnerSource,
	"rlm/__init__.py": rlmRuntimeInitSource,
};

export interface ExtractedAssets {
	readonly runnerScriptPath: string;
	readonly runtimePackagePath: string;
}

/**
 * Ensures the physical Python runner script and rlm-runtime package exist on disk
 * in the specified agent/target directory, extracted from the compiled bundle.
 */
export function ensureExtractedAssets(agentDir: string): ExtractedAssets {
	fs.mkdirSync(agentDir, { recursive: true });

	const runnerScriptPath = join(agentDir, "rlm_kernel_runner.py");
	let needsWriteRunner = true;
	try {
		if (fs.existsSync(runnerScriptPath)) {
			const existing = fs.readFileSync(runnerScriptPath, "utf8");
			if (existing === EMBEDDED_RUNNER_SOURCE) {
				needsWriteRunner = false;
			}
		}
	} catch {
		needsWriteRunner = true;
	}
	if (needsWriteRunner) {
		const tempPath = `${runnerScriptPath}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tempPath, EMBEDDED_RUNNER_SOURCE, { mode: 0o755 });
		fs.renameSync(tempPath, runnerScriptPath);
	}

	const runtimePackagePath = join(agentDir, "rlm-runtime");
	const runtimeSrcDir = join(runtimePackagePath, "src", "rlm");
	fs.mkdirSync(runtimeSrcDir, { recursive: true });

	const pyprojectPath = join(runtimePackagePath, "pyproject.toml");
	fs.writeFileSync(pyprojectPath, EMBEDDED_RLM_PYPROJECT_SOURCE, "utf8");

	const initPath = join(runtimeSrcDir, "__init__.py");
	fs.writeFileSync(initPath, EMBEDDED_RLM_INIT_SOURCE, "utf8");

	return { runnerScriptPath, runtimePackagePath };
}
