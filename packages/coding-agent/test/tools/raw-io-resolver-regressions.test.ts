import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	readRawIoBytes,
	registerUnexitedWriteTarget,
	stopRawIoHelper,
	writeRawIoBytes,
} from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import type { RawIoHelperClauseId } from "../../../../contracts/raw_io_helper.contract";

function evidence(what: string, expected: string, actual: unknown): string {
	const clause: RawIoHelperClauseId = "ERRORS-RAWIO-1d";
	return [
		`1. WHAT: ${what} FAILED`,
		`2. WHY: POST-RAWIO-2b / ${clause} violation`,
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Preserve real filesystem target identity and surface unexpected resolution failures",
	].join("\n");
}

describe("Raw-I/O resolved write-block regressions (audit #3/#16)", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-io-resolver-"));
	});
	afterEach(async () => {
		await stopRawIoHelper();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("refuses an equivalent target reached through symlink followed by '..' (#3)", async () => {
		/* Contract: contracts/raw_io_helper.contract.ts POST-RAWIO-2b / ERRORS-RAWIO-1d.
		 * HIGH-risk real filesystem regression; no test doubles.
		 * C1: current resolved-real-path obligation; C2: current alias bypass changes real bytes;
		 * C3: unlike the older simple symlink test, parent traversal follows a symlink;
		 * C4: existing resolver/write mechanism, not a hypothetical capability.
		 */
		const inner = path.join(dir, "real", "inner");
		await fs.mkdir(inner, { recursive: true });
		const target = path.join(dir, "real", "guarded.db-journal");
		const alias = path.join(dir, "alias");
		await fs.writeFile(target, "protected\n");
		await fs.symlink(inner, alias);
		// Do not path.join/resolve this input: the kernel must traverse the symlink BEFORE '..'.
		const alternate = `${alias}/../guarded.db-journal`;
		const oldHelperExit = Promise.withResolvers<void>();
		registerUnexitedWriteTarget(target, oldHelperExit.promise);
		try {
			let directError: unknown;
			try {
				await writeRawIoBytes(target, new TextEncoder().encode("blocked\n"));
			} catch (error: unknown) {
				directError = error;
			}
			expect(
				directError instanceof Error && directError.message.includes("previous helper is still alive"),
				evidence(
					"direct write-block positive control",
					"registered canonical target is refused",
					String(directError),
				),
			).toBe(true);
			let aliasError: unknown;
			try {
				await writeRawIoBytes(alternate, new TextEncoder().encode("BYPASSED\n"));
			} catch (error: unknown) {
				aliasError = error;
			}
			const content = new TextDecoder().decode(await readRawIoBytes(target));
			expect(
				{
					refused: aliasError instanceof Error && aliasError.message.includes("previous helper is still alive"),
					content,
				},
				evidence("symlink-parent write refusal", "equivalent real file is refused and remains protected", {
					error: String(aliasError),
					content,
				}),
			).toEqual({ refused: true, content: "protected\n" });
		} finally {
			oldHelperExit.resolve();
			await oldHelperExit.promise;
		}
	});

	it.skipIf(process.getuid?.() === 0)("surfaces EACCES instead of registering a lexical fallback (#16)", async () => {
		/* Contract: POST-RAWIO-2b / ERRORS-RAWIO-1d permit fallback only for ENOENT/ENOTDIR.
		 * HIGH-risk real permission boundary; no mocks, no source inspection.
		 * C1: current fallback condition; C2: current catch-all swallows this real EACCES;
		 * C3: distinct from alias traversal; C4: normal inaccessible-path input. Root cannot observe DAC denial.
		 */
		const denied = path.join(dir, "inaccessible");
		const target = path.join(denied, "guarded.db-journal");
		await fs.mkdir(denied);
		await fs.writeFile(target, "protected\n");
		const oldHelperExit = Promise.withResolvers<void>();
		await fs.chmod(denied, 0);
		try {
			let setupError: unknown;
			try {
				await fs.lstat(target);
			} catch (error: unknown) {
				setupError = error;
			}
			expect(
				setupError instanceof Error && "code" in setupError ? setupError.code : undefined,
				evidence(
					"permission-denial positive control",
					"actual filesystem lstat fails with EACCES",
					String(setupError),
				),
			).toBe("EACCES");
			let resolverError: unknown;
			try {
				registerUnexitedWriteTarget(target, oldHelperExit.promise);
			} catch (error: unknown) {
				resolverError = error;
			}
			const surfaced =
				resolverError instanceof Error &&
				(("code" in resolverError && resolverError.code === "EACCES") ||
					resolverError.message.includes("EACCES") ||
					(resolverError.cause instanceof Error &&
						"code" in resolverError.cause &&
						resolverError.cause.code === "EACCES"));
			expect(
				surfaced,
				evidence(
					"unexpected resolver-error propagation",
					"EACCES surfaces instead of silently selecting a fallback key",
					String(resolverError),
				),
			).toBe(true);
		} finally {
			await fs.chmod(denied, 0o700);
			oldHelperExit.resolve();
			await oldHelperExit.promise;
		}
	});
});
