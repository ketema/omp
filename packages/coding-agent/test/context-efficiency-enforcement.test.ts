/**
 * RED PHASE — Context Efficiency Enforcement tests (ketema/omp#27).
 *
 * Bridges the specification authority at
 *   contracts/context_efficiency_enforcement.contract.ts
 * and the implementation artifact at
 *   packages/coding-agent/src/context/context-efficiency-enforcement.ts
 *
 * FOUR-CRITERIA TEST VALIDITY GATE:
 *   [✓] C1 VALID: cites POST-CTX27-1..5, SEQ-CTX27-1..4, ERRORS-CTX27-1, FORBIDDEN-CTX27-1
 *   [✓] C2 VALUABLE: exact token counts, SHA-256 parity, display caps, and CompactionCancelledError
 *   [✓] C3 NON-DUPLICATIVE: one test per distinct gate + fixture transcript budget
 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract clauses only
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import * as natives from "@oh-my-pi/pi-natives";
import {
	assertBudgetInvariant,
	assertValidEnforcerPreconditions,
	BudgetInvariantViolationError,
	CARD_MAX_TOKENS,
	CARD_NAME_MAX_CHARS,
	CARD_SIGNATURE_MAX_CHARS,
	CARD_SNAPSHOT_MAX_CHARS,
	CARD_SUMMARY_MAX_CHARS,
	COMPACTION_CANCELLED_TEXT,
	CONTRACT_CONTEXT_EFFICIENCY_ENFORCEMENT,
	DESCRIPTOR_MAX_TOKENS,
	DISPLAY_MAX_BYTES,
	DISPLAY_MAX_LINES,
	FIXTURE_TRANSCRIPT_MAX_TOKENS,
	PAYLOAD_SLICE_BYTES,
	PreconditionViolationError,
	RESULT_TOKEN_THRESHOLD,
	SAMPLE_STRING_MAX_CHARS,
	SCHEMA_NAME_MAX_CHARS,
	SESSION_INLINE_TOKEN_BUDGET,
	TEXT_HEAD_LINES,
	TEXT_LINE_MAX_CHARS,
	TEXT_TAIL_LINES,
	TURN_INLINE_TOKEN_BUDGET,
	validateHelperCatalogCard,
	validateUdtDescriptorRecord,
} from "../../../contracts/context_efficiency_enforcement.contract";
import {
	assemblePromptWithCatalogCards,
	assertImplBudgetInvariant,
	ContextEfficiencyEnforcer,
	countO200kTokens,
	createContextEfficiencyExtension,
	findLeakedPayloadValueSlices,
	IMPL_CARD_MAX_TOKENS,
	IMPL_COMPACTION_CANCELLED_TEXT,
	IMPL_DESCRIPTOR_MAX_TOKENS,
	IMPL_DISPLAY_MAX_BYTES,
	IMPL_DISPLAY_MAX_LINES,
	IMPL_FIXTURE_TRANSCRIPT_MAX_TOKENS,
	IMPL_RESULT_TOKEN_THRESHOLD,
	IMPL_SESSION_INLINE_TOKEN_BUDGET,
	IMPL_TURN_INLINE_TOKEN_BUDGET,
	ImplBudgetInvariantViolationError,
	ImplPreconditionViolationError,
	restoreTrustedHelperSnapshotsWithLoader,
	saveTrustedHelperSnapshot,
} from "../src/context/context-efficiency-enforcement";

function buildTextWithExactO200kTokens(targetTokens: number, prefix = "tok"): string {
	const words: string[] = [];
	let current = "";
	let i = 0;
	while (natives.countTokens(current, natives.Encoding.O200kBase) < targetTokens) {
		words.push(`${prefix}_${i} `);
		i += 1;
		current = words.join("");
	}
	while (natives.countTokens(current, natives.Encoding.O200kBase) > targetTokens && current.length > 0) {
		current = current.slice(0, -1);
	}
	while (natives.countTokens(current, natives.Encoding.O200kBase) < targetTokens) {
		current += "!";
	}
	return current;
}

function buildJsonArrayWithExactMinTokens(minTokens: number): { jsonText: string; rows: Record<string, unknown>[] } {
	const rows: Record<string, unknown>[] = [];
	const longSchemaKey = "schema_column_identifier_exceeding_31_characters";
	let i = 0;
	let jsonText = "[]";
	while (natives.countTokens(jsonText, natives.Encoding.O200kBase) < minTokens) {
		rows.push({
			id: i,
			status: i % 2 === 0 ? "ok" : "warn",
			[longSchemaKey]: `VAL_ROW_${String(i).padStart(4, "0")}_` + "X".repeat(72),
		});
		i += 1;
		jsonText = JSON.stringify(rows, null, 2);
	}
	return { jsonText, rows };
}

describe("Context Efficiency Enforcement (ketema/omp#27)", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ctx27-"));
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("aligns contract and implementation constants and enforces PRE-CTX27-1 and INV-CTX27-1 runtime guards (PRE-CTX27-1, INV-CTX27-1, POST-CTX27-1..5, SEQ-CTX27-1..4, ERRORS-CTX27-1, FORBIDDEN-CTX27-1)", async () => {
		expect(Object.keys(CONTRACT_CONTEXT_EFFICIENCY_ENFORCEMENT).length).toBe(13);
		expect(IMPL_RESULT_TOKEN_THRESHOLD).toBe(RESULT_TOKEN_THRESHOLD);
		expect(IMPL_TURN_INLINE_TOKEN_BUDGET).toBe(TURN_INLINE_TOKEN_BUDGET);
		expect(IMPL_SESSION_INLINE_TOKEN_BUDGET).toBe(SESSION_INLINE_TOKEN_BUDGET);
		expect(IMPL_DESCRIPTOR_MAX_TOKENS).toBe(DESCRIPTOR_MAX_TOKENS);
		expect(IMPL_DISPLAY_MAX_LINES).toBe(DISPLAY_MAX_LINES);
		expect(IMPL_DISPLAY_MAX_BYTES).toBe(DISPLAY_MAX_BYTES);
		expect(IMPL_CARD_MAX_TOKENS).toBe(CARD_MAX_TOKENS);
		expect(IMPL_FIXTURE_TRANSCRIPT_MAX_TOKENS).toBe(FIXTURE_TRANSCRIPT_MAX_TOKENS);
		expect(IMPL_COMPACTION_CANCELLED_TEXT).toBe(COMPACTION_CANCELLED_TEXT);

		// PRE-CTX27-1: both contract validator and independent implementation reject blank agentDir/sessionId/toolCallId
		expect(() => assertValidEnforcerPreconditions({ agentDir: "", sessionId: "s1" })).toThrow(
			PreconditionViolationError,
		);
		expect(() => new ContextEfficiencyEnforcer({ agentDir: "", sessionId: "s1" })).toThrow(
			ImplPreconditionViolationError,
		);
		const enf = new ContextEfficiencyEnforcer({ agentDir: tempRoot, sessionId: "s1" });
		await expect(enf.admitToolResult({ toolCallId: "   ", text: "ok" })).rejects.toBeInstanceOf(
			ImplPreconditionViolationError,
		);

		// INV-CTX27-1: both contract validator and independent implementation enforce turn/session budget bounds
		expect(() => assertBudgetInvariant({ turnInlineTokens: 1501, sessionInlineTokens: 0 })).toThrow(
			BudgetInvariantViolationError,
		);
		expect(() => assertImplBudgetInvariant({ turnInlineTokens: 1501, sessionInlineTokens: 0 })).toThrow(
			ImplBudgetInvariantViolationError,
		);
	});

	it("Test 1 (Emission): enforces F-inline, F-over, F-turn, and F-session with kernel SHA-256 parity and display caps (POST-CTX27-1, POST-CTX27-2, POST-CTX27-3, SEQ-CTX27-1, SEQ-CTX27-2)", async () => {
		const enforcer = new ContextEfficiencyEnforcer({
			agentDir: tempRoot,
			sessionId: "01a18024-a7e2-7053-983f-dc092ca4aa58",
		});

		// F-inline (excluded from 700-token cap): 1,499 tokens admitted inline
		const fInlineText = buildTextWithExactO200kTokens(1499, "inline");
		expect(countO200kTokens(fInlineText)).toBe(1499);
		const inlineRes = await enforcer.admitToolResult({
			toolCallId: "call-f-inline",
			text: fInlineText,
		});
		expect(inlineRes.mode, "POST-CTX27-1 / SEQ-CTX27-1 violation: 1,499-token result must stay inline").toBe(
			"inline",
		);
		expect(inlineRes.transcriptText).toBe(fInlineText);

		// Reset turn/session for F-over
		enforcer.resetBudgets();
		const { jsonText: fOverPayload } = buildJsonArrayWithExactMinTokens(1501);
		expect(countO200kTokens(fOverPayload)).toBeGreaterThanOrEqual(1501);
		const overRes = await enforcer.admitToolResult({
			toolCallId: "call-f-over",
			text: fOverPayload,
		});
		expect(overRes.mode, "POST-CTX27-1 violation: >=1,500-token result must be filed").toBe("filed");
		const overDescriptor = overRes.descriptor;
		if (!overDescriptor) {
			throw new Error("POST-CTX27-1 violation: expected filed descriptor");
		}
		const descriptorTokens = countO200kTokens(overRes.transcriptText);
		expect(
			descriptorTokens <= DESCRIPTOR_MAX_TOKENS,
			`POST-CTX27-2 violation: descriptor tokens ${descriptorTokens} exceeded ${DESCRIPTOR_MAX_TOKENS}`,
		).toBe(true);
		expect(validateUdtDescriptorRecord(overDescriptor, descriptorTokens)).toBe(true);
		for (const key of overDescriptor.key_schema_union ?? []) {
			expect(key.length <= SCHEMA_NAME_MAX_CHARS).toBe(true);
		}
		for (const val of Object.values(overDescriptor.sample_row_0 ?? {})) {
			if (typeof val === "string") {
				expect(val.length <= SAMPLE_STRING_MAX_CHARS).toBe(true);
			}
		}

		// Kernel value hashes equal to payload & display output capped at 60 lines / 2 KB
		const kernelHash = await enforcer.getKernelArtifactSha256(overDescriptor.name);
		expect(
			kernelHash,
			`POST-CTX27-3 / SEQ-CTX27-2 violation: kernel artifact SHA-256 mismatch for ${overDescriptor.name}`,
		).toBe(crypto.createHash("sha256").update(fOverPayload, "utf8").digest("hex"));
		const displayOut = await enforcer.getKernelDisplayOutput(overDescriptor.name);
		const displayLines = displayOut.split("\n").length;
		const displayBytes = Buffer.byteLength(displayOut, "utf8");
		expect(
			displayLines <= DISPLAY_MAX_LINES && displayBytes <= DISPLAY_MAX_BYTES,
			`POST-CTX27-3 violation: display output (${displayLines} lines, ${displayBytes} bytes) exceeded 60 lines / 2048 bytes`,
		).toBe(true);

		// Also verify text descriptor 5 head + 5 tail cut at 40 chars and json_object copies no values
		const longText = Array.from({ length: 25 }, (_, idx) => `LINE_${idx}_` + "Z".repeat(60)).join("\n");
		const textDesc = enforcer.buildUdtDescriptor("artifact_text01", longText);
		expect(textDesc.class).toBe("text");
		expect(textDesc.head?.length).toBe(TEXT_HEAD_LINES);
		expect(textDesc.tail?.length).toBe(TEXT_TAIL_LINES);
		expect(textDesc.head?.every(l => l.length <= TEXT_LINE_MAX_CHARS)).toBe(true);
		expect(textDesc.tail?.every(l => l.length <= TEXT_LINE_MAX_CHARS)).toBe(true);

		const secretObjValue = "SECRET_OBJECT_VALUE_" + "Q".repeat(48);
		const objDesc = enforcer.buildUdtDescriptor(
			"artifact_obj01",
			JSON.stringify({ very_long_object_key_name_over_31_chars: secretObjValue }),
		);
		expect(objDesc.class).toBe("json_object");
		expect(JSON.stringify(objDesc).includes(secretObjValue)).toBe(false);

		// F-turn: two 1,400-token results in one turn -> first inline, second filed
		enforcer.resetBudgets();
		const turnText1 = buildTextWithExactO200kTokens(1400, "turnA");
		const turnText2 = buildTextWithExactO200kTokens(1400, "turnB");
		const turnRes1 = await enforcer.admitToolResult({ toolCallId: "call-turn-1", text: turnText1 });
		const turnRes2 = await enforcer.admitToolResult({ toolCallId: "call-turn-2", text: turnText2 });
		expect(turnRes1.mode, "POST-CTX27-1 violation: first 1,400-token result in turn must be inline").toBe("inline");
		expect(turnRes2.mode, "POST-CTX27-1 violation: second 1,400-token result in same turn must be filed").toBe(
			"filed",
		);

		// F-session: with 6,000 tokens of inline tool text already stored, a 100-token result is filed
		enforcer.resetBudgets();
		for (let turn = 0; turn < 4; turn += 1) {
			enforcer.startNewTurn();
			const chunk = buildTextWithExactO200kTokens(1499, `sess_${turn}`);
			const r = await enforcer.admitToolResult({ toolCallId: `call-sess-${turn}`, text: chunk });
			expect(r.mode).toBe("inline");
		}
		enforcer.startNewTurn();
		const topUp = buildTextWithExactO200kTokens(4, "topup");
		const topUpRes = await enforcer.admitToolResult({ toolCallId: "call-sess-topup", text: topUp });
		expect(topUpRes.mode).toBe("inline");
		expect(enforcer.getSessionInlineTokens()).toBe(6000);

		enforcer.startNewTurn();
		const small100 = buildTextWithExactO200kTokens(100, "after6000");
		const afterCapRes = await enforcer.admitToolResult({ toolCallId: "call-sess-after", text: small100 });
		expect(
			afterCapRes.mode,
			"POST-CTX27-1 violation: 100-token result after 6,000 session inline tokens must be filed",
		).toBe("filed");
	});

	it("Test 2 (Catalog): saves 3 functions to trusted snapshots and injects 3 schema-valid cards with zero bodies and <=240 tokens (POST-CTX27-4, SEQ-CTX27-3)", async () => {
		const snapshotsDir = path.join(tempRoot, "repl-snapshots");
		const fns = [
			{
				name: "expand_rules",
				signature: "(i: int) -> str",
				summary: "400-branch rule lookup",
				snapshot: "expand_rules.dill",
				pythonSource: "def expand_rules(i):\n    return f'R{i:03d}' if 1 <= i <= 400 else None\n",
			},
			{
				name: "tally_rows",
				signature: "(rows: list) -> dict",
				summary: "Count rows by status key",
				snapshot: "tally_rows.dill",
				pythonSource:
					"def tally_rows(rows):\n    out = {}\n    for r in rows:\n        out[r['s']] = out.get(r['s'], 0) + 1\n    return out\n",
			},
			{
				name: "digest_text",
				signature: "(s: str) -> str",
				summary: "SHA-256 hex of text",
				snapshot: "digest_text.dill",
				pythonSource: "import hashlib\ndef digest_text(s):\n    return hashlib.sha256(s.encode()).hexdigest()\n",
			},
		];

		for (const fn of fns) {
			await saveTrustedHelperSnapshot({
				snapshotsDir,
				name: fn.name,
				signature: fn.signature,
				summary: fn.summary,
				snapshotBasename: fn.snapshot,
				pythonSource: fn.pythonSource,
			});
		}

		const assembled = assemblePromptWithCatalogCards("Base system prompt.", snapshotsDir);
		expect(assembled.cards.length, "POST-CTX27-4 / SEQ-CTX27-3 violation: expected exactly 3 catalog cards").toBe(3);

		let totalCardTokens = 0;
		for (const card of assembled.cards) {
			const cardJson = JSON.stringify(card);
			const tokens = countO200kTokens(cardJson);
			totalCardTokens += tokens;
			expect(validateHelperCatalogCard(card, tokens)).toBe(true);
			expect(card.name.length <= CARD_NAME_MAX_CHARS).toBe(true);
			expect(card.signature.length <= CARD_SIGNATURE_MAX_CHARS).toBe(true);
			expect(card.summary.length <= CARD_SUMMARY_MAX_CHARS).toBe(true);
			expect(card.snapshot.length <= CARD_SNAPSHOT_MAX_CHARS).toBe(true);
		}
		expect(totalCardTokens <= 240, `POST-CTX27-4 violation: 3 cards consumed ${totalCardTokens} tokens (> 240)`).toBe(
			true,
		);
		for (const fn of fns) {
			expect(
				assembled.prompt.includes("def " + fn.name),
				`POST-CTX27-4 violation: prompt leaked function body for ${fn.name}`,
			).toBe(false);
		}

		// Also verify real dill loader binds digest_text.__globals__ to __main__ (globals()),
		// preventing Python 3.14 + dill 0.4.1 from pickling a custom dict containing module objects.
		const realDillHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ctx27-realdill-"));
		try {
			const realSnapDir = path.join(realDillHome, ".omp", "agent", "repl-snapshots");
			for (const fn of fns) {
				await saveTrustedHelperSnapshot({
					snapshotsDir: realSnapDir,
					name: fn.name,
					signature: fn.signature,
					summary: fn.summary,
					snapshotBasename: fn.snapshot,
					pythonSource: fn.pythonSource,
				});
			}
			const realLoad = await restoreTrustedHelperSnapshotsWithLoader({
				homeDir: realDillHome,
				probeCallExpr:
					"(sorted(k for k in digest_text.__globals__.keys() if not k.startswith('__')), digest_text('abc')[:8])",
			});
			expect(realLoad.restoredCount).toBe(3);
			expect(
				realLoad.probeResult,
				"POST-CTX27-4 violation: helper snapshot must serialize with globals() and recurse=True so Python 3.14 + dill 0.4.1 carries only referenced globals",
			).toBe("(['hashlib'], 'ba7816bf')");
		} finally {
			fs.rmSync(realDillHome, { recursive: true, force: true });
		}

		// Verify ~/.agents/skills/repl-snapshots/restore.py loads the declared names and types,
		// and a failed load leaves previous bindings in place and returns an error.
		const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ctx27-home-"));
		try {
			const homeSnapDir = path.join(homeRoot, ".omp", "agent", "repl-snapshots");
			for (const fn of fns) {
				await saveTrustedHelperSnapshot({
					snapshotsDir: homeSnapDir,
					name: fn.name,
					signature: fn.signature,
					summary: fn.summary,
					snapshotBasename: fn.snapshot,
					pythonSource: fn.pythonSource,
					pythonInterpreter: "python3",
				});
			}
			const goodLoad = await restoreTrustedHelperSnapshotsWithLoader({
				homeDir: homeRoot,
				probeCallExpr: "(expand_rules(17), bool(os.environ.get('PYTHONUSERBASE')))",
				pythonInterpreter: "python3",
				loaderPath: path.join(homeRoot, "missing-restore.py"),
			});
			expect(goodLoad.restoredCount, "POST-CTX27-4 violation: restore.py must restore all 3 functions").toBe(3);
			expect(goodLoad.probeResult).toBe("('R017', True)");

			// Corrupt one snapshot file so SHA-256 mismatches -> failed load leaves previous binding in place and returns error
			fs.writeFileSync(path.join(homeSnapDir, "expand_rules.dill"), "corrupted", { mode: 0o600 });
			const badLoad = await restoreTrustedHelperSnapshotsWithLoader({
				homeDir: homeRoot,
				priorBindingExpr: "expand_rules = lambda x: 'PRIOR_BINDING'",
				probeCallExpr: "expand_rules(17)",
				pythonInterpreter: "python3",
				loaderPath: path.join(homeRoot, "missing-restore.py"),
			});
			expect(badLoad.refused.length, "POST-CTX27-4 violation: failed load must report refusal error").toBe(1);
			expect(badLoad.probeResult, "POST-CTX27-4 violation: failed load must leave previous binding in place").toBe(
				"PRIOR_BINDING",
			);
		} finally {
			fs.rmSync(homeRoot, { recursive: true, force: true });
		}

		expect(typeof createContextEfficiencyExtension).toBe("function");
	});

	it("Test 3 (Compaction): drops unpicklable names to open_items, cancels on hash mismatch with CompactionCancelledError, and round-trips payload hash via dill.load_session (POST-CTX27-5, SEQ-CTX27-4, ERRORS-CTX27-1)", async () => {
		const sessionId = "01a18024-a7e2-7053-983f-dc092ca4aa58";
		const enforcer = new ContextEfficiencyEnforcer({
			agentDir: tempRoot,
			sessionId,
		});

		const { jsonText: fOverPayload } = buildJsonArrayWithExactMinTokens(1501);
		const overRes = await enforcer.admitToolResult({
			toolCallId: "call-compact-payload",
			text: fOverPayload,
		});
		expect(overRes.mode).toBe("filed");
		if (!overRes.descriptor) {
			throw new Error("POST-CTX27-1 violation: expected filed descriptor");
		}
		const artifactName = overRes.descriptor.name;

		// Inject an unpicklable generator/lock into the kernel namespace
		await enforcer.injectUnpicklableKernelVar("unpicklable_gen");

		// 1) Corrupted snapshot hash -> hook returns { cancel: true }, compact() throws CompactionCancelledError, entry count unchanged
		let compactionEntries = 0;
		const hookCancel = await enforcer.runBeforeCompactHook({ corruptHash: true });
		expect(hookCancel, "ERRORS-CTX27-1 / SEQ-CTX27-4 violation: corrupt hash must return { cancel: true }").toEqual({
			cancel: true,
		});
		await expect(
			enforcer.runCompactionWithGate({
				corruptHash: true,
				onCommitCompactionEntry: () => {
					compactionEntries += 1;
				},
			}),
		).rejects.toBeInstanceOf(CompactionCancelledError);
		expect(compactionEntries, "ERRORS-CTX27-1 violation: compaction-entry count must remain unchanged").toBe(0);
		expect(enforcer.getLastCompactionStatusText()).toBe(COMPACTION_CANCELLED_TEXT);

		// 2) Valid snapshot -> unpicklable name in open_items, absent from snapshot, one record written, fresh dill.load_session returns payload hash
		const outcome = await enforcer.runCompactionWithGate({
			corruptHash: false,
			onCommitCompactionEntry: () => {
				compactionEntries += 1;
			},
		});
		expect(compactionEntries).toBe(1);
		expect(outcome.recordKey).toBe(`auto-compact-memory-${sessionId}-1`);
		expect(outcome.record.open_items.some(item => item.includes("unpicklable_gen"))).toBe(true);
		expect(JSON.stringify(outcome.record).includes(fOverPayload.slice(0, 64))).toBe(false);

		const restored = await enforcer.verifyCompactionSnapshotInFreshProcess(
			outcome.record.snapshot_path,
			artifactName,
		);
		expect(restored.startsWithPickleMagic0x80).toBe(true);
		expect(restored.sha256MatchesRecord).toBe(outcome.record.sha256);
		expect(restored.hasUnpicklableGen).toBe(false);
		expect(restored.restoredArtifactSha256).toBe(
			crypto.createHash("sha256").update(fOverPayload, "utf8").digest("hex"),
		);
	});

	it("Test 4 (Prompt Assembly & Done Budget): forbids 32-byte payload value slices outside cut sample/text lines and keeps the fixture transcript <= 700 o200k tokens (FORBIDDEN-CTX27-1)", async () => {
		const sessionId = "01a18024-a7e2-7053-983f-dc092ca4aa58";
		const enforcer = new ContextEfficiencyEnforcer({
			agentDir: tempRoot,
			sessionId,
		});
		const snapshotsDir = path.join(tempRoot, "repl-snapshots");
		for (let i = 1; i <= 3; i += 1) {
			await saveTrustedHelperSnapshot({
				snapshotsDir,
				name: `helper_${i}`,
				signature: `(x: int) -> int`,
				summary: `Helper function ${i}`,
				snapshotBasename: `helper_${i}.dill`,
				pythonSource: `def helper_${i}(x):\n    return x + ${i}\n`,
			});
		}

		const { jsonText: fOverPayload, rows } = buildJsonArrayWithExactMinTokens(1501);
		const overRes = await enforcer.admitToolResult({
			toolCallId: "call-f-over-main",
			text: fOverPayload,
		});
		const assembled = assemblePromptWithCatalogCards("", snapshotsDir);
		const compactionStatus = COMPACTION_CANCELLED_TEXT;

		// Fixture transcript = F-over descriptor + 3 cards + compaction status line (excluding user prompts, F-inline, F-turn, F-session)
		const fixtureTranscript = [
			overRes.transcriptText,
			...assembled.cards.map(c => JSON.stringify(c)),
			compactionStatus,
		].join("\n");

		if (!overRes.descriptor) {
			throw new Error("POST-CTX27-1 violation: expected filed descriptor");
		}
		const payloadValues = rows.map(r => String(r.schema_column_identifier_exceeding_31_characters));
		const leaks = findLeakedPayloadValueSlices({
			promptText: fixtureTranscript,
			payloadValues,
			descriptor: overRes.descriptor,
			sliceBytes: PAYLOAD_SLICE_BYTES,
		});
		expect(
			leaks,
			`FORBIDDEN-CTX27-1 violation: 32-byte payload value slices leaked outside cut sample/text lines: ${leaks.join(", ")}`,
		).toEqual([]);

		const fixtureTokens = countO200kTokens(fixtureTranscript);
		expect(
			fixtureTokens <= FIXTURE_TRANSCRIPT_MAX_TOKENS,
			`FORBIDDEN-CTX27-1 violation: fixture transcript tokens ${fixtureTokens} exceeded ${FIXTURE_TRANSCRIPT_MAX_TOKENS}`,
		).toBe(true);
	});
});
