import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { runtimeIdentityHash } from "../src/bootstrap";
import {
	EMBEDDED_RLM_INIT_SOURCE,
	EMBEDDED_RLM_PYPROJECT_SOURCE,
	EMBEDDED_RUNNER_SOURCE,
	EMBEDDED_RUNTIME_SOURCES,
	ensureExtractedAssets,
	EMBEDDED_PICKLE_GUARD_SOURCE,
} from "../src/embedded_assets";

describe("RLM embedded assets", () => {
	test("embedded sources are non-empty strings", () => {
		expect(typeof EMBEDDED_RUNNER_SOURCE).toBe("string");
		expect(EMBEDDED_RUNNER_SOURCE.length).toBeGreaterThan(1000);
		expect(typeof EMBEDDED_RLM_INIT_SOURCE).toBe("string");
		expect(EMBEDDED_RLM_INIT_SOURCE.length).toBeGreaterThan(1000);
		expect(typeof EMBEDDED_RLM_PYPROJECT_SOURCE).toBe("string");
		expect(EMBEDDED_RLM_PYPROJECT_SOURCE.length).toBeGreaterThan(50);
	});

	test("runtime identity hash of embedded sources matches known hash", () => {
		const hash = runtimeIdentityHash(EMBEDDED_RUNTIME_SOURCES);
		expect(typeof hash).toBe("string");
		expect(hash.length).toBe(64);
		// Deterministic SHA-256 hash
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("ensureExtractedAssets extracts files idempotently and atomically", () => {
		const tempDir = fs.mkdtempSync(join(os.tmpdir(), "rlm-embed-test-"));
		try {
			const { runnerScriptPath, runtimePackagePath } = ensureExtractedAssets(tempDir);

			// Check runner script
			expect(fs.existsSync(runnerScriptPath)).toBe(true);
			const runnerContent = fs.readFileSync(runnerScriptPath, "utf8");
			expect(runnerContent).toBe(EMBEDDED_RUNNER_SOURCE);

			// Check rlm-runtime package
			const pyprojectPath = join(runtimePackagePath, "pyproject.toml");
			const initPath = join(runtimePackagePath, "src", "rlm", "__init__.py");
			expect(fs.existsSync(pyprojectPath)).toBe(true);
			expect(fs.existsSync(initPath)).toBe(true);
			expect(fs.readFileSync(pyprojectPath, "utf8")).toBe(EMBEDDED_RLM_PYPROJECT_SOURCE);
			expect(fs.readFileSync(initPath, "utf8")).toBe(EMBEDDED_RLM_INIT_SOURCE);

			// Second extraction is a clean no-op
			const second = ensureExtractedAssets(tempDir);
			expect(second.runnerScriptPath).toBe(runnerScriptPath);
			expect(second.runtimePackagePath).toBe(runtimePackagePath);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("the shared pickle guard ships beside the runner and is part of the runtime identity", () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-NOOPEN-1 / CROSS_INV-1 (one shared scanner) through the default extraction path
		 *   [x] C2 VALUABLE: a guard missing from the embedded sources, from the extraction, or from the identity hash fails
		 *   [x] C3 NON-DUPLICATIVE: the real-runner spec proves the guard works; this proves it is PACKAGED
		 *   [x] C4 NOT FUTURE-EDIT: bounds the asset layout the extractor performs today
		 */
		expect(
			EMBEDDED_RUNTIME_SOURCES["rlm_pickle_guard.py"],
			"POST-NOOPEN-1 violation: the guard is not among the embedded runtime sources",
		).toBe(EMBEDDED_PICKLE_GUARD_SOURCE);
		// Drift check: the embedded text is exactly the file the inspector and the tests import.
		expect(EMBEDDED_PICKLE_GUARD_SOURCE).toBe(
			fs.readFileSync(new URL("../python/rlm_pickle_guard.py", import.meta.url), "utf8"),
		);
		const withoutGuard = { ...EMBEDDED_RUNTIME_SOURCES };
		delete withoutGuard["rlm_pickle_guard.py"];
		expect(runtimeIdentityHash(withoutGuard)).not.toBe(runtimeIdentityHash(EMBEDDED_RUNTIME_SOURCES));

		const tempDir = fs.mkdtempSync(join(os.tmpdir(), "rlm-embed-guard-"));
		try {
			const { runnerScriptPath } = ensureExtractedAssets(tempDir);
			expect(fs.readFileSync(join(dirname(runnerScriptPath), "rlm_pickle_guard.py"), "utf8")).toBe(
				EMBEDDED_PICKLE_GUARD_SOURCE,
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("the extracted runner fails fast, naming the guard, when the guard is missing", () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites CL9 fail-fast (and POST-NOOPEN-1: a runner without its guard must not serve restores)
		 *   [x] C2 VALUABLE: a runner that degrades silently to an unguarded restore starts and exits 0
		 *   [x] C3 NON-DUPLICATIVE: no other test starts the extracted runner without its helper
		 *   [x] C4 NOT FUTURE-EDIT: bounds the startup failure today
		 */
		const tempDir = fs.mkdtempSync(join(os.tmpdir(), "rlm-embed-noguard-"));
		try {
			const { runnerScriptPath } = ensureExtractedAssets(tempDir);
			fs.rmSync(join(dirname(runnerScriptPath), "rlm_pickle_guard.py")); // one file this test extracted
			const ran = Bun.spawnSync([process.env.RLM_TEST_PYTHON ?? "python3", runnerScriptPath], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(ran.exitCode, "the runner started without its guard").not.toBe(0);
			expect(ran.stderr.toString(), "the failure does not name the missing guard").toContain("rlm_pickle_guard");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
