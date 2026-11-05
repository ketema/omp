/**
 * Context Efficiency Enforcement — Production Implementation for ketema/omp#27.
 *
 * Redeclares all specification constants, domain exceptions, and runtime
 * precondition/invariant/postcondition guards independently (CL11-F: zero
 * imports from contracts/).
 *
 * Traceability:
 *   PRE-CTX27-1: ImplPreconditionViolationError, assertImplEnforcerPreconditions
 *   INV-CTX27-1: ImplBudgetInvariantViolationError, assertImplBudgetInvariant
 *   POST-CTX27-1, SEQ-CTX27-1: countO200kTokens, admitToolResult (1,500 per-result/per-turn, 6,000 per-session)
 *   POST-CTX27-2: buildUdtDescriptor (<= 400 tokens, 31-char schema cut, 5+5 x 40 text, 40-char sample, progressive drop)
 *   POST-CTX27-3, SEQ-CTX27-2: getKernelArtifactSha256, getKernelDisplayOutput (<= 60 lines / 2,048 bytes)
 *   POST-CTX27-4, SEQ-CTX27-3: saveTrustedHelperSnapshot, restoreTrustedHelperSnapshotsWithLoader, assemblePromptWithCatalogCards
 *   POST-CTX27-5, SEQ-CTX27-4, ERRORS-CTX27-1: runBeforeCompactHook, runCompactionWithGate, verifyCompactionSnapshotInFreshProcess
 *   FORBIDDEN-CTX27-1: findLeakedPayloadValueSlices (no 32-byte payload value slice outside cut sample/text line)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import * as natives from "@oh-my-pi/pi-natives";

// =============================================================================
// Redeclared Constants (CL11-F)
// =============================================================================

export const IMPL_RESULT_TOKEN_THRESHOLD = 1500;
export const IMPL_TURN_INLINE_TOKEN_BUDGET = 1500;
export const IMPL_SESSION_INLINE_TOKEN_BUDGET = 6000;
export const IMPL_DESCRIPTOR_MAX_TOKENS = 400;
export const IMPL_SCHEMA_NAME_MAX_CHARS = 31;
export const IMPL_TEXT_HEAD_LINES = 5;
export const IMPL_TEXT_TAIL_LINES = 5;
export const IMPL_TEXT_LINE_MAX_CHARS = 40;
export const IMPL_SAMPLE_STRING_MAX_CHARS = 40;
export const IMPL_DISPLAY_MAX_LINES = 60;
export const IMPL_DISPLAY_MAX_BYTES = 2048;

export const IMPL_CARD_MAX_TOKENS = 80;
export const IMPL_CARD_NAME_MAX_CHARS = 16;
export const IMPL_CARD_SIGNATURE_MAX_CHARS = 24;
export const IMPL_CARD_SUMMARY_MAX_CHARS = 32;
export const IMPL_CARD_SNAPSHOT_MAX_CHARS = 24;

export const IMPL_PAYLOAD_SLICE_BYTES = 32;
export const IMPL_FIXTURE_TRANSCRIPT_MAX_TOKENS = 700;
export const IMPL_COMPACTION_CANCELLED_TEXT = "Compaction cancelled";

const LOW_CARDINALITY_MAX_DISTINCT = 12;

// =============================================================================
// Redeclared Domain Exception Hierarchy & Assertion Guards (CL11-A / CL11-F)
// =============================================================================

export class ImplContextEfficiencyError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class ImplPreconditionViolationError extends ImplContextEfficiencyError {
	constructor(detail: string) {
		super(`PRE-CTX27-1 violation: ${detail}`);
	}
}

export class ImplBudgetInvariantViolationError extends ImplContextEfficiencyError {
	constructor(detail: string) {
		super(`INV-CTX27-1 violation: ${detail}`);
	}
}

export function assertImplEnforcerPreconditions(options: {
	readonly agentDir: string;
	readonly sessionId: string;
}): asserts options is { readonly agentDir: string; readonly sessionId: string } {
	if (typeof options.agentDir !== "string" || options.agentDir.trim().length === 0) {
		throw new ImplPreconditionViolationError("agentDir must be a non-empty string");
	}
	if (typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
		throw new ImplPreconditionViolationError("sessionId must be a non-empty string");
	}
}

export function assertImplBudgetInvariant(state: {
	readonly turnInlineTokens: number;
	readonly sessionInlineTokens: number;
}): void {
	if (
		!Number.isInteger(state.turnInlineTokens) ||
		state.turnInlineTokens < 0 ||
		state.turnInlineTokens > IMPL_TURN_INLINE_TOKEN_BUDGET
	) {
		throw new ImplBudgetInvariantViolationError(
			`turnInlineTokens ${state.turnInlineTokens} outside [0, ${IMPL_TURN_INLINE_TOKEN_BUDGET}]`,
		);
	}
	if (
		!Number.isInteger(state.sessionInlineTokens) ||
		state.sessionInlineTokens < 0 ||
		state.sessionInlineTokens > IMPL_SESSION_INLINE_TOKEN_BUDGET
	) {
		throw new ImplBudgetInvariantViolationError(
			`sessionInlineTokens ${state.sessionInlineTokens} outside [0, ${IMPL_SESSION_INLINE_TOKEN_BUDGET}]`,
		);
	}
}

// =============================================================================
// Types
// =============================================================================

export type UdtClass = "json_array" | "json_object" | "tabular" | "text";

export interface UdtDescriptor {
	readonly class: UdtClass;
	readonly name: string;
	readonly count?: number;
	readonly key_schema_union?: readonly string[];
	readonly low_cardinality_distributions?: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly sample_row_0?: Readonly<Record<string, unknown>> | null;
	readonly top_level_keys?: readonly string[];
	readonly per_key_shape?: Readonly<Record<string, string>>;
	readonly columns?: readonly string[];
	readonly row_count?: number;
	readonly numeric_summary?: Readonly<
		Record<string, { readonly min: number; readonly max: number; readonly avg: number }>
	>;
	readonly total_lines?: number;
	readonly head?: readonly string[];
	readonly omitted?: number;
	readonly tail?: readonly string[];
}

export interface CatalogCard {
	readonly name: string;
	readonly signature: string;
	readonly summary: string;
	readonly snapshot: string;
}

export interface AutoCompactRecord {
	readonly narrative: string;
	readonly descriptors: Readonly<Record<string, UdtDescriptor>>;
	readonly kernel_handles: readonly string[];
	readonly snapshot_path: string;
	readonly sha256: string;
	readonly files_touched: readonly string[];
	readonly open_items: readonly string[];
}

export interface AdmitToolResultInput {
	readonly toolCallId: string;
	readonly text: string;
}

export interface AdmitToolResultOutput {
	readonly mode: "inline" | "filed";
	readonly transcriptText: string;
	readonly tokenCount: number;
	readonly descriptor?: UdtDescriptor;
}

export interface SaveTrustedHelperSnapshotInput {
	readonly snapshotsDir: string;
	readonly name: string;
	readonly signature: string;
	readonly summary: string;
	readonly snapshotBasename: string;
	readonly pythonSource: string;
}

interface HelperSnapshotManifestEntry {
	readonly id: string;
	readonly file: string;
	readonly sha256: string;
	readonly byte_size: number;
	readonly python_version: string;
	readonly dill_version: string;
	readonly names: readonly string[];
	readonly expected_types: Readonly<Record<string, "callable" | "str">>;
	readonly auto_restore: boolean;
	readonly signature: string;
	readonly summary: string;
	readonly compression: string;
	readonly saved_at: string;
}

interface HelperSnapshotManifest {
	readonly schema_version: 1;
	readonly snapshots: readonly HelperSnapshotManifestEntry[];
}

export interface ContextEfficiencyEnforcerOptions {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly pythonInterpreter?: string;
}

// =============================================================================
// Runtime Boundary Guards (skill://typescript-mastery)
// =============================================================================

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSnapshotMeta(rawText: string): {
	readonly sha256: string;
	readonly byte_size: number;
	readonly python_version: string;
	readonly dill_version: string;
	readonly compression: string;
} {
	const parsed: unknown = JSON.parse(rawText);
	if (
		!isPlainRecord(parsed) ||
		typeof parsed.sha256 !== "string" ||
		typeof parsed.byte_size !== "number" ||
		typeof parsed.python_version !== "string" ||
		typeof parsed.dill_version !== "string" ||
		typeof parsed.compression !== "string"
	) {
		throw new ImplContextEfficiencyError("POST-CTX27-4 violation: invalid snapshot metadata from Python serializer");
	}
	return {
		sha256: parsed.sha256,
		byte_size: parsed.byte_size,
		python_version: parsed.python_version,
		dill_version: parsed.dill_version,
		compression: parsed.compression,
	};
}

function parseManifestFile(rawText: string): HelperSnapshotManifest {
	const parsed: unknown = JSON.parse(rawText);
	if (!isPlainRecord(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.snapshots)) {
		return { schema_version: 1, snapshots: [] };
	}
	const entries: HelperSnapshotManifestEntry[] = [];
	for (const item of parsed.snapshots) {
		if (
			!isPlainRecord(item) ||
			typeof item.id !== "string" ||
			typeof item.file !== "string" ||
			typeof item.sha256 !== "string" ||
			typeof item.byte_size !== "number" ||
			typeof item.python_version !== "string" ||
			typeof item.dill_version !== "string" ||
			!Array.isArray(item.names) ||
			!item.names.every((n): n is string => typeof n === "string") ||
			!isPlainRecord(item.expected_types) ||
			typeof item.signature !== "string" ||
			typeof item.summary !== "string" ||
			typeof item.compression !== "string" ||
			typeof item.saved_at !== "string"
		) {
			continue;
		}
		const expectedTypes: Record<string, "callable" | "str"> = {};
		for (const [k, v] of Object.entries(item.expected_types)) {
			if (v === "callable" || v === "str") {
				expectedTypes[k] = v;
			}
		}
		entries.push({
			id: item.id,
			file: item.file,
			sha256: item.sha256,
			byte_size: item.byte_size,
			python_version: item.python_version,
			dill_version: item.dill_version,
			names: item.names,
			expected_types: expectedTypes,
			auto_restore: item.auto_restore === true,
			signature: item.signature,
			summary: item.summary,
			compression: item.compression,
			saved_at: item.saved_at,
		});
	}
	return { schema_version: 1, snapshots: entries };
}

function parseRestoreLoaderOutput(rawText: string): {
	readonly restoredCount: number;
	readonly refused: readonly { readonly record: string; readonly reason: string }[];
	readonly probeResult: string;
} {
	const parsed: unknown = JSON.parse(rawText);
	if (
		!isPlainRecord(parsed) ||
		typeof parsed.restoredCount !== "number" ||
		!Array.isArray(parsed.refused) ||
		typeof parsed.probeResult !== "string"
	) {
		throw new ImplContextEfficiencyError("POST-CTX27-4 violation: invalid output from restore.py runner");
	}
	const refused: { readonly record: string; readonly reason: string }[] = [];
	for (const r of parsed.refused) {
		if (isPlainRecord(r) && typeof r.record === "string" && typeof r.reason === "string") {
			refused.push({ record: r.record, reason: r.reason });
		}
	}
	return {
		restoredCount: parsed.restoredCount,
		refused,
		probeResult: parsed.probeResult,
	};
}

function parseDumpMeta(rawText: string): { readonly sha256: string; readonly dropped: readonly string[] } {
	const parsed: unknown = JSON.parse(rawText);
	if (
		!isPlainRecord(parsed) ||
		typeof parsed.sha256 !== "string" ||
		!Array.isArray(parsed.dropped) ||
		!parsed.dropped.every((d): d is string => typeof d === "string")
	) {
		throw new ImplContextEfficiencyError("POST-CTX27-5 violation: invalid compaction dump metadata");
	}
	return { sha256: parsed.sha256, dropped: parsed.dropped };
}

function parseVerifyOutput(rawText: string): {
	readonly startsWithPickleMagic0x80: boolean;
	readonly sha256MatchesRecord: string;
	readonly hasUnpicklableGen: boolean;
	readonly restoredArtifactSha256: string;
} {
	const parsed: unknown = JSON.parse(rawText);
	if (
		!isPlainRecord(parsed) ||
		typeof parsed.startsWithPickleMagic0x80 !== "boolean" ||
		typeof parsed.sha256MatchesRecord !== "string" ||
		typeof parsed.hasUnpicklableGen !== "boolean" ||
		typeof parsed.restoredArtifactSha256 !== "string"
	) {
		throw new ImplContextEfficiencyError("POST-CTX27-5 violation: invalid snapshot verification output");
	}
	return {
		startsWithPickleMagic0x80: parsed.startsWithPickleMagic0x80,
		sha256MatchesRecord: parsed.sha256MatchesRecord,
		hasUnpicklableGen: parsed.hasUnpicklableGen,
		restoredArtifactSha256: parsed.restoredArtifactSha256,
	};
}

// =============================================================================
// Token Counter (POST-CTX27-1)
// =============================================================================

/**
 * POST-CTX27-1: Counts tokens with natives.countTokens(text, Encoding.O200kBase).
 * Deterministic proxy; never retokenizes per model.
 */
export function countO200kTokens(text: string): number {
	if (text.length === 0) return 0;
	return natives.countTokens(text, natives.Encoding.O200kBase);
}

function resolveKernelPython(explicit?: string): string {
	if (explicit && explicit.length > 0) return explicit;
	const home = process.env.HOME ?? os.homedir();
	const managed = path.join(home, ".omp", "agent", "kernel-venv", "bin", "python");
	if (fs.existsSync(managed)) return managed;
	return "python3";
}

function formatCappedDisplay(rawText: string): string {
	const allLines = rawText.split("\n");
	const cappedLines = allLines.slice(0, IMPL_DISPLAY_MAX_LINES);
	let joined = cappedLines.join("\n");
	if (Buffer.byteLength(joined, "utf8") > IMPL_DISPLAY_MAX_BYTES) {
		const buf = Buffer.from(joined, "utf8").subarray(0, IMPL_DISPLAY_MAX_BYTES);
		joined = buf.toString("utf8");
	}
	return joined;
}

function describeValueShape(val: unknown): string {
	if (typeof val === "string") return `str[${val.length}]`;
	if (Array.isArray(val)) return `list[${val.length}]`;
	if (val !== null && typeof val === "object") return `dict[${Object.keys(val).length}]`;
	if (val === null) return "null";
	return typeof val;
}

function sanitizeSampleRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const entries = Object.entries(row).slice(0, 8);
	for (const [k, v] of entries) {
		const cutKey = k.slice(0, IMPL_SCHEMA_NAME_MAX_CHARS);
		if (typeof v === "string") {
			out[cutKey] = v.slice(0, IMPL_SAMPLE_STRING_MAX_CHARS);
		} else if (typeof v === "number" || typeof v === "boolean" || v === null) {
			out[cutKey] = v;
		} else {
			out[cutKey] = describeValueShape(v);
		}
	}
	return out;
}

function parseTabularIfStructured(rawText: string): UdtDescriptor | null {
	const lines = rawText
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	const headerLine = lines[0];
	if (lines.length < 2 || headerLine === undefined) return null;
	const sep = headerLine.includes("\t") ? "\t" : headerLine.includes(",") ? "," : null;
	if (!sep) return null;
	const rawHeaders = headerLine.split(sep).map(h => h.trim());
	if (rawHeaders.length < 2) return null;
	const rows = lines.slice(1).map(l => l.split(sep).map(c => c.trim()));
	if (!rows.every(r => r.length === rawHeaders.length)) return null;

	const columns = rawHeaders.map(h => h.slice(0, IMPL_SCHEMA_NAME_MAX_CHARS));
	const numericSummary: Record<string, { min: number; max: number; avg: number }> = {};
	for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
		const colName = columns[colIdx];
		if (colName === undefined) continue;
		const nums: number[] = [];
		for (const r of rows) {
			const cell = r[colIdx];
			const n = Number(cell);
			if (cell !== undefined && cell !== "" && !Number.isNaN(n)) nums.push(n);
		}
		if (nums.length === rows.length && nums.length > 0) {
			const min = Math.min(...nums);
			const max = Math.max(...nums);
			const avg = Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4));
			numericSummary[colName] = { min, max, avg };
		}
	}
	return {
		class: "tabular",
		name: "artifact_pending",
		columns,
		row_count: rows.length,
		numeric_summary: numericSummary,
	};
}

// =============================================================================
// Catalog Gate Helpers (POST-CTX27-4, SEQ-CTX27-3)
// =============================================================================

export async function saveTrustedHelperSnapshot(input: SaveTrustedHelperSnapshotInput): Promise<CatalogCard> {
	const snapshotsDir = path.resolve(input.snapshotsDir);
	fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(snapshotsDir, 0o700);

	const basename = path.basename(input.snapshotBasename).slice(0, IMPL_CARD_SNAPSHOT_MAX_CHARS);
	const snapshotPath = path.join(snapshotsDir, basename);
	const tmpPath = `${snapshotPath}.tmp.${process.pid}.${Date.now()}`;
	const pythonExe = resolveKernelPython();

	const pyScript = [
		"import dill, hashlib, json, lzma, os, sys",
		"src = sys.argv[1]",
		"fn_name = sys.argv[2]",
		"tmp_path = sys.argv[3]",
		"ns = {}",
		"exec(compile(src, '<helper>', 'exec'), ns)",
		"fn = ns[fn_name]",
		"payload = {fn_name: fn}",
		"raw = dill.dumps(payload, protocol=4)",
		"comp = lzma.compress(raw, preset=0)",
		"use_lzma = len(comp) * 2 <= len(raw)",
		"out_bytes = comp if use_lzma else raw",
		"fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)",
		"with os.fdopen(fd, 'wb') as fh:",
		"    fh.write(out_bytes)",
		"    fh.flush()",
		"    os.fsync(fh.fileno())",
		"print(json.dumps({",
		"    'sha256': hashlib.sha256(out_bytes).hexdigest(),",
		"    'byte_size': len(out_bytes),",
		"    'python_version': f'{sys.version_info.major}.{sys.version_info.minor}',",
		"    'dill_version': getattr(dill, '__version__', '0.4'),",
		"    'compression': 'lzma' if use_lzma else 'raw',",
		"}))",
	].join("\n");

	const proc = Bun.spawnSync({
		cmd: [pythonExe, "-c", pyScript, input.pythonSource, input.name, tmpPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new ImplContextEfficiencyError(
			`POST-CTX27-4 violation: failed to serialize helper snapshot: ${proc.stderr.toString()}`,
		);
	}
	const meta = parseSnapshotMeta(proc.stdout.toString().trim());
	fs.renameSync(tmpPath, snapshotPath);
	fs.chmodSync(snapshotPath, 0o600);

	const manifestPath = path.join(snapshotsDir, "manifest.json");
	let existing: HelperSnapshotManifestEntry[] = [];
	if (fs.existsSync(manifestPath)) {
		const loaded = parseManifestFile(fs.readFileSync(manifestPath, "utf8"));
		existing = loaded.snapshots.filter(s => s.id !== input.name);
	}
	const id = input.name.slice(0, IMPL_CARD_NAME_MAX_CHARS);
	const entry: HelperSnapshotManifestEntry = {
		id,
		file: basename,
		sha256: meta.sha256,
		byte_size: meta.byte_size,
		python_version: meta.python_version,
		dill_version: meta.dill_version,
		names: [id],
		expected_types: { [id]: "callable" },
		auto_restore: true,
		signature: input.signature.slice(0, IMPL_CARD_SIGNATURE_MAX_CHARS),
		summary: input.summary.slice(0, IMPL_CARD_SUMMARY_MAX_CHARS),
		compression: meta.compression,
		saved_at: new Date().toISOString(),
	};
	const nextManifest: HelperSnapshotManifest = {
		schema_version: 1,
		snapshots: [...existing, entry],
	};
	const manifestTmp = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(manifestTmp, JSON.stringify(nextManifest, null, 2), { mode: 0o600 });
	fs.renameSync(manifestTmp, manifestPath);
	fs.chmodSync(manifestPath, 0o600);

	return {
		name: entry.id,
		signature: entry.signature,
		summary: entry.summary,
		snapshot: entry.file,
	};
}

export async function restoreTrustedHelperSnapshotsWithLoader(options: {
	readonly homeDir: string;
	readonly priorBindingExpr?: string;
	readonly probeCallExpr: string;
	readonly loaderPath?: string;
}): Promise<{
	readonly restoredCount: number;
	readonly refused: readonly { readonly record: string; readonly reason: string }[];
	readonly probeResult: string;
}> {
	const realHome = process.env.HOME ?? os.homedir();
	const loaderPath = options.loaderPath ?? path.join(realHome, ".agents", "skills", "repl-snapshots", "restore.py");
	const pythonExe = resolveKernelPython();
	const pyRunner = [
		"import io, json, os, sys",
		"from pathlib import Path",
		"loader = Path(sys.argv[1])",
		"prior_expr = sys.argv[2]",
		"probe_expr = sys.argv[3]",
		"if prior_expr:",
		"    exec(prior_expr, globals())",
		"buf = io.StringIO()",
		"old_out = sys.stdout",
		"try:",
		"    sys.stdout = buf",
		"    exec(compile(loader.read_text(), str(loader), 'exec'), globals())",
		"finally:",
		"    sys.stdout = old_out",
		"lines = [ln.strip() for ln in buf.getvalue().splitlines() if ln.strip()]",
		"events = [json.loads(ln) for ln in lines]",
		"restored_count = sum(1 for e in events if e.get('snapshot_restore') == 'restored')",
		"refused = [{'record': e.get('record', ''), 'reason': e.get('reason', '')} for e in events if e.get('snapshot_restore') == 'refused']",
		"probe_val = eval(probe_expr, globals()) if probe_expr else ''",
		"print(json.dumps({'restoredCount': restored_count, 'refused': refused, 'probeResult': str(probe_val)}))",
	].join("\n");

	const proc = Bun.spawnSync({
		cmd: [pythonExe, "-c", pyRunner, loaderPath, options.priorBindingExpr ?? "", options.probeCallExpr],
		env: { ...process.env, HOME: path.resolve(options.homeDir) },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new ImplContextEfficiencyError(
			`POST-CTX27-4 violation: restore.py execution failed: ${proc.stderr.toString()}`,
		);
	}
	return parseRestoreLoaderOutput(proc.stdout.toString().trim());
}

export function assemblePromptWithCatalogCards(
	basePrompt: string,
	snapshotsDir: string,
): { readonly prompt: string; readonly cards: readonly CatalogCard[] } {
	const manifestPath = path.join(path.resolve(snapshotsDir), "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		return { prompt: basePrompt, cards: [] };
	}
	const manifest = parseManifestFile(fs.readFileSync(manifestPath, "utf8"));
	const cards: CatalogCard[] = [];
	for (const entry of manifest.snapshots) {
		const snapshotFile = path.join(path.resolve(snapshotsDir), path.basename(entry.file));
		if (!fs.existsSync(snapshotFile)) continue;
		const lst = fs.lstatSync(snapshotFile);
		if (!lst.isFile() || lst.isSymbolicLink() || (lst.mode & 0o777) !== 0o600) continue;
		const bytes = fs.readFileSync(snapshotFile);
		const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
		if (actualSha !== entry.sha256 || bytes.byteLength !== entry.byte_size) continue;

		const card: CatalogCard = {
			name: entry.id.slice(0, IMPL_CARD_NAME_MAX_CHARS),
			signature: entry.signature.slice(0, IMPL_CARD_SIGNATURE_MAX_CHARS),
			summary: entry.summary.slice(0, IMPL_CARD_SUMMARY_MAX_CHARS),
			snapshot: path.basename(entry.file).slice(0, IMPL_CARD_SNAPSHOT_MAX_CHARS),
		};
		cards.push(card);
	}
	const cardLines = cards.map(c => JSON.stringify(c));
	const prompt = cardLines.length > 0 ? [basePrompt, ...cardLines].filter(Boolean).join("\n") : basePrompt;
	return { prompt, cards };
}

// =============================================================================
// Prompt-Assembly Leak Detector (FORBIDDEN-CTX27-1)
// =============================================================================

export function findLeakedPayloadValueSlices(options: {
	readonly promptText: string;
	readonly payloadValues: readonly string[];
	readonly descriptor: UdtDescriptor;
	readonly sliceBytes?: number;
}): string[] {
	const sliceBytes = options.sliceBytes ?? IMPL_PAYLOAD_SLICE_BYTES;
	const allowedSubstrings: string[] = [];
	if (options.descriptor.sample_row_0) {
		for (const val of Object.values(options.descriptor.sample_row_0)) {
			if (typeof val === "string") {
				allowedSubstrings.push(val.slice(0, IMPL_SAMPLE_STRING_MAX_CHARS));
			}
		}
	}
	for (const line of [...(options.descriptor.head ?? []), ...(options.descriptor.tail ?? [])]) {
		allowedSubstrings.push(line.slice(0, IMPL_TEXT_LINE_MAX_CHARS));
	}

	let scrubbedPrompt = options.promptText;
	for (const allowed of allowedSubstrings) {
		if (allowed.length > 0) {
			scrubbedPrompt = scrubbedPrompt.split(allowed).join("");
		}
	}

	const leaked: string[] = [];
	for (const value of options.payloadValues) {
		if (Buffer.byteLength(value, "utf8") < sliceBytes) continue;
		for (let offset = 0; offset + sliceBytes <= value.length; offset += 8) {
			const candidate = value.slice(offset, offset + sliceBytes);
			if (Buffer.byteLength(candidate, "utf8") >= sliceBytes && scrubbedPrompt.includes(candidate)) {
				leaked.push(candidate);
				break;
			}
		}
	}
	return leaked;
}

// =============================================================================
// Enforcer (Emission Gate + Kernel Binding + Compaction Gate)
// =============================================================================

export class ContextEfficiencyEnforcer {
	readonly #agentDir: string;
	readonly #sessionId: string;
	readonly #pythonExe: string;
	#turnInlineTokens = 0;
	#sessionInlineTokens = 0;
	#artifactSeq = 0;
	readonly #kernelArtifacts = new Map<string, string>();
	readonly #descriptors = new Map<string, UdtDescriptor>();
	readonly #unpicklableVars = new Set<string>();
	readonly #memoryRecords = new Map<string, AutoCompactRecord>();
	#lastCompactionStatusText = "";

	constructor(options: ContextEfficiencyEnforcerOptions) {
		// PRE-CTX27-1
		assertImplEnforcerPreconditions(options);
		this.#agentDir = path.resolve(options.agentDir);
		this.#sessionId = options.sessionId;
		this.#pythonExe = resolveKernelPython(options.pythonInterpreter);
		fs.mkdirSync(this.#agentDir, { recursive: true });
		// INV-CTX27-1 established at construction
		assertImplBudgetInvariant({
			turnInlineTokens: this.#turnInlineTokens,
			sessionInlineTokens: this.#sessionInlineTokens,
		});
	}

	startNewTurn(): void {
		this.#turnInlineTokens = 0;
		assertImplBudgetInvariant({
			turnInlineTokens: this.#turnInlineTokens,
			sessionInlineTokens: this.#sessionInlineTokens,
		});
	}

	resetBudgets(): void {
		this.#turnInlineTokens = 0;
		this.#sessionInlineTokens = 0;
		assertImplBudgetInvariant({
			turnInlineTokens: this.#turnInlineTokens,
			sessionInlineTokens: this.#sessionInlineTokens,
		});
	}

	getTurnInlineTokens(): number {
		return this.#turnInlineTokens;
	}

	getSessionInlineTokens(): number {
		return this.#sessionInlineTokens;
	}

	getLastCompactionStatusText(): string {
		return this.#lastCompactionStatusText;
	}

	async admitToolResult(input: AdmitToolResultInput): Promise<AdmitToolResultOutput> {
		// PRE-CTX27-1
		if (typeof input.toolCallId !== "string" || input.toolCallId.trim().length === 0) {
			throw new ImplPreconditionViolationError("toolCallId must be a non-empty string");
		}
		// INV-CTX27-1 at entry
		assertImplBudgetInvariant({
			turnInlineTokens: this.#turnInlineTokens,
			sessionInlineTokens: this.#sessionInlineTokens,
		});

		const tokenCount = countO200kTokens(input.text);
		const fitsResultThreshold = tokenCount < IMPL_RESULT_TOKEN_THRESHOLD;
		const fitsTurnBudget = this.#turnInlineTokens + tokenCount <= IMPL_TURN_INLINE_TOKEN_BUDGET;
		const fitsSessionBudget = this.#sessionInlineTokens + tokenCount <= IMPL_SESSION_INLINE_TOKEN_BUDGET;

		if (fitsResultThreshold && fitsTurnBudget && fitsSessionBudget) {
			this.#turnInlineTokens += tokenCount;
			this.#sessionInlineTokens += tokenCount;
			// INV-CTX27-1 at exit
			assertImplBudgetInvariant({
				turnInlineTokens: this.#turnInlineTokens,
				sessionInlineTokens: this.#sessionInlineTokens,
			});
			return {
				mode: "inline",
				transcriptText: input.text,
				tokenCount,
			};
		}

		this.#artifactSeq += 1;
		const cleanId = input.toolCallId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || String(this.#artifactSeq);
		const artifactName = `artifact_${cleanId}_${this.#artifactSeq}`;

		// SEQ-CTX27-2: bind in kernel store BEFORE returning descriptor
		this.#kernelArtifacts.set(artifactName, input.text);
		const descriptor = this.buildUdtDescriptor(artifactName, input.text);
		this.#descriptors.set(artifactName, descriptor);
		const transcriptText = JSON.stringify(descriptor);

		// INV-CTX27-1 at exit
		assertImplBudgetInvariant({
			turnInlineTokens: this.#turnInlineTokens,
			sessionInlineTokens: this.#sessionInlineTokens,
		});
		return {
			mode: "filed",
			transcriptText,
			tokenCount: countO200kTokens(transcriptText),
			descriptor,
		};
	}

	buildUdtDescriptor(artifactName: string, rawText: string): UdtDescriptor {
		let base: UdtDescriptor;
		let parsedJson: unknown;
		let isJson = false;
		try {
			parsedJson = JSON.parse(rawText);
			isJson = true;
		} catch {
			isJson = false;
		}

		if (isJson && Array.isArray(parsedJson)) {
			const keyUnionSet = new Set<string>();
			const rawKeyMap = new Map<string, string>();
			for (const item of parsedJson) {
				if (isPlainRecord(item)) {
					for (const k of Object.keys(item)) {
						const cut = k.slice(0, IMPL_SCHEMA_NAME_MAX_CHARS);
						keyUnionSet.add(cut);
						if (!rawKeyMap.has(cut)) rawKeyMap.set(cut, k);
					}
				}
			}
			const keySchemaUnion = [...keyUnionSet].toSorted();
			const distributions: Record<string, Record<string, number>> = {};
			for (const cutKey of keySchemaUnion) {
				const origKey = rawKeyMap.get(cutKey) ?? cutKey;
				const counts = new Map<string, number>();
				let totalPresent = 0;
				for (const item of parsedJson) {
					if (isPlainRecord(item) && origKey in item) {
						totalPresent += 1;
						const val = item[origKey];
						if (typeof val === "string" || typeof val === "number" || typeof val === "boolean" || val === null) {
							const label = String(val).slice(0, IMPL_SAMPLE_STRING_MAX_CHARS);
							counts.set(label, (counts.get(label) ?? 0) + 1);
						}
					}
				}
				if (
					counts.size > 1 &&
					counts.size <= LOW_CARDINALITY_MAX_DISTINCT &&
					counts.size < Math.max(totalPresent * 0.5, 2)
				) {
					distributions[cutKey] = Object.fromEntries(counts.entries());
				}
			}
			const first = parsedJson[0];
			const sampleRow0 = isPlainRecord(first) ? sanitizeSampleRow(first) : null;
			base = {
				class: "json_array",
				name: artifactName,
				count: parsedJson.length,
				key_schema_union: keySchemaUnion,
				low_cardinality_distributions: distributions,
				sample_row_0: sampleRow0,
			};
		} else if (isJson && isPlainRecord(parsedJson)) {
			const topKeys: string[] = [];
			const perKeyShape: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsedJson)) {
				const cut = k.slice(0, IMPL_SCHEMA_NAME_MAX_CHARS);
				topKeys.push(cut);
				perKeyShape[cut] = describeValueShape(v);
			}
			base = {
				class: "json_object",
				name: artifactName,
				top_level_keys: topKeys,
				per_key_shape: perKeyShape,
			};
		} else {
			const tabular = parseTabularIfStructured(rawText);
			if (tabular !== null) {
				base = {
					...tabular,
					name: artifactName,
				};
			} else {
				const lines = rawText.split("\n");
				const head = lines.slice(0, IMPL_TEXT_HEAD_LINES).map(l => l.slice(0, IMPL_TEXT_LINE_MAX_CHARS));
				const tail =
					lines.length > IMPL_TEXT_HEAD_LINES
						? lines.slice(-IMPL_TEXT_TAIL_LINES).map(l => l.slice(0, IMPL_TEXT_LINE_MAX_CHARS))
						: [];
				const omitted = Math.max(0, lines.length - head.length - tail.length);
				base = {
					class: "text",
					name: artifactName,
					total_lines: lines.length,
					head,
					omitted,
					tail,
				};
			}
		}

		// POST-CTX27-2: progressive fallback if > 400 tokens (drop sample_row_0 first, then low_cardinality_distributions)
		if (countO200kTokens(JSON.stringify(base)) > IMPL_DESCRIPTOR_MAX_TOKENS && base.class === "json_array") {
			const withoutSample: UdtDescriptor = {
				class: base.class,
				name: base.name,
				count: base.count,
				key_schema_union: base.key_schema_union,
				low_cardinality_distributions: base.low_cardinality_distributions,
			};
			base = withoutSample;
		}
		if (countO200kTokens(JSON.stringify(base)) > IMPL_DESCRIPTOR_MAX_TOKENS && base.class === "json_array") {
			const withoutDist: UdtDescriptor = {
				class: base.class,
				name: base.name,
				count: base.count,
				key_schema_union: base.key_schema_union,
			};
			base = withoutDist;
		}
		return base;
	}

	async getKernelArtifactSha256(artifactName: string): Promise<string> {
		const raw = this.#kernelArtifacts.get(artifactName);
		if (raw === undefined) {
			throw new ImplContextEfficiencyError(`POST-CTX27-3 violation: unknown kernel artifact ${artifactName}`);
		}
		return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
	}

	async getKernelDisplayOutput(artifactName: string): Promise<string> {
		const raw = this.#kernelArtifacts.get(artifactName);
		if (raw === undefined) {
			throw new ImplContextEfficiencyError(`POST-CTX27-3 violation: unknown kernel artifact ${artifactName}`);
		}
		return formatCappedDisplay(raw);
	}

	async injectUnpicklableKernelVar(varName: string): Promise<void> {
		this.#unpicklableVars.add(varName);
	}

	async runBeforeCompactHook(options?: {
		readonly corruptHash?: boolean;
		readonly simulateWriteFailure?: boolean;
	}): Promise<{ readonly cancel?: boolean; readonly recordKey?: string; readonly record?: AutoCompactRecord }> {
		if (options?.simulateWriteFailure === true) {
			this.#lastCompactionStatusText = IMPL_COMPACTION_CANCELLED_TEXT;
			return { cancel: true };
		}

		const snapshotPath = path.join(this.#agentDir, `ipython-compact-${this.#sessionId}.pkl`);
		const rawPath = `${snapshotPath}.raw`;
		const artifactsJson = JSON.stringify(Object.fromEntries(this.#kernelArtifacts.entries()));
		const unpicklableJson = JSON.stringify([...this.#unpicklableVars]);

		const pyDump = [
			"import dill, hashlib, json, lzma, os, sys, threading",
			"raw_path = sys.argv[1]",
			"xz_path = sys.argv[2]",
			"artifacts = json.loads(sys.argv[3])",
			"unpicklables = json.loads(sys.argv[4])",
			"ns = dict(artifacts)",
			"for u in unpicklables:",
			"    ns[u] = (x for x in range(3))",
			"dropped = []",
			"for k in list(ns.keys()):",
			"    try:",
			"        dill.dumps(ns[k])",
			"    except Exception as exc:",
			"        dropped.append(f'{k}: unpicklable ({type(exc).__name__})')",
			"        del ns[k]",
			"globals()['__ctx27_artifacts__'] = ns",
			"for k, v in ns.items():",
			"    globals()[k] = v",
			"dill.dump_session(raw_path)",
			"raw_bytes = open(raw_path, 'rb').read()",
			"assert len(raw_bytes) > 0 and raw_bytes[0] == 0x80",
			"with lzma.open(xz_path, 'wb', preset=0) as zf:",
			"    zf.write(raw_bytes)",
			"os.remove(raw_path)",
			"xz_bytes = open(xz_path, 'rb').read()",
			"with lzma.open(xz_path, 'rb') as vf:",
			"    head = vf.read(2)",
			"    assert head.startswith(b'\\x80')",
			"print(json.dumps({",
			"    'sha256': hashlib.sha256(xz_bytes).hexdigest(),",
			"    'dropped': dropped,",
			"}))",
		].join("\n");

		const proc = Bun.spawnSync({
			cmd: [this.#pythonExe, "-c", pyDump, rawPath, snapshotPath, artifactsJson, unpicklableJson],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0 || !fs.existsSync(snapshotPath)) {
			this.#lastCompactionStatusText = IMPL_COMPACTION_CANCELLED_TEXT;
			return { cancel: true };
		}

		const dumpMeta = parseDumpMeta(proc.stdout.toString().trim());
		const diskBytes = fs.readFileSync(snapshotPath);
		const diskSha = crypto.createHash("sha256").update(diskBytes).digest("hex");
		const recordedSha = options?.corruptHash === true ? "0".repeat(64) : dumpMeta.sha256;

		if (diskSha !== recordedSha) {
			this.#lastCompactionStatusText = IMPL_COMPACTION_CANCELLED_TEXT;
			return { cancel: true };
		}

		const seq = this.#memoryRecords.size + 1;
		const recordKey = `auto-compact-memory-${this.#sessionId}-${seq}`;
		const record: AutoCompactRecord = {
			narrative: `Compaction checkpoint ${seq} for session ${this.#sessionId}`,
			descriptors: Object.fromEntries(this.#descriptors.entries()),
			kernel_handles: [...this.#kernelArtifacts.keys()],
			snapshot_path: snapshotPath,
			sha256: recordedSha,
			files_touched: [],
			open_items: [...dumpMeta.dropped],
		};
		this.#memoryRecords.set(recordKey, record);
		return { cancel: false, recordKey, record };
	}

	async runCompactionWithGate(options: {
		readonly corruptHash?: boolean;
		readonly simulateWriteFailure?: boolean;
		readonly onCommitCompactionEntry: () => void;
	}): Promise<{ readonly recordKey: string; readonly record: AutoCompactRecord }> {
		const hookResult = await this.runBeforeCompactHook({
			corruptHash: options.corruptHash,
			simulateWriteFailure: options.simulateWriteFailure,
		});
		if (hookResult.cancel === true || !hookResult.recordKey || !hookResult.record) {
			this.#lastCompactionStatusText = IMPL_COMPACTION_CANCELLED_TEXT;
			throw new CompactionCancelledError(IMPL_COMPACTION_CANCELLED_TEXT);
		}
		options.onCommitCompactionEntry();
		return {
			recordKey: hookResult.recordKey,
			record: hookResult.record,
		};
	}

	async verifyCompactionSnapshotInFreshProcess(
		snapshotPath: string,
		artifactName: string,
	): Promise<{
		readonly startsWithPickleMagic0x80: boolean;
		readonly sha256MatchesRecord: string;
		readonly hasUnpicklableGen: boolean;
		readonly restoredArtifactSha256: string;
	}> {
		const pyVerify = [
			"import dill, hashlib, json, lzma, sys, tempfile",
			"xz_path = sys.argv[1]",
			"artifact_name = sys.argv[2]",
			"xz_bytes = open(xz_path, 'rb').read()",
			"sha = hashlib.sha256(xz_bytes).hexdigest()",
			"raw_bytes = lzma.decompress(xz_bytes)",
			"magic_ok = len(raw_bytes) > 0 and raw_bytes[0] == 0x80",
			"with tempfile.NamedTemporaryFile(suffix='.pkl', delete=True) as tf:",
			"    tf.write(raw_bytes)",
			"    tf.flush()",
			"    dill.load_session(tf.name)",
			"restored_val = globals().get(artifact_name)",
			"if restored_val is None and '__ctx27_artifacts__' in globals():",
			"    restored_val = globals()['__ctx27_artifacts__'].get(artifact_name)",
			"val_sha = hashlib.sha256(restored_val.encode('utf-8')).hexdigest() if isinstance(restored_val, str) else ''",
			"print(json.dumps({",
			"    'startsWithPickleMagic0x80': magic_ok,",
			"    'sha256MatchesRecord': sha,",
			"    'hasUnpicklableGen': 'unpicklable_gen' in globals(),",
			"    'restoredArtifactSha256': val_sha,",
			"}))",
		].join("\n");

		const proc = Bun.spawnSync({
			cmd: [this.#pythonExe, "-c", pyVerify, snapshotPath, artifactName],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) {
			throw new ImplContextEfficiencyError(
				`POST-CTX27-5 violation: fresh dill.load_session failed: ${proc.stderr.toString()}`,
			);
		}
		return parseVerifyOutput(proc.stdout.toString().trim());
	}
}

// =============================================================================
// Harness Extension Factory (sdk.ts inline extension wiring)
// =============================================================================

export interface ContextEfficiencyExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

export function createContextEfficiencyExtension(options?: {
	readonly agentDir?: string;
	readonly sessionId?: string;
	readonly snapshotsDir?: string;
}): (api: ContextEfficiencyExtensionAPI) => Promise<void> {
	return async (api: ContextEfficiencyExtensionAPI): Promise<void> => {
		const home = process.env.HOME ?? os.homedir();
		const agentDir = options?.agentDir ?? path.join(home, ".omp", "agent");
		const snapshotsDir = options?.snapshotsDir ?? path.join(agentDir, "repl-snapshots");
		const sessionId = options?.sessionId ?? "default";
		const enforcer = new ContextEfficiencyEnforcer({ agentDir, sessionId });

		api.on("turn_start", () => {
			enforcer.startNewTurn();
		});

		api.on("tool_result", async (rawEvent: unknown) => {
			if (!isPlainRecord(rawEvent)) return undefined;
			const rawContent = rawEvent.content;
			const blocks = Array.isArray(rawContent) ? rawContent : [];
			const texts: string[] = [];
			for (const b of blocks) {
				if (isPlainRecord(b) && b.type === "text" && typeof b.text === "string") {
					texts.push(b.text);
				}
			}
			if (texts.length === 0) return undefined;
			const combined = texts.join("\n");
			const outcome = await enforcer.admitToolResult({
				toolCallId: typeof rawEvent.toolCallId === "string" ? rawEvent.toolCallId : "tool",
				text: combined,
			});
			if (outcome.mode === "inline") return undefined;
			return {
				content: [{ type: "text", text: outcome.transcriptText }],
			};
		});

		api.on("before_agent_start", async (rawEvent: unknown) => {
			const existingPrompt: string[] = [];
			if (isPlainRecord(rawEvent) && Array.isArray(rawEvent.systemPrompt)) {
				for (const item of rawEvent.systemPrompt) {
					if (typeof item === "string") existingPrompt.push(item);
				}
			}
			const assembled = assemblePromptWithCatalogCards("", snapshotsDir);
			if (assembled.cards.length === 0) return undefined;
			const cardBlock = assembled.cards.map(c => JSON.stringify(c)).join("\n");
			return {
				systemPrompt: [...existingPrompt, cardBlock],
			};
		});

		api.on("session_before_compact", async () => {
			const res = await enforcer.runBeforeCompactHook();
			if (res.cancel === true) {
				return { cancel: true };
			}
			return undefined;
		});
	};
}
