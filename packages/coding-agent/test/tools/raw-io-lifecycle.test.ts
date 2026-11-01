import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWorkerSpawnCmd } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { RAW_IO_WORKER_ARG } from "../../../../contracts/raw_io_helper.contract";

function evidence(clause: string, what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		`2. WHY: ${clause} violation`,
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Preserve the contracted helper lifecycle through the real parent boundary",
	].join("\n");
}

// These bounds observe separate OS processes and kernel IPC, not timer-driven
// application logic. In-process fake timers cannot advance child exit or PID death.
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "deadline"> {
	let cancelDeadline: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<"deadline">(resolve => {
				const timer = setTimeout(() => resolve("deadline"), ms);
				cancelDeadline = () => clearTimeout(timer);
			}),
		]);
	} finally {
		cancelDeadline?.();
	}
}

async function readReceipt(file: string): Promise<unknown> {
	const until = performance.now() + 5000;
	while (performance.now() < until) {
		try {
			return JSON.parse(await fs.readFile(file, "utf8"));
		} catch (error: unknown) {
			if (
				!(error instanceof SyntaxError) &&
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			) {
				throw error;
			}
		}
		await Bun.sleep(20);
	}
	throw new Error(evidence("SEQ-RAWIO-1", "real parent readiness", "readiness receipt within 5s", file));
}

function killOwnedHelper(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

describe("Raw-I/O Helper actual process lifecycle (SEQ-RAWIO-1/2/3)", () => {
	it("starts from the parent's executable on first tool need and stops before parent exit", async () => {
		/* Enforces SEQ-RAWIO-1/2. HIGH-risk integration; real ReadTool -> client -> CLI worker.
		 * C1: current SEQ clauses; C2: child argv and pre-exit liveness distinguish wrong startup/stop;
		 * C3: observes actual exit, unlike direct stop tests; C4: existing lifecycle only. No doubles.
		 */
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-io-lifecycle-"));
		const sourceRoot = path.resolve(import.meta.dir, "../../src");
		const fixture = path.join(dir, "ordinary.txt");
		const ready = path.join(dir, "ready.json");
		const cleanup = path.join(dir, "cleanup.json");
		await fs.writeFile(fixture, "lifecycle fixture\n");
		const driver = [
			`import * as fs from "node:fs";`,
			`import {ReadTool} from ${JSON.stringify(path.join(sourceRoot, "tools/read.ts"))};`,
			`import {Settings} from ${JSON.stringify(path.join(sourceRoot, "config/settings.ts"))};`,
			`import {classifyRawIoTarget} from ${JSON.stringify(path.join(sourceRoot, "tools/raw-io-client.ts"))};`,
			`import {postmortem} from "@oh-my-pi/pi-utils";`,
			`const target=${JSON.stringify(fixture)};`,
			`const watchdog=setTimeout(()=>process.exit(98),10000);`,
			`const session={cwd:${JSON.stringify(dir)},hasUI:false,enableLsp:false,settings:Settings.isolated(),getSessionFile:()=>null,getSessionSpawns:()=>"*"};`,
			`const result=await new ReadTool(session).execute("first-tool-request",{path:target});`,
			`const c=await classifyRawIoTarget(target);`,
			// This observes the registered teardown while the parent and its IPC pipe still exist.
			// Pipe closure alone cannot make a missing/no-op stop callback pass.
			`postmortem.register("test-pre-exit-observation",async()=>{`,
			` let stopped=false; const until=performance.now()+2000;`,
			` while(performance.now()<until){try{process.kill(c.helperPid,0);}catch(e){if(e.code!=="ESRCH")throw e;stopped=true;break;}await Bun.sleep(20);}`,
			` fs.writeFileSync(${JSON.stringify(cleanup)},JSON.stringify({stoppedBeforeExit:stopped}));`,
			`});`,
			`fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({helperPid:c.helperPid,execPath:process.execPath,text:result.content.filter(b=>b.type==="text").map(b=>b.text).join(String.fromCharCode(10))}));`,
			`await Bun.stdin.text();clearTimeout(watchdog);await postmortem.quit(0);`,
		].join("\n");
		const proc = Bun.spawn([process.execPath, "-e", driver], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(proc.stderr).text();
		let helperPid: number | undefined;
		try {
			const receipt = await readReceipt(ready);
			if (
				typeof receipt !== "object" ||
				receipt === null ||
				!("helperPid" in receipt) ||
				typeof receipt.helperPid !== "number" ||
				!("execPath" in receipt) ||
				typeof receipt.execPath !== "string" ||
				!("text" in receipt) ||
				typeof receipt.text !== "string"
			) {
				throw new Error(
					evidence("SEQ-RAWIO-1", "real parent receipt", "typed PID/executable/result receipt", receipt),
				);
			}
			helperPid = receipt.helperPid;
			const ps = Bun.spawnSync(["ps", "-p", String(helperPid), "-o", "command="], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const command = new TextDecoder().decode(ps.stdout).trim();
			expect(
				{
					ownExecutable: command.startsWith(receipt.execPath + " "),
					selector: command.split(/\s+/).includes(RAW_IO_WORKER_ARG),
					served: receipt.text.includes("lifecycle fixture"),
				},
				evidence(
					"SEQ-RAWIO-1",
					"first-tool helper startup",
					"own executable, contracted selector, and completed first tool request",
					{ command, receipt },
				),
			).toEqual({ ownExecutable: true, selector: true, served: true });
			proc.stdin.end();
			const exit = await within(proc.exited, 5000);
			const cleanupReceipt = await readReceipt(cleanup);
			expect(
				{ exit, cleanup: cleanupReceipt },
				evidence(
					"SEQ-RAWIO-2",
					"at-exit helper teardown",
					"parent exit 0 with helper already stopped before the parent's IPC closes",
					{ exit, cleanupReceipt, stderr: exit === "deadline" ? "parent did not exit" : await stderr },
				),
			).toEqual({ exit: 0, cleanup: { stoppedBeforeExit: true } });
		} finally {
			proc.kill();
			await proc.exited;
			if (helperPid !== undefined) killOwnedHelper(helperPid);
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15000);

	it("exits the real CLI helper when its parent IPC pipe closes", async () => {
		/* Enforces SEQ-RAWIO-3 and POST-RAWIO-2. HIGH-risk real CLI/IPC integration.
		 * C1: existing pipe-close guarantee; C2: a live worker must exit without a kill;
		 * C3: parent remains alive here; C4: existing disconnect lifecycle, no future guard.
		 */
		const launch = resolveWorkerSpawnCmd(RAW_IO_WORKER_ARG);
		const reply = Promise.withResolvers<unknown>();
		const proc = Bun.spawn({
			cmd: [...launch.cmd],
			cwd: launch.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			serialization: "advanced",
			ipc(message: unknown) {
				if (typeof message === "object" && message !== null && "type" in message && message.type === "classified")
					reply.resolve(message);
			},
		});
		const stderr = new Response(proc.stderr).text();
		try {
			proc.send({ type: "classify", id: 1, targetPath: "/dev/null" });
			const ready = await within(reply.promise, 5000);
			expect(
				ready === "deadline",
				evidence("SEQ-RAWIO-3", "pipe-close positive control", "live helper responds before disconnect", ready),
			).toBe(false);
			proc.disconnect();
			const exited = await within(proc.exited, 3000);
			expect(
				exited === "deadline",
				evidence("SEQ-RAWIO-3", "parent-pipe-close exit", "helper exits without parent killing it", { exited }),
			).toBe(false);
		} finally {
			proc.kill();
			await proc.exited;
			await stderr;
		}
	}, 12000);
});
