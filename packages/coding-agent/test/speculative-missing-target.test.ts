import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSpeculativeReadTarget } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => removeWithRetries(directory)));
});

/** A workspace reached through a symlink, like the macOS temp directory behind a /private link. */
async function symlinkedWorkspace(): Promise<{ cwd: string; real: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-missing-"));
	directories.push(root);
	const real = path.join(root, "real-workspace");
	await fs.mkdir(real);
	const cwd = path.join(root, "linked-workspace");
	await fs.symlink(real, cwd, "dir");
	return { cwd, real };
}

describe("resolveSpeculativeReadTarget through a symlinked workspace (macOS regression)", () => {
	it("control: an existing file resolves inside the workspace", async () => {
		const { cwd, real } = await symlinkedWorkspace();
		await fs.writeFile(path.join(real, "present.txt"), "text\n");
		const result = await resolveSpeculativeReadTarget(cwd, "present.txt");
		expect(result).toEqual({ ok: true, resolved: path.join(await fs.realpath(real), "present.txt") });
	});

	it("reports a missing file as unavailable, not as outside the workspace", async () => {
		/* CAR: existing pinned behavior (read-speculation.test.ts, missing.txt -> 'local read path is unavailable')
		 * that the POST-RAWIO-3 resolver without realpath broke on macOS: a missing path comes back unresolved, so a
		 * symlinked workspace made it look outside the workspace and report 'unsafe'.
		 * C1: pinned reason strings; C2: Linux tmp has no symlink so the existing test passes there; C3: this
		 * test creates the symlinked workspace explicitly; C4: real resolver, real filesystem, no doubles.
		 */
		const { cwd } = await symlinkedWorkspace();
		const result = await resolveSpeculativeReadTarget(cwd, "missing.txt");
		expect(
			result,
			`1. WHAT: missing speculative target FAILED\n3. EXPECTED: unavailable\n4. ACTUAL: ${JSON.stringify(result)}`,
		).toEqual({ ok: false, reason: "local read path is unavailable" });
	});
});
