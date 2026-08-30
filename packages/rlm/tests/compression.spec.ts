/**
 * RED Phase TypeScript tests for RLM Snapshot Manifest Compression Telemetry.
 *
 * Contract Authority: requirements/contracts/rlm-dill-compression.contract.ts
 * Requirements Manifest: requirements/REQ-2026-RLM-DILL-COMPRESSION.md
 * Issue: ketema/omp#15
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MIN_COMPRESSION_RATIO_PERCENT,
  RlmSnapshotCompressionError,
  type SnapshotMetadata,
  UnsupportedCodecError,
  validateCompressionHeader,
  validateCompressionRatio,
  validateSnapshotMagic,
} from "../../../requirements/contracts/rlm-dill-compression.contract";

describe("RLM Dill Compression Contracts & Validators", () => {
  test("INV-DETECT-1: validateSnapshotMagic identifies LZMA, Gzip, and Raw headers", () => {
    const lzmaHeader = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x01]);
    const gzipHeader = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const rawHeader = new Uint8Array([0x80, 0x04, 0x95]);
    const unknownHeader = new Uint8Array([0x00, 0x01, 0x02]);

    expect(validateSnapshotMagic(lzmaHeader).codec).toBe("lzma");
    expect(validateSnapshotMagic(gzipHeader).codec).toBe("gzip");
    expect(validateSnapshotMagic(rawHeader).codec).toBe("raw");
    expect(() => validateSnapshotMagic(unknownHeader)).toThrow(UnsupportedCodecError);
  });

  test("INV-COMPAT-1: validateCompressionHeader parses valid compression headers and rejects invalid formats", () => {
    const validHeader: SnapshotMetadata = {
      version: 1,
      savedNames: ["x"],
      skipped: [],
      bytes: 2048,
      uncompressedBytes: 10240,
      compressedBytes: 2048,
      compression: "lzma",
      compressionRatio: 80.0,
      compressionDurationMs: 4.5,
      pythonVersion: "3.14.0",
      timestamp: new Date().toISOString(),
    };
    expect(() => validateCompressionHeader(validHeader)).not.toThrow();

    const invalidCodec = { ...validHeader, compression: "zstd" };
    expect(() => validateCompressionHeader(invalidCodec)).toThrow(UnsupportedCodecError);

    const missingVersion = { ...validHeader, version: undefined };
    expect(() => validateCompressionHeader(missingVersion)).toThrow(RlmSnapshotCompressionError);
  });

  test("INV-RATIO-1: validateCompressionRatio enforces 50% threshold for active compression codecs", () => {
    expect(validateCompressionRatio(100, 40)).toBe(60.0);
    expect(validateCompressionRatio(100, 50)).toBe(50.0);
    expect(() => validateCompressionRatio(100, 60)).toThrow(RlmSnapshotCompressionError);
    expect(MIN_COMPRESSION_RATIO_PERCENT).toBe(50.0);
  });
});

describe("RLM Python Dill Compression Integration Tests", () => {
  const pythonDir = path.join(import.meta.dir, "..", "python");
  const testScript = path.join(pythonDir, "test_rlm_dill_compression.py");
  let pythonAvailable = false;
  let detectedPython = "python3";
  let tempVenvBase: string | null = null;
  let lastProvError: string | null = null;

  test("POST-COMPRESS-1/POST-RESTORE-1: Python unittest suite passes 100%", async () => {
    // 1. Probe for an existing python environment that already has dill + numpy + rlm-runtime
    const venvPath = process.env.VIRTUAL_ENV
      ? path.join(process.env.VIRTUAL_ENV, "bin", "python3")
      : path.join(process.env.HOME ?? "", ".omp", "agent", "kernel-venv", "bin", "python3");

    let pythonExe = fs.existsSync(venvPath) ? venvPath : "python3";

    try {
      let probe = Bun.spawnSync([
        pythonExe,
        "-c",
        "import dill, numpy, rlm; print('OK')",
      ]);

      if (probe.exitCode !== 0 && pythonExe !== "python3") {
        pythonExe = "python3";
        probe = Bun.spawnSync([
          pythonExe,
          "-c",
          "import dill, numpy, rlm; print('OK')",
        ]);
      }

      if (probe.exitCode === 0) {
        pythonAvailable = true;
        detectedPython = pythonExe;
      } else {
        // Auto-provision via uv if uv is available in environment
        const uvPath = Bun.which("uv");
        if (uvPath !== null) {
          tempVenvBase = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-test-venv-"));
          try {
            const venvProc = Bun.spawn([uvPath, "venv", "--python", "3.14", tempVenvBase], { stdout: "ignore", stderr: "pipe" });
            const [venvErr, venvExit] = await Promise.all([
              new Response(venvProc.stderr).text(),
              venvProc.exited,
            ]);
            if (venvExit === 0) {
              const uvPython = path.join(tempVenvBase, "bin", "python3");
              const rlmRuntimeDir = path.join(pythonDir, "rlm-runtime");
              const pipProc = Bun.spawn(
                [uvPath, "pip", "install", "--python", uvPython, "dill", "numpy", "ipykernel", rlmRuntimeDir],
                { stdout: "ignore", stderr: "pipe" },
              );
              const [pipErr, pipExit] = await Promise.all([
                new Response(pipProc.stderr).text(),
                pipProc.exited,
              ]);
              if (pipExit === 0 && fs.existsSync(uvPython)) {
                const provProbe = Bun.spawnSync([
                  uvPython,
                  "-c",
                  "import dill, numpy, rlm; print('OK')",
                ]);
                if (provProbe.exitCode === 0) {
                  pythonAvailable = true;
                  detectedPython = uvPython;
                } else {
                  lastProvError = `prov probe failed (code ${provProbe.exitCode}): ${provProbe.stderr.toString()}`;
                }
              } else {
                lastProvError = `pip install failed (code ${pipExit}): ${pipErr}`;
              }
            } else {
              lastProvError = `venv create failed (code ${venvExit}): ${venvErr}`;
            }
          } catch (provErr) {
            lastProvError = `exception: ${provErr instanceof Error ? provErr.message : String(provErr)}`;
          }
        }
      }
    } catch {
      pythonAvailable = false;
    }

    if (!pythonAvailable) {
      console.warn(`[SKIP] Python dill/numpy/rlm environment not found (provisioning note: ${lastProvError ?? "no uv"}). Skipping Python test execution.`);
      return;
    }

    const proc = Bun.spawn([detectedPython, testScript], {
      cwd: pythonDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error("Python test failure stdout:", stdout);
      console.error("Python test failure stderr:", stderr);
    }

    expect(exitCode).toBe(0);
    expect(stderr).toContain("OK");
    expect(stderr).toContain("Ran 25 tests");

    // Best-effort cleanup of temporary test venv
    if (tempVenvBase && fs.existsSync(tempVenvBase)) {
      try {
        fs.rmSync(tempVenvBase, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
