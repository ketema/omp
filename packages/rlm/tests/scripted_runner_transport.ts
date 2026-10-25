/**
 * A behavioral substitute for the real transport PLUS the Python runner behind it, for specs that need a "kernel" whose
 * namespace follows a snapshot across a session relocation without starting Python.
 *
 * CL13 classification: this is a provider substitute (not a wire input fixture). Its relocation behavior is pinned to the
 * real transport's in transport.spec.ts ("scripted runner transport parity live"): after setArtifactsDir(dir), a
 * snapshot lands in `dir` and not in the old directory, and a second instance restores the namespace from `dir`.
 *
 * The Python process, scripted: `name=N` sets a variable, a bare `name` reports it.
 */
import * as fs from "node:fs";
import { join } from "node:path";

import type { KernelTransport } from "../src/kernel.ts";

export function scriptedRunnerTransport(initialDir: string): KernelTransport & { setArtifactsDir(next: string): void } {
	let dir = initialDir;
	const namespace: Record<string, number> = {};
	return {
		// What the real transport offers a manager that relocates a kernel.
		setArtifactsDir(next) {
			dir = next;
		},
		start() {},
		async execute(_id, code) {
			const assignment = /^(\w+)=(\d+)$/.exec(code);
			if (assignment) {
				namespace[assignment[1]] = Number(assignment[2]);
				return { code: 0, stdout: "", stderr: "", result: "" };
			}
			return { code: 0, stdout: `${code}=${namespace[code]}`, stderr: "", result: "" };
		},
		interrupt() {},
		kill() {},
		onOutput() {},
		async snapshotNames() {
			return Object.keys(namespace);
		},
		// The real runner writes the payload into the transport's own directory.
		async writeSnapshot() {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(join(dir, "kernel-state.dill"), JSON.stringify(namespace));
			return { bytes: 1, skipped: [] };
		},
		async restoreSnapshot() {
			const payload = join(dir, "kernel-state.dill");
			if (!fs.existsSync(payload)) return [];
			Object.assign(namespace, JSON.parse(fs.readFileSync(payload, "utf8")) as Record<string, number>);
			return Object.keys(namespace);
		},
		bootstrap() {},
		isBusy: () => false,
		alive: () => true,
		dispose() {},
	};
}
