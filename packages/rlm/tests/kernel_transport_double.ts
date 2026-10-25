/**
 * The behavioral substitute for the real KernelTransport (RlmTransport) used by the manager specs.
 *
 * CL13 classification: this IS a provider substitute (unlike transport.spec.ts's makeFakeProcess, which is an adversarial
 * wire input fixture). Its parity with the real transport is pinned in transport.spec.ts ("KernelTransport double
 * parity"): every public method of the real transport exists here (optional interface members only when scripted), and
 * the observable results of the calls it answers have the shapes the real runner returns.
 *
 * Scripted AT CONSTRUCTION; records every call.
 */
import type { KernelSnapshotWriteResult } from "../src/kernel.ts";

export interface TransportResult {
	code: number;
	stdout: string;
	stderr: string;
	result: string;
	traceback?: string;
	errorEname?: string;
}

export interface TransportScript {
	start?: () => Promise<void> | void;
	execute?: (id: string, code: string, call: number) => Promise<TransportResult>;
	snapshotNames?: () => Promise<string[]>;
	writeSnapshot?: (names: string[], maxBytes: number) => Promise<KernelSnapshotWriteResult>;
	/** Snapshot payload write at the FS boundary. */
	writeSnapshotPayload?: (dir: string) => Promise<void>;
	restoreSnapshot?: () => Promise<string[]>;
	isBusy?: () => boolean;
	/** Kernel Python version for the snapshot manifest (POST-KM-SNAPSHOT-PAIR-1). */
	pythonVersion?: () => Promise<string>;
	/** Optional interface members: present on the double only when scripted. */
	setArtifactsDir?: (dir: string) => void;
	discardSnapshotStage?: () => void;
	shutdown?: () => Promise<void> | void;
}

type OutputListener = (output: { id: string; stream: "stdout" | "stderr"; data: string }) => void;

export function makeScriptedTransport(script: TransportScript = {}) {
	const calls: Array<{ kind: string; detail: string }> = [];
	const listeners: OutputListener[] = [];
	let execCount = 0;
	return {
		calls,
		emit(id: string, stream: "stdout" | "stderr", data: string) {
			for (const listener of listeners) listener({ id, stream, data });
		},
		async start(): Promise<void> {
			calls.push({ kind: "start", detail: "" });
			await script.start?.();
		},
		async execute(id: string, code: string): Promise<TransportResult> {
			execCount += 1;
			calls.push({ kind: "execute", detail: `${id}:${code}` });
			const result = await script.execute?.(id, code, execCount);
			return result ?? { code: 0, stdout: "", stderr: "", result: "" };
		},
		interrupt() {
			calls.push({ kind: "interrupt", detail: "" });
		},
		kill() {
			calls.push({ kind: "kill", detail: "" });
		},
		onOutput(callback: OutputListener) {
			listeners.push(callback);
		},
		async snapshotNames(): Promise<string[]> {
			calls.push({ kind: "snapshotNames", detail: "" });
			return await (script.snapshotNames?.() ?? Promise.resolve(["a", "b"]));
		},
		async writeSnapshot(
			names: string[],
			maxBytes: number,
		): Promise<{ bytes: number; skipped: { name: string; reason: string }[] }> {
			calls.push({ kind: "writeSnapshot", detail: names.join(",") });
			return await (script.writeSnapshot?.(names, maxBytes) ?? Promise.resolve({ bytes: 10, skipped: [] }));
		},
		async restoreSnapshot(): Promise<string[]> {
			calls.push({ kind: "restoreSnapshot", detail: "" });
			return await (script.restoreSnapshot?.() ?? Promise.resolve(["a", "b"]));
		},
		async bootstrap(): Promise<void> {
			calls.push({ kind: "bootstrap", detail: "" });
		},
		isBusy(): boolean {
			return script.isBusy?.() ?? false;
		},
		...(script.writeSnapshotPayload !== undefined
			? {
					writeSnapshotPayload: (dir: string): Promise<void> =>
						script.writeSnapshotPayload?.(dir) ?? Promise.resolve(),
				}
			: {}),
		...(script.pythonVersion !== undefined
			? { pythonVersion: (): Promise<string> => script.pythonVersion?.() ?? Promise.resolve("") }
			: {}),
		...(script.setArtifactsDir !== undefined
			? { setArtifactsDir: (dir: string): void => script.setArtifactsDir?.(dir) }
			: {}),
		...(script.discardSnapshotStage !== undefined
			? { discardSnapshotStage: (): void => script.discardSnapshotStage?.() }
			: {}),
		...(script.shutdown !== undefined ? { shutdown: (): Promise<void> | void => script.shutdown?.() } : {}),
		alive(): boolean {
			return true;
		},
		async dispose(): Promise<void> {
			calls.push({ kind: "transportDispose", detail: "" });
		},
	};
}
