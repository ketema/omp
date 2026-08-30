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
        # No dedicated reset function is exposed in the runner module by
        # design (see _freeze_snapshot_codec docstring) -- tests simulate a
        # fresh process launch by clearing the module global directly.
        rlm_kernel_runner._FROZEN_SNAPSHOT_CODEC = None

    def test_post_snap_compress_1_lzma_header(self):
        """POST-COMPRESS-1, SEQ-3, IP-3: Snapshot file is compressed with LZMA magic header by default."""
        ns = rlm_kernel_runner._get_ns()
        ns["arr"] = np.arange(10000)
        ns["msg"] = "hello transparent compression"

        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        self.assertTrue(os.path.exists(self.snapshot_path))
        with open(self.snapshot_path, "rb") as f:
            header = f.read(6)
        # Check LZMA magic bytes
        self.assertEqual(header, bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
        self.assertEqual(result["compression"], "lzma")
        self.assertGreaterEqual(result["compressionRatio"], 50.0)
        self.assertIn("compressionDurationMs", result)

    def test_post_snap_compress_1_gzip_header(self):
        """POST-COMPRESS-1, SEQ-3, IP-3: Snapshot file is compressed with Gzip header when configured."""
        ns = rlm_kernel_runner._get_ns()
        ns["matrix"] = np.arange(40000).reshape(200, 200)

        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "gzip"
        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        self.assertTrue(os.path.exists(self.snapshot_path))
        with open(self.snapshot_path, "rb") as f:
            header = f.read(2)
        # Check Gzip magic bytes
        self.assertEqual(header, bytes([0x1f, 0x8b]))
        self.assertEqual(result["compression"], "gzip")

    def test_post_snap_restore_1_decompression_roundtrip(self):
        """POST-RESTORE-1, SEQ-4, SEQ-5, IP-5: _snapshot_restore decompresses and restores exact namespace variables."""
        ns = rlm_kernel_runner._get_ns()
        test_arr = np.linspace(0, 100, 5000)
        test_dict = {"a": 1, "b": [1, 2, 3], "c": "test"}
        ns["test_arr"] = test_arr
        ns["test_dict"] = test_dict

        # Write compressed
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Clear namespace
        ns.clear()
        self.assertNotIn("test_arr", ns)
        self.assertNotIn("test_dict", ns)

        # Restore
        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertIn("test_arr", result["restoredNames"])
        self.assertIn("test_dict", result["restoredNames"])
        np.testing.assert_array_equal(ns["test_arr"], test_arr)
        self.assertEqual(ns["test_dict"], test_dict)

    def test_inv_snap_compat_1_legacy_uncompressed_restore(self):
        """INV-COMPAT-1, SEQ-4, IP-5: Legacy uncompressed snapshots starting with 0x80 restore cleanly."""
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
        """INV-DETECT-1: _detect_codec correctly classifies LZMA, Gzip, and Raw headers."""
        lzma_buf = bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x01, 0x02])
        gzip_buf = bytes([0x1f, 0x8b, 0x08, 0x00])
        raw_buf = bytes([0x80, 0x04, 0x95])
        self.assertEqual(_detect_codec(lzma_buf), "lzma")
        self.assertEqual(_detect_codec(gzip_buf), "gzip")
        self.assertEqual(_detect_codec(raw_buf), "raw")

    def test_inv_snap_ratio_1_size_reduction(self):
        """INV-RATIO-1, IP-4: Compression achieves >= 50% reduction on numerical array payload."""
        ns = rlm_kernel_runner._get_ns()
        ns["big_array"] = np.arange(250000).reshape(500, 500)

        # Write compressed
        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Verify >= 50% savings
        self.assertGreaterEqual(
            result["compressionRatio"],
            50.0,
            f"Expected >= 50% compression, got {result['compressionRatio']}% (uncompressed: {result['uncompressedBytes']}, compressed: {result['compressedBytes']})",
        )

    def test_inv_snap_time_1_latency_bound(self):
        """INV-TIME-1, POST-TIME-1: Serialization and stream compression completes in < 3000ms."""
        ns = rlm_kernel_runner._get_ns()
        ns["array_5mb"] = np.arange(625000).reshape(1000, 625)

        start = time.perf_counter()
        result = rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)
        elapsed_ms = (time.perf_counter() - start) * 1000.0

        self.assertLess(
            elapsed_ms,
            3000.0,
            f"Snapshot write took {elapsed_ms}ms, exceeding 3000ms limit",
        )
        self.assertLess(result["compressionDurationMs"], 3000.0)

    def test_forbidden_1_no_raw_bytes_when_compressed(self):
        """FORBIDDEN-1: Snapshot file must not begin with uncompressed 0x80 pickle byte when compression active."""
        ns = rlm_kernel_runner._get_ns()
        ns["data"] = [1, 2, 3, "test"]

        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        with open(self.snapshot_path, "rb") as f:
            first_byte = f.read(1)
        self.assertNotEqual(
            first_byte,
            bytes([0x80]),
            "Compressed snapshot must not start with uncompressed pickle protocol byte 0x80",
        )

    def test_forbidden_2_and_3_atomic_write_and_tmp_cleanup(self):
        """FORBIDDEN-2, FORBIDDEN-3, IP-3: Atomic .tmp replacement with immediate cleanup on success."""
        ns = rlm_kernel_runner._get_ns()
        ns["v"] = 123

        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Target file exists
        self.assertTrue(os.path.exists(self.snapshot_path))
        self.assertTrue(os.path.exists(self.manifest_path))

        # No .tmp files left behind in test directory
        tmp_files = [f for f in os.listdir(self.test_dir) if ".tmp" in f]
        self.assertEqual(len(tmp_files), 0, f"Found orphaned temp files: {tmp_files}")

    def test_errors_1_non_string_variable_names_raise_corrupt_error(self):
        """ERRORS-1: Corrupt payload containing non-string dictionary keys fails validation without mutating user_ns."""
        ns = rlm_kernel_runner._get_ns()
        ns["clean_var"] = "initial"

        # Construct invalid payload with integer key
        invalid_payload = {12345: dill.dumps("bad_key")}
        with open(self.snapshot_path, "wb") as f:
            dill.dump(invalid_payload, f)

        # Attempt restore
        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # Namespace must remain untouched
        self.assertEqual(ns.get("clean_var"), "initial")
        self.assertNotIn(12345, ns)

    def test_errors_1_empty_snapshot_file_fails_fast(self):
        """ERRORS-1: Existing 0-byte snapshot file raises CorruptSnapshotError fail-fast."""
        # Create empty 0-byte snapshot file
        with open(self.snapshot_path, "wb") as f:
            pass

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

    def test_errors_1_corrupt_payload_fails_fast(self):
        """ERRORS-1: Corrupt or truncated compressed payload raises CorruptSnapshotError directly."""
        # Write LZMA magic header followed by garbage bytes
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0xff, 0xff, 0xff, 0xff]))

        with self.assertRaises(CorruptSnapshotError):
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

    def test_errors_1_truncated_magic_headers_raise_corrupt_error(self):
        """ERRORS-1: Truncated magic headers for LZMA and Gzip raise CorruptSnapshotError directly."""
        # Truncated LZMA (< 6 bytes)
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0xfd, 0x37, 0x7a]))
        with self.assertRaises(CorruptSnapshotError) as ctx:
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertIn("Truncated LZMA magic header", str(ctx.exception))

        # Truncated Gzip (< 2 bytes)
        with open(self.snapshot_path, "wb") as f:
            f.write(bytes([0x1f]))
        with self.assertRaises(CorruptSnapshotError) as ctx:
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertIn("Truncated Gzip magic header", str(ctx.exception))

    def test_inv_snap_stream_counting_accuracy(self):
        """POST-COMPRESS-1, POST-MANIFEST-1: _CountingWriter measures exact uncompressed byte size of serialized dictionary."""
        ns = rlm_kernel_runner._get_ns()
        ns["k1"] = [1, 2, 3, 4, 5]
        ns["k2"] = {"hello": "world", "nested": [10, 20]}

        # Measure direct uncompressed size of the container dictionary
        payload = {k: dill.dumps(ns[k]) for k in ["k1", "k2"]}
        direct_uncompressed_bytes = len(dill.dumps(payload))

        res = rlm_kernel_runner._snapshot_write(
            self.snapshot_path, self.manifest_path, 100 * 1024 * 1024, force_codec="lzma"
        )

        self.assertEqual(res["uncompressedBytes"], direct_uncompressed_bytes)
        with open(self.manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(manifest["uncompressedBytes"], direct_uncompressed_bytes)
        self.assertEqual(manifest["compressionDurationMs"], res["compressionDurationMs"])

    def test_post_snap_restore_1_atomic_namespace_isolation(self):
        """POST-RESTORE-1: Failed unpickling of any variable leaves active user_ns dictionary keys untouched (dictionary binding atomicity)."""
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

        # Active namespace dictionary must NOT contain partial key assignments
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
        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "invalid_codec_xyz"
        with self.assertRaises(SnapshotConfigurationError):
            rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

    def test_forbidden_4_frozen_codec_survives_mid_session_env_mutation(self):
        """FORBIDDEN-4: a codec frozen at bootstrap is immune to a later in-process

        os.environ["RLM_SNAPSHOT_COMPRESSION"] mutation by user cells.
        """
        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "lzma"
        rlm_kernel_runner._bootstrap()

        # Simulate a rogue user cell altering the environment mid-session
        os.environ["RLM_SNAPSHOT_COMPRESSION"] = "raw"

        ns = rlm_kernel_runner._get_ns()
        ns["post_bootstrap_var"] = "must be lzma compressed"

        result = rlm_kernel_runner._snapshot_write(
            self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
        )

        # Invariant: codec MUST still be lzma (the frozen value), NOT raw
        self.assertEqual(
            result["compression"],
            "lzma",
            "Snapshot codec must reflect bootstrap freeze, not mid-session env mutation",
        )
        with open(self.snapshot_path, "rb") as f:
            header = f.read(6)
        self.assertEqual(header, bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))

    def test_errors_4_and_forbidden_3_atomic_replace_failure_cleanup(self):
        """ERRORS-4, FORBIDDEN-3: Atomic replacement failure raises RlmSnapshotCompressionError and cleans up .tmp."""
        ns = rlm_kernel_runner._get_ns()
        ns["test_var"] = "abc"

        with patch("os.replace", side_effect=OSError("Simulated disk error")):
            with self.assertRaises(RlmSnapshotCompressionError):
                rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Temporary files must be cleaned up on failure
        tmp_files = [f for f in os.listdir(self.test_dir) if ".tmp" in f]
        self.assertEqual(len(tmp_files), 0, f"Found orphaned temp files after failure: {tmp_files}")

    def test_errors_4_manifest_commit_failure_rolls_back_payload_replace(self):
        """ERRORS-4: a manifest-commit failure after a successful payload commit rolls

        the live payload path back to its prior generation so the reported failure
        leaves NO partial or desynced state on disk.
        """
        ns = rlm_kernel_runner._get_ns()

        # Generation 1: establish a clean prior snapshot
        ns["generation"] = 1
        gen1_res = rlm_kernel_runner._snapshot_write(
            self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
        )
        self.assertEqual(gen1_res["compression"], "lzma")
        with open(self.snapshot_path, "rb") as f:
            gen1_payload_bytes = f.read()

        # Generation 2 setup
        ns["generation"] = 2

        # Mock os.replace so the FIRST replace (payload commit) succeeds but the
        # SECOND replace (manifest commit) raises OSError.
        real_replace = os.replace
        replace_call_count = 0

        def fail_manifest_replace(src, dst):
            nonlocal replace_call_count
            replace_call_count += 1
            if replace_call_count == 2:
                raise OSError("Simulated manifest commit failure")
            return real_replace(src, dst)

        with patch("os.replace", side_effect=fail_manifest_replace):
            with self.assertRaises(RlmSnapshotCompressionError):
                rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)

        # Rollback invariant: the live payload on disk MUST equal generation 1
        with open(self.snapshot_path, "rb") as f:
            restored_payload_bytes = f.read()
        self.assertEqual(
            restored_payload_bytes,
            gen1_payload_bytes,
            "Failed manifest commit must roll live payload back to prior generation",
        )

        # Verification: restore must read generation 1, NOT generation 2
        ns.clear()
        rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertEqual(ns.get("generation"), 1)

    def test_errors_4_payload_replace_failure_leaves_no_orphaned_backup(self):
        """Peer review Finding #4: when the FIRST os.replace (payload commit)

        fails with an OSError, POSIX rename() is a no-op that leaves the
        source and destination referencing the same inode. The backup hard
        link created before the replace must be explicitly cleaned up so it
        does not linger on disk as an orphaned .bak file alongside the
        untouched payload.
        """
        ns = rlm_kernel_runner._get_ns()

        # Generation 1: establish a clean prior snapshot
        ns["generation"] = 1
        rlm_kernel_runner._snapshot_write(
            self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
        )
        self.assertTrue(os.path.exists(self.snapshot_path))

        # Generation 2: fail the payload commit on the very first replace call
        real_replace = os.replace
        replace_call_count = 0

        def fail_first_payload_replace(src, dst):
            nonlocal replace_call_count
            replace_call_count += 1
            if replace_call_count == 1:
                raise OSError("Simulated payload commit failure")
            return real_replace(src, dst)

        with patch("os.replace", side_effect=fail_first_payload_replace):
            with self.assertRaises(RlmSnapshotCompressionError):
                rlm_kernel_runner._snapshot_write(
                    self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
                )

        # Invariant 1: no .bak file remains on disk
        backup_files = [f for f in os.listdir(self.test_dir) if ".bak" in f]
        self.assertEqual(
            backup_files,
            [],
            f"Failed payload commit must not leave orphaned .bak files: {backup_files}",
        )

        # Invariant 2: the untouched payload is still present and valid
        self.assertTrue(os.path.exists(self.snapshot_path))
        ns.clear()
        rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertEqual(ns.get("generation"), 1)

    def test_regression_payload_path_never_source_of_replace_during_commit(self):
        """Regression guard, not a contract clause: the live payload path must

        never be the source argument of an os.replace call during snapshot_write.
        Moving the live payload away leaves a transient window where the file
        does not exist; the protocol must use a hard-link backup instead.
        """
        ns = rlm_kernel_runner._get_ns()
        ns["v"] = "initial"
        rlm_kernel_runner._snapshot_write(
            self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
        )

        ns["v"] = "updated"
        rename_away_calls = []
        real_replace = os.replace

        def spy_replace(src, dst):
            if os.path.abspath(src) == os.path.abspath(self.snapshot_path):
                rename_away_calls.append((src, dst))
            return real_replace(src, dst)

        with patch("os.replace", side_effect=spy_replace):
            rlm_kernel_runner._snapshot_write(
                self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
            )

        self.assertEqual(
            rename_away_calls,
            [],
            "the live payload path must never be the source of an os.replace "
            "(that would leave it transiently absent); use a hard-link backup instead",
        )

    def test_regression_successful_commit_survives_backup_cleanup_failure(self):
        """Regression guard, not a contract clause (peer review Defect A): a

        failure while unlinking the backup hard link after BOTH replaces
        succeeded must not convert a successful commit into a reported failure.
        """
        ns = rlm_kernel_runner._get_ns()
        ns["generation"] = 1
        rlm_kernel_runner._snapshot_write(
            self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
        )

        ns["generation"] = 2
        real_remove = os.remove

        def fail_backup_remove(path):
            if ".bak" in path:
                raise OSError("Simulated backup cleanup permission error")
            return real_remove(path)

        with patch("os.remove", side_effect=fail_backup_remove):
            # Must succeed despite backup remove failure
            result = rlm_kernel_runner._snapshot_write(
                self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
            )
            self.assertIn("bytes", result)

        # Verification: new state is on disk
        ns.clear()
        rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        self.assertEqual(ns.get("generation"), 2)

    def test_errors_4_first_snapshot_manifest_failure_leaves_no_partial_payload(self):
        """Peer review Defect B: on the VERY FIRST snapshot (no prior

        generation existed), a manifest commit failure must remove the newly
        committed payload so the failed write leaves NO partial state on disk (ERRORS-4).
        """
        ns = rlm_kernel_runner._get_ns()
        ns["first_ever"] = "data"

        real_replace = os.replace
        replace_call_count = 0

        def fail_manifest_replace(src, dst):
            nonlocal replace_call_count
            replace_call_count += 1
            if replace_call_count == 2:
                raise OSError("Simulated manifest commit failure")
            return real_replace(src, dst)

        with patch("os.replace", side_effect=fail_manifest_replace):
            with self.assertRaises(RlmSnapshotCompressionError):
                rlm_kernel_runner._snapshot_write(
                    self.snapshot_path, self.manifest_path, 100 * 1024 * 1024
                )

        # Invariant: neither payload nor manifest exists on disk
        self.assertFalse(os.path.exists(self.snapshot_path))
        self.assertFalse(os.path.exists(self.manifest_path))
        self.assertFalse(os.path.exists(self.snapshot_path + ".tmp"))
        self.assertFalse(os.path.exists(self.manifest_path + ".tmp"))
        self.assertFalse(os.path.exists(self.snapshot_path + ".bak"))

    def test_post_snap_skip_1_unpicklable_and_oversize_handling(self):
        """POST-SKIP-1, SEQ-2, IP-4: Unpicklable and oversize objects recorded in skipped list while valid state persists."""
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
