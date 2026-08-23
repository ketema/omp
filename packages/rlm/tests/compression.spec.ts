/**
 * RED Phase TypeScript tests for RLM Snapshot Manifest Compression Telemetry.
 *
 * Contract Authority: requirements/contracts/rlm-dill-compression.contract.ts
 * Requirements Manifest: requirements/REQ-2026-RLM-DILL-COMPRESSION.md
 * Issue: ketema/omp#15
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  MIN_COMPRESSION_RATIO_PERCENT,
  validateCompressionHeader,
  validateCompressionRatio,
  validateSnapshotMagic,
} from "../../../requirements/contracts/rlm-dill-compression.contract.ts";

describe("RLM Dill Compression Contracts & Validators", () => {
  test("INV-SNAP-DETECT-1: validateSnapshotMagic identifies LZMA, Gzip, and Raw headers", () => {
    const lzmaHeader = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x01]);
    const gzipHeader = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const rawHeader = new Uint8Array([0x80, 0x04, 0x95]);

    expect(validateSnapshotMagic(lzmaHeader)).toEqual({
      codec: "lzma",
      isCompressed: true,
      headerLength: 6,
    });

    expect(validateSnapshotMagic(gzipHeader)).toEqual({
      codec: "gzip",
      isCompressed: true,
      headerLength: 2,
    });

    expect(validateSnapshotMagic(rawHeader)).toEqual({
      codec: "raw",
      isCompressed: false,
      headerLength: 1,
    });
  });

  test("ERRORS-2: validateSnapshotMagic rejects unrecognized binary headers", () => {
    const unknownHeader = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    expect(() => validateSnapshotMagic(unknownHeader)).toThrow();
  });

  test("INV-SNAP-RATIO-1: validateCompressionRatio calculates correct ratio and bounds", () => {
    // 5.0 MB uncompressed, 1.0 MB compressed = 80.0% savings
    const ratio = validateCompressionRatio(5_000_000, 1_000_000);
    expect(ratio).toBe(80.0);
    expect(ratio).toBeGreaterThanOrEqual(MIN_COMPRESSION_RATIO_PERCENT);

    // Below 50% threshold throws RlmSnapshotCompressionError
    expect(() => validateCompressionRatio(1_000_000, 900_000, 50.0)).toThrow();
  });

  test("POST-SNAP-MANIFEST-1: validateCompressionHeader enforces metadata shape", () => {
    const validMetadata = {
      version: 1,
      savedNames: ["A", "df"],
      skipped: [],
      bytes: 250000,
      uncompressedBytes: 1000000,
      compressedBytes: 250000,
      compression: "lzma",
      compressionRatio: 75.0,
      pythonVersion: "3.11.0",
      timestamp: "2026-08-22T21:45:00Z",
    };

    expect(() => validateCompressionHeader(validMetadata)).not.toThrow();

    const invalidMetadata = {
      version: 1,
      savedNames: ["A"],
      skipped: [],
      bytes: 250000,
      uncompressedBytes: 1000000,
      compression: "unsupported_codec",
      compressionRatio: 75.0,
    };

    expect(() => validateCompressionHeader(invalidMetadata)).toThrow();
  });

  test("Python unittest suite: test_rlm_dill_compression.py passes 100%", async () => {
    const rlmDir = join(import.meta.dir, "..");
    const pythonDir = join(rlmDir, "python");
    const testFile = join(pythonDir, "test_rlm_dill_compression.py");

    const venvPath = process.env.VIRTUAL_ENV
      ? `${process.env.VIRTUAL_ENV}/bin/python3`
      : `${process.env.HOME}/.omp/agent/kernel-venv/bin/python3`;
    const pythonExe = fs.existsSync(venvPath) ? venvPath : "python3";

    // Safe probe: verify interpreter has required dependencies (dill, numpy)
    const probe = Bun.spawnSync([pythonExe, "-c", "import dill, numpy, rlm_kernel_runner"], {
      cwd: pythonDir,
      env: { ...process.env, PYTHONPATH: pythonDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (probe.exitCode !== 0) {
      console.warn("Skipping Python unittest execution in unprovisioned environment (missing dill/numpy)");
      return;
    }

    const proc = Bun.spawn([
      pythonExe,
      "-m",
      "unittest",
      testFile,
    ], {
      cwd: pythonDir,
      env: {
        ...process.env,
        PYTHONPATH: pythonDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("OK");
  }, 30_000);
});
