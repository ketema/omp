#!/usr/bin/env python3
"""RLM kernel runner — dedicated JSON-lines-over-stdio Python runner.

Reads op lines from stdin, writes frame lines to stdout. All stdout/stderr
produced by cells is captured into frames, never mixed with protocol lines.

Host -> runner ops:
  {"op":"execute","id":...,"code":...}
  {"op":"interrupt"}
  {"op":"snapshot_names","id":...}
  {"op":"snapshot_write","id":...,"path":...,"manifestPath":...,"maxBytes":...}
  {"op":"snapshot_restore","id":...,"path":...,"manifestPath":...}
  {"op":"bootstrap","id":...}
  {"op":"shutdown"}

Runner -> host frames:
  {"type":"ready","protocol":1,"pythonVersion":...}
  {"type":"started","id":...}
  {"type":"stdout","id":...,"data":...}
  {"type":"stderr","id":...,"data":...}
  {"type":"done","id":...,"code":0|1,"stdout":...,"stderr":...,"result":...,"traceback":...,"errorEname":...}
  {"type":"result","id":...,"names":[...]}
  {"type":"result","id":...,"bytes":...,"skipped":[...]}
  {"type":"result","id":...,"restoredNames":[...]}
  {"type":"error","id":...,"errorEname":...,"data":...}
"""

from __future__ import annotations

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
from typing import Any

# ---------------------------------------------------------------------------
# Frame writer — writes to the REAL stdout (fd 1), under a lock
# ---------------------------------------------------------------------------

_FRAME_LOCK = threading.Lock()
_RAW_STDOUT = sys.__stdout__


def _emit(frame: dict) -> None:
    """Serialize a frame and write it to the host as a single JSON line."""
    line = json.dumps(frame, ensure_ascii=False, default=str)
    with _FRAME_LOCK:
        _RAW_STDOUT.write(line)
        _RAW_STDOUT.write("\n")
        _RAW_STDOUT.flush()


# ---------------------------------------------------------------------------
# Persistent IPython namespace
# ---------------------------------------------------------------------------

_ALWAYS_SKIP: frozenset[str] = frozenset(
    {"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
)

_shell: Any = None
_user_ns: dict[str, Any] = {}


def _ensure_shell() -> Any:
    """Create or return the persistent InteractiveShell instance."""
    global _shell, _user_ns
    if _shell is not None:
        return _shell
    try:
        from IPython.core.interactiveshell import InteractiveShell

        InteractiveShell.clear_instance()
        _shell = InteractiveShell.instance()
        _user_ns = _shell.user_ns
    except Exception:
        # Fallback to plain namespace if IPython not available
        _shell = _user_ns  # type: ignore[assignment]
        _user_ns.update(
            {"__name__": "__main__", "__doc__": None, "__builtins__": builtins}
        )
    return _shell


def _get_ns() -> dict[str, Any]:
    """Return the user namespace dict."""
    shell = _ensure_shell()
    if isinstance(shell, dict):
        return shell
    return _user_ns


# ---------------------------------------------------------------------------
# Cell execution with stdout/stderr capture
# ---------------------------------------------------------------------------

_exec_lock = threading.Lock()


def _execute_cell(code: str, exec_id: str) -> dict:
    """Execute a cell, capturing stdout/stderr, returning the done frame."""
    global _is_executing
    _is_executing = True
    _interrupt_event.clear()
    ns = _get_ns()
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    # Redirect sys.stdout/sys.stderr during cell execution
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf

    # Emit started frame
    _emit({"type": "started", "id": exec_id})

    code_val = 0
    result_str = ""
    traceback_str: str | None = None
    error_ename: str | None = None

    try:
        with _exec_lock:
            if _shell is not None and not isinstance(_shell, dict):
                # Use IPython's run_cell for rich execution
                result = _shell.run_cell(code)
                # Flush any output from the shell
                stdout_buf.flush()
                stderr_buf.flush()
                if _interrupt_event.is_set():
                    code_val = 1
                    error_ename = "KeyboardInterrupt"
                    traceback_str = "Execution interrupted by host"
                elif result.error_in_exec is not None or not getattr(result, "success", True):
                    exc = result.error_in_exec
                    code_val = 1
                    if exc is not None:
                        error_ename = type(exc).__name__
                        tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
                        traceback_str = "".join(tb_lines)
                    else:
                        error_ename = "ExecutionError"
                        traceback_str = "Execution failed"
                elif result.result is not None:
                    try:
                        result_str = repr(result.result)
                    except Exception:
                        result_str = "<unrepr>"
            else:
                # Plain Python fallback — split last expression for result
                import ast

                try:
                    module = ast.parse(code, "<cell>", "exec")
                    if module.body and isinstance(module.body[-1], ast.Expr):
                        body = ast.Module(body=module.body[:-1], type_ignores=[])
                        expr = ast.Expression(body=module.body[-1].value)
                        exec(compile(body, "<cell>", "exec"), ns)
                        val = eval(compile(expr, "<cell>", "eval"), ns)
                        if val is not None:
                            result_str = repr(val)
                    else:
                        exec(compile(module, "<cell>", "exec"), ns)
                except KeyboardInterrupt:
                    code_val = 1
                    error_ename = "KeyboardInterrupt"
                    traceback_str = "Execution interrupted"
                except SystemExit:
                    code_val = 1
                    error_ename = "SystemExit"
                except BaseException as exc:
                    code_val = 1
                    error_ename = type(exc).__name__
                    tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
                    traceback_str = "".join(tb_lines)
    except KeyboardInterrupt:
        code_val = 1
        error_ename = "KeyboardInterrupt"
        traceback_str = "Execution interrupted"
    except BaseException as exc:
        code_val = 1
        error_ename = type(exc).__name__
        tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
        traceback_str = "".join(tb_lines)
    finally:
        _is_executing = False
        if _interrupt_event.is_set():
            code_val = 1
            if error_ename is None:
                error_ename = "KeyboardInterrupt"
                traceback_str = "Execution interrupted by host"
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    stdout_text = stdout_buf.getvalue()
    stderr_text = stderr_buf.getvalue()

    # Stream stdout/stderr frames
    if stdout_text:
        _emit({"type": "stdout", "id": exec_id, "data": stdout_text})
    if stderr_text:
        _emit({"type": "stderr", "id": exec_id, "data": stderr_text})

    return {
        "type": "done",
        "id": exec_id,
        "code": code_val,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "result": result_str,
        "traceback": traceback_str,
        "errorEname": error_ename,
    }


# ---------------------------------------------------------------------------
# Interrupt handling
# ---------------------------------------------------------------------------

_interrupt_event = threading.Event()
_is_executing = False


def _install_interrupt_handler() -> None:
    """Install SIGINT handler that interrupts the running cell without terminating the runner when idle."""
    def handler(signum: int, frame: Any) -> None:
        _interrupt_event.set()
        if _is_executing:
            raise KeyboardInterrupt("Execution interrupted by host")

    try:
        signal.signal(signal.SIGINT, handler)
    except (OSError, ValueError):
        pass


# ---------------------------------------------------------------------------
# Snapshot operations
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Snapshot Compression Exceptions
# ---------------------------------------------------------------------------


class RlmSnapshotCompressionError(Exception):
    """Base exception for snapshot compression errors."""
    pass


class CorruptSnapshotError(RlmSnapshotCompressionError):
    """Raised when a snapshot file payload is corrupted or truncated."""
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
        return self.target_stream.flush()

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

    raise UnsupportedCodecError(
        f"Unrecognized magic header: {[hex(b) for b in data[:6]]}"
    )


def _snapshot_names() -> list[str]:
    """Top-level user_ns names excluding builtins and the always-skip set."""
    ns = _get_ns()
    names = []
    for name in list(ns.keys()):
        if name.startswith("_"):
            continue
        if name in _ALWAYS_SKIP:
            continue
        # Skip modules
        value = ns.get(name)
        if isinstance(value, type(sys)):
            continue
        names.append(name)
    return sorted(names)


def _snapshot_write(
    path: str, manifest_path: str, max_bytes: int
) -> dict:
    """Per-variable dill.dumps with transparent stream compression, atomic write, and manifest."""
    import dill
    t_start = time.time()

    dill.settings["recurse"] = True

    # Validate compression codec configuration with dynamic module loading and gzip fallback
    codec_env = os.environ.get("RLM_SNAPSHOT_COMPRESSION", "auto").strip().lower()
    lzma_mod = None
    gzip_mod = None

    if codec_env in ("auto", "default", ""):
        try:
            import lzma as lzma_mod
            codec = "lzma"
        except ImportError:
            import gzip as gzip_mod
            codec = "gzip"
    elif codec_env in ("lzma", "xz"):
        try:
            import lzma as lzma_mod
            codec = "lzma"
        except ImportError as exc:
            raise SnapshotConfigurationError(
                f"LZMA compression requested but _lzma module is unavailable: {exc}"
            ) from exc
    elif codec_env == "gzip":
        import gzip as gzip_mod
        codec = "gzip"
    elif codec_env in ("raw", "none", "uncompressed"):
        codec = "raw"
    else:
        raise SnapshotConfigurationError(f"Unsupported RLM_SNAPSHOT_COMPRESSION: {codec_env}")

    ns = _get_ns()
    names = _snapshot_names()

    payload: dict[str, bytes] = {}
    skipped: list[dict[str, str]] = []
    total = 0

    for name in names:
        value = ns.get(name)
        if value is None:
            continue
        try:
            blob = dill.dumps(value)
        except Exception as exc:
            skipped.append(
                {"name": name, "reason": f"{type(exc).__name__}: {str(exc)[:200]}"}
            )
            continue
        if len(blob) > max_bytes or total + len(blob) > max_bytes:
            skipped.append({"name": name, "reason": "exceeds snapshot size cap"})
            continue
        payload[name] = blob
        total += len(blob)

    # Coupled two-phase commit: stage both payload and manifest to .tmp files before replacing production state
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp_path = path + ".tmp"
    manifest_tmp = manifest_path + ".tmp"
    uncompressed_bytes = 0


    try:
        # Phase 1: Stream payload directly to tmp_path with fsync and exact stream counting
        with open(tmp_path, "wb") as raw_fh:
            if codec == "lzma":
                if lzma_mod is None:
                    import lzma as lzma_mod
                with lzma_mod.open(raw_fh, "wb", preset=0) as comp_fh:
                    cw = _CountingWriter(comp_fh)
                    dill.dump(payload, cw)
                    comp_fh.flush()
                    uncompressed_bytes = cw.bytes_written
            elif codec == "gzip":
                if gzip_mod is None:
                    import gzip as gzip_mod
                with gzip_mod.open(raw_fh, "wb", compresslevel=1) as comp_fh:
                    cw = _CountingWriter(comp_fh)
                    dill.dump(payload, cw)
                    comp_fh.flush()
                    uncompressed_bytes = cw.bytes_written
            else:
                cw = _CountingWriter(raw_fh)
                dill.dump(payload, cw)
                uncompressed_bytes = cw.bytes_written
            raw_fh.flush()
            os.fsync(raw_fh.fileno())

        bytes_written = os.path.getsize(tmp_path)
        saved = sorted(payload.keys())

        compression_ratio = (
            round(max(0.0, (1.0 - (bytes_written / uncompressed_bytes)) * 100.0), 2)
            if uncompressed_bytes > 0
            else 0.0
        )
        duration_ms = round((time.time() - t_start) * 1000.0, 2)

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

        # Phase 2: Stage and fsync manifest to manifest_tmp
        with open(manifest_tmp, "w") as fh:
            json.dump(manifest, fh)
            fh.flush()
            os.fsync(fh.fileno())

        # Phase 3: Direct atomic replace (in POSIX, each os.replace is atomic so prior file remains intact until replacement)
        os.replace(tmp_path, path)
        os.replace(manifest_tmp, manifest_path)
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

    # Two-phase atomic restore: unpack into isolated temp dict first to protect active namespace
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


# ---------------------------------------------------------------------------
# Op dispatch
# ---------------------------------------------------------------------------


def _handle_op(op: dict) -> None:
    """Dispatch a single op from the host."""
    op_name = op.get("op")
    op_id = op.get("id", "")

    if op_name == "execute":
        code = op.get("code", "")
        done_frame = _execute_cell(code, op_id)
        _emit(done_frame)

    elif op_name == "interrupt":
        # SIGINT ourselves to interrupt the running cell
        try:
            os.kill(os.getpid(), signal.SIGINT)
        except OSError:
            pass

    elif op_name == "snapshot_names":
        names = _snapshot_names()
        _emit({"type": "result", "id": op_id, "names": names})

    elif op_name == "snapshot_write":
        path = op.get("path", "")
        manifest_path = op.get("manifestPath", "")
        max_bytes = op.get("maxBytes", 256 * 1024 * 1024)
        try:
            result = _snapshot_write(path, manifest_path, max_bytes)
            _emit({
                "type": "result",
                "id": op_id,
                "bytes": result["bytes"],
                "uncompressedBytes": result.get("uncompressedBytes", result["bytes"]),
                "compressedBytes": result.get("compressedBytes", result["bytes"]),
                "compression": result.get("compression", "raw"),
                "compressionRatio": result.get("compressionRatio", 0.0),
                "compressionDurationMs": result.get("compressionDurationMs", 0.0),
                "skipped": result["skipped"],
            })
        except Exception as exc:
            _emit({
                "type": "error",
                "id": op_id,
                "errorEname": type(exc).__name__,
                "data": str(exc),
            })

    elif op_name == "snapshot_restore":
        path = op.get("path", "")
        manifest_path = op.get("manifestPath", "")
        result = _snapshot_restore(path, manifest_path)
        _emit({
            "type": "result",
            "id": op_id,
            "restoredNames": result["restoredNames"],
        })

    elif op_name == "bootstrap":
        try:
            _bootstrap()
            _emit({"type": "result", "id": op_id})
        except Exception as exc:
            _emit({
                "type": "error",
                "id": op_id,
                "errorEname": type(exc).__name__,
                "data": str(exc),
            })

    elif op_name == "shutdown":
        sys.exit(0)

    else:
        _emit({
            "type": "error",
            "id": op_id,
            "errorEname": "UnknownOp",
            "data": f"unknown op: {op_name}",
        })


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def main() -> None:
    # Emit ready frame immediately
    _emit({
        "type": "ready",
        "protocol": 1,
        "pythonVersion": sys.version.split()[0],
    })

    _install_interrupt_handler()

    # Ensure shell is initialized
    _ensure_shell()

    # Read op lines from stdin. The loop is re-entered after an idle SIGINT
    # (an interrupt delivered while no cell is executing) so the runner stays
    # alive; a SIGINT that lands mid-cell is caught inside _execute_cell and
    # settles that cell as an interrupted error instead.
    while True:
        try:
            for line in sys.__stdin__:
                line = line.strip()
                if not line:
                    continue
                try:
                    op = json.loads(line)
                except json.JSONDecodeError as exc:
                    _emit({
                        "type": "error",
                        "id": "",
                        "errorEname": "ProtocolError",
                        "data": f"invalid JSON: {exc}",
                    })
                    continue

                try:
                    _handle_op(op)
                except SystemExit:
                    raise
                except BaseException as exc:
                    _emit({
                        "type": "error",
                        "id": op.get("id", ""),
                        "errorEname": type(exc).__name__,
                        "data": str(exc),
                    })
            break  # stdin closed (EOF)
        except KeyboardInterrupt:
            # Idle SIGINT with no cell in flight: absorb and keep serving.
            continue


if __name__ == "__main__":
    main()
