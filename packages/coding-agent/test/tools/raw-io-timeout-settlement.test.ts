import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as client from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import {
	RAW_IO_SETTLE_KILL_WAIT_FN_NAME,
	type RawIoTimeoutRequest,
	type RawIoTimeoutSettlementInput,
} from "../../../../contracts/raw_io_helper.contract";

function evidence(what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		"2. WHY: ERRORS-RAWIO-1c violation",
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Settle every affected request despite failed write-block registration, without retry or floating rejection",
	].join("\n");
}

it.skipIf(process.getuid?.() === 0)(
	"settles active and queued native promises when real registration fails with EACCES (#17b)",
	async () => {
		/* CAR: contracts/raw_io_helper.contract.ts ERRORS-RAWIO-1c, verification=test.
		 * HIGH-risk owner-boundary unit regression. C1: explicit settlement/cause fields;
		 * C2: failed registration cannot leave requests pending; C3: unlike pure decision
		 * tests, executes the actual settlement owner and registrar; C4: real resolver failure.
		 * No registrar double. helperExited=false is the approved unit input, not a claim
		 * that a live unprivileged process survived SIGKILL. False-result caller wiring
		 * remains inspection; existing T4 tests exercise the real kill/exit path.
		 */
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-io-settlement-"));
		const denied = path.join(dir, "inaccessible");
		const target = path.join(denied, "active.db-journal");
		const queuedPaths = [
			path.join(dir, "queued-read.db-journal"),
			path.join(dir, "queued-classify.db-journal"),
		] as const;
		await fs.mkdir(denied);
		await fs.writeFile(target, "existing target\n");
		for (const queued of queuedPaths) await fs.writeFile(queued, "queued existing target\n");
		const exit = Promise.withResolvers<void>();
		let cancelWatchdog: (() => void) | undefined;
		await fs.chmod(denied, 0);
		try {
			let registrationError: unknown;
			try {
				client.registerUnexitedWriteTarget(target, exit.promise);
			} catch (error: unknown) {
				registrationError = error;
			}
			expect(
				registrationError instanceof Error && "code" in registrationError ? registrationError.code : undefined,
				evidence("real registrar positive control", "actual registrar raises EACCES", String(registrationError)),
			).toBe("EACCES");

			const owner: unknown = Reflect.get(client, RAW_IO_SETTLE_KILL_WAIT_FN_NAME);
			if (typeof owner !== "function") {
				throw new Error(evidence("production settlement owner", "contracted owner is callable", typeof owner));
			}
			const active = Promise.withResolvers<void>();
			const queuedRead = Promise.withResolvers<void>();
			const queuedClassify = Promise.withResolvers<void>();
			const activeRequest: RawIoTimeoutRequest = {
				operation: "write",
				targetPath: target,
				rejectTask: active.reject,
			};
			const queuedRequests: RawIoTimeoutRequest[] = [
				{ operation: "read", targetPath: queuedPaths[0], rejectTask: queuedRead.reject },
				{ operation: "classify", targetPath: queuedPaths[1], rejectTask: queuedClassify.reject },
			];
			const requests = [activeRequest, ...queuedRequests];
			const deferred = [active, queuedRead, queuedClassify];
			const rejectedQueueOrder: string[] = [];
			const observed = deferred.map((item, index) =>
				item.promise.then(
					() => ({ status: "fulfilled", error: undefined }),
					(error: unknown) => {
						const request = requests[index];
						if (index > 0 && request) rejectedQueueOrder.push(request.targetPath);
						return { status: "rejected", error };
					},
				),
			);
			const input: RawIoTimeoutSettlementInput = {
				activeRequest,
				queuedRequests,
				timeoutMs: 500,
				helperExited: false,
				exitPromise: exit.promise,
			};
			let thrown: unknown;
			let resolution: unknown;
			try {
				resolution = owner(input);
			} catch (error: unknown) {
				thrown = error;
			}
			// The watchdog bounds a broken promise-owner test, not a business clock.
			const outcomes = await Promise.race([
				Promise.all(observed),
				new Promise<"unsettled">(resolve => {
					const timer = setTimeout(() => resolve("unsettled"), 1000);
					cancelWatchdog = () => clearTimeout(timer);
				}),
			]);
			expect(
				thrown,
				evidence("registration failure ownership", "no escaping synchronous failure", String(thrown)),
			).toBeUndefined();
			expect(outcomes === "unsettled", evidence("request settlement", "all native promises settle", outcomes)).toBe(
				false,
			);
			if (outcomes === "unsettled") return;
			expect(
				resolution,
				evidence("fail-closed decision", "no retry and original blocked target", resolution),
			).toMatchObject({
				retryQueueOnFreshHelper: false,
				blockFutureWritesToTarget: target,
			});
			expect(
				outcomes.length,
				evidence("settled count", "all three requests are accounted for", outcomes.length),
			).toBe(requests.length);
			for (const [index, outcome] of outcomes.entries()) {
				const expected = requests[index];
				if (!expected) throw new Error(evidence("request fixture", "corresponding request identity", index));
				expect(outcome.status, evidence("request rejection", "each request rejects", outcome)).toBe("rejected");
				expect(
					outcome.error,
					evidence("exact error class", "RawIoHelperOperationError", String(outcome.error)),
				).toBeInstanceOf(client.RawIoHelperOperationError);
				expect(
					outcome.error,
					evidence("exact request identity", "scenario clause and caller request fields", outcome.error),
				).toMatchObject({
					clauseId: "ERRORS-RAWIO-1c",
					operation: expected.operation,
					targetPath: expected.targetPath,
					cause: { code: "EACCES" },
				});
			}
			expect(
				rejectedQueueOrder,
				evidence("queue order", "queued requests retain input order", rejectedQueueOrder),
			).toEqual([...queuedPaths]);
		} finally {
			cancelWatchdog?.();
			await fs.chmod(denied, 0o700);
			exit.resolve();
			await exit.promise;
			await client.stopRawIoHelper();
			await fs.rm(dir, { recursive: true, force: true });
		}
	},
	5000,
);
