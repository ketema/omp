/**
 * RLM Dill Snapshot Compression Contract — specification authority.
 *
 * Enforces transparent, collision-free stream compression for persistent
 * Python kernel state snapshots, ensuring >=50% disk savings, writes
 * completing within the 3000ms MAX_COMPRESS_MS ceiling, and 100% backward
 * compatibility with legacy uncompressed files.
 *
 * Traceability: REQ-2026-RLM-DILL-COMPRESSION, issue ketema/omp#15.
 *
 * The implementation does NOT import from this file; tests import both.
 */

// =============================================================================
// Artifact 1: Importable Constants
// =============================================================================

export const LZMA_MAGIC_BYTES = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
export const GZIP_MAGIC_BYTES = new Uint8Array([0x1f, 0x8b]);
export const PICKLE_PROTO_MAGIC = 0x80;

export const MAX_COMPRESS_MS = 3000;
export const MIN_COMPRESSION_RATIO_PERCENT = 50.0;
export const DEFAULT_COMPRESSION_CODEC = "lzma";

export const SUPPORTED_COMPRESSION_CODECS = ["lzma", "gzip", "raw"] as const;

// =============================================================================
// Artifact 2: Domain Exception Classes
// =============================================================================

export class RlmSnapshotCompressionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RlmSnapshotCompressionError";
  }
}

/** ERRORS-1: Truncated or corrupted compressed payload. */
export class CorruptSnapshotError extends RlmSnapshotCompressionError {
  constructor(detail: string) {
    super(`Corrupt snapshot payload: ${detail}`);
    this.name = "CorruptSnapshotError";
  }
}

/** ERRORS-2: Unsupported or unknown binary compression codec/header. */
export class UnsupportedCodecError extends RlmSnapshotCompressionError {
  constructor(codecOrHeader: string) {
    super(`Unsupported snapshot compression format: ${codecOrHeader}`);
    this.name = "UnsupportedCodecError";
  }
}

/** ERRORS-3: Invalid compression codec configuration in environment. */
export class SnapshotConfigurationError extends RlmSnapshotCompressionError {
  constructor(detail: string) {
    super(`Invalid snapshot compression configuration: ${detail}`);
    this.name = "SnapshotConfigurationError";
  }
}

/** Timing Invariant: Compression exceeded maximum latency ceiling. */
export class CompressionTimeoutError extends RlmSnapshotCompressionError {
  constructor(durationMs: number, ceilingMs = MAX_COMPRESS_MS) {
    super(`Snapshot compression exceeded latency ceiling of ${ceilingMs}ms (took ${durationMs}ms)`);
    this.name = "CompressionTimeoutError";
  }
}

// =============================================================================
// Artifact 3: Types & Interfaces
// =============================================================================

export type CompressionCodec = (typeof SUPPORTED_COMPRESSION_CODECS)[number];

export interface SnapshotMetadata {
  version: number;
  savedNames: string[];
  skipped: Array<{ name: string; reason: string }>;
  bytes: number;
  uncompressedBytes: number;
  compressedBytes: number;
  compression: CompressionCodec;
  compressionRatio: number;
  compressionDurationMs: number;
  pythonVersion: string;
  timestamp: string;
}

export interface SnapshotHeaderInfo {
  codec: CompressionCodec;
  isCompressed: boolean;
  headerLength: number;
}

export interface CompressionResult {
  bytesWritten: number;
  uncompressedBytes: number;
  compressedBytes: number;
  compressionRatio: number;
  codec: CompressionCodec;
  durationMs: number;
}

// =============================================================================
// Artifact 4: Pure Callable Validators
// =============================================================================

export function validateSnapshotMagic(header: Uint8Array): SnapshotHeaderInfo {
  if (header.length < 1) {
    throw new CorruptSnapshotError("Empty header: snapshot file contains zero bytes");
  }

  // Check LZMA: 0xFD 0x37 0x7A 0x58 0x5A 0x00
  if (
    header.length >= 6 &&
    header[0] === 0xfd &&
    header[1] === 0x37 &&
    header[2] === 0x7a &&
    header[3] === 0x58 &&
    header[4] === 0x5a &&
    header[5] === 0x00
  ) {
    return { codec: "lzma", isCompressed: true, headerLength: 6 };
  }

  // Check Truncated LZMA Magic Prefix (< 6 bytes matching start of LZMA header)
  if (header.length < 6) {
    let matchesLzma = true;
    for (let i = 0; i < header.length; i++) {
      if (header[i] !== LZMA_MAGIC_BYTES[i]) {
        matchesLzma = false;
        break;
      }
    }
    if (matchesLzma) {
      throw new CorruptSnapshotError(`Truncated LZMA magic header (${header.length}/6 bytes)`);
    }
  }

  // Check Gzip: 0x1F 0x8B
  if (header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
    return { codec: "gzip", isCompressed: true, headerLength: 2 };
  }

  // Check Truncated Gzip Magic Prefix (< 2 bytes matching start of Gzip header)
  if (header.length < 2 && header[0] === GZIP_MAGIC_BYTES[0]) {
    throw new CorruptSnapshotError(`Truncated Gzip magic header (${header.length}/2 bytes)`);
  }

  // Check Legacy Pickle Protocol 2/3/4/5: starts with 0x80
  if (header[0] === PICKLE_PROTO_MAGIC) {
    return { codec: "raw", isCompressed: false, headerLength: 1 };
  }

  throw new UnsupportedCodecError(
    `Unrecognized magic header: [${Array.from(header.slice(0, 6)).map(b => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`
  );
}

export function validateCompressionTiming(durationMs: number, ceilingMs = MAX_COMPRESS_MS): void {
  if (durationMs > ceilingMs) {
    throw new CompressionTimeoutError(durationMs, ceilingMs);
  }
}

export function validateCompressionRatio(
  uncompressedBytes: number,
  compressedBytes: number,
  minPercent = MIN_COMPRESSION_RATIO_PERCENT
): number {
  if (uncompressedBytes <= 0) return 0.0;
  const ratio = Number((((uncompressedBytes - compressedBytes) / uncompressedBytes) * 100.0).toFixed(2));
  if (ratio < minPercent) {
    throw new RlmSnapshotCompressionError(
      `Compression ratio ${ratio}% is below minimum required threshold of ${minPercent}%`
    );
  }
  return ratio;
}

export function validateCompressionHeader(metadata: unknown): asserts metadata is SnapshotMetadata {
  if (typeof metadata !== "object" || metadata === null) {
    throw new RlmSnapshotCompressionError("Snapshot metadata must be a non-null object");
  }
  const m = metadata as Record<string, unknown>;
  if (typeof m.version !== "number") {
    throw new RlmSnapshotCompressionError("Snapshot metadata version must be a number");
  }
  if (!Array.isArray(m.savedNames) || !m.savedNames.every(n => typeof n === "string")) {
    throw new RlmSnapshotCompressionError("Snapshot metadata savedNames must be an array of strings");
  }
  if (
    !Array.isArray(m.skipped) ||
    !m.skipped.every(
      s =>
        typeof s === "object" &&
        s !== null &&
        "name" in s &&
        "reason" in s &&
        typeof (s as Record<string, unknown>).name === "string" &&
        typeof (s as Record<string, unknown>).reason === "string"
    )
  ) {
    throw new RlmSnapshotCompressionError("Snapshot metadata skipped must be an array of {name, reason} objects");
  }
  if (typeof m.bytes !== "number" || typeof m.uncompressedBytes !== "number" || typeof m.compressedBytes !== "number") {
    throw new RlmSnapshotCompressionError("Snapshot metadata bytes, uncompressedBytes, and compressedBytes must be numbers");
  }
  if (!SUPPORTED_COMPRESSION_CODECS.includes(m.compression as CompressionCodec)) {
    throw new UnsupportedCodecError(String(m.compression));
  }
  if (typeof m.compressionRatio !== "number" || Number.isNaN(m.compressionRatio)) {
    throw new RlmSnapshotCompressionError("Snapshot metadata compressionRatio must be a number");
  }
  if (
    typeof m.compressionDurationMs !== "number" ||
    Number.isNaN(m.compressionDurationMs) ||
    m.compressionDurationMs < 0
  ) {
    throw new RlmSnapshotCompressionError(
      "Snapshot metadata compressionDurationMs must be a non-negative number"
    );
  }
  if (typeof m.pythonVersion !== "string" || typeof m.timestamp !== "string") {
    throw new RlmSnapshotCompressionError("Snapshot metadata pythonVersion and timestamp must be strings");
  }
}

// =============================================================================
// Artifact 5: CONTRACT_RLM_DILL_COMPRESSION Traceability Dictionary
// =============================================================================

export const CONTRACT_RLM_DILL_COMPRESSION = {
  "POST-COMPRESS-1": {
    id: "POST-COMPRESS-1",
    description: "Snapshot file is compressed and begins with the exact magic byte header for active codec",
    verification: "test",
  },
  "POST-RESTORE-1": {
    id: "POST-RESTORE-1",
    description: "Restores namespace variables identically to uncompressed state with full object equivalence",
    verification: "test",
  },
  "POST-MANIFEST-1": {
    id: "POST-MANIFEST-1",
    description: "Manifest JSON contains compression, uncompressedBytes, compressedBytes, and compressionRatio",
    verification: "test",
  },
  "POST-TIME-1": {
    id: "POST-TIME-1",
    description: "Snapshot serialization and stream compression completes in < 3000ms",
    verification: "test",
  },
  "POST-SKIP-1": {
    id: "POST-SKIP-1",
    description: "Unpicklable or oversize objects are recorded in skipped list while remaining state is persisted",
    verification: "test",
  },
  "INV-COMPAT-1": {
    id: "INV-COMPAT-1",
    description: "Legacy raw uncompressed snapshots starting with 0x80 restore without error",
    verification: "test",
  },
  "INV-DETECT-1": {
    id: "INV-DETECT-1",
    description: "Dynamic codec selection is determined solely by inspecting the first 6 magic bytes",
    verification: "test",
  },
  "INV-RATIO-1": {
    id: "INV-RATIO-1",
    description: "Compression achieves >= 50% disk space reduction on non-trivial state payloads",
    verification: "test",
  },
  "INV-TIME-1": {
    id: "INV-TIME-1",
    description: "Snapshot stream compression completes within 3000ms latency ceiling",
    verification: "test",
  },
  "FORBIDDEN-1": {
    id: "FORBIDDEN-1",
    description: "Runner SHALL NOT emit uncompressed bytes when compression is active",
    verification: "test",
  },
  "FORBIDDEN-2": {
    id: "FORBIDDEN-2",
    description: "Runner SHALL NOT overwrite target file until .tmp file is verified and flushed",
    verification: "test",
  },
  "FORBIDDEN-3": {
    id: "FORBIDDEN-3",
    description: "Runner SHALL NOT leave orphaned temporary snapshot files on disk when serialization fails",
    verification: "test",
  },
  "FORBIDDEN-4": {
    id: "FORBIDDEN-4",
    description:
      "Runner SHALL NOT re-resolve RLM_SNAPSHOT_COMPRESSION from the process environment after bootstrap; " +
      "the codec is frozen once at bootstrap, before any Model-issued cell can execute, and reused for all " +
      "subsequent writes in that process (REQ-2026-RLM-DILL-COMPRESSION.md Actor Matrix: " +
      '"Model SHALL NOT disable kernel snapshot compression")',
    verification: "test",
  },
  "ERRORS-1": {
    id: "ERRORS-1",
    description: "Truncated or corrupted compressed payload raises CorruptSnapshotError",
    verification: "test",
  },
  "ERRORS-2": {
    id: "ERRORS-2",
    description: "Unsupported binary header raises UnsupportedCodecError",
    verification: "test",
  },
  "ERRORS-3": {
    id: "ERRORS-3",
    description: "Invalid compression codec configuration in environment raises SnapshotConfigurationError",
    verification: "test",
  },
  "ERRORS-4": {
    id: "ERRORS-4",
    description:
      "Atomic snapshot replacement failure on filesystem raises RlmSnapshotCompressionError; " +
      "if the payload commit already succeeded when the manifest commit fails, the payload " +
      "is rolled back to its prior generation so the reported failure has no partial effect on disk",
    verification: "test",
  },
  "SEQ-1": {
    id: "SEQ-1",
    description: "KernelManager onCompaction schedules snapshot write after cell completion",
    verification: "test",
  },
  "SEQ-2": {
    id: "SEQ-2",
    description: "Runner pickles individual variables before stream compression",
    verification: "test",
  },
  "SEQ-3": {
    id: "SEQ-3",
    description: "Runner applies stream compression before atomic file write",
    verification: "test",
  },
  "SEQ-4": {
    id: "SEQ-4",
    description: "Runner inspects magic byte header before decompression on restore",
    verification: "test",
  },
  "SEQ-5": {
    id: "SEQ-5",
    description: "Runner injects restored variables into user_ns after decompression",
    verification: "test",
  },
  "IP-1": {
    id: "IP-1",
    description: "KernelManager scheduleSnapshot passes path, manifestPath, maxBytes to transport",
    verification: "test",
  },
  "IP-2": {
    id: "IP-2",
    description: "Transport writeSnapshot sends snapshot_write op to runner stdin",
    verification: "test",
  },
  "IP-3": {
    id: "IP-3",
    description: "Runner writes compressed binary payload to kernel-state.dill",
    verification: "test",
  },
  "IP-4": {
    id: "IP-4",
    description: "Runner writes enhanced telemetry metadata to kernel-state.json",
    verification: "test",
  },
  "IP-5": {
    id: "IP-5",
    description: "Runner restores variables from kernel-state.dill into user_ns",
    verification: "test",
  },
} as const;
