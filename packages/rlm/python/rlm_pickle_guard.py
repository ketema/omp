"""File-handle guard shared by the kernel runner's snapshot restore/write and the quarantine inspector.

dill rebuilds a file handle by reopening its path BEFORE it applies the closed flag, so loading a serialized handle
truncates a write-mode file. A snapshot therefore never carries one, and every consumer refuses one before anything is
opened. The scan reads pickle opcodes only and never unpickles anything.

This is an accidental-I/O guard under the runner's existing permissions; it does not sandbox arbitrary pickles.

Contract authority: contracts/rlm_dill_resilient_restore.contract.py (FILE_HANDLE_RECONSTRUCTORS, POST-NOHANDLE-1,
POST-NOOPEN-1, ERRORS-HANDLECONTAINER-1, CROSS_INV-1) and contracts/quarantine_inspector.contract.py (POST-QNOOPEN-1,
ERRORS-QHANDLECONTAINER-1, CROSS_INV-1). This module redeclares the contract's values (CL11-F) and does not import the
contract; tests import both and assert they agree.

Packaging: the runner is spawned as `python <runner path>` and loads this module from its own directory, so the module
is embedded and extracted beside the runner (packages/rlm/src/embedded_assets.ts). A missing file stops the runner at
start with an error naming this module; there is no unguarded fallback.
"""

from __future__ import annotations

import pickletools
from collections.abc import Callable
from typing import Any, Final

# Names that reconstruct a file handle (and so open a path) when a serialized variable is rebuilt.
FILE_HANDLE_RECONSTRUCTORS: Final[frozenset[str]] = frozenset({"_create_filehandle"})

# Opcodes that push nothing onto the pickle stack: they never separate a global's module and name operands.
_NO_PUSH_OPCODES: Final[frozenset[str]] = frozenset({"PROTO", "FRAME", "MEMOIZE", "PUT", "BINPUT", "LONG_BINPUT"})
_MEMO_GET_OPCODES: Final[frozenset[str]] = frozenset({"GET", "BINGET", "LONG_BINGET"})
_STRING_PUSH_OPCODES: Final[frozenset[str]] = frozenset(
    {"SHORT_BINUNICODE", "BINUNICODE", "BINUNICODE8", "UNICODE", "STRING", "BINSTRING", "SHORT_BINSTRING"}
)


def references_file_handle_reconstructor(data: Any) -> bool:
    """True when the pickle stream `data` (bytes or a binary file object) references a file-handle reconstructor.

    Looks only at how a global is named: GLOBAL's operand, or the two strings pushed immediately before STACK_GLOBAL
    (read through the memo, since dill reuses a memoized module or name). Plain text that merely mentions a name is not
    a reference. A stream that cannot be parsed further is judged on the opcodes read before the break: the unpickler
    cannot execute past it either, so the break surfaces as the ordinary deserialization error.
    """
    recent: list[Any] = []
    memo: dict[Any, Any] = {}
    memo_index = 0
    try:
        for opcode, arg, _ in pickletools.genops(data):
            name = opcode.name
            if name in _NO_PUSH_OPCODES:
                top = recent[-1] if recent else None
                if name == "MEMOIZE":
                    memo[memo_index] = top
                    memo_index += 1
                else:
                    memo[arg] = top
                continue
            value = None
            if name == "GLOBAL":
                if str(arg).rsplit(" ", 1)[-1] in FILE_HANDLE_RECONSTRUCTORS:
                    return True
            elif name == "STACK_GLOBAL":
                if len(recent) == 2 and recent[1] in FILE_HANDLE_RECONSTRUCTORS:
                    return True
            elif name in _STRING_PUSH_OPCODES:
                value = arg if isinstance(arg, str) else None
            elif name in _MEMO_GET_OPCODES:
                value = memo.get(arg)
            recent.append(value)
            del recent[:-2]
    except (ValueError, EOFError):
        return False
    return False


def container_references_file_handle_reconstructor(path: str, codec: str) -> bool:
    """True when the snapshot CONTAINER at `path` (codec: "lzma", "gzip" or "raw") references a reconstructor.

    The caller has already imported the codec module it names, so a missing `_lzma` surfaces through the caller's own
    codec error and never as an unguarded load.
    """
    opener: Callable[[str, str], Any]
    if codec == "lzma":
        import lzma

        opener = lzma.open
    elif codec == "gzip":
        import gzip

        opener = gzip.open
    else:
        opener = open
    with opener(path, "rb") as fh:
        return references_file_handle_reconstructor(fh)
