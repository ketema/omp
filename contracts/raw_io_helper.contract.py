"""
Raw-I/O Helper Contract - specification authority (Python meta-validator surface).

Authoritative Contract for SLICE-4 (REQ-L15586-05, REQ-L15586-31, REQ-L15586-08,
REQ-L15586-28; negative constraints INV-L15586-01, INV-L15586-02, INV-L15586-03,
INV-L15586-04, INV-L15586-12, INV-L15586-13; sequence SEQ-2, SEQ-5, SEQ-6;
integration points IP-2).

Target implementation language: TypeScript (Bun) in packages/coding-agent.
This Python twin is the specification-verification authority required by
check_runtime_enforceable.py; the TypeScript runtime contract in
contracts/raw_io_helper.contract.ts mirrors every artifact class and clause ID.
"""

from dataclasses import dataclass
from typing import Final, Literal

# ==============================================================================
# Artifact 1: Exported Constants
# ==============================================================================

SQLITE_HEADER_MAGIC: Final[bytes] = b"SQLite format 3\x00"
SQLITE_SIDECAR_SUFFIXES: Final[tuple[str, ...]] = ("-wal", "-shm", "-journal")
SQLITE_FAMILY_CLASSIFICATIONS: Final[tuple[str, ...]] = (
    "sqlite_db",
    "sqlite_sidecar",
    "non_sqlite",
    "missing",
    "directory",
    "special",
)
SQLITE_FAMILY_ACTIVE_KINDS: Final[frozenset[str]] = frozenset(
    {"sqlite_db", "sqlite_sidecar"}
)
VALID_ENTRY_KINDS: Final[tuple[str, ...]] = (
    "file",
    "missing",
    "directory",
    "special",
)
VALID_TOOL_NAMES: Final[tuple[str, ...]] = ("read", "write")
VALID_ACCESS_CHANNELS: Final[tuple[str, ...]] = (
    "raw_io_helper",
    "sqlite_connection",
    "in_process",
)
VALID_HELPER_OPERATIONS: Final[tuple[str, ...]] = ("classify", "read", "write")
VALID_QUEUED_TIMEOUT_ACTIONS: Final[tuple[str, ...]] = (
    "none",
    "retry_on_fresh_helper",
    "fail_queued_helper_not_stopped",
)
VALID_FAILURE_KINDS: Final[tuple[str, ...]] = (
    "none",
    "per_request_error",
    "helper_crash",
    "timeout",
)
RAW_IO_WORKER_ARG: Final[str] = "__omp_worker_raw_io"
RAW_IO_WORKER_SELECTORS_MODULE: Final[str] = (
    "@oh-my-pi/pi-coding-agent/cli/worker-selectors"
)
RAW_IO_CLIENT_MODULE: Final[str] = "@oh-my-pi/pi-coding-agent/tools/raw-io-client"
RAW_IO_CLASSIFY_FN_NAME: Final[str] = "classifyRawIoTarget"
RAW_IO_READ_BYTES_FN_NAME: Final[str] = "readRawIoBytes"
RAW_IO_WRITE_BYTES_FN_NAME: Final[str] = "writeRawIoBytes"
RAW_IO_STOP_FN_NAME: Final[str] = "stopRawIoHelper"
RAW_IO_RESOLVE_KILL_WAIT_FN_NAME: Final[str] = "resolveTimeoutAfterKillWait"
RAW_IO_SETTLE_KILL_WAIT_FN_NAME: Final[str] = "settleRawIoTimeoutAfterKillWait"
RAW_IO_REGISTER_UNEXITED_WRITE_FN_NAME: Final[str] = "registerUnexitedWriteTarget"
RAW_IO_DEFAULT_TIMEOUT_MS: Final[int] = 5000
RAW_IO_KILL_WAIT_TIMEOUT_MS: Final[int] = 5000
RAW_IO_PROGRESS_CHUNK_BYTES: Final[int] = 65536
type ClassificationKind = Literal[
    "sqlite_db",
    "sqlite_sidecar",
    "non_sqlite",
    "missing",
    "directory",
    "special",
]
type EntryKind = Literal["file", "missing", "directory", "special"]
type ToolName = Literal["read", "write"]
type AccessChannel = Literal["raw_io_helper", "sqlite_connection", "in_process"]
type HelperOperation = Literal["classify", "read", "write"]
type QueuedTimeoutAction = Literal[
    "none",
    "retry_on_fresh_helper",
    "fail_queued_helper_not_stopped",
]
type FailureKind = Literal["none", "per_request_error", "helper_crash", "timeout"]
# ==============================================================================
# Artifact 2: Exception Hierarchy
# ==============================================================================


class RawIoHelperContractError(Exception):
    """Base exception for Raw-I/O Helper contract violations."""

    clause_id: str

    def __init__(self, clause_id: str, message: str) -> None:
        super().__init__(f"{clause_id} violation: {message}")
        self.clause_id = clause_id


class RawIoInvalidTargetPathError(RawIoHelperContractError):
    """Raised when target_path is not a non-empty POSIX absolute path (PRE-RAWIO-1)."""

    def __init__(self, target_path: object) -> None:
        msg = (
            "target_path must be a non-empty POSIX absolute path starting "
            f"with '/': got {target_path!r}"
        )
        super().__init__("PRE-RAWIO-1", msg)


class RawIoClassificationMismatchError(RawIoHelperContractError):
    """Raised when classification or failure text violates contract clauses."""

    def __init__(self, clause_id: str, message: str) -> None:
        super().__init__(clause_id, message)


class RawIoHelperUnavailableError(RawIoHelperContractError):
    """Raised when the Raw-I/O Helper fails, crashes, or times out (ERRORS-RAWIO-1)."""

    operation: str
    target_path: str

    def __init__(self, operation: str, target_path: str, reason: str) -> None:
        self.operation = operation
        self.target_path = target_path
        super().__init__(
            "ERRORS-RAWIO-1",
            f"Raw-I/O Helper failed during {operation} for '{target_path}': {reason}",
        )


# ==============================================================================
# Artifact 3: Frozen Dataclasses (Typed Records)
# ==============================================================================


@dataclass(slots=True, frozen=True)
class RawIoTargetClassification:
    """Result returned by the out-of-process Raw-I/O Helper target classifier."""

    target_path: str
    resolved_path: str
    kind: ClassificationKind
    is_sqlite_family: bool
    helper_pid: int
    header_bytes: bytes = b""
    entry_kind: EntryKind = "file"


@dataclass(slots=True, frozen=True)
class RawIoClassifyOptionsSpec:
    """Validated options for classifyRawIoTarget / readRawIoBytes / writeRawIoBytes."""

    helper_spawn_cmd: tuple[str, ...] | None = None
    timeout_ms: int = RAW_IO_DEFAULT_TIMEOUT_MS


@dataclass(slots=True, frozen=True)
class RawIoToolAccessRecord:
    """Validated record of a ReadTool or WriteTool target access decision."""

    tool_name: ToolName
    classification: RawIoTargetClassification
    access_channel: AccessChannel
    classified_before_open: bool


@dataclass(slots=True, frozen=True)
class RawIoHelperRequestEntry:
    """Single request observed by or sent to the Raw-I/O Helper."""

    operation: HelperOperation
    target_path: str


@dataclass(slots=True, frozen=True)
class RawIoTimeoutEvaluation:
    """Validated timeout/failure evaluation for a Raw-I/O Helper request."""

    operation: HelperOperation
    timeout_ms: int
    queued_wait_ms: int
    started_received: bool
    elapsed_before_start_ms: int
    elapsed_since_start_ms: int
    elapsed_since_progress_ms: int
    timed_out: bool
    helper_killed: bool
    queued_requests_count: int = 0
    queued_action: QueuedTimeoutAction = "none"
    failure_kind: FailureKind = "none"
    kill_wait_elapsed_ms: int = 0
    helper_exited_within_kill_wait: bool = True


@dataclass(slots=True, frozen=True)
class RawIoKillWaitResolution:
    """Validated result of resolveTimeoutAfterKillWait (POST-RAWIO-2b / 1b / 1c)."""

    active_error: str
    retry_queue_on_fresh_helper: bool
    queued_errors: tuple[str, ...]
    block_future_writes_to_target: str | None = None


@dataclass(slots=True, frozen=True)
class Clause:
    """Single behavioral contract clause with verification method and citation."""

    verification: Literal["test", "execution", "tool"]
    text: str


# ==============================================================================
# Artifact 4: Pure Validators
# ==============================================================================


def validate_target_path(target_path: object) -> str:
    """PRE-RAWIO-1: target_path is a non-empty POSIX absolute path starting with '/'."""
    if not isinstance(target_path, str):
        raise RawIoInvalidTargetPathError(target_path)
    if not target_path or not target_path.startswith("/"):
        raise RawIoInvalidTargetPathError(target_path)
    return target_path


def validate_classify_options(options: object) -> RawIoClassifyOptionsSpec:
    """POST-RAWIO-2b / ERRORS-RAWIO-1: validate helperSpawnCommand.cmd and timeoutMs."""
    if options is None:
        return RawIoClassifyOptionsSpec()
    if not isinstance(options, dict):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            f"options must be a mapping or None; got {type(options).__name__}",
        )
    timeout_raw = options.get("timeoutMs", RAW_IO_DEFAULT_TIMEOUT_MS)
    if (
        not isinstance(timeout_raw, int)
        or isinstance(timeout_raw, bool)
        or timeout_raw <= 0
    ):
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1b",
            f"timeoutMs must be a positive integer (> 0); got {timeout_raw!r}",
        )
    spawn = options.get("helperSpawnCommand")
    if spawn is None:
        return RawIoClassifyOptionsSpec(timeout_ms=timeout_raw)
    if not isinstance(spawn, dict):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            f"helperSpawnCommand must be a mapping; got {type(spawn).__name__}",
        )
    cmd = spawn.get("cmd")
    if (
        not isinstance(cmd, (list, tuple))
        or len(cmd) == 0
        or not all(isinstance(part, str) and bool(part.strip()) for part in cmd)
    ):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            "helperSpawnCommand.cmd must be a non-empty sequence of non-empty strings",
        )
    return RawIoClassifyOptionsSpec(
        helper_spawn_cmd=tuple(cmd),
        timeout_ms=timeout_raw,
    )


def classify_resolved_target_pure(
    target_path: object,
    resolved_path: object,
    header_bytes: object,
    helper_pid: object,
    parent_pid: int,
    *,
    entry_kind: object = "file",
) -> RawIoTargetClassification:
    """POST-RAWIO-1 / FORBIDDEN-RAWIO-2: pure classification validator."""
    valid_target = validate_target_path(target_path)
    valid_resolved = validate_target_path(resolved_path)
    if (
        not isinstance(helper_pid, int)
        or isinstance(helper_pid, bool)
        or helper_pid <= 0
        or helper_pid == parent_pid
    ):
        raise RawIoClassificationMismatchError(
            "FORBIDDEN-RAWIO-2",
            (
                f"helper_pid ({helper_pid!r}) must be a positive OS PID "
                f"distinct from omp parent_pid ({parent_pid})"
            ),
        )
    if not isinstance(entry_kind, str) or entry_kind not in VALID_ENTRY_KINDS:
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-1",
            f"entry_kind must be one of {VALID_ENTRY_KINDS!r}; got {entry_kind!r}",
        )
    if entry_kind == "missing":
        return RawIoTargetClassification(
            target_path=valid_target,
            resolved_path=valid_resolved,
            kind="missing",
            is_sqlite_family=False,
            helper_pid=helper_pid,
            header_bytes=b"",
            entry_kind="missing",
        )
    if entry_kind == "directory":
        return RawIoTargetClassification(
            target_path=valid_target,
            resolved_path=valid_resolved,
            kind="directory",
            is_sqlite_family=False,
            helper_pid=helper_pid,
            header_bytes=b"",
            entry_kind="directory",
        )
    if entry_kind == "special":
        return RawIoTargetClassification(
            target_path=valid_target,
            resolved_path=valid_resolved,
            kind="special",
            is_sqlite_family=False,
            helper_pid=helper_pid,
            header_bytes=b"",
            entry_kind="special",
        )
    if not isinstance(header_bytes, (bytes, bytearray)):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-1",
            (
                "header_bytes must be bytes for regular files; "
                f"got {type(header_bytes).__name__}"
            ),
        )
    raw_header = bytes(header_bytes)
    magic_len = len(SQLITE_HEADER_MAGIC)
    if any(valid_resolved.endswith(suffix) for suffix in SQLITE_SIDECAR_SUFFIXES):
        kind: ClassificationKind = "sqlite_sidecar"
    elif len(raw_header) >= magic_len and raw_header[:magic_len] == SQLITE_HEADER_MAGIC:
        kind = "sqlite_db"
    else:
        kind = "non_sqlite"
    return RawIoTargetClassification(
        target_path=valid_target,
        resolved_path=valid_resolved,
        kind=kind,
        is_sqlite_family=kind in SQLITE_FAMILY_ACTIVE_KINDS,
        helper_pid=helper_pid,
        header_bytes=raw_header[:magic_len],
        entry_kind="file",
    )


def validate_helper_failure_error(
    error_message: object,
    expected_operation: str,
    expected_path: str,
    *,
    timed_out: bool = False,
    helper_still_alive_after_kill: bool = False,
    queued_behind_unstopped_helper: bool = False,
    unexited_write_target_refusal: bool = False,
) -> str:
    """ERRORS-RAWIO-1 / 1b / 1c / 1d error message validator."""
    clause_id = (
        "ERRORS-RAWIO-1d"
        if unexited_write_target_refusal
        else "ERRORS-RAWIO-1c"
        if helper_still_alive_after_kill or queued_behind_unstopped_helper
        else "ERRORS-RAWIO-1b"
        if timed_out
        else "ERRORS-RAWIO-1"
    )
    if not isinstance(error_message, str) or not error_message.strip():
        raise RawIoClassificationMismatchError(
            clause_id,
            (
                "error message must be a non-empty string naming operation "
                f"{expected_operation!r} and path {expected_path!r}"
            ),
        )
    if expected_operation not in error_message or expected_path not in error_message:
        raise RawIoClassificationMismatchError(
            clause_id,
            (
                f"error message {error_message!r} must include operation "
                f"{expected_operation!r} and target path {expected_path!r}"
            ),
        )
    lower = error_message.lower()
    if unexited_write_target_refusal and (
        "still alive" not in lower
        or "fix the mount" not in lower
        or "restart omp" not in lower
    ):
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1d",
            (
                f"unexited-write refusal {error_message!r} must state that "
                "the previous helper is still alive and to fix the mount "
                "or restart omp"
            ),
        )
    if queued_behind_unstopped_helper and "could not be stopped" not in lower:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1c",
            (
                f"queued-request error {error_message!r} when previous helper "
                "did not exit within RAW_IO_KILL_WAIT_TIMEOUT_MS must state "
                "that the previous helper could not be stopped"
            ),
        )
    if timed_out or helper_still_alive_after_kill:
        if "timed out" not in lower and "timeout" not in lower:
            raise RawIoClassificationMismatchError(
                clause_id,
                f"timed-out error message {error_message!r} must indicate a timeout",
            )
        if expected_operation == "write":
            if "outcome is unknown" not in lower and "outcome unknown" not in lower:
                raise RawIoClassificationMismatchError(
                    clause_id,
                    (
                        f"timed-out write error {error_message!r} must state that "
                        "the write outcome is unknown"
                    ),
                )
            if helper_still_alive_after_kill and "may still land" not in lower:
                raise RawIoClassificationMismatchError(
                    "ERRORS-RAWIO-1c",
                    (
                        f"timed-out write error {error_message!r} when helper "
                        "did not exit within RAW_IO_KILL_WAIT_TIMEOUT_MS must "
                        "state that the write may still land"
                    ),
                )
    return error_message


def _compute_expected_queued_action(
    *,
    timed_out: bool,
    helper_exited: bool,
    resolved_failure_kind: FailureKind,
    queued_requests_count: int,
) -> QueuedTimeoutAction:
    """Compute the expected queued action for ERRORS-RAWIO-1 / 1b / 1c."""
    if queued_requests_count == 0:
        return "none"
    if timed_out and not helper_exited:
        return "fail_queued_helper_not_stopped"
    if timed_out or resolved_failure_kind in ("helper_crash", "timeout"):
        return "retry_on_fresh_helper"
    return "none"


def evaluate_timeout_semantics(
    operation: object,
    timeout_ms: object,
    *,
    queued_wait_ms: object = 0,
    started_received: object = True,
    elapsed_before_start_ms: object = 0,
    elapsed_since_start_ms: object,
    elapsed_since_progress_ms: object,
    helper_killed: object,
    queued_requests_count: object = 0,
    queued_action: object = None,
    failure_kind: object = None,
    kill_wait_elapsed_ms: object = 0,
) -> RawIoTimeoutEvaluation:
    """POST-RAWIO-2b / ERRORS-RAWIO-1 / ERRORS-RAWIO-1b / ERRORS-RAWIO-1c validator."""
    if not isinstance(operation, str) or operation not in VALID_HELPER_OPERATIONS:
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            f"operation must be one of {VALID_HELPER_OPERATIONS!r}; got {operation!r}",
        )
    if (
        not isinstance(timeout_ms, int)
        or isinstance(timeout_ms, bool)
        or timeout_ms <= 0
    ):
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1b",
            f"timeout_ms must be a positive integer (> 0); got {timeout_ms!r}",
        )
    if not isinstance(started_received, bool):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            f"started_received must be a bool; got {started_received!r}",
        )
    if (
        not isinstance(queued_wait_ms, int)
        or isinstance(queued_wait_ms, bool)
        or queued_wait_ms < 0
        or not isinstance(elapsed_before_start_ms, int)
        or isinstance(elapsed_before_start_ms, bool)
        or elapsed_before_start_ms < 0
        or not isinstance(elapsed_since_start_ms, int)
        or isinstance(elapsed_since_start_ms, bool)
        or elapsed_since_start_ms < 0
        or not isinstance(elapsed_since_progress_ms, int)
        or isinstance(elapsed_since_progress_ms, bool)
        or elapsed_since_progress_ms < 0
        or not isinstance(queued_requests_count, int)
        or isinstance(queued_requests_count, bool)
        or queued_requests_count < 0
        or not isinstance(kill_wait_elapsed_ms, int)
        or isinstance(kill_wait_elapsed_ms, bool)
        or kill_wait_elapsed_ms < 0
    ):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            "elapsed and queue counts must be non-negative integers",
        )
    if not isinstance(helper_killed, bool):
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1b",
            f"helper_killed must be a bool; got {helper_killed!r}",
        )
    typed_op: HelperOperation = (
        "classify"
        if operation == "classify"
        else "read"
        if operation == "read"
        else "write"
    )
    if not started_received:
        timed_out = elapsed_before_start_ms >= timeout_ms
    elif typed_op == "classify":
        timed_out = elapsed_since_start_ms >= timeout_ms
    else:
        timed_out = elapsed_since_progress_ms >= timeout_ms
    raw_failure = (
        ("timeout" if timed_out else "none") if failure_kind is None else failure_kind
    )
    if not isinstance(raw_failure, str) or raw_failure not in VALID_FAILURE_KINDS:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1",
            (
                f"failure_kind must be one of {VALID_FAILURE_KINDS!r}; "
                f"got {failure_kind!r}"
            ),
        )
    resolved_failure_kind: FailureKind = (
        "per_request_error"
        if raw_failure == "per_request_error"
        else "helper_crash"
        if raw_failure == "helper_crash"
        else "timeout"
        if raw_failure == "timeout"
        else "none"
    )
    if resolved_failure_kind == "per_request_error" and helper_killed:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1",
            "a per-request error from a live helper must not kill the helper",
        )
    if (timed_out or resolved_failure_kind == "timeout") and not helper_killed:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1b",
            "omp must kill the helper subprocess when a request times out",
        )
    helper_exited = (not timed_out) or (
        kill_wait_elapsed_ms < RAW_IO_KILL_WAIT_TIMEOUT_MS
    )
    expected_queued_action = _compute_expected_queued_action(
        timed_out=timed_out,
        helper_exited=helper_exited,
        resolved_failure_kind=resolved_failure_kind,
        queued_requests_count=queued_requests_count,
    )
    resolved_queued_action = (
        expected_queued_action if queued_action is None else queued_action
    )
    if (
        not isinstance(resolved_queued_action, str)
        or resolved_queued_action not in VALID_QUEUED_TIMEOUT_ACTIONS
        or resolved_queued_action != expected_queued_action
    ):
        clause_for_queue = (
            "ERRORS-RAWIO-1"
            if resolved_failure_kind == "per_request_error"
            else "ERRORS-RAWIO-1c"
            if timed_out and not helper_exited
            else "ERRORS-RAWIO-1b"
        )
        raise RawIoClassificationMismatchError(
            clause_for_queue,
            (
                f"queued_action must be {expected_queued_action!r} when "
                f"failure_kind={resolved_failure_kind!r}, timed_out={timed_out}, "
                f"helper_exited={helper_exited}, and queued_requests_count="
                f"{queued_requests_count}; got {queued_action!r}"
            ),
        )
    return RawIoTimeoutEvaluation(
        operation=typed_op,
        timeout_ms=timeout_ms,
        queued_wait_ms=queued_wait_ms,
        started_received=started_received,
        elapsed_before_start_ms=elapsed_before_start_ms,
        elapsed_since_start_ms=elapsed_since_start_ms,
        elapsed_since_progress_ms=elapsed_since_progress_ms,
        timed_out=timed_out,
        helper_killed=helper_killed,
        queued_requests_count=queued_requests_count,
        queued_action=expected_queued_action,
        failure_kind=resolved_failure_kind,
        kill_wait_elapsed_ms=kill_wait_elapsed_ms,
        helper_exited_within_kill_wait=helper_exited,
    )


def validate_tool_access_route(
    tool_name: object,
    classification: RawIoTargetClassification,
    access_channel: object,
    *,
    classified_before_open: object,
) -> RawIoToolAccessRecord:
    """POST-RAWIO-3 / POST-RAWIO-3b / POST-RAWIO-3c / FORBIDDEN-RAWIO-3 validator."""
    if not isinstance(tool_name, str) or tool_name not in VALID_TOOL_NAMES:
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-3",
            f"tool_name must be one of {VALID_TOOL_NAMES!r}; got {tool_name!r}",
        )
    clause_id = "POST-RAWIO-3" if tool_name == "read" else "POST-RAWIO-3b"
    if classified_before_open is not True:
        raise RawIoClassificationMismatchError(
            clause_id,
            f"{tool_name} tool must classify target via Raw-I/O Helper before any open",
        )
    if (
        not isinstance(access_channel, str)
        or access_channel not in VALID_ACCESS_CHANNELS
    ):
        raise RawIoClassificationMismatchError(
            clause_id,
            (
                f"access_channel must be one of {VALID_ACCESS_CHANNELS!r}; "
                f"got {access_channel!r}"
            ),
        )
    if classification.is_sqlite_family:
        if access_channel == "in_process":
            raise RawIoClassificationMismatchError(
                "FORBIDDEN-RAWIO-3",
                (
                    f"{tool_name} tool accessed SQLite-Family target "
                    f"'{classification.resolved_path}' in-process"
                ),
            )
    elif classification.kind == "non_sqlite" and access_channel != "in_process":
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-3c",
            (
                f"{tool_name} tool must keep non_sqlite target "
                f"'{classification.resolved_path}' on the in_process fast path; "
                f"got {access_channel!r}"
            ),
        )
    typed_tool: ToolName = "read" if tool_name == "read" else "write"
    typed_channel: AccessChannel = (
        "raw_io_helper"
        if access_channel == "raw_io_helper"
        else "sqlite_connection"
        if access_channel == "sqlite_connection"
        else "in_process"
    )
    return RawIoToolAccessRecord(
        tool_name=typed_tool,
        classification=classification,
        access_channel=typed_channel,
        classified_before_open=True,
    )


def validate_non_sqlite_helper_log(
    entries: object,
    non_sqlite_path: object,
) -> tuple[RawIoHelperRequestEntry, ...]:
    """POST-RAWIO-3c: helper sees classify and zero read/write for non_sqlite."""
    valid_path = validate_target_path(non_sqlite_path)
    if not isinstance(entries, (list, tuple)):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-3c",
            f"entries must be a sequence; got {type(entries).__name__}",
        )
    validated: list[RawIoHelperRequestEntry] = []
    saw_classify = False
    for item in entries:
        if isinstance(item, RawIoHelperRequestEntry):
            op: object = item.operation
            path_val: object = item.target_path
        elif isinstance(item, dict):
            op = item.get("operation")
            path_val = item.get("targetPath", item.get("target_path"))
        else:
            raise RawIoClassificationMismatchError(
                "POST-RAWIO-3c",
                f"log entry must be a mapping or RawIoHelperRequestEntry; got {item!r}",
            )
        if not isinstance(op, str) or op not in VALID_HELPER_OPERATIONS:
            raise RawIoClassificationMismatchError(
                "POST-RAWIO-3c",
                f"operation must be one of {VALID_HELPER_OPERATIONS!r}; got {op!r}",
            )
        valid_entry_path = validate_target_path(path_val)
        typed_op: HelperOperation = (
            "classify" if op == "classify" else "read" if op == "read" else "write"
        )
        if valid_entry_path == valid_path:
            if typed_op == "classify":
                saw_classify = True
            else:
                raise RawIoClassificationMismatchError(
                    "POST-RAWIO-3c",
                    (
                        f"non_sqlite target '{valid_path}' must not send "
                        f"'{typed_op}' byte requests to the Raw-I/O Helper"
                    ),
                )
        validated.append(
            RawIoHelperRequestEntry(
                operation=typed_op,
                target_path=valid_entry_path,
            )
        )
    if not saw_classify:
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-3c",
            (
                f"expected at least one 'classify' request for non_sqlite "
                f"target '{valid_path}'"
            ),
        )
    return tuple(validated)


def validate_sqlite_family_helper_log(
    entries: object,
    sqlite_family_path: object,
    *,
    expected_operations: tuple[HelperOperation, ...] = ("classify", "read", "write"),
) -> tuple[RawIoHelperRequestEntry, ...]:
    """POST-RAWIO-3 / POST-RAWIO-3b: helper log records classify/read/write."""
    valid_path = validate_target_path(sqlite_family_path)
    if not isinstance(entries, (list, tuple)):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-3",
            f"entries must be a sequence; got {type(entries).__name__}",
        )
    validated: list[RawIoHelperRequestEntry] = []
    seen_ops: set[HelperOperation] = set()
    for item in entries:
        if isinstance(item, RawIoHelperRequestEntry):
            op: object = item.operation
            path_val: object = item.target_path
        elif isinstance(item, dict):
            op = item.get("operation")
            path_val = item.get("targetPath", item.get("target_path"))
        else:
            raise RawIoClassificationMismatchError(
                "POST-RAWIO-3",
                f"log entry must be a mapping or RawIoHelperRequestEntry; got {item!r}",
            )
        if not isinstance(op, str) or op not in VALID_HELPER_OPERATIONS:
            raise RawIoClassificationMismatchError(
                "POST-RAWIO-3",
                f"operation must be one of {VALID_HELPER_OPERATIONS!r}; got {op!r}",
            )
        valid_entry_path = validate_target_path(path_val)
        typed_op: HelperOperation = (
            "classify" if op == "classify" else "read" if op == "read" else "write"
        )
        if valid_entry_path == valid_path:
            seen_ops.add(typed_op)
        validated.append(
            RawIoHelperRequestEntry(
                operation=typed_op,
                target_path=valid_entry_path,
            )
        )
    for req_op in expected_operations:
        if req_op not in seen_ops:
            clause_id = "POST-RAWIO-3b" if req_op == "write" else "POST-RAWIO-3"
            raise RawIoClassificationMismatchError(
                clause_id,
                (
                    f"expected '{req_op}' helper request for SQLite-Family "
                    f"target '{valid_path}'; seen={sorted(seen_ops)!r}"
                ),
            )
    return tuple(validated)


def validate_kill_wait_resolution(
    resolution: object,
    *,
    operation: HelperOperation,
    target_path: str,
    helper_exited: bool,
    queued_requests: tuple[RawIoHelperRequestEntry, ...],
) -> RawIoKillWaitResolution:
    """POST-RAWIO-2b / ERRORS-RAWIO-1b / ERRORS-RAWIO-1c kill-wait validator."""
    clause_id = "ERRORS-RAWIO-1b" if helper_exited else "ERRORS-RAWIO-1c"
    if not isinstance(resolution, dict):
        raise RawIoClassificationMismatchError(
            clause_id,
            f"resolution must be a mapping; got {type(resolution).__name__}",
        )
    active_err = validate_helper_failure_error(
        resolution.get("activeError"),
        operation,
        target_path,
        timed_out=True,
        helper_still_alive_after_kill=not helper_exited,
    )
    retry_flag = resolution.get("retryQueueOnFreshHelper")
    expected_retry = helper_exited and len(queued_requests) > 0
    if not isinstance(retry_flag, bool) or retry_flag != expected_retry:
        raise RawIoClassificationMismatchError(
            clause_id,
            (
                f"retryQueueOnFreshHelper must be {expected_retry} when "
                f"helper_exited={helper_exited} and len(queued_requests)="
                f"{len(queued_requests)}; got {retry_flag!r}"
            ),
        )
    raw_queued_errors = resolution.get("queuedErrors")
    if not isinstance(raw_queued_errors, (list, tuple)):
        raise RawIoClassificationMismatchError(
            clause_id,
            f"queuedErrors must be a sequence; got {type(raw_queued_errors).__name__}",
        )
    block_target = resolution.get("blockFutureWritesToTarget")
    expected_block = (
        target_path if (not helper_exited and operation == "write") else None
    )
    if block_target != expected_block:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1d",
            (
                f"blockFutureWritesToTarget must be {expected_block!r} when "
                f"helper_exited={helper_exited} and operation={operation!r}; "
                f"got {block_target!r}"
            ),
        )
    if helper_exited:
        if len(raw_queued_errors) != 0:
            raise RawIoClassificationMismatchError(
                "ERRORS-RAWIO-1b",
                (
                    "queuedErrors must be empty when helper_exited=True; "
                    f"got {raw_queued_errors!r}"
                ),
            )
        return RawIoKillWaitResolution(
            active_error=active_err,
            retry_queue_on_fresh_helper=expected_retry,
            queued_errors=(),
            block_future_writes_to_target=None,
        )
    if len(raw_queued_errors) != len(queued_requests):
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1c",
            (
                f"queuedErrors length ({len(raw_queued_errors)}) must equal "
                f"queued_requests length ({len(queued_requests)}) when "
                "helper_exited=False"
            ),
        )
    validated_queued: list[str] = []
    for q_req, q_err in zip(queued_requests, raw_queued_errors, strict=True):
        validated_queued.append(
            validate_helper_failure_error(
                q_err,
                q_req.operation,
                q_req.target_path,
                queued_behind_unstopped_helper=True,
            )
        )
    return RawIoKillWaitResolution(
        active_error=active_err,
        retry_queue_on_fresh_helper=False,
        queued_errors=tuple(validated_queued),
        block_future_writes_to_target=expected_block,
    )


# ==============================================================================
# Artifact 5: Traceability Registry
# ==============================================================================

RAW_IO_HELPER_CONTRACT: Final[dict[str, Clause]] = {
    "PRE-RAWIO-1": Clause(
        verification="test",
        text=(
            "Target path passed to the Raw-I/O Helper classifier is a non-empty "
            "POSIX absolute path starting with '/'. Source: REQ-L15586-05, IP-2."
        ),
    ),
    "POST-RAWIO-1": Clause(
        verification="test",
        text=(
            "The Raw-I/O Helper resolves the target path in a separate OS process "
            "and returns kind='missing', 'directory', or 'special' (with "
            "isSqliteFamily=false) when the resolved target is not an existing "
            "regular file, even if its path ends in -wal, -shm, or -journal; for "
            "an existing regular file, it classifies the target as 'sqlite_sidecar' "
            "when resolvedPath (not targetPath alone) ends in -wal, -shm, or "
            "-journal, 'sqlite_db' when its first 16 bytes equal "
            "'SQLite format 3\\x00', and 'non_sqlite' otherwise. "
            "Source: REQ-L15586-05, IP-2."
        ),
    ),
    "POST-RAWIO-1b": Clause(
        verification="test",
        text=(
            "Classifying a target through the Raw-I/O Helper closes no file "
            "descriptor inside the omp process and retains every POSIX advisory "
            "lock omp holds on SQLite database and sidecar inodes. "
            "Source: INV-L15586-01, REQ-L15586-05, REQ-L15586-28."
        ),
    ),
    "POST-RAWIO-2": Clause(
        verification="test",
        text=(
            "The worker-selector module "
            "(@oh-my-pi/pi-coding-agent/cli/worker-selectors) exports "
            "RAW_IO_WORKER_ARG ('__omp_worker_raw_io'), and omp's CLI entrypoint "
            "dispatches RAW_IO_WORKER_ARG to the Raw-I/O Helper worker. "
            "Source: REQ-L15586-05, SEQ-5, IP-2."
        ),
    ),
    "POST-RAWIO-2b": Clause(
        verification="test",
        text=(
            "The Raw-I/O client module (@oh-my-pi/pi-coding-agent/tools/raw-io-client) "
            "exports classifyRawIoTarget(targetPath, options?) -> "
            "Promise<RawIoTargetClassification>, readRawIoBytes(targetPath, offset?, "
            "length?, options?) -> Promise<Uint8Array>, writeRawIoBytes("
            "targetPath, data, options?) -> Promise<void>, "
            "resolveTimeoutAfterKillWait(input) -> {activeError, "
            "retryQueueOnFreshHelper, queuedErrors, blockFutureWritesToTarget}, "
            "and registerUnexitedWriteTarget(targetPath, exitPromise) -> void "
            "(which keys the blocked target by its resolved real path, falling back "
            "to targetPath on ENOENT/ENOTDIR, and lifts the block when exitPromise "
            "settles), where options.helperSpawnCommand is an optional "
            "spawn-command override, options.timeoutMs is an optional positive "
            "integer timeout bound defaulting to RAW_IO_DEFAULT_TIMEOUT_MS "
            "(5000ms), and options.onRequest is invoked exactly once for each "
            "request sent to the Raw-I/O Helper across every operation "
            "('classify', 'read', 'write') with that request's operation and "
            "targetPath; requests on a shared helper are dispatched strictly "
            "serially (a queued request is never sent to the helper before the "
            "active request settles and has no running timeout while waiting in "
            "the queue; a request queued behind a timed-out request is sent—and "
            "logged via onRequest—exactly once to the fresh helper only when the "
            "old helper is confirmed exited, as specified by ERRORS-RAWIO-1b; "
            "if the old helper has not exited within RAW_IO_KILL_WAIT_TIMEOUT_MS, "
            "ERRORS-RAWIO-1c takes precedence: queued requests fail without "
            "dispatch, retry, or an onRequest entry), the helper emits a "
            "{type: 'started', id} message when it "
            "begins the active request (which starts the fixed options.timeoutMs "
            "timer for 'classify' and the no-progress options.timeoutMs timer for "
            "'read' and 'write'), and for 'read' and 'write' the helper transfers "
            "in bounded chunks (RAW_IO_PROGRESS_CHUNK_BYTES = 65536) and emits "
            "{type: 'progress', id, bytesProcessed} after each chunk to reset the "
            "no-progress timer. "
            "Source: REQ-L15586-05, REQ-L15586-08, REQ-L15586-31, SEQ-2, SEQ-5, IP-2."
        ),
    ),
    "POST-RAWIO-2c": Clause(
        verification="test",
        text=(
            "The Raw-I/O client module (@oh-my-pi/pi-coding-agent/tools/raw-io-client) "
            "exports stopRawIoHelper() -> Promise<void> to terminate the helper "
            "subprocess. Source: SEQ-6, IP-2."
        ),
    ),
    "SEQ-RAWIO-1": Clause(
        verification="test",
        text=(
            "On the first ReadTool or WriteTool request requiring the Raw-I/O "
            "Helper, the Raw-I/O client SHALL start the helper as a child OS "
            "process from omp's own executable with RAW_IO_WORKER_ARG before "
            "serving that request; an explicitly supplied "
            "options.helperSpawnCommand remains the contracted spawn-command "
            "override. Source: REQ-L15586-05, SEQ-5, IP-2."
        ),
    ),
    "SEQ-RAWIO-2": Clause(
        verification="test",
        text=(
            "At omp process exit, omp SHALL invoke stopRawIoHelper after its "
            "last Raw-I/O request to terminate the helper subprocess. "
            "A one-shot CLI command that issues Raw-I/O requests (such as "
            "`omp read`) SHALL stop the helper before it returns, so the "
            "process can exit even when the helper child is held referenced "
            "(as under PI_TEST_RUNTIME=1). "
            "Source: SEQ-6, IP-2, CI run 41504561263."
        ),
    ),
    "SEQ-RAWIO-3": Clause(
        verification="test",
        text=(
            "When the Raw-I/O Helper's parent IPC pipe closes, the helper SHALL "
            "exit rather than remain as an orphan process. Source: SEQ-6, IP-2, "
            "manifest Raw-I/O Helper lifecycle cleanup."
        ),
    ),
    "POST-RAWIO-3": Clause(
        verification="test",
        text=(
            "When ReadTool receives a host file path, it forwards "
            "session.rawIoHelperOptions on every helper request, classifies the "
            "target out of process through the Raw-I/O Helper before any in-process "
            "file open, and accesses every SQLite-Family target (including -wal, "
            "-shm, and -journal sidecars) only through the Raw-I/O Helper "
            "(recording a 'read' entry in onRequest) or a SQLite connection "
            "(whose own connection close is permitted because SQLite retains .db "
            "and -shm locks across secondary connection closes), retaining every "
            "POSIX advisory lock SQLite holds on the database file and its -shm "
            "file, and every POSIX advisory lock omp holds on a SQLite-Family "
            "target that the tool accesses through the Raw-I/O Helper. "
            "ReadTool SHALL bound the bytes it holds in memory for a SQLite-Family "
            "target by SNAPSHOT_MAX_BYTES (4 MiB): a larger target is returned as "
            "the binary-file result when its bounded helper prefix is binary, and "
            "otherwise is paged through bounded Raw-I/O Helper range reads (the "
            "default first page and single line ranges; any other selector is "
            "refused with an error naming the 4 MiB limit), never read whole and "
            "never opened in-process. "
            "Speculative reads SHALL resolve their target without opening it and "
            "SHALL NOT read a SQLite-Family target in-process: a SQLite-Family "
            "target is refused as unsafe for speculation, so the read falls back "
            "to the ordinary helper-backed path. "
            "Source: REQ-L15586-05, REQ-L15586-31, SEQ-2, IP-2, INV-L15586-01, "
            "INV-L15586-04, Q-SLICE4-01."
        ),
    ),
    "POST-RAWIO-3b": Clause(
        verification="test",
        text=(
            "When WriteTool receives a host file path, it forwards "
            "session.rawIoHelperOptions on every helper request, classifies the "
            "target out of process through the Raw-I/O Helper before any in-process "
            "file open, and accesses every SQLite-Family target (including -wal, "
            "-shm, and -journal sidecars) only through the Raw-I/O Helper "
            "(recording a 'write' entry in onRequest) or a SQLite connection "
            "(whose own connection close is permitted because SQLite retains .db "
            "and -shm locks across secondary connection closes), retaining every "
            "POSIX advisory lock SQLite holds on the database file and its -shm "
            "file, and every POSIX advisory lock omp holds on a SQLite-Family "
            "target that the tool accesses through the Raw-I/O Helper. "
            "WriteTool SHALL recheck cancellation after classifying a "
            "SQLite-Family target and before dispatching the write to the Raw-I/O "
            "Helper, so a cancelled call never mutates the target. "
            "Source: REQ-L15586-05, REQ-L15586-31, SEQ-2, IP-2, INV-L15586-01, "
            "INV-L15586-04, Q-SLICE4-01."
        ),
    ),
    "POST-RAWIO-3c": Clause(
        verification="test",
        text=(
            "When a host file is classified as 'non_sqlite', ReadTool and WriteTool "
            "forward session.rawIoHelperOptions and access that ordinary file on the "
            "in-process fast path so the same onRequest hook that records 'read' and "
            "'write' entries for SQLite-Family helper targets records a 'classify' "
            "request and zero 'read' or 'write' byte requests for the 'non_sqlite' "
            "path. Source: REQ-L15586-31, SEQ-2, IP-2."
        ),
    ),
    "POST-RAWIO-4": Clause(
        verification="test",
        text=("When InternalUrlFilesystem.readPrefix reads a non-virtual node (a host file path or a file-backed internal URL), it forwards context.session?.rawIoHelperOptions and reads the first maxBytes bytes at offset 0 through the Raw-I/O Helper (readRawIoBytes) without opening the file in the omp process, retaining every POSIX advisory lock SQLite holds on a database file and its -shm file and every POSIX advisory lock omp holds on the target; virtual nodes continue to slice their in-memory bytes, and any Raw-I/O Helper failure rejects with a UrlFsError whose message names the failed 'read' operation and resolved target path without falling back to an in-process file open. Source: REQ-L15586-06, REQ-L15586-08, INV-L15586-01, INV-L15586-03."),
    ),
    "POST-RAWIO-5": Clause(
        verification="test",
        text=("When the embedded shell (pi-shell VfsFs::open, sys::pump, or brush Shell::open_file) or a shell builtin opens, reads, or writes a host file through pi-vfs Route::Native (native_open, Fs::read, Fs::write, BlockingFs::read, BlockingFs::write, or native::copy), pi-vfs SHALL execute that open, read, write, metadata, truncation, sync, and close inside the long-lived Raw-I/O Helper child process (started lazily on first request from omp's executable with RAW_IO_WORKER_ARG and stopped at process exit) over anonymous OS byte pipes without opening or receiving any file descriptor for that target inside the omp process, retaining every POSIX advisory lock SQLite holds on a database file and its -shm file and every POSIX advisory lock omp holds on the target; external-command redirects on the resulting handle stream through dedicated OS pump threads over anonymous pipes (with O_CREAT, O_TRUNC, and O_APPEND applied in the helper at open_file time) so payloads larger than the OS pipe buffer do not deadlock; and if the helper cannot start or fails, pi-vfs SHALL return an io::Error naming the failed operation and target path without falling back to an in-process file open. Source: REQ-L15586-07, REQ-L15586-08, SEQ-4, SEQ-5, SEQ-6, IP-4, INV-L15586-01, INV-L15586-03, INV-L15586-04, INV-L15586-12."),
    ),
    "POST-RAWIO-6": Clause(
        verification="test",
        text=("When native Rust grep (crates/pi-walker/src/grep/run.rs or crates/pi-natives/src/grep.rs) reads candidate file contents or prefixes, when pi-walker (crates/pi-walker/src/lib.rs) reads .gitignore, .ignore, .git/info/exclude, or global git excludes/config files, or when GrepTool.execute (packages/coding-agent/src/tools/grep.ts) records snapshot tags for matched files, those reads SHALL execute in the Raw-I/O Helper child process (via pi-vfs Route::Native over anonymous byte pipes for Rust grep/pi-walker and via readRawIoBytes + EditStore.recordSnapshot forwarding session.rawIoHelperOptions for GrepTool snapshot tags) without opening or receiving any file descriptor for those targets inside the omp process, retaining every POSIX advisory lock SQLite holds on a database file and its -shm file and every POSIX advisory lock omp holds on the target; and if the Raw-I/O Helper cannot start or fails, grep, pi-walker, and GrepTool SHALL surface an error naming the failed operation and target path without falling back to an in-process file open. Source: REQ-L15586-04, REQ-L15586-08, SEQ-3, SEQ-5, SEQ-6, IP-3, INV-L15586-01, INV-L15586-02, INV-L15586-03, INV-L15586-04, INV-L15586-12, INV-L15586-13."),
    ),
    "ERRORS-RAWIO-1": Clause(
        verification="test",
        text=(
            "IF a live Raw-I/O Helper returns a per-request error for the active "
            "request (such as a target read or write error), THEN omp SHALL fail "
            "only that active request with an error naming its operation and target "
            "path, leave the live helper subprocess and any queued requests "
            "untouched, and SHALL NOT fall back to an in-process file open. "
            "The public async operation's returned promise SHALL reject with "
            "RawIoHelperOperationError carrying clauseId='ERRORS-RAWIO-1', "
            "operation, and targetPath for that request; this helper failure "
            "SHALL NOT be thrown synchronously. PRE-RAWIO-1 violations remain "
            "distinct RawIoInvalidTargetPathError failures. "
            "Source: REQ-L15586-08, INV-L15586-03."
        ),
    ),
    "ERRORS-RAWIO-1b": Clause(
        verification="test",
        text=(
            "IF the Raw-I/O Helper cannot start, crashes (exiting or erroring at "
            "the helper level while a request is active), or times out (when the "
            "active request does not receive {type: 'started', id} within "
            "options.timeoutMs of being sent to the helper, when 'classify' exceeds "
            "options.timeoutMs after {type: 'started', id}, or when 'read'/'write' "
            "receives no {type: 'progress', id} or completion message for "
            "options.timeoutMs after {type: 'started', id}, default "
            "RAW_IO_DEFAULT_TIMEOUT_MS = 5000ms) and the failed or killed helper "
            "exits within RAW_IO_KILL_WAIT_TIMEOUT_MS (5000ms), THEN omp SHALL kill "
            "the helper subprocess on timeout, fail only the active request naming "
            "its operation and target path (and for a timed-out 'write', stating "
            "that its outcome is unknown), dispatch requests still queued behind it "
            "(which were never sent to the failed helper) once in their original "
            "order to a newly spawned helper (with no second retry if that fresh "
            "helper also fails or times out), and SHALL NOT fall back to an "
            "in-process file open. Each public async operation failed under this "
            "clause SHALL reject its returned promise with "
            "RawIoHelperOperationError carrying clauseId='ERRORS-RAWIO-1b', "
            "operation, and targetPath for that request; this helper failure "
            "SHALL NOT be thrown synchronously. PRE-RAWIO-1 violations remain "
            "distinct RawIoInvalidTargetPathError failures. "
            "Source: REQ-L15586-08, INV-L15586-03."
        ),
    ),
    "ERRORS-RAWIO-1c": Clause(
        verification="test",
        text=(
            "IF a timed-out Raw-I/O Helper has not exited within "
            "RAW_IO_KILL_WAIT_TIMEOUT_MS (5000ms) after SIGKILL "
            "(helperExited=false in resolveTimeoutAfterKillWait), THEN omp SHALL "
            "report the active request's timeout error anyway (for a 'write', "
            "stating both that its outcome is unknown and that it may still land), "
            "SHALL NOT retry queued requests on a fresh helper "
            "(retryQueueOnFreshHelper=false), SHALL fail each queued request "
            "naming its operation and target path with an error stating that the "
            "previous helper could not be stopped, and SHALL NOT fall back to an "
            "in-process file open. Each affected public async operation's returned "
            "promise SHALL reject with RawIoHelperOperationError carrying "
            "clauseId='ERRORS-RAWIO-1c', operation, and targetPath for that active "
            "or queued request; this helper failure SHALL NOT be thrown "
            "synchronously. PRE-RAWIO-1 violations remain distinct "
            "RawIoInvalidTargetPathError failures. "
            "The exported settleRawIoTimeoutAfterKillWait(input: "
            "RawIoTimeoutSettlementInput) -> RawIoKillWaitResolution is the "
            "settlement owner invoked by the real kill-wait continuation. "
            "If registerUnexitedWriteTarget throws during that settlement, the "
            "owner SHALL still settle the active and queued request promises "
            "with the specified errors, retain the registration error as cause, "
            "preserve queued request order, and produce no floating rejection. "
            "Verified by unit tests on the real exported "
            "resolveTimeoutAfterKillWait and settlement owner with "
            "helperExited=false, native promise rejectors, and real "
            "registration/EACCES; the false-result wiring after the 5s wait "
            "remains code inspection because no unprivileged test can create "
            "a process that survives SIGKILL. "
            "Source: REQ-L15586-08, INV-L15586-03."
        ),
    ),
    "ERRORS-RAWIO-1d": Clause(
        verification="test",
        text=(
            "WHILE a timed-out write's Raw-I/O Helper has not been observed to "
            "exit (tracked in-memory via registerUnexitedWriteTarget(targetPath, "
            "exitPromise) keyed by the target's resolved real path—falling back to "
            "targetPath on ENOENT/ENOTDIR—for the life of the omp process with no "
            "time cap; does not survive an omp restart), omp SHALL refuse any new "
            "write request whose resolved real path matches that target with an "
            "error naming the operation ('write') and target path and stating "
            "that the previous helper is still alive and to fix the mount or "
            "restart omp, while allowing read and classify requests and write "
            "requests to other files to proceed on a fresh helper, and SHALL lift "
            "the block when exitPromise (the old helper's exit) settles. "
            "The refused public async write operation's returned promise SHALL "
            "reject with RawIoHelperOperationError carrying "
            "clauseId='ERRORS-RAWIO-1d', operation='write', and targetPath for "
            "that refused request; this helper failure SHALL NOT be thrown "
            "synchronously. PRE-RAWIO-1 violations remain distinct "
            "RawIoInvalidTargetPathError failures. "
            "The public WriteTool SHALL apply this refusal before selecting any "
            "write route, independent of the target's current classification (a "
            "timed-out helper write can leave a SQLite database classified as "
            "non-SQLite). "
            "(Verified by test driving registerUnexitedWriteTarget(targetPath, "
            "exitPromise), writeRawIoBytes, readRawIoBytes, and "
            "classifyRawIoTarget, including symlink-alias refusal and lift when "
            "exitPromise settles; the wiring that registers the target when the "
            "5s kill wait ends with helperExited=false is checked by reading the "
            "code during the slice audit, because no unprivileged test can create "
            "a process that survives SIGKILL.) "
            "Source: REQ-L15586-08, INV-L15586-03."
        ),
    ),
    "ERRORS-RAWIO-1e": Clause(
        verification="test",
        text=(
            "IF classifyRawIoTarget receives a sqlite_db classification without "
            "the actual header bytes matching SQLITE_HEADER_MAGIC, THEN its "
            "returned promise SHALL reject with RawIoHelperOperationError "
            "carrying clauseId='ERRORS-RAWIO-1e', operation='classify', and "
            "the caller's targetPath; it SHALL NOT synthesize header bytes or "
            "throw this failure synchronously. "
            "Source: REQ-L15586-05, REQ-L15586-08, IP-2."
        ),
    ),
    "FORBIDDEN-RAWIO-1": Clause(
        verification="test",
        text=(
            "The Raw-I/O Helper SHALL NOT open a SQLite database connection. "
            "Rationale: do not add the SQLite library (bun:sqlite or any SQLite "
            "binding) as a dependency of the Raw-I/O Helper. Verified by existing "
            "tests executing the real helper's normal classify, read, write, "
            "start, and stop operations (Ketema D1). "
            "Source: INV-L15586-02."
        ),
    ),
    "FORBIDDEN-RAWIO-1b": Clause(
        verification="test",
        text=(
            "omp SHALL NOT fall back to an in-process file open when the Raw-I/O "
            "Helper is unavailable or fails. Source: INV-L15586-03, REQ-L15586-08."
        ),
    ),
    "FORBIDDEN-RAWIO-2": Clause(
        verification="test",
        text=(
            "omp SHALL NOT run the Raw-I/O Helper as an in-process thread or "
            "Worker (helperPid SHALL be a live OS process ID distinct from "
            "omp's process.pid). Source: INV-L15586-13."
        ),
    ),
    "FORBIDDEN-RAWIO-2b": Clause(
        verification="tool",
        text=("omp SHALL NOT receive from another process a file descriptor for a file opened by a Trigger Path. Tool guarantee: Bun's IPC channel (for TypeScript callers) and anonymous OS byte pipes created by pipe(2) over stdin/stdout (for Rust pi-vfs callers) between omp and the Raw-I/O Helper carry serialized byte data only and cannot carry a file descriptor (SCM_RIGHTS requires an AF_UNIX socket control message, which pipe(2) does not support). This proof applies only while omp and the helper communicate over those channels (Ketema D2). Source: INV-L15586-12."),
    ),
    "FORBIDDEN-RAWIO-3": Clause(
        verification="test",
        text=(
            "ReadTool and WriteTool SHALL NOT open or close a raw in-process file "
            "descriptor on a SQLite-Family File (including during SQLite header "
            "sniffing, WAL-version inspection, editable-file header checks, or "
            "byte reads/writes; a SQLite connection's own descriptors managed by "
            "SQLite are not raw descriptors). Source: REQ-L15586-05, REQ-L15586-31, "
            "INV-L15586-01, INV-L15586-04, Q-SLICE4-01."
        ),
    ),
}
