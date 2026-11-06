/**
 * ipython output filing tests (ketema/omp#27, SLICE-3 item 2, batch A).
 *
 * Targets the IMPLEMENTATION through the real session path: createRlmExtension, its ipython tool, the session lifecycle,
 * the real adapter, KernelManager and transport, and a real Python kernel in a temporary HOME. Only the host API is
 * synthetic; its saveArtifact mirrors ReadonlySessionManager.saveArtifact (returns the id of the saved copy).
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: contracts/context_efficiency_enforcement.contract.ts
 * - POST-CTX27-12, POST-CTX27-13, POST-CTX27-14, POST-CTX27-15 (this batch)
 *
 * Skips truthfully when the managed kernel interpreter is absent on this host.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";

import {
	expectedIpythonDescriptor,
	IPYTHON_ARTIFACT_TOOL_TYPE,
	IPYTHON_DESCRIPTOR_INSTRUCTION,
	IPYTHON_FILE_THRESHOLD_TOKENS,
	wholeReadRefusal,
} from "../../../contracts/context_efficiency_enforcement.contract.ts";
import { buildKernelEnv, type KernelCaps, type KernelSession } from "../src/bootstrap.ts";
import { KernelManagerAdapter } from "../src/extension.ts";
import { type KernelClock, KernelManager } from "../src/kernel.ts";
import { createTransport } from "../src/transport.ts";
import { openRealSession } from "./real_extension.ts";

const KERNEL_PYTHON = join(os.homedir(), ".omp", "agent", "kernel-venv", "bin", "python");
const liveTest = fs.existsSync(KERNEL_PYTHON) ? test : test.skip;

const clock: KernelClock = {
	now: () => Date.now(),
	schedule(fn: () => void, ms: number): () => void {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};

/** A cell that prints `lines` lines of varied text, and the exact stdout it produces (print adds the final newline). */
function bigPrint(lines: number): { code: string; stdout: string } {
	return {
		code: `print("\\n".join(f"row {i}: value-{i * 7919 % 10007} status=ok" for i in range(${lines})))`,
		stdout: `${Array.from({ length: lines }, (_, i) => `row ${i}: value-${(i * 7919) % 10007} status=ok`).join("\n")}\n`,
	};
}

/** The real session path over a real kernel whose HOME is `home`. */
async function openFilingSession(home: string) {
	const artifactsDir = join(home, "artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true });
	const kernelSession: KernelSession = {
		sessionDir: artifactsDir,
		harnessDir: join(artifactsDir, "harness"),
		globalHarnessDir: join(home, ".omp", "agent", "harness"),
		agentDir: join(home, ".omp", "agent"),
		depth: 0,
		maxDepth: 1,
	};
	const caps: KernelCaps = { maxOutputChars: 65536, snapshotMaxBytes: 256 * 1024 * 1024 };
	const env = { ...buildKernelEnv(kernelSession, caps), HOME: home };
	const transport = createTransport({ interpreter: KERNEL_PYTHON, env, cwd: home, artifactsDir });
	const manager = new KernelManager(transport, { clock, artifactsDir });
	const session = await openRealSession(home, artifactsDir, {
		createKernel: () => new KernelManagerAdapter(transport, manager),
	});
	await session.start();
	return session;
}

const resultText = (result: { content: Array<{ text: string }> }): string =>
	result.content.map(part => part.text).join("\n");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("a large ipython stdout is filed into out_<n> (REQ-CTX27-23 to REQ-CTX27-26)", () => {
	liveTest(
		"POST-CTX27-12 / POST-CTX27-14 / POST-CTX27-15: the full stdout is kept in out_1 and as an artifact, and the result is the descriptor",
		async () => {
			// Risk tier: HIGH — this is the change that keeps large printed results out of every later turn.
			const home = fs.mkdtempSync(join(os.tmpdir(), "omp-ipy-filing-"));
			const session = await openFilingSession(home);
			try {
				const { code, stdout } = bigPrint(600);
				expect(
					countTokens(stdout, Encoding.O200kBase),
					"fixture check: the printed text must reach the filing threshold",
				).toBeGreaterThanOrEqual(IPYTHON_FILE_THRESHOLD_TOKENS);

				const first = await session.call(code);
				const info = {
					n: 1,
					text: stdout,
					tokens: countTokens(stdout, Encoding.O200kBase),
					artifactId: session.artifacts[0]?.id ?? null,
					cutAtCeiling: false,
				};
				expect(
					resultText(first),
					"POST-CTX27-15 violation: the tool result is not the contracted descriptor\n" +
						`EXPECTED: ${JSON.stringify(expectedIpythonDescriptor(info))}\n` +
						`ACTUAL (first 300 chars): ${JSON.stringify(resultText(first).slice(0, 300))}\n` +
						"GUIDANCE: a stdout of this size is replaced by a descriptor naming out_1 and the artifact copy",
				).toBe(expectedIpythonDescriptor(info));

				expect(
					session.artifacts.map(a => ({ content: a.content, toolType: a.toolType })),
					"POST-CTX27-14 violation: the artifact copy is not exactly the full stdout under the ipython tool type\n" +
						`EXPECTED: one artifact of ${stdout.length} chars, toolType ${IPYTHON_ARTIFACT_TOOL_TYPE}\n` +
						`ACTUAL: ${session.artifacts.length} artifacts\n` +
						"GUIDANCE: save the same full text through the session artifact manager",
				).toEqual([{ content: stdout, toolType: IPYTHON_ARTIFACT_TOOL_TYPE }]);

				const probe = await session.call(
					"import hashlib\nprint(hashlib.sha256(out_1.encode()).hexdigest(), len(out_1))",
				);
				expect(
					resultText(probe),
					"POST-CTX27-12 violation: the kernel variable out_1 does not hold exactly the full stdout\n" +
						`EXPECTED: "${sha256(stdout)} ${stdout.length}\\n"\n` +
						`ACTUAL: ${JSON.stringify(resultText(probe).slice(0, 300))}\n` +
						"GUIDANCE: the full stdout stays in the kernel under the filed name",
				).toBe(`${sha256(stdout)} ${stdout.length}\n`);
			} finally {
				await session.shutdown();
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		120_000,
	);

	liveTest(
		"POST-CTX27-13: filed outputs are numbered per session and never overwrite a variable the user bound",
		async () => {
			// Risk tier: HIGH — a filed output must never replace the model's or Ketema's own variable.
			const home = fs.mkdtempSync(join(os.tmpdir(), "omp-ipy-filing-"));
			const session = await openFilingSession(home);
			try {
				await session.call('out_1 = "mine"');
				const a = bigPrint(600);
				const b = bigPrint(650);
				const first = await session.call(a.code);
				const second = await session.call(b.code);
				const expectedFirst = expectedIpythonDescriptor({
					n: 2,
					text: a.stdout,
					tokens: countTokens(a.stdout, Encoding.O200kBase),
					artifactId: session.artifacts[0]?.id ?? null,
					cutAtCeiling: false,
				});
				const expectedSecond = expectedIpythonDescriptor({
					n: 3,
					text: b.stdout,
					tokens: countTokens(b.stdout, Encoding.O200kBase),
					artifactId: session.artifacts[1]?.id ?? null,
					cutAtCeiling: false,
				});
				expect(
					[resultText(first), resultText(second)],
					"POST-CTX27-13 violation: filed outputs did not skip the bound name out_1 and continue the numbering\n" +
						"EXPECTED: descriptors for out_2 and out_3\n" +
						`ACTUAL (first 200 chars each): ${JSON.stringify([resultText(first).slice(0, 200), resultText(second).slice(0, 200)])}\n` +
						"GUIDANCE: number filed outputs from 1, skip any name already bound, and never overwrite it",
				).toEqual([expectedFirst, expectedSecond]);

				const probe = await session.call("print(out_1, len(out_2), len(out_3))");
				expect(
					resultText(probe),
					"POST-CTX27-13 violation: the user's out_1 was overwritten or the filed variables are missing\n" +
						`EXPECTED: "mine ${a.stdout.length} ${b.stdout.length}\\n"\n` +
						`ACTUAL: ${JSON.stringify(resultText(probe).slice(0, 200))}\n` +
						"GUIDANCE: a variable the user bound is never replaced by a filed output",
				).toBe(`mine ${a.stdout.length} ${b.stdout.length}\n`);
			} finally {
				await session.shutdown();
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		120_000,
	);

	liveTest(
		"POST-CTX27-12 / POST-CTX27-14: a stdout between 800 and 1,500 tokens is filed, and one below 800 stays inline",
		async () => {
			// Risk tier: HIGH — the threshold is a value REQ-CTX27-23 and REQ-CTX27-27 name (lowered from 1,500 to 800 on 2026-11-05).
			const home = fs.mkdtempSync(join(os.tmpdir(), "omp-ipy-filing-"));
			const session = await openFilingSession(home);
			try {
				const above = bigPrint(90);
				const below = bigPrint(60);
				const aboveTokens = countTokens(above.stdout, Encoding.O200kBase);
				const belowTokens = countTokens(below.stdout, Encoding.O200kBase);
				expect(
					aboveTokens,
					"fixture check: the larger print must sit between 800 and 1,500 tokens",
				).toBeGreaterThan(800);
				expect(aboveTokens, "fixture check: the larger print must sit between 800 and 1,500 tokens").toBeLessThan(
					1500,
				);
				expect(belowTokens, "fixture check: the smaller print must sit below 800 tokens").toBeLessThan(800);

				const small = await session.call(below.code);
				expect(
					resultText(small).includes("row 59: value-"),
					"POST-CTX27-14 violation: a stdout below the threshold did not reach the tool result unchanged\n" +
						`ACTUAL (first 200 chars): ${JSON.stringify(resultText(small).slice(0, 200))}\n` +
						"GUIDANCE: stdout below IPYTHON_FILE_THRESHOLD_TOKENS stays inline",
				).toBe(true);
				expect(
					session.artifacts.length,
					"POST-CTX27-14 violation: a stdout below the threshold was filed\n" +
						"GUIDANCE: only a stdout that reaches IPYTHON_FILE_THRESHOLD_TOKENS is filed",
				).toBe(0);

				const large = await session.call(above.code);
				const expected = expectedIpythonDescriptor({
					n: 1,
					text: above.stdout,
					tokens: aboveTokens,
					artifactId: session.artifacts[0]?.id ?? null,
					cutAtCeiling: false,
				});
				expect(
					resultText(large),
					`POST-CTX27-12 violation: a stdout of ${aboveTokens} tokens was not filed\n` +
						`EXPECTED: ${JSON.stringify(expected)}\n` +
						`ACTUAL (first 300 chars): ${JSON.stringify(resultText(large).slice(0, 300))}\n` +
						"GUIDANCE: the filing threshold is 800 tokens",
				).toBe(expected);
			} finally {
				await session.shutdown();
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		120_000,
	);

	liveTest(
		"POST-CTX27-19 / POST-CTX27-20: a whole read of a filed artifact is refused with the range hint, and the descriptor says to answer from the kernel",
		async () => {
			// Risk tier: HIGH — in session 01a1add1 the model read the whole artifact back and cancelled the saving.
			const home = fs.mkdtempSync(join(os.tmpdir(), "omp-ipy-filing-"));
			const session = await openFilingSession(home);
			try {
				const refusedBeforeAnyFiling = await session.toolCall("read", { path: "artifact://1" });
				expect(
					refusedBeforeAnyFiling,
					"POST-CTX27-19 violation: a read of an artifact that no ipython output filed was refused\n" +
						"GUIDANCE: only artifacts saved by the ipython filing are guarded",
				).toBeUndefined();

				const first = await session.call(bigPrint(100).code);
				const second = await session.call(bigPrint(110).code);
				const idFirst = session.artifacts[0]?.id ?? "missing";
				const idSecond = session.artifacts[1]?.id ?? "missing";
				expect(
					[resultText(first), resultText(second)].every(
						text => text.includes(IPYTHON_DESCRIPTOR_INSTRUCTION) && text.includes("a whole read is refused"),
					),
					"POST-CTX27-20 violation: the descriptor does not tell the model to answer from the kernel and read by range only\n" +
						`ACTUAL (first 400 chars): ${JSON.stringify(resultText(first).slice(0, 400))}\n` +
						"GUIDANCE: the first access line ends with the instruction and the artifact line says a whole read is refused",
				).toBe(true);

				const whole = await session.toolCall("read", { path: `artifact://${idFirst}` });
				expect(
					whole,
					"POST-CTX27-19 violation: a whole read of a filed artifact was not refused with the contracted text\n" +
						`EXPECTED: ${JSON.stringify({ block: true, reason: wholeReadRefusal(idFirst, 1) })}\n` +
						`ACTUAL: ${JSON.stringify(whole)}\n` +
						"GUIDANCE: refuse the call and name out_<n> and the range form",
				).toEqual({ block: true, reason: wholeReadRefusal(idFirst, 1) });

				expect(
					await session.toolCall("read", { path: `artifact://${idSecond}:raw` }),
					"POST-CTX27-19 violation: a whole :raw read of the second filed artifact was not refused with out_2\n" +
						"GUIDANCE: map each filed artifact to its own out_<n>",
				).toEqual({ block: true, reason: wholeReadRefusal(idSecond, 2) });

				for (const [label, toolName, input] of [
					["ranged read", "read", { path: `artifact://${idFirst}:1-60` }],
					["raw ranged read", "read", { path: `artifact://${idFirst}:raw:5-9` }],
					["last lines", "read", { path: `artifact://${idFirst}:-20` }],
					["other artifact", "read", { path: "artifact://99" }],
					["other protocol", "read", { path: "file:///tmp/x.txt" }],
					["other tool", "bash", { command: `cat artifact://${idFirst}` }],
				] as const) {
					expect(
						await session.toolCall(toolName, input),
						`POST-CTX27-19 violation: the ${label} was refused\nGUIDANCE: only a whole read of a filed artifact is refused`,
					).toBeUndefined();
				}
			} finally {
				await session.shutdown();
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
