import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	RAW_IO_DEFAULT_TIMEOUT_MS,
	RAW_IO_PROGRESS_CHUNK_BYTES,
	RAW_IO_WORKER_ARG,
	SQLITE_HEADER_MAGIC,
} from "../../../../contracts/raw_io_helper.contract";

function message(clause: string, expected: string): string {
	return [
		"1. WHAT: Real Raw-I/O Helper observation FAILED",
		`2. WHY: ${clause} violation`,
		`3. EXPECTED: ${expected}`,
		"4. ACTUAL: See the matcher diagnostic",
		"5. GUIDANCE: Preserve actual worker protocol frames and client error/lifecycle boundaries",
	].join("\n");
}

// Integration deadlines bound real IPC/PID observations; fake timers cannot
// advance another OS process. Each child has a final owned-helper cleanup path.
function receipt(driver: string, clause: string): unknown {
	const run = Bun.spawnSync([process.execPath, "-e", driver], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 10000,
	});
	expect(
		run.exitCode,
		message(clause, `isolated observer exits normally; stderr=${new TextDecoder().decode(run.stderr)}`),
	).toBe(0);
	return JSON.parse(new TextDecoder().decode(run.stdout));
}

it("observes actual CLI worker started/progress/terminal frames and exact normal-operation bytes", async () => {
	/* POST-RAWIO-1/2b/3/3b; high-risk real IPC integration, no fake provider.
	 * C1 current clauses; C2 actual emitted frames kill M17/M21; C3 client
	 * terminal results alone did not observe frames; C4 normal operations only.
	 */
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-io-actual-protocol-"));
	const sourceRoot = path.resolve(import.meta.dir, "../../src");
	const source = path.join(dir, "actual.db");
	const destination = path.join(dir, "written.db-journal");
	const data = new Uint8Array(2 * RAW_IO_PROGRESS_CHUNK_BYTES + 17).fill(42);
	data.set(SQLITE_HEADER_MAGIC);
	await fs.writeFile(source, data);
	const driver = [
		`import {resolveWorkerSpawnCmd} from ${JSON.stringify(path.join(sourceRoot, "subprocess/worker-client.ts"))};`,
		`import {RAW_IO_DEFAULT_TIMEOUT_MS} from ${JSON.stringify(path.join(sourceRoot, "tools/raw-io-protocol.ts"))};`,
		`const source=${JSON.stringify(source)}, destination=${JSON.stringify(destination)};`,
		`const frames={}, waiting=new Map();`,
		`const launch=resolveWorkerSpawnCmd(${JSON.stringify(RAW_IO_WORKER_ARG)});`,
		`const helper=Bun.spawn({cmd:[...launch.cmd],cwd:launch.cwd,serialization:"advanced",`,
		` stdout:"ignore",stderr:"inherit",ipc(m){`,
		`  (frames[m.id]??=[]).push(m.type==="progress"?[m.type,m.bytesProcessed]:m.type);`,
		`  if(["classified","read_ok","write_ok","error"].includes(m.type))waiting.get(m.id)?.(m);`,
		` }});`,
		`async function ask(m){const {promise,resolve}=Promise.withResolvers();waiting.set(m.id,resolve);helper.send(m);return await promise;}`,
		`try{`,
		` const c=await ask({type:"classify",id:"classify",targetPath:source});`,
		` const r=await ask({type:"read",id:"read",targetPath:source,offset:0,length:${data.byteLength}});`,
		` const w=await ask({type:"write",id:"write",targetPath:destination,data:r.bytes});`,
		` const written=await Bun.file(destination).bytes();`,
		` console.log(JSON.stringify({frames,defaultTimeout:RAW_IO_DEFAULT_TIMEOUT_MS,kind:c.classification.kind,header:[...c.classification.headerBytes],readLength:r.bytes.length,readHash:Bun.hash(r.bytes).toString(),writeHash:Bun.hash(written).toString(),writeType:w.type}));`,
		`}finally{helper.kill();await helper.exited;}`,
	].join("\n");
	try {
		const progress = [RAW_IO_PROGRESS_CHUNK_BYTES, 2 * RAW_IO_PROGRESS_CHUNK_BYTES, data.byteLength].map(n => [
			"progress",
			n,
		]);
		expect(
			receipt(driver, "POST-RAWIO-2b"),
			message(
				"POST-RAWIO-1 / POST-RAWIO-2b / POST-RAWIO-3 / POST-RAWIO-3b",
				"actual normal-operation frames and bytes",
			),
		).toEqual({
			frames: {
				classify: ["started", "classified"],
				read: ["started", ...progress, "read_ok"],
				write: ["started", ...progress, "write_ok"],
			},
			defaultTimeout: RAW_IO_DEFAULT_TIMEOUT_MS,
			kind: "sqlite_db",
			header: [...SQLITE_HEADER_MAGIC],
			readLength: data.byteLength,
			readHash: Bun.hash(data).toString(),
			writeHash: Bun.hash(data).toString(),
			writeType: "write_ok",
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 15000);

it("keeps the real helper and queue alive after a per-request error, then actually stops that helper", async () => {
	/* ERRORS-RAWIO-1 / POST-RAWIO-2c; high-risk live process boundary.
	 * C1 current clauses; C2 PID identity/liveness kills M10/M19; C3 previously
	 * absent direct observations; C4 actual missing-file read, no future what-if.
	 */
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-io-live-error-"));
	const target = path.join(dir, "ordinary.txt");
	const missing = path.join(dir, "missing.db-journal");
	await fs.writeFile(target, "live helper fixture\n");
	const clientPath = path.resolve(import.meta.dir, "../../src/tools/raw-io-client.ts");
	const driver = [
		`import {classifyRawIoTarget,readRawIoBytes,stopRawIoHelper} from ${JSON.stringify(clientPath)};`,
		`const owned=new Set();let result;`,
		`function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code!=="ESRCH")throw e;return false;}}`,
		`try{`,
		` const before=await classifyRawIoTarget(${JSON.stringify(target)});owned.add(before.helperPid);`,
		` const [failed,queued]=await Promise.allSettled([readRawIoBytes(${JSON.stringify(missing)},0,4),classifyRawIoTarget(${JSON.stringify(target)})]);`,
		` if(queued.status==="fulfilled")owned.add(queued.value.helperPid);`,
		` const after=await classifyRawIoTarget(${JSON.stringify(target)});owned.add(after.helperPid);`,
		` const liveBeforeStop=alive(before.helperPid);`,
		` await stopRawIoHelper();`,
		` result={errorStatus:failed.status,errorClass:failed.reason?.constructor?.name,clauseId:failed.reason?.clauseId,operation:failed.reason?.operation,targetPath:failed.reason?.targetPath,queuedStatus:queued.status,sameQueued:queued.value?.helperPid===before.helperPid,sameSubsequent:after.helperPid===before.helperPid,liveBeforeStop,deadAfterStop:!alive(after.helperPid)};`,
		`}finally{await stopRawIoHelper();for(const pid of owned){if(alive(pid))process.kill(pid,"SIGKILL");}}`,
		`console.log(JSON.stringify(result));`,
	].join("\n");
	try {
		expect(
			receipt(driver, "ERRORS-RAWIO-1 / POST-RAWIO-2c"),
			message(
				"ERRORS-RAWIO-1 / POST-RAWIO-2c",
				"only the failed request rejects, the same helper serves queued/subsequent work, and stop kills it",
			),
		).toEqual({
			errorStatus: "rejected",
			errorClass: "RawIoHelperOperationError",
			clauseId: "ERRORS-RAWIO-1",
			operation: "read",
			targetPath: missing,
			queuedStatus: "fulfilled",
			sameQueued: true,
			sameSubsequent: true,
			liveBeforeStop: true,
			deadAfterStop: true,
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 15000);
