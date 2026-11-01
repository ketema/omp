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
RAW_IO_WORKER_ARG: Final[str] = "__omp_worker_raw_io"
RAW_IO_WORKER_SELECTORS_MODULE: Final[str] = (
    "@oh-my-pi/pi-coding-agent/cli/worker-selectors"
)
RAW_IO_CLIENT_MODULE: Final[str] = "@oh-my-pi/pi-coding-agent/tools/raw-io-client"
RAW_IO_CLASSIFY_FN_NAME: Final[str] = "classifyRawIoTarget"
RAW_IO_READ_BYTES_FN_NAME: Final[str] = "readRawIoBytes"
RAW_IO_WRITE_BYTES_FN_NAME: Final[str] = "writeRawIoBytes"
RAW_IO_STOP_FN_NAME: Final[str] = "stopRawIoHelper"
RAW_IO_DEFAULT_TIMEOUT_MS: Final[int] = 5000
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
    """Validated timeout evaluation for a Raw-I/O Helper request (T4/R1 = A, B7)."""

    operation: HelperOperation
    timeout_ms: int
    queued_wait_ms: int
    started_received: bool
    elapsed_before_start_ms: int
    elapsed_since_start_ms: int
    elapsed_since_progress_ms: int
    timed_out: bool
    helper_killed: bool


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
    stripped = target_path.strip()
    if not stripped or not stripped.startswith("/"):
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
            "ERRORS-RAWIO-1",
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
) -> str:
    """ERRORS-RAWIO-1: failure error names operation/path and timeout/write-unknown."""
    if not isinstance(error_message, str) or not error_message.strip():
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1",
            (
                "error message must be a non-empty string naming operation "
                f"{expected_operation!r} and path {expected_path!r}"
            ),
        )
    if expected_operation not in error_message or expected_path not in error_message:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1",
            (
                f"error message {error_message!r} must include operation "
                f"{expected_operation!r} and target path {expected_path!r}"
            ),
        )
    if timed_out:
        lower = error_message.lower()
        if "timed out" not in lower and "timeout" not in lower:
            raise RawIoClassificationMismatchError(
                "ERRORS-RAWIO-1",
                f"timed-out error message {error_message!r} must indicate a timeout",
            )
        if (
            expected_operation == "write"
            and "outcome is unknown" not in lower
            and "outcome unknown" not in lower
        ):
            raise RawIoClassificationMismatchError(
                "ERRORS-RAWIO-1",
                (
                    f"timed-out write error {error_message!r} must state that "
                    "the write outcome is unknown"
                ),
            )
    return error_message


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
) -> RawIoTimeoutEvaluation:
    """POST-RAWIO-2b / ERRORS-RAWIO-1: pure validator for T4/R1 = A & B7 rules."""
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
            "ERRORS-RAWIO-1",
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
    ):
        raise RawIoClassificationMismatchError(
            "POST-RAWIO-2b",
            "queued_wait_ms, elapsed_before_start_ms, elapsed_since_start_ms, and "
            "elapsed_since_progress_ms must be non-negative integers",
        )
    if not isinstance(helper_killed, bool):
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1",
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
    if timed_out and not helper_killed:
        raise RawIoClassificationMismatchError(
            "ERRORS-RAWIO-1",
            "omp must kill the helper subprocess when a request times out",
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
            "length?, options?) -> Promise<Uint8Array>, and writeRawIoBytes("
            "targetPath, data, options?) -> Promise<void>, where "
            "options.helperSpawnCommand is an optional spawn-command override, "
            "options.timeoutMs is an optional positive integer timeout bound "
            "defaulting to RAW_IO_DEFAULT_TIMEOUT_MS (5000ms), and options.onRequest "
            "is invoked exactly once for each request sent to the Raw-I/O Helper "
            "across every operation ('classify', 'read', 'write') with that "
            "request's operation and targetPath; requests on a shared helper are "
            "dispatched serially (queued requests have no running timeout while "
            "waiting behind an earlier active request), the helper emits a "
            "{type: 'started', id} message when it begins the active request (which "
            "starts the fixed options.timeoutMs timer for 'classify' and the "
            "no-progress options.timeoutMs timer for 'read' and 'write'), and for "
            "'read' and 'write' the helper transfers in bounded chunks "
            "(RAW_IO_PROGRESS_CHUNK_BYTES = 65536) and emits {type: 'progress', id, "
            "bytesProcessed} after each chunk to reset the no-progress timer. "
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
    "POST-RAWIO-3": Clause(
        verification="test",
        text=(
            "When ReadTool receives a host file path, it forwards "
            "session.rawIoHelperOptions on every helper request, classifies the "
            "target out of process through the Raw-I/O Helper before any in-process "
            "file open, and accesses a SQLite-Family target only through the Raw-I/O "
            "Helper (recording a 'read' entry in onRequest) or a SQLite connection "
            "while retaining every POSIX advisory lock omp holds on that inode. "
            "Source: REQ-L15586-05, REQ-L15586-31, SEQ-2, IP-2, INV-L15586-01, "
            "INV-L15586-04."
        ),
    ),
    "POST-RAWIO-3b": Clause(
        verification="test",
        text=(
            "When WriteTool receives a host file path, it forwards "
            "session.rawIoHelperOptions on every helper request, classifies the "
            "target out of process through the Raw-I/O Helper before any in-process "
            "file open, and accesses a SQLite-Family target only through the Raw-I/O "
            "Helper (recording a 'write' entry in onRequest) or a SQLite connection "
            "while retaining every POSIX advisory lock omp holds on that inode. "
            "Source: REQ-L15586-05, REQ-L15586-31, SEQ-2, IP-2, INV-L15586-01, "
            "INV-L15586-04."
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
    "ERRORS-RAWIO-1": Clause(
        verification="test",
        text=(
            "IF the Raw-I/O Helper cannot start, crashes, fails, or times out "
            "(when the active request does not receive {type: 'started', id} within "
            "options.timeoutMs of being sent to the helper, when 'classify' exceeds "
            "options.timeoutMs after {type: 'started', id}, or when 'read'/'write' "
            "receives no {type: 'progress', id} or completion message for "
            "options.timeoutMs after {type: 'started', id}, default "
            "RAW_IO_DEFAULT_TIMEOUT_MS = 5000ms), THEN omp SHALL kill the helper "
            "subprocess (so a timed-out write cannot land late and any other "
            "in-flight or queued requests on the shared helper also fail closed "
            "naming their operation and target path), surface an error naming the "
            "operation and target path (and for a timed-out 'write', stating that "
            "its outcome is unknown), and SHALL NOT fall back to an in-process file "
            "open. Source: REQ-L15586-08, INV-L15586-03."
        ),
    ),
    "FORBIDDEN-RAWIO-1": Clause(
        verification="test",
        text=(
            "The Raw-I/O Helper SHALL NOT open a SQLite database connection. "
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
        verification="test",
        text=(
            "omp SHALL NOT receive from another process a file descriptor for a file "
            "opened by a Trigger Path. Source: INV-L15586-12."
        ),
    ),
    "FORBIDDEN-RAWIO-3": Clause(
        verification="test",
        text=(
            "ReadTool and WriteTool SHALL NOT open or close a raw in-process file "
            "descriptor on a SQLite-Family File (including during SQLite header "
            "sniffing, WAL-version inspection, editable-file header checks, or "
            "byte reads/writes). Source: REQ-L15586-05, REQ-L15586-31, "
            "INV-L15586-01, INV-L15586-04."
        ),
    ),
}
