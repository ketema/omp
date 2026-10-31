"""
Raw-I/O Helper Contract — specification authority (Python meta-validator surface).

Authoritative contract for SLICE-4 (REQ-L15586-05, REQ-L15586-31, REQ-L15586-08,
REQ-L15586-28; negative constraints INV-L15586-01, INV-L15586-02, INV-L15586-03,
INV-L15586-04, INV-L15586-12, INV-L15586-13) paired with
contracts/raw_io_helper.contract.ts.
"""

from dataclasses import dataclass
from typing import Final, Literal

# =============================================================================
# 1. Importable constants
# =============================================================================

RAW_IO_WORKER_ARG: Final[str] = "__omp_worker_raw_io"
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
SQLITE_FAMILY_ACTIVE_KINDS: Final[tuple[str, ...]] = ("sqlite_db", "sqlite_sidecar")
VALID_ENTRY_KINDS: Final[tuple[str, ...]] = ("file", "missing", "directory", "special")

type ClassificationKind = Literal[
    "sqlite_db",
    "sqlite_sidecar",
    "non_sqlite",
    "missing",
    "directory",
    "special",
]

# =============================================================================
# 2. Exception classes
# =============================================================================


class RawIoHelperContractError(Exception):
    """Base contract violation for the Raw-I/O Helper domain."""

    def __init__(self, clause_id: str, message: str) -> None:
        self.clause_id: Final[str] = clause_id
        super().__init__(f"{clause_id} violation: {message}")


class RawIoInvalidTargetPathError(RawIoHelperContractError):
    """Raised when a target path is not a POSIX absolute path (PRE-RAWIO-1)."""

    def __init__(self, target_path: object) -> None:
        super().__init__(
            "PRE-RAWIO-1",
            (
                "target_path must be a non-empty POSIX absolute path starting "
                f"with '/'; got {target_path!r}"
            ),
        )


class RawIoClassificationMismatchError(RawIoHelperContractError):
    """Raised when classification or failure text violates POST/ERRORS clauses."""

    def __init__(self, clause_id: str, message: str) -> None:
        super().__init__(clause_id, message)


class RawIoHelperUnavailableError(RawIoHelperContractError):
    """Raised when the Raw-I/O Helper cannot start or fails (ERRORS-RAWIO-1)."""

    def __init__(self, operation: str, target_path: str, reason: str) -> None:
        self.operation: Final[str] = operation
        self.target_path: Final[str] = target_path
        self.reason: Final[str] = reason
        super().__init__(
            "ERRORS-RAWIO-1",
            f"Raw-I/O Helper failed during {operation} for '{target_path}': {reason}",
        )


# =============================================================================
# 3. Dataclasses / value carriers
# =============================================================================


@dataclass(slots=True, frozen=True)
class Clause:
    verification: Literal["test", "execution", "tool"]
    text: str


@dataclass(slots=True, frozen=True)
class RawIoTargetClassification:
    """Validated out-of-process classification of a host file target."""

    target_path: str
    resolved_path: str
    kind: ClassificationKind
    is_sqlite_family: bool
    helper_pid: int


# =============================================================================
# 4. Callable validators (pure; no I/O)
# =============================================================================


def validate_target_path(target_path: object) -> str:
    """PRE-RAWIO-1: target_path is a non-empty POSIX absolute path (macOS/Linux)."""
    if (
        not isinstance(target_path, str)
        or len(target_path.strip()) == 0
        or not target_path.startswith("/")
    ):
        raise RawIoInvalidTargetPathError(target_path)
    return target_path


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
        )
    if entry_kind == "directory":
        return RawIoTargetClassification(
            target_path=valid_target,
            resolved_path=valid_resolved,
            kind="directory",
            is_sqlite_family=False,
            helper_pid=helper_pid,
        )
    if entry_kind == "special":
        return RawIoTargetClassification(
            target_path=valid_target,
            resolved_path=valid_resolved,
            kind="special",
            is_sqlite_family=False,
            helper_pid=helper_pid,
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
    )


def validate_helper_failure_error(
    error_message: object,
    expected_operation: str,
    expected_path: str,
) -> str:
    """ERRORS-RAWIO-1: failure error message names the failed operation and path."""
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
                f"error message {error_message!r} must name operation "
                f"{expected_operation!r} and path {expected_path!r}"
            ),
        )
    return error_message


# =============================================================================
# 5. Traceability
# =============================================================================

RAW_IO_HELPER_CONTRACT: Final[dict[str, Clause]] = {
    "PRE-RAWIO-1": Clause(
        verification="test",
        text=(
            "Target path supplied to the Raw-I/O Helper classifier or reader is a "
            "non-empty POSIX absolute filesystem path starting with '/'. "
            "Source: REQ-L15586-05, IP-2."
        ),
    ),
    "POST-RAWIO-1": Clause(
        verification="test",
        text=(
            "The Raw-I/O Helper classifies a target as SQLite-Family ('sqlite_sidecar' "
            "when its resolved real path ends with '-wal', '-shm', or '-journal'; "
            "'sqlite_db' when its first 16 bytes equal 'SQLite format 3\\0') and "
            "as 'non_sqlite' (or 'missing'/'directory'/'special') otherwise, returning "
            "only bytes and metadata from a separate OS process "
            "(helper_pid != omp.pid) without closing any descriptor for the target "
            "inside omp. Source: REQ-L15586-05, INV-L15586-01, SEQ-5, IP-2."
        ),
    ),
    "ERRORS-RAWIO-1": Clause(
        verification="test",
        text=(
            "When the Raw-I/O Helper cannot start, crashes, or fails during a "
            "classification or byte-read request, omp surfaces an error that names "
            "both the failed operation and the target path. Source: REQ-L15586-08."
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
            "omp SHALL NOT run the Raw-I/O Helper as an in-process thread or Worker. "
            "Source: INV-L15586-13."
        ),
    ),
    "FORBIDDEN-RAWIO-2b": Clause(
        verification="test",
        text=(
            "omp SHALL NOT receive from another process a file descriptor for a file "
            "opened by a Trigger Path. Source: INV-L15586-12."
        ),
    ),
}
