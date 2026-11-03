import { dlopen, FFIType, read } from "bun:ffi";
import * as fsSync from "node:fs";

export interface PeerWriteProbeResult {
	readonly blocked: boolean;
	readonly detail: string;
}

const libcName = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
const isDarwin = process.platform === "darwin";
const errnoSymbolName = isDarwin ? "__error" : "__errno_location";
const libc = dlopen(libcName, {
	lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
	[errnoSymbolName]: { args: [], returns: FFIType.ptr },
});
const F_TLOCK = 2;

function currentErrno(): number {
	const errnoFn = libc.symbols[errnoSymbolName];
	if (typeof errnoFn !== "function") return -1;
	const errnoPtr = errnoFn();
	return errnoPtr ? read.i32(errnoPtr, 0) : -1;
}

/**
 * Acquire a real POSIX `lockf(fd, F_TLOCK, 0n)` advisory record lock (backed by
 * kernel `fcntl` record locks on both Linux and macOS, with fixed 3-argument
 * C ABI on darwin-arm64 and linux-x64) inside the current `omp` process.
 * Closing *any* file descriptor for the same inode inside `omp` causes the
 * kernel to release this lock immediately.
 */
export function acquireInProcessPosixWriteLock(filePath: string): number {
	const fd = fsSync.openSync(filePath, "r+");
	const rc = libc.symbols.lockf(fd, F_TLOCK, 0n);
	if (rc !== 0) {
		const errnoVal = currentErrno();
		fsSync.closeSync(fd);
		throw new Error(
			`POST-RAWIO-1b setup: failed to acquire in-process POSIX lockf write lock on ${filePath} (rc=${String(rc)}, errno=${String(errnoVal)})`,
		);
	}
	return fd;
}

/**
 * Probe from a separate OS child process whether `filePath` currently holds a
 * conflicting POSIX record lock via `lockf(fd, F_TLOCK=2, 0n)`.
 * Only `EAGAIN` or `EACCES` counts as `LOCKED`; any other non-zero result throws
 * with `errno` so a broken probe can never masquerade as locked.
 */
export function peerPosixWriteLockBlocked(filePath: string): PeerWriteProbeResult {
	const script = [
		'import { dlopen, FFIType, read } from "bun:ffi";',
		'import * as fs from "node:fs";',
		'import * as os from "node:os";',
		'const isDarwin = process.platform === "darwin";',
		'const libcName = isDarwin ? "libSystem.B.dylib" : "libc.so.6";',
		'const errnoSym = isDarwin ? "__error" : "__errno_location";',
		"const libc = dlopen(libcName, {",
		"  lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },",
		"  [errnoSym]: { args: [], returns: FFIType.ptr },",
		"});",
		'const fd = fs.openSync(process.argv[1], "r+");',
		"const rc = libc.symbols.lockf(fd, 2, 0n);",
		"const errPtr = libc.symbols[errnoSym]();",
		"const errno = rc === 0 ? 0 : (errPtr ? read.i32(errPtr, 0) : -1);",
		"fs.closeSync(fd);",
		"if (rc === 0) {",
		'  console.log("ACQUIRED");',
		"} else if (rc === -1 && (errno === os.constants.errno.EAGAIN || errno === os.constants.errno.EACCES)) {",
		'  console.log("LOCKED:" + String(errno));',
		"} else {",
		'  console.log("UNEXPECTED_ERRNO:" + String(rc) + ":" + String(errno));',
		"  process.exit(2);",
		"}",
	].join("\n");
	const proc = Bun.spawnSync({
		cmd: [process.execPath, "-e", script, filePath],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout).trim();
	const stderr = new TextDecoder().decode(proc.stderr).trim();
	const detail = `exit=${String(proc.exitCode)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
	if (proc.exitCode !== 0 || (!stdout.startsWith("LOCKED:") && stdout !== "ACQUIRED")) {
		throw new Error(`POST-RAWIO-1b setup: POSIX lockf probe failed on ${filePath}: ${detail}`);
	}
	return {
		blocked: stdout.startsWith("LOCKED:"),
		detail,
	};
}
