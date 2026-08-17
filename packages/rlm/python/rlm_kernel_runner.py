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
                if result.error_in_exec is not None:
                    exc = result.error_in_exec
                    code_val = 1
                    error_ename = type(exc).__name__
                    tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
                    traceback_str = "".join(tb_lines)
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


def _install_interrupt_handler() -> None:
    """Install SIGINT handler that interrupts the running cell."""
    def handler(signum: int, frame: Any) -> None:
        _interrupt_event.set()
        # Also raise KeyboardInterrupt in the main thread
        raise KeyboardInterrupt("Execution interrupted by host")

    try:
        signal.signal(signal.SIGINT, handler)
    except (OSError, ValueError):
        pass


# ---------------------------------------------------------------------------
# Snapshot operations
# ---------------------------------------------------------------------------


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
    """Per-variable dill.dumps with atomic write and manifest."""
    import dill

    dill.settings["recurse"] = True

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

    # Atomic write: temp file in same directory, then os.replace
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp_path = path + ".tmp"
    try:
        with open(tmp_path, "wb") as fh:
            dill.dump(payload, fh)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise

    bytes_written = os.path.getsize(path)
    saved = sorted(payload.keys())

    manifest = {
        "version": 1,
        "savedNames": saved,
        "skipped": skipped,
        "bytes": bytes_written,
        "pythonVersion": sys.version.split()[0],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    try:
        with open(manifest_path, "w") as fh:
            json.dump(manifest, fh)
    except Exception:
        pass

    return {"bytes": bytes_written, "skipped": skipped}


def _snapshot_restore(path: str, manifest_path: str) -> dict:
    """Load the payload and inject names into user_ns."""
    import dill

    if not os.path.exists(path):
        return {"restoredNames": []}

    try:
        with open(path, "rb") as fh:
            payload = dill.load(fh)
    except Exception:
        return {"restoredNames": []}

    if not isinstance(payload, dict):
        return {"restoredNames": []}

    ns = _get_ns()
    restored = []
    for name, blob in payload.items():
        try:
            ns[name] = dill.loads(blob)
            restored.append(name)
        except Exception:
            pass

    return {"restoredNames": sorted(restored)}


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

    # Read op lines from stdin
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


if __name__ == "__main__":
    main()
