import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyRawIoTarget,
	RawIoHelperOperationError,
	stopRawIoHelper,
} from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { SQLITE_HEADER_MAGIC, type RawIoHelperClauseId } from "../../../../contracts/raw_io_helper.contract";

function evidence(clause: RawIoHelperClauseId, what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		`2. WHY: ${clause} violation`,
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Preserve actual provider evidence and settle public operation failures without process-fatal rejection",
	].join("\n");
}

describe("Raw-I/O error-boundary regressions (audit #4/#17)", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-io-errors-"));
	});
	afterEach(async () => {
		await stopRawIoHelper();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("rejects sqlite_db evidence whose real-worker header bytes are missing (#4/#23)", async () => {
		/* Enforces POST-RAWIO-1 / ERRORS-RAWIO-1e, HIGH-risk IPC boundary regression.
		 * C1: actual header and exact rejection identity; C2: current rejection has the wrong clauseId;
		 * C3: malformed response differs from normal classification; C4: existing provider boundary.
		 * The provider is the real worker. Its construction-time transport records its actual
		 * header and then supplies the specified malformed response; no successful provider fake.
		 */
		const target = path.join(dir, "header.db");
		const receipt = path.join(dir, "provider-header.json");
		const scriptPath = path.join(dir, "missing-header.mjs");
		const workerModule = path.resolve(import.meta.dir, "../../src/tools/raw-io-worker.ts");
		await fs.writeFile(target, SQLITE_HEADER_MAGIC);
		await fs.writeFile(
			scriptPath,
			[
				`import * as fs from "node:fs";`,
				`import {startRawIoWorker} from ${JSON.stringify(workerModule)};`,
				`startRawIoWorker({onMessage(handler){process.on("message",handler);},send(message){`,
				` if(message.type==="classified"&&message.classification.kind==="sqlite_db"){`,
				`  fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(Array.from(message.classification.headerBytes)));`,
				`  process.send({...message,classification:{...message.classification,headerBytes:new Uint8Array(0)}});`,
				` }else process.send(message);`,
				`}});process.on("disconnect",()=>process.exit(0));`,
			].join("\n"),
		);
		let error: unknown;
		let result: unknown;
		try {
			result = await classifyRawIoTarget(target, { helperSpawnCommand: { cmd: [process.execPath, scriptPath] } });
		} catch (caught: unknown) {
			error = caught;
		}
		const observedHeader: unknown = JSON.parse(await fs.readFile(receipt, "utf8"));
		expect(
			observedHeader,
			evidence(
				"POST-RAWIO-1",
				"real-worker header positive control",
				"actual 16-byte SQLite header before the malformed IPC boundary",
				observedHeader,
			),
		).toEqual(Array.from(SQLITE_HEADER_MAGIC));
		expect(
			error,
			evidence("ERRORS-RAWIO-1e", "missing-header error class", "native RawIoHelperOperationError", {
				error: String(error),
				result,
			}),
		).toBeInstanceOf(RawIoHelperOperationError);
		expect(
			error,
			evidence(
				"ERRORS-RAWIO-1e",
				"missing-header error identity",
				"own error clause and caller operation/target",
				error,
			),
		).toMatchObject({ clauseId: "ERRORS-RAWIO-1e", operation: "classify", targetPath: target });
	});

	it("rejects a throwing onRequest promise without unhandled rejection or process exit (#17)", async () => {
		/* Enforces POST-RAWIO-2b, HIGH-risk public callback boundary.
		 * C1: public async request surface; C2: current callback throw kills this actual child;
		 * C3: different from helper errors; C4: existing onRequest option and queue, no mocks.
		 * Isolation prevents a current process-fatal bug from killing the test runner.
		 */
		const target = path.join(dir, "ordinary.txt");
		await fs.writeFile(target, "callback fixture\n");
		const clientModule = path.resolve(import.meta.dir, "../../src/tools/raw-io-client.ts");
		const driver = [
			`import {classifyRawIoTarget,stopRawIoHelper} from ${JSON.stringify(clientModule)};`,
			`let rejected=false;`,
			`try{await classifyRawIoTarget(${JSON.stringify(target)},{onRequest(){throw new Error("onRequest observer failed");}});}`,
			`catch(error){rejected=error instanceof Error;}`,
			`const next=await classifyRawIoTarget(${JSON.stringify(target)});`,
			`await stopRawIoHelper();console.log(JSON.stringify({rejected,recovered:next.kind==="non_sqlite"}));`,
		].join("\n");
		const proc = Bun.spawnSync({
			cmd: [process.execPath, "-e", driver],
			stdout: "pipe",
			stderr: "pipe",
			timeout: 7000,
		});
		const stdout = new TextDecoder().decode(proc.stdout).trim();
		const stderr = new TextDecoder().decode(proc.stderr);
		const report: unknown = stdout.startsWith("{") ? JSON.parse(stdout) : undefined;
		const rejected =
			typeof report === "object" && report !== null && "rejected" in report ? report.rejected : undefined;
		const recovered =
			typeof report === "object" && report !== null && "recovered" in report ? report.recovered : undefined;
		expect(
			{ exit: proc.exitCode, rejected, recovered, unhandled: stderr.includes("Unhandled Rejection") },
			evidence(
				"POST-RAWIO-2b",
				"throwing onRequest supervision",
				"request rejects, subsequent request works, process exits 0 with no unhandled rejection",
				{ exit: proc.exitCode, stdout, stderr },
			),
		).toEqual({ exit: 0, rejected: true, recovered: true, unhandled: false });
	}, 10000);
});
