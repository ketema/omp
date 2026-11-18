from __future__ import annotations

import gzip
import hashlib
import json
import lzma
import os
import platform
import stat
from pathlib import Path

import dill

ROOT = Path.home() / ".omp" / "agent" / "repl-snapshots"
MANIFEST = ROOT / "manifest.json"
LZMA_MAGIC = bytes([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])
GZIP_MAGIC = bytes([0x1F, 0x8B])
RAW_MAGIC = bytes([0x80])


def fail(record: str, reason: str) -> None:
    print(json.dumps({"snapshot_restore": "refused", "record": record, "reason": reason}, sort_keys=True))


def check_mode(path: Path, mode: int) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"{path.name} is a symlink")
    if info.st_uid != os.getuid():
        raise ValueError(f"{path.name} owner mismatch")
    if stat.S_IMODE(info.st_mode) != mode:
        raise ValueError(f"{path.name} mode mismatch")
    return info


try:
    root_info = check_mode(ROOT, 0o700)
    if not stat.S_ISDIR(root_info.st_mode):
        raise ValueError("snapshot root is not a directory")
    if not stat.S_ISREG(check_mode(MANIFEST, 0o600).st_mode):
        raise ValueError("manifest is not a regular file")
    manifest = json.loads(MANIFEST.read_text())
    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported manifest schema")
    for record in manifest.get("snapshots", []):
        if record.get("auto_restore") is not True:
            continue
        record_id = record.get("id", "<missing>")
        names = record.get("names")
        file_name = record.get("file")
        if not isinstance(names, list) or not names or not all(isinstance(name, str) and name.isidentifier() for name in names):
            fail(record_id, "invalid names allowlist")
            continue
        if not isinstance(file_name, str) or Path(file_name).name != file_name:
            fail(record_id, "invalid snapshot file name")
            continue
        snapshot = ROOT / file_name
        if snapshot.parent != ROOT:
            fail(record_id, "snapshot escapes trusted root")
            continue
        if not stat.S_ISREG(check_mode(snapshot, 0o600).st_mode):
            fail(record_id, "snapshot is not a regular file")
            continue
        blob = snapshot.read_bytes()
        if len(blob) != record.get("byte_size"):
            fail(record_id, "byte-size mismatch")
            continue
        if hashlib.sha256(blob).hexdigest() != record.get("sha256"):
            fail(record_id, "sha256 mismatch")
            continue
        if record.get("python_version") != ".".join(platform.python_version_tuple()[:2]):
            fail(record_id, "python version mismatch")
            continue
        if record.get("dill_version") != dill.__version__:
            fail(record_id, "dill version mismatch")
            continue
        if blob.startswith(LZMA_MAGIC):
            payload = lzma.decompress(blob)
            codec = "lzma"
        elif blob.startswith(GZIP_MAGIC):
            payload = gzip.decompress(blob)
            codec = "gzip"
        elif blob.startswith(RAW_MAGIC):
            payload = blob
            codec = "raw"
        else:
            fail(record_id, "unknown or truncated codec header")
            continue
        if codec != record.get("compression"):
            fail(record_id, "codec metadata mismatch")
            continue
        staged = dill.loads(payload)
        if not isinstance(staged, dict) or any(name not in staged for name in names):
            fail(record_id, "snapshot mapping mismatch")
            continue
        expected_types = record.get('expected_types')
        if not isinstance(expected_types, dict) or set(expected_types) != set(names) or any(kind not in ('callable', 'str') for kind in expected_types.values()):
            fail(record_id, 'invalid expected-types allowlist')
            continue
        if any((expected_types[name] == 'callable' and not callable(staged[name])) or (expected_types[name] == 'str' and not isinstance(staged[name], str)) for name in names):
            fail(record_id, 'restored type mismatch')
            continue
        restored = {name: staged[name] for name in names}
        globals().update(restored)
        print(json.dumps({"snapshot_restore": "restored", "record": record_id, "names": names, "codec": codec}, sort_keys=True))
except Exception as exc:
    fail("<manifest>", str(exc))
