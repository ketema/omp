"""rlm_ledger — harness state ledger for the OMP RLM subsystem.

Implements the contract at requirements/contracts/rlm-ledger.contract.ts.
All constants, exceptions, and types are redeclared independently (no import
from the contract file).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

__all__ = [
    "ENTRY_VERSION_DEFAULT",
    "GLOBAL_FILE",
    "ID_MAX_CHARS",
    "KINDS",
    "LOCAL_FILE",
    "OVERVIEW_PER_KIND",
    "OVERVIEW_REFINEMENTS",
    "OVERVIEW_TRUNCATE_CHARS",
    "REFINEMENT_PREFIX",
    "SCHEMA_VERSION",
    "SCOPES",
    "HarnessState",
    "RlmLedgerError",
]

# ---------------------------------------------------------------------------
# Constants (redeclared, aligned with contract LED_*)
# ---------------------------------------------------------------------------

KINDS: Final[tuple[str, ...]] = ("prompt", "memory", "skill", "subagent")
SCOPES: Final[tuple[str, ...]] = ("local", "global")
SCHEMA_VERSION: Final[int] = 1
ID_MAX_CHARS: Final[int] = 80
OVERVIEW_PER_KIND: Final[int] = 20
OVERVIEW_TRUNCATE_CHARS: Final[int] = 120
OVERVIEW_REFINEMENTS: Final[int] = 5
LOCAL_FILE: Final[str] = "harness/harness_state.json"
GLOBAL_FILE: Final[str] = "harness/harness_state.json"
ENTRY_VERSION_DEFAULT: Final[int] = 1
REFINEMENT_PREFIX: Final[str] = "refine_"

_logger = logging.getLogger("rlm_ledger")


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class RlmLedgerError(ValueError):
    """Raised for all ledger contract violations."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _slugify(title: str) -> str:
    """Convert title to a slug of [a-z0-9_] capped at ID_MAX_CHARS.

    Returns "" when the title carries no slug characters — callers MUST
    reject that (INV-LED-1), never persist an empty id.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")
    if len(slug) > ID_MAX_CHARS:
        slug = slug[:ID_MAX_CHARS]
    return slug


def _atomic_write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Refinement event
# ---------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class RefinementEvent:
    id: str
    trigger: str
    changes: str
    evidence: str
    outcome: str
    created_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "trigger": self.trigger,
            "changes": self.changes,
            "evidence": self.evidence,
            "outcome": self.outcome,
            "created_at": self.created_at,
        }


# ---------------------------------------------------------------------------
# Store: manages one state file (local or global)
# ---------------------------------------------------------------------------


class _Store:
    """Manages loading/saving a single state file."""

    __slots__ = ("_entries", "_file", "_refinement_counter", "_refinements")

    def __init__(self, file_path: Path) -> None:
        self._file = file_path
        self._entries: dict[str, dict[str, dict[str, object]]] = {k: {} for k in KINDS}
        self._refinements: list[RefinementEvent] = []
        self._refinement_counter = 0

    @property
    def file(self) -> Path:
        return self._file

    @property
    def entries(self) -> dict[str, dict[str, dict[str, object]]]:
        return self._entries

    @property
    def refinements(self) -> list[RefinementEvent]:
        return self._refinements

    @property
    def refinement_counter(self) -> int:
        return self._refinement_counter

    def load(self) -> None:
        """Load from disk; corrupt file yields empty state + WARNING log."""
        self._entries = {k: {} for k in KINDS}
        self._refinements = []
        self._refinement_counter = 0

        if not self._file.exists():
            return
        try:
            raw = self._file.read_text(encoding="utf-8")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise TypeError("not a dict")
            if data.get("schema") != SCHEMA_VERSION:
                raise ValueError("schema mismatch")
            entries = data.get("entries")
            if not isinstance(entries, dict):
                raise TypeError("entries not a dict")
            refinements = data.get("refinements")
            if not isinstance(refinements, list):
                raise TypeError("refinements not a list")
        except (TypeError, ValueError, json.JSONDecodeError, OSError):
            _logger.warning(
                "corrupt state file, starting with empty state: %s",
                str(self._file),
            )
            return

        for kind, kind_entries in entries.items():
            if kind not in KINDS:
                continue
            for entry_id, entry_data in kind_entries.items():
                if isinstance(entry_data, dict):
                    version = entry_data.get("version", ENTRY_VERSION_DEFAULT)
                    if isinstance(version, bool) or not isinstance(version, int):
                        _logger.warning(
                            "dropping entry with malformed version %r: %s/%s",
                            version,
                            kind,
                            entry_id,
                        )
                        continue
                    for text_field in ("title", "content", "path"):
                        value = entry_data.get(text_field)
                        if not isinstance(value, str):
                            _logger.warning(
                                "dropping entry with malformed %s %r: %s/%s",
                                text_field,
                                value,
                                kind,
                                entry_id,
                            )
                            entry_data = None
                            break
                    if entry_data is None:
                        continue
                    self._entries[kind][entry_id] = dict(entry_data)

        for ref in refinements:
            if isinstance(ref, dict):
                event = RefinementEvent(
                    id=str(ref.get("id", "")),
                    trigger=str(ref.get("trigger", "")),
                    changes=str(ref.get("changes", "")),
                    evidence=str(ref.get("evidence", "")),
                    outcome=str(ref.get("outcome", "")),
                    created_at=str(ref.get("created_at", "")),
                )
                self._refinements.append(event)
                ref_id = event.id
                if ref_id.startswith(REFINEMENT_PREFIX):
                    try:
                        num = int(ref_id[len(REFINEMENT_PREFIX) :])
                        self._refinement_counter = max(self._refinement_counter, num)
                    except ValueError:
                        pass

    def save(self) -> None:
        """Save to disk atomically."""
        data = {
            "schema": SCHEMA_VERSION,
            "entries": self._entries,
            "refinements": [r.to_dict() for r in self._refinements],
        }
        _atomic_write(self._file, json.dumps(data, indent=2))

    def reload(self) -> None:
        """Re-read from disk (INV-LED-2: external writes visible)."""
        self.load()


# ---------------------------------------------------------------------------
# HarnessState
# ---------------------------------------------------------------------------


class HarnessState:
    """Persistent harness state ledger with CRUD for entries and refinements."""

    __slots__ = ("_global", "_local")

    def __init__(
        self,
        *,
        session_dir: str | None = None,
        harness_state_dir: str | None = None,
        global_state_dir: str | None = None,
        agent_dir: str | None = None,
    ) -> None:
        # Resolve local file path
        if harness_state_dir is not None:
            local_dir = Path(harness_state_dir)
        elif session_dir is not None:
            local_dir = Path(session_dir)
        else:
            local_dir = Path.cwd()

        local_file = local_dir / LOCAL_FILE

        # Resolve global file path
        if global_state_dir is not None:
            global_file = Path(global_state_dir) / GLOBAL_FILE
        elif agent_dir is not None:
            global_file = Path(agent_dir) / GLOBAL_FILE
        else:
            global_file = local_dir.parent / "global-rlm-state" / GLOBAL_FILE

        if global_file.resolve() == local_file.resolve():
            raise RlmLedgerError(
                "INV-LED-LIFETIME-2 violation: local and global state files must be "
                f"distinct paths (both resolve to {local_file.resolve()})"
            )

        self._local = _Store(local_file)
        self._global = _Store(global_file)

        self._local.load()
        self._global.load()

    # ------------------------------------------------------------------
    # Kind validation
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_kind(kind: str) -> None:
        if kind not in KINDS:
            raise RlmLedgerError(
                f"LED-V1 violation: kind must be one of {'|'.join(KINDS)}, got {kind!r}"
            )

    # ------------------------------------------------------------------
    # Store selection
    # ------------------------------------------------------------------

    def _store_for_scope(self, scope: str) -> _Store:
        if scope == "global":
            return self._global
        return self._local

    def _parse_id(self, id: str) -> tuple[str | None, str]:
        """Parse an id that may have a [global:id] or [local:id] prefix.

        Returns (scope_override, bare_id).
        """
        if id.startswith("[global:") and id.endswith("]"):
            return "global", id[len("[global:") : -1]
        if id.startswith("[local:") and id.endswith("]"):
            return "local", id[len("[local:") : -1]
        return None, id

    def _resolve_get(
        self, kind: str, id: str
    ) -> tuple[_Store | None, dict[str, object] | None]:
        """Resolve an entry across both stores, checking local then global.

        Supports [global:id] and [local:id] prefix syntax to explicitly
        route to a specific store.
        """
        scope_override, bare_id = self._parse_id(id)
        if scope_override == "global":
            entry = self._global.entries[kind].get(bare_id)
            if entry is not None:
                return self._global, entry
            return None, None
        if scope_override == "local":
            entry = self._local.entries[kind].get(bare_id)
            if entry is not None:
                return self._local, entry
            return None, None
        # No prefix: check local first, then global
        entry = self._local.entries[kind].get(bare_id)
        if entry is not None:
            return self._local, entry
        entry = self._global.entries[kind].get(bare_id)
        if entry is not None:
            return self._global, entry
        return None, None

    # ------------------------------------------------------------------
    # Reload before reads (INV-LED-2)
    # ------------------------------------------------------------------

    def _reload_all(self) -> None:
        """Reload both stores from disk before reads."""
        self._local.reload()
        self._global.reload()

    # ------------------------------------------------------------------
    # Generic CRUD
    # ------------------------------------------------------------------

    def _create(
        self,
        kind: str,
        title: str,
        content: str,
        *,
        path: str = "general",
        scope: str = "local",
        reference: dict[str, object] | None = None,
        arguments: dict[str, object] | None = None,
        metadata: dict[str, object] | None = None,
        id: str | None = None,
        global_: bool = False,
    ) -> dict[str, object]:
        self._validate_kind(kind)
        # INV-LED-2: mutations reload external state before saving so a
        # concurrent host write is never clobbered by a stale save
        self._reload_all()

        if global_:
            scope = "global"
        if scope not in SCOPES:
            raise RlmLedgerError(
                f"scope must be one of {'|'.join(SCOPES)}, got {scope!r}"
            )

        if id is None:
            id = _slugify(title)
            if not id:
                raise RlmLedgerError(
                    "INV-LED-1 violation: title carries no slug characters; "
                    f"auto id would be empty (title={title!r})"
                )
        else:
            id = id[:ID_MAX_CHARS]
            if not id:
                raise RlmLedgerError(
                    "INV-LED-1 violation: explicit id must be non-empty"
                )

        store = self._store_for_scope(scope)

        # Check for duplicates in the target store
        if id in store.entries[kind]:
            raise RlmLedgerError(f"LED-V2 violation: entry {id!r} already exists")

        # Also check the other store for [global:id] resolution
        other = self._global if store is self._local else self._local
        if id in other.entries[kind]:
            raise RlmLedgerError(f"LED-V2 violation: entry {id!r} already exists")

        now = _utc_now_iso()
        entry: dict[str, object] = {
            "id": id,
            "kind": kind,
            "title": title,
            "content": content,
            "path": path,
            "scope": scope,
            "reference": reference,
            "arguments": arguments,
            "metadata": metadata,
            "source": "harness",
            "created_at": now,
            "updated_at": now,
            "version": ENTRY_VERSION_DEFAULT,
        }

        store.entries[kind][id] = entry
        store.save()

        return dict(entry)

    _RESERVED_FIELDS: Final[frozenset[str]] = frozenset(
        {"kind", "id", "version", "created_at", "updated_at", "source"}
    )

    def _update(self, kind: str, id: str, **fields: object) -> dict[str, object]:
        self._validate_kind(kind)
        # ERRORS-LED-1: reserved-field collisions raise the domain error, not
        # a raw TypeError from argument binding
        reserved = sorted(self._RESERVED_FIELDS & fields.keys())
        if reserved:
            raise RlmLedgerError(
                "ERRORS-LED-1 violation: cannot update reserved field(s) "
                f"{', '.join(reserved)} on entry {id!r}"
            )
        # INV-LED-2: mutations reload external state before saving
        self._reload_all()

        store, entry = self._resolve_get(kind, id)
        if store is None or entry is None:
            raise RlmLedgerError(
                f"LED-V2 violation: update on a missing entry — {id!r} not found"
            )

        if "scope" in fields and fields["scope"] is not None:
            _, bare_id = self._parse_id(id)
            current = entry.get("scope", "local")
            if fields["scope"] != current:
                raise RlmLedgerError(
                    "INV-LED-3 violation: scope is immutable after creation "
                    f"(entry {bare_id!r} is {current!r}; refusing to set {fields['scope']!r})"
                )

        version = entry.get("version", ENTRY_VERSION_DEFAULT)
        if isinstance(version, bool) or not isinstance(version, int):
            raise RlmLedgerError(
                f"ERRORS-LED-1 violation: entry {id!r} has malformed on-disk "
                f"version {version!r}; refusing update"
            )

        for key in (
            "title",
            "content",
            "path",
            "reference",
            "arguments",
            "metadata",
        ):
            if key in fields and fields[key] is not None:
                entry[key] = fields[key]

        entry["version"] = version + 1
        entry["updated_at"] = _utc_now_iso()

        store.save()

        return dict(entry)

    def _delete(self, kind: str, id: str) -> None:
        self._validate_kind(kind)
        # INV-LED-2: mutations reload external state before saving
        self._reload_all()

        store, entry = self._resolve_get(kind, id)
        if store is None or entry is None:
            raise RlmLedgerError(
                f"LED-V2 violation: delete on a missing entry — {id!r} not found"
            )

        del store.entries[kind][id]
        store.save()

    def _get(self, kind: str, id: str) -> dict[str, object] | None:
        self._validate_kind(kind)
        self._reload_all()
        _store, entry = self._resolve_get(kind, id)
        if entry is None:
            return None
        return dict(entry)

    def _list(self, kind: str) -> list[dict[str, object]]:
        self._validate_kind(kind)
        self._reload_all()
        # INV-LED-4: list renders both scopes — local entries first, then global
        combined = [dict(e) for e in self._local.entries[kind].values()]
        combined.extend(dict(e) for e in self._global.entries[kind].values())
        return combined

    # ------------------------------------------------------------------
    # Kind-specific CRUD dispatchers
    # ------------------------------------------------------------------

    def create_memory(
        self, title: str, content: str, /, **kwargs: object
    ) -> dict[str, object]:
        return self._create("memory", title, content, **kwargs)  # type: ignore[arg-type]

    def _guard_reserved(self, kind: str, id: str, fields: dict) -> dict:
        """ERRORS-LED-1: reserved-field collisions raise the domain error
        instead of TypeError at **fields binding time."""
        reserved = sorted(self._RESERVED_FIELDS & fields.keys())
        if reserved:
            raise RlmLedgerError(
                "ERRORS-LED-1 violation: cannot update reserved field(s) "
                f"{', '.join(reserved)} on entry {id!r}"
            )
        return fields

    def update_memory(self, id: str, /, **fields: object) -> dict[str, object]:
        return self._update("memory", id, **self._guard_reserved("memory", id, fields))

    def delete_memory(self, id: str, /) -> None:
        self._delete("memory", id)

    def create_skill(
        self, title: str, content: str, /, **kwargs: object
    ) -> dict[str, object]:
        return self._create("skill", title, content, **kwargs)  # type: ignore[arg-type]

    def update_skill(self, id: str, /, **fields: object) -> dict[str, object]:
        return self._update("skill", id, **self._guard_reserved("skill", id, fields))

    def delete_skill(self, id: str, /) -> None:
        self._delete("skill", id)

    def create_subagent(
        self, title: str, content: str, /, **kwargs: object
    ) -> dict[str, object]:
        return self._create("subagent", title, content, **kwargs)  # type: ignore[arg-type]

    def update_subagent(self, id: str, /, **fields: object) -> dict[str, object]:
        return self._update(
            "subagent", id, **self._guard_reserved("subagent", id, fields)
        )

    def delete_subagent(self, id: str, /) -> None:
        self._delete("subagent", id)

    def create_prompt_note(
        self, title: str, content: str, /, **kwargs: object
    ) -> dict[str, object]:
        return self._create("prompt", title, content, **kwargs)  # type: ignore[arg-type]

    def update_prompt_note(self, id: str, /, **fields: object) -> dict[str, object]:
        return self._update("prompt", id, **self._guard_reserved("prompt", id, fields))

    def delete_prompt_note(self, id: str, /) -> None:
        self._delete("prompt", id)

    # ------------------------------------------------------------------
    # Generic create(kind) dispatcher
    # ------------------------------------------------------------------

    def create(self, kind: str):
        """Return a callable that creates an entry of the given kind."""
        self._validate_kind(kind)
        kind_method = {
            "prompt": self.create_prompt_note,
            "memory": self.create_memory,
            "skill": self.create_skill,
            "subagent": self.create_subagent,
        }
        return kind_method[kind]

    def update(self, kind: str):
        self._validate_kind(kind)
        kind_method = {
            "prompt": self.update_prompt_note,
            "memory": self.update_memory,
            "skill": self.update_skill,
            "subagent": self.update_subagent,
        }
        return kind_method[kind]

    def delete(self, kind: str):
        self._validate_kind(kind)
        kind_method = {
            "prompt": self.delete_prompt_note,
            "memory": self.delete_memory,
            "skill": self.delete_skill,
            "subagent": self.delete_subagent,
        }
        return kind_method[kind]

    def get(self, kind: str, id: str) -> dict[str, object] | None:
        return self._get(kind, id)

    def list(self, kind: str) -> list[dict[str, object]]:
        return self._list(kind)

    # ------------------------------------------------------------------
    # Refinements
    # ------------------------------------------------------------------

    def record_refinement(
        self,
        trigger: str,
        changes: str,
        evidence: str,
        outcome: str,
    ) -> str:
        """Record a refinement event and return its id."""
        # Reload to pick up any external writes
        self._reload_all()

        self._local._refinement_counter += 1
        ref_id = f"{REFINEMENT_PREFIX}{self._local._refinement_counter:04d}"
        event = RefinementEvent(
            id=ref_id,
            trigger=trigger,
            changes=changes,
            evidence=evidence,
            outcome=outcome,
            created_at=_utc_now_iso(),
        )
        self._local._refinements.append(event)
        self._local.save()
        return ref_id

    # ------------------------------------------------------------------
    # Overview
    # ------------------------------------------------------------------

    def overview(self) -> str:
        """Render a human-readable overview of the ledger state."""
        self._reload_all()

        lines: list[str] = []

        # INV-LED-4: overview renders both scopes; global entries carry the
        # [global:id] prefix in their scope lines
        combined: dict[str, list[dict[str, object]]] = {k: [] for k in KINDS}
        for store in (self._local, self._global):
            for kind in KINDS:
                for entry in store.entries[kind].values():
                    rendered = dict(entry)
                    if store is self._global:
                        rendered["scope"] = "global"
                    combined[kind].append(rendered)

        for kind in KINDS:
            entries = combined[kind]
            if not entries:
                continue
            shown = entries[:OVERVIEW_PER_KIND]
            for entry in shown:
                scope = entry.get("scope", "local")
                eid = entry.get("id", "")
                title = entry.get("title", "")
                path = entry.get("path", "")
                version = entry.get("version", 1)
                content = entry.get("content", "")
                if len(content) > OVERVIEW_TRUNCATE_CHARS:
                    truncated = content[: OVERVIEW_TRUNCATE_CHARS - 3] + "..."
                else:
                    truncated = content
                lines.append(
                    f"[{scope}:{eid}] {title} ({path}, v{version})\n  {truncated}"
                )
            remaining = len(entries) - OVERVIEW_PER_KIND
            if remaining > 0:
                lines.append(f"+{remaining} more {kind} entries")

        # Refinements (from local store)
        if self._local.refinements:
            recent = self._local.refinements[-OVERVIEW_REFINEMENTS:]
            lines.append("Refinements:")
            for ref in recent:
                lines.append(f"  [{ref.id}] {ref.trigger} → {ref.outcome}")

        return "\n".join(lines)
