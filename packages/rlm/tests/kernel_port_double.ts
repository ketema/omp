/**
 * The one complete test double for the extension's kernel port (RlmExtensionKernelPort).
 *
 * CL13: a double is trusted only while it has the same shape as the real provider. This one implements EVERY port method,
 * and kernel_port_parity.spec.ts fails when the real KernelManagerAdapter gains a method (or changes its arity) that this
 * double lacks. Specs that need scripted behavior spread it first (`{ ...completePortDouble(), ...scripted }`), so a method
 * the port gains later cannot silently go missing from their doubles.
 */
import type { RlmExtensionKernelPort } from "../src/extension.ts";

export interface PortDouble extends RlmExtensionKernelPort {
	/** Every directory the extension retargeted this kernel to, in order. */
	readonly retargets: string[];
	/** How many times the extension disposed this kernel. */
	disposals(): number;
}

export function completePortDouble(script: { retargetFails?: boolean } = {}): PortDouble {
	const retargets: string[] = [];
	let disposed = 0;
	return {
		retargets,
		disposals: () => disposed,
		async ensureStarted() {},
		async execute() {
			return {
				status: "ok" as const,
				stdout: "",
				stderr: "",
				result: "",
				traceback: undefined,
				errorEname: undefined,
				durationMs: 1,
				kernelRestarted: undefined,
			};
		},
		async kill() {},
		async dispose() {
			disposed++;
		},
		async retarget(dir: string) {
			retargets.push(dir);
			if (script.retargetFails) throw new Error("the retarget flush could not settle");
		},
		async flushSnapshot() {},
		restoredNames: () => [],
		restoredSkipped: () => [],
		async onCompactionComplete() {},
		compactionNotice: () => null,
		takeTeardownNotice: () => null,
	};
}
