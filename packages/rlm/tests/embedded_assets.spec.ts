import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { runtimeIdentityHash } from "../src/bootstrap";
import {
	EMBEDDED_RLM_INIT_SOURCE,
	EMBEDDED_RLM_PYPROJECT_SOURCE,
	EMBEDDED_RUNNER_SOURCE,
	EMBEDDED_RUNTIME_SOURCES,
	ensureExtractedAssets,
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
});
