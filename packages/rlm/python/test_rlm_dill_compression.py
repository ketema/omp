"""Adversarial unit tests for RLM transparent snapshot compression.

Contract Authority: requirements/contracts/rlm-dill-compression.contract.ts
Requirements Manifest: requirements/REQ-2026-RLM-DILL-COMPRESSION.md
Issue: ketema/omp#15
"""

import json
import os
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch
import numpy as np
import dill

# Import runner methods and domain exceptions to test
import rlm_kernel_runner
from rlm_kernel_runner import (
    CorruptSnapshotError,
    UnsupportedCodecError,
    SnapshotConfigurationError,
    RlmSnapshotCompressionError,
    _detect_codec,
)


class TestRlmDillCompression(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="rlm_comp_test_")
        self.snapshot_path = os.path.join(self.test_dir, "kernel-state.dill")
        self.manifest_path = os.path.join(self.test_dir, "kernel-state.json")
        # Ensure clean user namespace
        ns = rlm_kernel_runner._get_ns()
        ns.clear()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
        if "RLM_SNAPSHOT_COMPRESSION" in os.environ:
            del os.environ["RLM_SNAPSHOT_COMPRESSION"]

    def test_post_snap_compress_1_lzma_header(self):
        """POST-SNAP-COMPRESS-1, SEQ-3, IP-3: Snapshot file is compressed with LZMA magic header by default."""
        ns = rlm_kernel_runner._get_ns()
        ns["arr"] = np.arange(10000)
        ns["msg"] = "hello transparent compression"

        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "lzma"
        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        self.assertTrue(os.path.exists(self.snapshot_path))
        with open(self.snapshot_path, "rb") as f:
            header = f.read(6)

        self.assertEqual(header, bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
        self.assertGreater(result["bytes"], 0)
        self.assertEqual(result["compression"], "lzma")
        self.assertIn("compressionDurationMs", result)

    def test_post_snap_compress_1_gzip_header(self):
        """POST-SNAP-COMPRESS-1, SEQ-3, IP-3: Snapshot file is compressed with Gzip header when configured."""
        ns = rlm_kernel_runner._get_ns()
        ns["matrix"] = np.arange(40000).reshape(200, 200)

        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "gzip"
        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        self.assertTrue(os.path.exists(self.snapshot_path))
        with open(self.snapshot_path, "rb") as f:
            header = f.read(2)

        self.assertEqual(header, bytes([0x1f, 0x8b]))
        self.assertEqual(result["compression"], "gzip")

    def test_post_snap_restore_1_decompression_roundtrip(self):
        """POST-SNAP-RESTORE-1, SEQ-4, SEQ-5, IP-5: _snapshot_restore decompresses and restores exact namespace variables."""
        ns = rlm_kernel_runner._get_ns()
        test_arr = np.linspace(0, 100, 5000)
        test_dict = {"a": 1, "b": [1, 2, 3], "c": "test"}
        ns["test_arr"] = test_arr
        ns["test_dict"] = test_dict

        # Save compressed
        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "lzma"
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Clear namespace
        ns.clear()
        self.assertNotIn("test_arr", ns)
        self.assertNotIn("test_dict", ns)

        # Restore
        res = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertIn("test_arr", res["restoredNames"])
        self.assertIn("test_dict", res["restoredNames"])

        np.testing.assert_array_equal(ns["test_arr"], test_arr)
        self.assertEqual(ns["test_dict"], test_dict)

    def test_inv_snap_compat_1_legacy_uncompressed_restore(self):
        """INV-SNAP-COMPAT-1, SEQ-4, IP-5: Legacy uncompressed snapshots starting with 0x80 restore cleanly."""
        ns = rlm_kernel_runner._get_ns()
        legacy_data = {"legacy_x": 42, "legacy_msg": "uncompressed legacy"}

        # Write raw uncompressed dill dictionary payload
        payload = {k: dill.dumps(v) for k, v in legacy_data.items()}
        with open(self.snapshot_path, "wb") as f:
            dill.dump(payload, f)

        # Verify it has raw pickle header (0x80)
        with open(self.snapshot_path, "rb") as f:
            first_byte = f.read(1)
        self.assertEqual(first_byte, bytes([0x80]))

        # Restore from uncompressed
        res = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertIn("legacy_x", res["restoredNames"])
        self.assertIn("legacy_msg", res["restoredNames"])
        self.assertEqual(ns["legacy_x"], 42)
        self.assertEqual(ns["legacy_msg"], "uncompressed legacy")

    def test_inv_snap_detect_1_codec_detection(self):
        """INV-SNAP-DETECT-1: _detect_codec correctly classifies LZMA, Gzip, and Raw headers."""
        lzma_buf = bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x01, 0x02])
        gzip_buf = bytes([0x1f, 0x8b, 0x08, 0x00])
        raw_buf = bytes([0x80, 0x04, 0x95])

        self.assertEqual(_detect_codec(lzma_buf), "lzma")
        self.assertEqual(_detect_codec(gzip_buf), "gzip")
        self.assertEqual(_detect_codec(raw_buf), "raw")

    def test_inv_snap_ratio_1_size_reduction(self):
        """INV-SNAP-RATIO-1, IP-4: Compression achieves >= 50% reduction on numerical array payload."""
        ns = rlm_kernel_runner._get_ns()
        ns["big_array"] = np.arange(250000).reshape(500, 500)

        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "lzma"
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        with open(self.manifest_path) as f:
            manifest = json.load(f)

        self.assertIn("uncompressedBytes", manifest)
        self.assertIn("compressedBytes", manifest)
        self.assertIn("compressionRatio", manifest)
        self.assertGreaterEqual(
            manifest["compressionRatio"],
            50.0,
            f"Expected compression ratio >= 50%, got {manifest['compressionRatio']}%",
        )

    def test_inv_snap_time_1_latency_bound(self):
        """INV-SNAP-TIME-1, POST-SNAP-TIME-1: Serialization and stream compression completes in < 3000ms."""
        ns = rlm_kernel_runner._get_ns()
        ns["array_5mb"] = np.arange(625000).reshape(1000, 625)

        t0 = time.time()
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)
        duration_ms = (time.time() - t0) * 1000.0

        self.assertLess(
            duration_ms,
            3000.0,
            f"Snapshot write exceeded 3000ms latency ceiling: took {duration_ms:.2f}ms",
        )

    def test_forbidden_1_no_raw_bytes_when_compressed(self):
        """FORBIDDEN-1: Snapshot file must not begin with uncompressed 0x80 pickle byte when compression active."""
        ns = rlm_kernel_runner._get_ns()
        ns["val"] = 12345

        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "lzma"
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        with open(self.snapshot_path, "rb") as f:
            first_byte = f.read(1)

        self.assertNotEqual(first_byte, bytes([0x80]))

    def test_forbidden_2_and_3_atomic_write_and_tmp_cleanup(self):
        """FORBIDDEN-2, FORBIDDEN-3, IP-3: Atomic .tmp replacement with immediate cleanup on success."""
        tmp_path = self.snapshot_path + ".tmp"
        self.assertFalse(os.path.exists(tmp_path))

        ns = rlm_kernel_runner._get_ns()
        ns["data"] = "atomic test"
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        self.assertFalse(os.path.exists(tmp_path), "FORBIDDEN-3 violation: orphaned .tmp file left behind")
        self.assertTrue(os.path.exists(self.snapshot_path))

    def test_errors_1_non_string_variable_names_raise_corrupt_error(self):
        """ERRORS-1: Corrupt payload containing non-string dictionary keys fails validation without mutating user_ns."""
        ns = rlm_kernel_runner._get_ns()
        ns["safe_key"] = "safe_value"

        # Payload with non-string key
        invalid_payload = {
            12345: dill.dumps("numeric_key_val"),
            "valid_key": dill.dumps("valid_val"),
        }
        with open(self.snapshot_path, "wb") as f:
            dill.dump(invalid_payload, f)

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # Active user_ns must NOT contain numeric key or valid_key
        self.assertEqual(ns.get("safe_key"), "safe_value")
        self.assertNotIn("valid_key", ns)
        self.assertNotIn(12345, ns)

    def test_errors_1_empty_snapshot_file_fails_fast(self):
        """ERRORS-1: Existing 0-byte snapshot file raises CorruptSnapshotError fail-fast."""
        # Touch empty file
        with open(self.snapshot_path, "wb") as f:
            pass

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

    def test_errors_1_corrupt_payload_fails_fast(self):
        """ERRORS-1: Corrupt or truncated compressed payload raises CorruptSnapshotError directly."""
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]))

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

    def test_errors_1_truncated_magic_headers_raise_corrupt_error(self):
        """ERRORS-1: Truncated magic headers for LZMA and Gzip raise CorruptSnapshotError directly."""
        # Truncated LZMA (3 bytes instead of 6) matching prefix
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0xfd, 0x37, 0x7a]))

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # Truncated Gzip (1 byte instead of 2) matching prefix
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0x1f]))

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # 6-byte non-LZMA header starting with 0xfd raises UnsupportedCodecError, NOT CorruptSnapshotError
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0xfd, 0x00, 0x00, 0x00, 0x00, 0x00]))

        with self.assertRaises(UnsupportedCodecError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # 2-byte non-Gzip header starting with 0x1f raises UnsupportedCodecError, NOT CorruptSnapshotError
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0x1f, 0x00]))

        with self.assertRaises(UnsupportedCodecError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

    def test_inv_snap_stream_counting_accuracy(self):
        """POST-SNAP-COMPRESS-1, POST-SNAP-MANIFEST-1: _CountingWriter measures exact uncompressed byte size of serialized dictionary."""
        ns = rlm_kernel_runner._get_ns()
        ns["k1"] = [1, 2, 3, 4, 5]
        ns["k2"] = {"hello": "world", "nested": [10, 20]}

        res = rlm_kernel_runner._snapshot_write(
            self.snapshot_path,
            self.manifest_path,
            256 * 1024 * 1024
        )
        self.assertGreater(res["uncompressedBytes"], 0)
        self.assertGreater(res["compressionDurationMs"], 0.0)

        with open(self.manifest_path) as f:
            manifest = json.load(f)

        self.assertEqual(manifest["uncompressedBytes"], res["uncompressedBytes"])
        self.assertEqual(manifest["compressionDurationMs"], res["compressionDurationMs"])

    def test_post_snap_restore_1_atomic_namespace_isolation(self):
        """POST-SNAP-RESTORE-1: Failed unpickling of any variable leaves active user_ns completely untouched."""
        ns = rlm_kernel_runner._get_ns()
        ns["original_var"] = "untouched"

        # Construct a payload where variable 1 is valid, but variable 2 has corrupt pickle bytes
        corrupted_payload = {
            "good_var": dill.dumps("good"),
            "bad_var": b"CORRUPT_PICKLE_BLOB_NOT_DILL",
        }
        with open(self.snapshot_path, "wb") as f:
            dill.dump(corrupted_payload, f)

        # Attempt restore
        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # Active namespace must NOT contain partial restores
        self.assertEqual(ns.get("original_var"), "untouched")
        self.assertNotIn("good_var", ns)
        self.assertNotIn("bad_var", ns)

    def test_errors_2_unsupported_header_fails_fast(self):
        """ERRORS-2: Unrecognized magic header raises UnsupportedCodecError directly."""
        with open(self.snapshot_path, "wb") as f:
            f.write(b"UNKNOWN_BINARY_HEADER_12345")

        with self.assertRaises(UnsupportedCodecError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

    def test_errors_3_invalid_compression_config(self):
        """ERRORS-3: Unsupported RLM_SNAPSHOT_COMPRESSION value raises SnapshotConfigurationError directly."""
        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "invalid_bzip3_codec"
        ns = rlm_kernel_runner._get_ns()
        ns["x"] = 1

        with self.assertRaises(SnapshotConfigurationError):
            rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

    def test_errors_4_and_forbidden_3_atomic_replace_failure_cleanup(self):
        """ERRORS-4, FORBIDDEN-3: Atomic replacement failure raises RlmSnapshotCompressionError and cleans up .tmp."""
        ns = rlm_kernel_runner._get_ns()
        ns["safe_val"] = 999

        tmp_path = self.snapshot_path + ".tmp"

        with patch("os.replace", side_effect=OSError("Simulated disk error")):
            with self.assertRaises(RlmSnapshotCompressionError):
                rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Temporary file must be unlinked on failure
        self.assertFalse(os.path.exists(tmp_path), "FORBIDDEN-3: .tmp file was not cleaned up after write error")

    def test_post_snap_skip_1_unpicklable_and_oversize_handling(self):
        """POST-SNAP-SKIP-1, SEQ-2, IP-4: Unpicklable and oversize objects recorded in skipped list while valid state persists."""
        ns = rlm_kernel_runner._get_ns()
        ns["valid_val"] = "persists"
        # Generator is unpicklable in standard dill configurations
        ns["unpicklable_gen"] = (x for x in range(10))

        # Write snapshot with 500 byte limit to trigger oversize skip for large object
        ns["oversize_val"] = "X" * 10000

        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 500)

        with open(self.manifest_path) as f:
            manifest = json.load(f)

        self.assertIn("valid_val", manifest["savedNames"])
        skipped_names = [item["name"] for item in manifest["skipped"]]
        self.assertIn("oversize_val", skipped_names)
        self.assertEqual(manifest["skipped"][skipped_names.index("oversize_val")]["reason"], "exceeds snapshot size cap")
        self.assertIn("unpicklable_gen", skipped_names)
        self.assertIn("TypeError", manifest["skipped"][skipped_names.index("unpicklable_gen")]["reason"])


if __name__ == "__main__":
    unittest.main()
