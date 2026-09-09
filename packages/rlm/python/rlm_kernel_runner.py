#!/usr/bin/env python3
"""RLM in-kernel IPC execution runner.

Runs as a persistent subprocess managed by KernelManager.
Handles code execution, variable inspection, and snapshot management via dill.

Protocol:
- Reads JSON commands from stdin (one per line)
- Writes JSON responses to stdout (one per line)
- Captures stdout/stderr during cell execution
- Handles SIGINT for cell cancellation without killing runner process
"""

import builtins
import datetime
import io
import json
import os
import signal
import sys
import threading
import time
import traceback
from typing import Any, Dict, List, Optional

# Optional compression codec modules
lzma_mod = None
gzip_mod = None

# Optional dill module
dill = None

# Global execution lock and active cell tracking
_exec_lock = threading.Lock()
_active_cell_id = None
_interrupt_event = threading.Event()

# IPython InteractiveShell instance (or fallback namespace)
_shell = {}

# Track total variables saved across snapshots for this process
TOTAL_SNAPSHOT_VARIABLES_SAVED = 0


class RlmRunnerError(Exception):
    """Base exception for RLM runner errors."""
    pass


class CellExecutionError(RlmRunnerError):
    """Raised when cell execution fails."""
    pass


def _sigint_handler(signum, frame):
    """Handle SIGINT by setting interrupt event without terminating process."""
    _interrupt_event.set()


def _emit(frame: dict) -> None:
    """Emit JSON response frame to stdout."""
    line = json.dumps(frame)
    sys.__stdout__.write(line + "\n")
    sys.__stdout__.flush()


def _ensure_dill() -> None:
    """Ensure dill is loaded; raise informative error if not present."""
    global dill
    if dill is None:
        try:
            import dill as _dill
            dill = _dill
        except ImportError:
            raise RuntimeError(
                "dill is required for RLM snapshot serialization. "
                "Ensure dill is installed in the active Python environment."
            )


def _ensure_shell() -> Any:
    """Lazily load IPython InteractiveShell if available, else dict namespace.

    Lazy loading avoids paying IPython's full ~200ms startup cost in short-lived
    test environments or pure unit tests that only exercise snapshot functions.
    """
    global _shell
    if _shell is None or isinstance(_shell, dict) and not _shell:
        try:
            from IPython.core.interactiveshell import InteractiveShell
            _shell = InteractiveShell.instance()
            # Configure shell for non-interactive runner mode
            _shell.colors = "nocolor"
            _shell.autocall = 0
        except ImportError:
            _shell = {}
    return _shell


def _get_ns() -> dict[str, Any]:
    """Return the active namespace dict for variable storage."""
    global _shell
    if _shell is not None and hasattr(_shell, "user_ns"):
        return _shell.user_ns
    if isinstance(_shell, dict):
        return _shell
    return _ensure_shell().user_ns if hasattr(_shell, "user_ns") else _shell


def _capture_streams():
    """Context manager / helper to capture stdout and stderr during execution."""
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    return stdout_buf, stderr_buf, old_stdout, old_stderr


def _execute_cell(code: str, exec_id: str) -> dict:
    """Execute code in the persistent namespace and return output."""
    global _active_cell_id
    _active_cell_id = exec_id

    stdout_buf, stderr_buf, old_stdout, old_stderr = _capture_streams()
    result_val = None
    error_ename = None
    traceback_str = None
    code_val = 0

    try:
        # Re-initialize the interrupt event per-execution (INV-KM-5 /
        # POST-KM-3). Any stale SIGINT delivered before the cell started
        # MUST be cleared so an empty/idle interrupt cannot bleed into
        # THIS cell's result — an idle interrupt with no cell in flight is
        # intentionally absorbed, never attached to a future execution.
        _interrupt_event.clear()
        sys.stdout = stdout_buf
        sys.stderr = stderr_buf

        # Emit started frame
        _emit({"type": "started", "id": exec_id})

        shell = _ensure_shell()
        if not isinstance(shell, dict):
            with _exec_lock:
                # Use IPython's run_cell for rich execution
                result = shell.run_cell(code)
            # Flush any output from the shell
            stdout_buf.flush()
            stderr_buf.flush()
            if _interrupt_event.is_set():
                code_val = 1
                error_ename = "KeyboardInterrupt"
                traceback_str = "Execution interrupted by host"
            else:
                # error_before_exec covers parse/compile failures (SyntaxError);
                # error_in_exec covers runtime failures during execution. Both
                # SHALL be checked — reading only one silently downgrades the
                # other class of failure to a generic ExecutionError.
                exc = result.error_before_exec or result.error_in_exec
                if exc is not None or not getattr(result, "success", True):
                    code_val = 1
                    if exc is not None:
                        error_ename = type(exc).__name__
                        traceback_str = "\n".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
                    else:
                        error_ename = "ExecutionError"
                        traceback_str = "Cell execution failed"
                else:
                    if result.result is not None:
                        result_val = repr(result.result)
        else:
            # Fallback execution in simple namespace
            with _exec_lock:
                compiled = compile(code, "<rlm-cell>", "exec")
                exec(compiled, _get_ns())
            stdout_buf.flush()
            stderr_buf.flush()
            if _interrupt_event.is_set():
                code_val = 1
                error_ename = "KeyboardInterrupt"
                traceback_str = "Execution interrupted by host"

    except KeyboardInterrupt:
        code_val = 1
        error_ename = "KeyboardInterrupt"
        traceback_str = "Execution interrupted by host"
    except Exception as e:
        code_val = 1
        error_ename = type(e).__name__
        traceback_str = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        _active_cell_id = None
        _interrupt_event.clear()

    return {
        "type": "done",
        "id": exec_id,
        "code": code_val,
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "result": result_val,
        "traceback": traceback_str,
        "errorEname": error_ename,
    }


def _sigint_handler_installed() -> bool:
    """Return True if the active SIGINT handler is our _sigint_handler."""
    try:
        return signal.getsignal(signal.SIGINT) == _sigint_handler
    except (ValueError, AttributeError):
        return False


def _install_interrupt_handler() -> None:
    """Install the SIGINT handler on the main thread if not already set.

    In worker threads (e.g. during threaded test suites), signal.signal
    raises ValueError; this helper safely ignores that case so tests run
    without unhandled exceptions.
    """
    try:
        signal.signal(signal.SIGINT, _sigint_handler)
    except (ValueError, AttributeError):
        # signal.signal only works from the main thread; ignore in test threads
        pass


# =============================================================================
# Custom Exception Classes for Compression Subsystem (Issue #15)
# =============================================================================

class RlmSnapshotCompressionError(Exception):
    """Base exception for all snapshot compression subsystem errors."""
    pass


class CorruptSnapshotError(RlmSnapshotCompressionError):
    """Raised when snapshot payload is truncated, empty, or fails checksum/magic validation."""
    pass


class UnsupportedCodecError(RlmSnapshotCompressionError):
    """Raised when a snapshot binary magic header is unrecognized."""
    pass


class SnapshotConfigurationError(RlmSnapshotCompressionError):
    """Raised when RLM_SNAPSHOT_COMPRESSION is configured with an unsupported value."""
    pass


class _CountingWriter(io.RawIOBase):
    """Transparent stream wrapper that counts exact uncompressed bytes written by dill.dump without buffering in RAM."""

    def __init__(self, target_stream):
        self.target_stream = target_stream
        self.bytes_written = 0

    def write(self, b):
        self.bytes_written += len(b)
        return self.target_stream.write(b)

    def flush(self):
        if not getattr(self.target_stream, "closed", False):
            try:
                return self.target_stream.flush()
            except ValueError:
                pass
        return None

    def readable(self):
        return False

    def writable(self):
        return True


def _detect_codec(data: bytes) -> str:
    """Inspect magic bytes to determine compression codec (lzma, gzip, or raw)."""
    if len(data) < 1:
        raise CorruptSnapshotError("Empty snapshot payload: 0 bytes")

    # LZMA: 0xFD '7' 'z' 'X' 'Z' 0x00
    if len(data) >= 6 and data.startswith(b"\xfd7zXZ\x00"):
        return "lzma"
    if len(data) < 6 and b"\xfd7zXZ\x00".startswith(data):
        raise CorruptSnapshotError(f"Truncated LZMA magic header ({len(data)}/6 bytes)")

    # Gzip: 0x1F 0x8B
    if len(data) >= 2 and data.startswith(b"\x1f\x8b"):
        return "gzip"
    if len(data) < 2 and b"\x1f\x8b".startswith(data):
        raise CorruptSnapshotError(f"Truncated Gzip magic header ({len(data)}/2 bytes)")

    # Legacy Python pickle / dill protocol 2/3/4/5: starts with 0x80
    if data[0] == 0x80:
        return "raw"

    header_hex = ", ".join(f"0x{b:02x}" for b in data[:6])
    raise UnsupportedCodecError(f"Unrecognized magic header: [{header_hex}]")


def _snapshot_names() -> list[str]:
    """Return sorted list of user-defined variable names eligible for snapshotting."""
    ns = _get_ns()
    # Filter out private / builtin variables
    return sorted([
        k for k in ns.keys()
        if not k.startswith("_") and k not in ("In", "Out", "get_ipython", "exit", "quit")
    ])


def _fsync_dir(dir_path: str) -> None:
    """Fsync directory to guarantee directory entry persistence (POST-DSYNC-1)."""
    try:
        dfd = os.open(dir_path, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except (OSError, AttributeError):
        pass


def _resolve_snapshot_codec() -> dict[str, Any]:
    """Resolve and validate active compression codec from environment (POST-CONFIG-1..4)."""
    raw = os.environ.get("RLM_SNAPSHOT_COMPRESSION", "lzma").strip().lower()
    if raw in ("", "1", "true", "yes", "lzma", "auto"):
        return {"codec": "lzma", "active": True}
    if raw == "gzip":
        return {"codec": "gzip", "active": True}
    if raw in ("0", "false", "no", "raw", "none", "off"):
        return {"codec": "raw", "active": False}
    raise SnapshotConfigurationError(
        f"Unsupported RLM_SNAPSHOT_COMPRESSION value: '{raw}'. Supported codecs: lzma, gzip, raw."
    )


# Frozen snapshot codec resolved once at bootstrap (FORBIDDEN-4).
# A frozen codec survives any subsequent in-process mutation of
# os.environ["RLM_SNAPSHOT_COMPRESSION"].
#
# Module-level default is None: the codec is lazily frozen on the first
# call to _freeze_snapshot_codec() — which _bootstrap() triggers before any
# user cell can run, and which _snapshot_write() falls back to in tests.
_FROZEN_SNAPSHOT_CODEC: Optional[dict[str, Any]] = None


def _freeze_snapshot_codec() -> dict[str, Any]:
    """Freeze snapshot compression codec once for this process (FORBIDDEN-4).

    Re-resolving codec on every snapshot write creates a race condition and
    allows rogue cells to alter snapshot format mid-session. Freezing at
    bootstrap ensures codec determinism.

    The frozen value is held in _FROZEN_SNAPSHOT_CODEC and intentionally has
    NO public un-freeze or re-freeze mutation path. Codec selection is fixed
    for the process lifetime once frozen.
    """
    global _FROZEN_SNAPSHOT_CODEC
    if _FROZEN_SNAPSHOT_CODEC is None:
        _FROZEN_SNAPSHOT_CODEC = _resolve_snapshot_codec()
    return _FROZEN_SNAPSHOT_CODEC


def _ensure_dill():
    """Ensure dill is loaded; raise informative error if not present."""
    global dill
    if dill is None:
        try:
            import dill as _dill
            dill = _dill
        except ImportError:
            raise RuntimeError(
                "dill is required for RLM snapshot serialization. "
                "Ensure dill is installed in the active Python environment."
            )


def _snapshot_write(
    path: str,
    manifest_path: Optional[str] = None,
    max_bytes: int = 100 * 1024 * 1024,
    force_codec: Optional[str] = None,
) -> dict:
    """Serialize and compress persistent namespace state using the frozen codec.

    Writes compressed payload to path, writes manifest telemetry to manifest_path.
    Uses atomic write pattern: write to .tmp.<pid>.<ts>, flush, fsync, os.replace.

    If force_codec is supplied (e.g. during explicit test assertions), that
    codec overrides the frozen default for THIS call only. Otherwise, the codec
    frozen at bootstrap (_freeze_snapshot_codec) is used (FORBIDDEN-4).
    """
    global dill, lzma_mod, gzip_mod, TOTAL_SNAPSHOT_VARIABLES_SAVED

    t_start = time.perf_counter()
    _ensure_dill()

    if force_codec is not None:
        if force_codec not in ("lzma", "gzip", "raw"):
            raise SnapshotConfigurationError(
                f"Unsupported force_codec: '{force_codec}'. Supported codecs: lzma, gzip, raw."
            )
        codec_info = {"codec": force_codec, "active": force_codec != "raw"}
    else:
        codec_info = _freeze_snapshot_codec()

    codec = codec_info["codec"]

    # Filter namespace keys (exclude private, builtins, etc.)
    ns = _get_ns()
    names = _snapshot_names()

    # Pre-flight per-variable picklability check and serialization (SEQ-2, POST-SKIP-1)
    serialized_vars = {}
    skipped = []

    for name in names:
        val = ns[name]
        try:
            blob = dill.dumps(val)
            # Size ceiling validation per serialized variable
            if len(blob) > max_bytes:
                skipped.append({"name": name, "reason": "exceeds snapshot size cap"})
                continue
            serialized_vars[name] = blob
        except Exception as exc:
            skipped.append({"name": name, "reason": f"unpicklable ({type(exc).__name__}: {exc})"})

    # Wrap in root dict container
    container = serialized_vars
    uncompressed_bytes = 0

    # Ensure parent directories exist
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    if manifest_path:
        os.makedirs(os.path.dirname(os.path.abspath(manifest_path)) or ".", exist_ok=True)

    # Temporary paths for atomic two-file commit (FORBIDDEN-2, FORBIDDEN-3, IP-3, IP-4)
    nonce = f"{os.getpid()}.{time.time_ns()}"
    tmp_path = f"{path}.tmp.{nonce}"
    manifest_tmp = f"{manifest_path}.tmp.{nonce}" if manifest_path else f"{path}.manifest.tmp.{nonce}"

    try:
        # Atomic serialization to temp file using transparent streaming counter
        with open(tmp_path, "wb") as fh:
            if codec == "lzma":
                try:
                    import lzma
                except ImportError as exc:
                    raise UnsupportedCodecError(
                        f"LZMA compression unsupported on this Python build (missing _lzma): {exc}"
                    ) from exc
                with lzma.open(fh, "wb", preset=0) as comp_fh:
                    cw = _CountingWriter(comp_fh)
                    dill.dump(container, cw)
                    comp_fh.flush()
                    uncompressed_bytes = cw.bytes_written
            elif codec == "gzip":
                import gzip
                with gzip.open(fh, "wb", compresslevel=1) as comp_fh:
                    cw = _CountingWriter(comp_fh)
                    dill.dump(container, cw)
                    comp_fh.flush()
                    uncompressed_bytes = cw.bytes_written
            elif codec == "raw":
                cw = _CountingWriter(fh)
                dill.dump(container, cw)
                uncompressed_bytes = cw.bytes_written
            else:
                raise SnapshotConfigurationError(f"Unsupported compression codec: {codec}")

            fh.flush()
            os.fsync(fh.fileno())

        bytes_written = os.path.getsize(tmp_path)
        saved = sorted(container.keys())

        compression_ratio = (
            round(max(0.0, (1.0 - (bytes_written / uncompressed_bytes)) * 100.0), 2)
            if uncompressed_bytes > 0
            else 0.0
        )
        duration_ms = max(0.01, round((time.perf_counter() - t_start) * 1000.0, 2))

        manifest = {
            "version": 1,
            "savedNames": saved,
            "skipped": skipped,
            "bytes": bytes_written,
            "uncompressedBytes": uncompressed_bytes,
            "compressedBytes": bytes_written,
            "compression": codec,
            "compressionRatio": compression_ratio,
            "compressionDurationMs": duration_ms,
            "pythonVersion": sys.version.split()[0],
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

        # Write manifest tmp file (POST-MANIFEST-1, IP-4)
        with open(manifest_tmp, "w", encoding="utf-8") as mfh:
            json.dump(manifest, mfh, indent=2)
            mfh.flush()
            os.fsync(mfh.fileno())

        # Atomic commit via sequential os.replace calls. If the manifest
        # commit fails after the payload commit succeeded, roll the live
        # `path` back to the prior generation via the backup hard link, so a
        # REPORTED failure has no partial effect on disk (ERRORS-4). Two
        # independent os.replace calls still cannot be made one atomic
        # operation without directory-swap machinery (out of scope here);
        # this closes the trappable half of that gap only. The residual
        # window (an unstoppable process kill between the two replaces) can
        # still leave a stale kernel-state.json describing the prior
        # generation; that is bounded, not silent, because TypeScript's
        # KernelManager independently overwrites this file with
        # authoritative telemetry on every SUCCESSFUL snapshot and skips
        # that write on failure (kernel.ts:818-835).
        payload_backup = path + ".bak" if os.path.exists(path) else None
        if payload_backup is not None:
            if os.path.exists(payload_backup):
                os.remove(payload_backup)
            os.link(path, payload_backup)
        try:
            os.replace(tmp_path, path)
            os.replace(manifest_tmp, manifest_path)
        except OSError as commit_exc:
            try:
                if payload_backup is not None:
                    os.replace(payload_backup, path)
                    # POSIX rename() is a documented no-op (source is NOT
                    # unlinked) when src and dst already reference the same
                    # inode -- the case when the FIRST os.replace(tmp_path,
                    # path) failed, leaving `path` untouched and still
                    # hard-linked to `payload_backup`. Reclaim the backup
                    # explicitly so it never lingers as an orphan.
                    if os.path.exists(payload_backup):
                        os.remove(payload_backup)
                elif os.path.exists(path):
                    # Peer review Defect B: first-ever snapshot has no prior
                    # generation to roll back to. Remove the just-committed
                    # payload too, so a reported failure has no partial
                    # effect on disk (ERRORS-4) regardless of whether a
                    # prior generation existed.
                    os.remove(path)
            except OSError as rollback_exc:
                raise RlmSnapshotCompressionError(
                    f"Atomic snapshot write failed and payload rollback also failed "
                    f"(disk state indeterminate for path={path!r}, "
                    f"manifest_path={manifest_path!r}): commit error={commit_exc}; "
                    f"rollback error={rollback_exc}"
                ) from commit_exc
            raise
        else:
            # Peer review Defect A: cleanup of the now-unneeded backup must
            # never turn a SUCCESSFUL commit into a reported failure -- both
            # replaces already landed by this point. Swallow cleanup errors
            # the same way the outer handler swallows .tmp cleanup errors.
            try:
                if payload_backup is not None and os.path.exists(payload_backup):
                    os.remove(payload_backup)
            except OSError:
                pass
        # FORBIDDEN-2/3: file contents were fsynced above, but the directory
        # entries created by these renames were not — without this, a power
        # loss can still lose either rename despite the advertised atomic-
        # durability guarantee. Fsync each distinct containing directory.
        for _dir in {os.path.dirname(path) or ".", os.path.dirname(manifest_path) or "."}:
            _fsync_dir(_dir)
    except Exception as exc:
        for p in (tmp_path, manifest_tmp):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass
        if isinstance(exc, RlmSnapshotCompressionError):
            raise
        raise RlmSnapshotCompressionError(f"Atomic snapshot write failed: {exc}") from exc
    return {
        "bytes": bytes_written,
        "uncompressedBytes": uncompressed_bytes,
        "compressedBytes": bytes_written,
        "compression": codec,
        "compressionRatio": compression_ratio,
        "compressionDurationMs": duration_ms,
        "skipped": skipped,
    }


def _snapshot_restore(path: str, manifest_path: str) -> dict:
    """Load the payload with transparent stream decompression auto-detection and inject names into user_ns."""
    import dill

    if not os.path.exists(path):
        return {"restoredNames": []}

    try:
        if os.path.getsize(path) == 0:
            raise CorruptSnapshotError("Empty snapshot payload: 0 bytes")
        with open(path, "rb") as fh:
            header = fh.read(6)
    except Exception as exc:
        if isinstance(exc, RlmSnapshotCompressionError):
            raise
        raise RlmSnapshotCompressionError(f"Failed to read snapshot file {path}: {exc}") from exc

    # Detect compression codec from magic header
    codec = _detect_codec(header)

    try:
        if codec == "lzma":
            try:
                import lzma
            except ImportError as exc:
                raise UnsupportedCodecError(
                    f"LZMA decompression unsupported on this Python build (missing _lzma): {exc}"
                ) from exc
            with lzma.open(path, "rb") as fh:
                payload = dill.load(fh)
        elif codec == "gzip":
            import gzip
            with gzip.open(path, "rb") as fh:
                payload = dill.load(fh)
        else:
            with open(path, "rb") as fh:
                payload = dill.load(fh)
    except Exception as exc:
        if isinstance(exc, RlmSnapshotCompressionError):
            raise
        raise CorruptSnapshotError(f"Decompression / dill load failed for codec {codec}: {exc}") from exc

    if not isinstance(payload, dict):
        raise CorruptSnapshotError(f"Expected dict payload, got {type(payload).__name__}")

    # Staged dictionary restore: unpack all variables into an isolated staging dict
    # first to guarantee namespace dictionary binding atomicity — preventing partial key
    # assignments in user_ns if any variable blob fails deserialization. (Note: in-process
    # deserialization executes __setstate__ / reducer callables during dill.loads, so
    # transactional heap rollback for custom reducer side effects requires a process fork).
    temp_restored = {}
    for name, blob in payload.items():
        if not isinstance(name, str):
            raise CorruptSnapshotError(f"Invalid non-string variable name in snapshot payload: {name!r}")
        try:
            temp_restored[name] = dill.loads(blob)
        except Exception as exc:
            raise CorruptSnapshotError(f"Failed to unpickle variable '{name}': {exc}") from exc

    # Validate and sort restored names BEFORE mutating active user namespace
    try:
        restored_names = sorted(temp_restored.keys())
    except Exception as exc:
        raise CorruptSnapshotError(f"Failed to order restored variable names: {exc}") from exc

    # Commit atomically to user namespace only after all variables and names are validated
    ns = _get_ns()
    ns.update(temp_restored)

    return {"restoredNames": restored_names}


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


def _bootstrap() -> None:
    """Execute the runtime bootstrap: import the runtime package; verify dill."""
    # Verify dill is importable
    import dill  # noqa: F401

    # Import the runtime package
    import rlm  # noqa: F401

    # Pre-freeze the snapshot compression codec (FORBIDDEN-4).
    _freeze_snapshot_codec()


def _handle_op(op: dict) -> None:
    """Dispatch a single JSON-lines operation frame from the host."""
    op_name = op.get("op")
    op_id = op.get("id")

    if op_name == "bootstrap":
        try:
            _bootstrap()
            _emit({"type": "result", "id": op_id, "data": "ready"})
        except Exception as exc:
            _emit({
                "type": "error",
                "id": op_id,
                "errorEname": type(exc).__name__,
                "data": str(exc),
            })
    elif op_name == "execute":
        code = op.get("code", "")
        # SIGINT is installed on the main thread; in child threads (e.g. tests),
        # _install_interrupt_handler safely no-ops.
        _install_interrupt_handler()
        frame = _execute_cell(code, op_id)
        _emit(frame)
    elif op_name == "snapshot_names":
        try:
            names = _snapshot_names()
            _emit({"type": "result", "id": op_id, "names": names})
        except Exception as exc:
            _emit({
                "type": "error",
                "id": op_id,
                "errorEname": type(exc).__name__,
                "data": str(exc),
            })
    elif op_name == "snapshot_write":
        path = op.get("path")
        manifest_path = op.get("manifestPath")
        max_bytes = op.get("maxBytes", 100 * 1024 * 1024)
        try:
            res = _snapshot_write(path, manifest_path, max_bytes)
            _emit({
                "type": "result",
                "id": op_id,
                "bytes": res["bytes"],
                "uncompressedBytes": res["uncompressedBytes"],
                "compressedBytes": res["compressedBytes"],
                "compression": res["compression"],
                "compressionRatio": res["compressionRatio"],
                "compressionDurationMs": res["compressionDurationMs"],
                "skipped": res["skipped"],
            })
        except Exception as exc:
            _emit({
                "type": "error",
                "id": op_id,
                "errorEname": type(exc).__name__,
                "data": f"Snapshot write failed: {str(exc)}",
            })
    elif op_name == "snapshot_restore":
        path = op.get("path")
        manifest_path = op.get("manifestPath")
        try:
            res = _snapshot_restore(path, manifest_path)
            _emit({
                "type": "result",
                "id": op_id,
                "restoredNames": res["restoredNames"],
            })
        except Exception as exc:
            _emit({
                "type": "error",
                "id": op_id,
                "errorEname": type(exc).__name__,
                "data": str(exc),
            })
    elif op_name == "interrupt":
        # Software interrupt fallback when SIGINT is unavailable.
        _interrupt_event.set()
    elif op_name == "shutdown":
        sys.exit(0)
    else:
        _emit({
            "type": "error",
            "id": op_id,
            "errorEname": "UnknownOpError",
            "data": f"Unknown op: {op_name}",
        })


def main() -> None:
    """Main stdio loop: read op frames from stdin, emit response frames to stdout."""
    # Install SIGINT handler on main thread
    _install_interrupt_handler()

    # Pre-initialize shell or fallback namespace
    _ensure_shell()

    # Emit ready handshake
    _emit({
        "type": "ready",
        "protocol": 1,
        "pythonVersion": sys.version.split()[0],
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            op = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({
                "type": "error",
                "id": "unknown",
                "errorEname": "JSONDecodeError",
                "data": f"Invalid JSON on stdin: {exc}",
            })
            continue

        _handle_op(op)


if __name__ == "__main__":
    main()
