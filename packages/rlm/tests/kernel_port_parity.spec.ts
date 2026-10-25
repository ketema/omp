/**
 * CL13 parity and wiring for the extension's kernel-port double (tests/kernel_port_double.ts).
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered: POST-SESSION-MOVE-3 (the extension retargets the live port to the new owned directory, surfaces a
 *   flush that cannot settle, and never disposes it on a same-session move), POST-SESSION-OWNED-DIR-1 (the directory it
 *   retargets to is the one the host resolved)
 * - Provider the double stands in for: KernelManagerAdapter (src/extension.ts), the real implementation of the port.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { KernelManagerAdapter } from "../src/extension.ts";
import { completePortDouble } from "./kernel_port_double.ts";
import { openRealSession } from "./real_extension.ts";

function realProviderMethods(): string[] {
	return Object.getOwnPropertyNames(KernelManagerAdapter.prototype)
		.filter(name => name !== "constructor" && !name.startsWith("_"))
		.sort();
}

describe("the kernel-port double has the real provider's shape", () => {
	test("every public method of the real adapter exists on the double", () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites CL13 (a double must match its provider) for the port POST-SESSION-MOVE-3 extends
		 *   [x] C2 VALUABLE: a port method added to the adapter and not to the double fails this test (the drift that left
		 *       five specs' doubles without `retarget`)
		 *   [x] C3 NON-DUPLICATIVE: no other test compares the double with the provider
		 *   [x] C4 NOT FUTURE-EDIT: it fails only when the provider and double disagree today
		 */
		const double = completePortDouble() as unknown as Record<string, unknown>;
		const missing = realProviderMethods().filter(name => typeof double[name] !== "function");
		expect(
			missing,
			`CL13 violation: the port double lacks real-provider methods\nEXPECTED: every method of KernelManagerAdapter on the double\nACTUAL missing: ${missing.join(", ")}\nGUIDANCE: add the method to tests/kernel_port_double.ts with the provider's observable behavior`,
		).toEqual([]);
	});
});

describe("POST-SESSION-MOVE-3: the extension's use of the port on a same-session move", () => {
	function scratch(label: string) {
		const root = fs.mkdtempSync(join(os.tmpdir(), `rlm-port-parity-${label}-`));
		const oldDir = join(root, "old");
		const newDir = join(root, "new");
		fs.mkdirSync(oldDir);
		fs.mkdirSync(newDir);
		return { root, oldDir, newDir };
	}

	test("a move retargets the live port to the resolved directory and never disposes it", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-MOVE-3
		 *   [x] C2 VALUABLE: an extension that disposes (the old behavior) or retargets a different directory fails
		 *   [x] C3 NON-DUPLICATIVE: move_live_kernel.spec.ts proves the effect on a real kernel; this proves the call the
		 *       extension makes on the port, with the exact directory
		 *   [x] C4 NOT FUTURE-EDIT: bounds the wiring the extension performs today
		 */
		const { root, oldDir, newDir } = scratch("retarget");
		const port = completePortDouble();
		const session = await openRealSession(root, oldDir, { createKernel: () => port });
		await session.start();
		await session.run("x = 1"); // starts the kernel so a move finds it live

		await session.emit("session_switch", { reason: "move" }, newDir);

		expect(
			port.retargets,
			"POST-SESSION-MOVE-3 violation: the live port was not retargeted to the resolved directory",
		).toEqual([newDir]);
		expect(port.disposals(), "POST-SESSION-MOVE-3 violation: a same-session move disposed the kernel").toBe(0);
		expect(session.warnings, "POST-SESSION-MOVE-3 violation: a clean retarget raised a warning").toEqual([]);
	});

	test("a flush that cannot settle is surfaced as a warning and the kernel stays live", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-MOVE-3 (c): an abandoned flush is an observable warning, never silent
		 *   [x] C2 VALUABLE: an extension that swallows the failure, or disposes the kernel because of it, fails
		 *   [x] C3 NON-DUPLICATIVE: the real-kernel spec reaches this only through a 5s timeout; this drives the failure directly
		 *   [x] C4 NOT FUTURE-EDIT: bounds the failure handling the extension performs today
		 */
		const { root, oldDir, newDir } = scratch("failure");
		const port = completePortDouble({ retargetFails: true });
		const session = await openRealSession(root, oldDir, { createKernel: () => port });
		await session.start();
		await session.run("x = 1");

		await session.emit("session_switch", { reason: "move" }, newDir);

		expect(session.warnings.length, "POST-SESSION-MOVE-3 violation: a failed flush was not surfaced").toBe(1);
		expect(
			session.warnings[0],
			"POST-SESSION-MOVE-3 violation: the warning must name the failed flush and its cause",
		).toContain("Snapshot flush after the session move failed: the retarget flush could not settle");
		expect(port.disposals(), "POST-SESSION-MOVE-3 violation: a failed flush disposed the live kernel").toBe(0);
		expect(await session.run("x"), "the kernel must still answer after the failed flush").toBeDefined();
	});

	test("a move with no live kernel starts nothing and retargets nothing", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-MOVE-3 (no kernel is live at the move: there is nothing to retarget)
		 *   [x] C2 VALUABLE: an extension that creates a kernel on a move, or calls a retarget on nothing, fails
		 *   [x] C3 NON-DUPLICATIVE: no other test emits a move before any kernel exists
		 *   [x] C4 NOT FUTURE-EDIT: bounds the behavior the contract now states
		 */
		const { root, oldDir, newDir } = scratch("nokernel");
		let constructed = 0;
		const port = completePortDouble();
		const session = await openRealSession(root, oldDir, {
			createKernel: () => {
				constructed++;
				return port;
			},
		});
		await session.start(); // no cell ran: the kernel is lazy and not live

		await session.emit("session_switch", { reason: "move" }, newDir);

		expect(port.retargets, "POST-SESSION-MOVE-3 violation: a retarget was issued with no live kernel").toEqual([]);
		expect(constructed, "POST-SESSION-MOVE-3 violation: a move built a kernel nobody asked for").toBe(0);
	});
});
