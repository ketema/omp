"""RED PHASE — rlm_ledger implementation tests (SLICE-1).

Targets the IMPLEMENTATION artifact packages/rlm/python/rlm_ledger/, not the
contract file. At RED time the module does not exist; these tests fail with
ModuleNotFoundError. Contract verification lives in
test_ledger_alignment.py (supporting, labeled).

CONTRACT AUTHORITY RECORD:
- File: requirements/contracts/rlm-ledger.contract.ts
- Authority: specification authority for the harness ledger
- PRE: 1, POST: 4, INV: 2, INV-LIFETIME: 2, ERRORS: 1, FORBIDDEN: 2

TSR (coordinator-issued, reference-faithful):
- module rlm_ledger defines __all__ exporting exactly: KINDS, SCOPES,
  SCHEMA_VERSION, ID_MAX_CHARS, OVERVIEW_PER_KIND, OVERVIEW_TRUNCATE_CHARS,
  OVERVIEW_REFINEMENTS, LOCAL_FILE, GLOBAL_FILE, ENTRY_VERSION_DEFAULT,
  REFINEMENT_PREFIX, RlmLedgerError, HarnessState
- HarnessState(session_dir=None, harness_state_dir=None, global_state_dir=None,
  agent_dir=None); explicit args override env resolution
- CRUD: create/update/delete_{memory,skill,subagent,prompt_note}
  create_<kind>(title, content, *, path="general", scope="local",
  reference=None, arguments=None, metadata=None, id=None, global_=False)
  update_<kind>(id, **fields); delete_<kind>(id)
- get(kind, id), list(kind), overview(), record_refinement(trigger, changes,
  evidence, outcome) — returns refinement id
- Corruption notice: logging WARNING naming the affected file
- Local file: <session_dir>/harness/harness_state.json;
  global file: <global_state_dir or agent_dir>/harness/harness_state.json
"""

import json
import logging

import pytest

from rlm_ledger import HarnessState, RlmLedgerError  # noqa: I001 — RED: ModuleNotFoundError expected


def make_state(tmp_path):
    """Object Mother: valid local+global HarnessState over tmp dirs.

    Satisfies PRE-LED-1 (valid construction) with per-test override via args.
    """
    return HarnessState(
        session_dir=str(tmp_path / "session"),
        global_state_dir=str(tmp_path / "global"),
    )


# ============================================================================
# PRE-LED-1 — kind membership + create-if-absent
# ============================================================================

@pytest.mark.parametrize("kind", ["prompt", "memory", "skill", "subagent"])
def test_pre_led_1_create_each_kind_persists_entry(tmp_path, kind):
    """
    CONTRACT TRACEABILITY:
    - Enforces: PRE-LED-1: CRUD operations name a valid kind (LED-V1)
    - Category: positive (equivalence class: all four kinds behave identically)
    - Risk tier: Medium — normal-operation path, correctable impact
    - Adversarial: Implementation-blind

    FOUR-CRITERIA TEST VALIDITY GATE:
    [x] C1 VALID: cites PRE-LED-1 in requirements/contracts/rlm-ledger.contract.ts
    [x] C2 VALUABLE: wrong kind routing (entry under wrong kind) fails this test
    [x] C3 NON-DUPLICATIVE: only test asserting per-kind persistence
    [x] C4 NOT FUTURE-EDIT: enforces current contracted kind set

    Audit F7: persistence checked per kind here too — a return-shaped dict
    with no store now fails (was left only to POST-LED-1's memory path).
    """
    state = make_state(tmp_path)
    method = getattr(state, f"create_{kind}" if kind != "prompt" else "create_prompt_note")
    entry = method("Title", "content")
    assert entry["kind"] == kind, (
        f"test_pre_led_1 FAILED\n"
        f"WHY: PRE-LED-1 violation — entry not recorded under the named kind\n"
        f"EXPECTED: kind == {kind!r}\n"
        f"ACTUAL: kind == {entry.get('kind')!r}\n"
        f"GUIDANCE: each create_<kind> MUST persist the entry under its own kind"
    )
    fetched = state.get(kind, entry["id"])
    assert fetched is not None and fetched["kind"] == kind, (
        f"test_pre_led_1 FAILED\n"
        f"WHY: PRE-LED-1 violation — {kind} entry not persisted\n"
        f"EXPECTED: get('{kind}', id) returns the entry\n"
        f"ACTUAL: {fetched!r}\n"
        f"GUIDANCE: create MUST persist, not just return a shaped dict"
    )


def test_pre_led_1_invalid_kind_raises_listing_kinds(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: PRE-LED-1 + ERRORS-LED-1: unknown kind raises naming valid kinds
    - Category: negative
    - Risk tier: Medium
    - Adversarial: Implementation-blind

    FOUR-CRITERIA GATE: C1 PRE-LED-1/ERRORS-LED-1 · C2 wrong error shape fails ·
    C3 only invalid-kind surface test · C4 contracted error, not hypothetical
    """
    state = make_state(tmp_path)
    with pytest.raises(RlmLedgerError) as excinfo:
        state.list("bogus")
    msg = str(excinfo.value)
    assert "prompt" in msg and "memory" in msg and "skill" in msg and "subagent" in msg, (
        f"test_pre_led_1_invalid FAILED\n"
        f"WHY: ERRORS-LED-1 violation — unknown-kind error must name the valid kinds\n"
        f"EXPECTED: message containing all of prompt|memory|skill|subagent\n"
        f"ACTUAL: {msg!r}\n"
        f"GUIDANCE: the error MUST list the four valid kinds so the caller can self-correct"
    )


# ============================================================================
# POST-LED-1 — save-on-mutate (SEQ-9 durability at the file surface)
# ============================================================================

def test_post_led_1_every_mutation_persists_immediately(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-LED-1: every mutation saves to disk immediately after the
      CRUD completes (SEQ-9)
    - Category: invariant (create → update → delete pipeline, one observable:
      file content tracks state after each mutation)
    - Risk tier: High — silent loss of durable model memory is unrecoverable
    - Adversarial: Implementation-blind

    FOUR-CRITERIA GATE: C1 POST-LED-1 · C2 save-deferral bug fails ·
    C3 single pipeline observation (not three duplicate tests) · C4 contracted

    Exercises all four kinds (audit F8: memory-only coverage was a theater
    gap — a kind-specific save omission now fails this test).
    """
    state = make_state(tmp_path)
    state_file = tmp_path / "session" / "harness" / "harness_state.json"

    creators = {
        "memory": state.create_memory,
        "skill": state.create_skill,
        "subagent": state.create_subagent,
        "prompt": state.create_prompt_note,
    }
    for kind, create in creators.items():
        entry = create(f"{kind} Entry", f"{kind} content", id=f"{kind}1")
        on_disk = json.loads(state_file.read_text())
        assert entry["id"] in on_disk["entries"][kind], (
            f"test_post_led_1 FAILED\n"
            f"WHY: POST-LED-1 violation — {kind} create did not persist immediately\n"
            f"EXPECTED: {entry['id']} in on-disk entries.{kind}\n"
            f"ACTUAL: keys == {sorted(on_disk['entries'][kind])}\n"
            f"GUIDANCE: each mutation MUST write the state file before returning"
        )
        create(f"{kind} Second", f"{kind} v1", id=f"{kind}2")

    # update surface: new content on disk immediately (audit re-run F5)
    state.update_memory("memory1", content="memory v2")
    assert json.loads(state_file.read_text())["entries"]["memory"]["memory1"]["content"] == "memory v2", (
        f"test_post_led_1 FAILED\n"
        f"WHY: POST-LED-1 violation — update did not persist immediately\n"
        f"EXPECTED: content == 'memory v2'\nACTUAL: stale on disk\n"
        f"GUIDANCE: updates MUST hit disk before returning"
    )

    # delete surface: gone from disk immediately
    state.delete_memory("memory2")
    assert "memory2" not in json.loads(state_file.read_text())["entries"]["memory"], (
        f"test_post_led_1 FAILED\n"
        f"WHY: POST-LED-1 violation — delete did not persist immediately\n"
        f"EXPECTED: memory2 absent on disk\nACTUAL: still present\n"
        f"GUIDANCE: deletes MUST hit disk before returning"
    )

    # refinement surface: refine_0001 on disk immediately
    state.record_refinement("t", "c", "e", "o")
    on_disk = json.loads(state_file.read_text())
    assert any(r["id"] == "refine_0001" for r in on_disk["refinements"]), (
        f"test_post_led_1 FAILED\n"
        f"WHY: POST-LED-1 violation — refinement did not persist immediately\n"
        f"EXPECTED: refine_0001 in on-disk refinements\n"
        f"ACTUAL: {on_disk['refinements']!r}\n"
        f"GUIDANCE: refinements MUST hit disk before returning"
    )


# ============================================================================
# POST-LED-2 — update preservation + version bump (FORBIDDEN-LED-1 at same
# observable surface; kept in one test per C3)
# ============================================================================

def test_post_led_2_update_preserves_omitted_fields_and_bumps_version(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-LED-2 + FORBIDDEN-LED-1: omitted path/reference/arguments/
      metadata preserved; version += 1; updated_at bumped
    - Category: boundary (partial update)
    - Risk tier: High — field loss is silent data loss in durable memory
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    state.create_memory(
        "Keep", "original",
        id="keep1", path="special", reference={"type": "python"},
        arguments={"a": 1}, metadata={"m": "x"},
    )
    updated = state.update_memory("keep1", title="Keep2")
    assert updated["path"] == "special", (
        f"test_post_led_2 FAILED\n"
        f"WHY: FORBIDDEN-LED-1 violation — omitted path lost on update\n"
        f"EXPECTED: 'special'\nACTUAL: {updated.get('path')!r}\n"
        f"GUIDANCE: omitted fields MUST be preserved verbatim"
    )
    assert updated["reference"] == {"type": "python"}, (
        f"test_post_led_2 FAILED\n"
        f"WHY: FORBIDDEN-LED-1 violation — omitted reference lost on update\n"
        f"EXPECTED: {{'type': 'python'}}\nACTUAL: {updated.get('reference')!r}\n"
        f"GUIDANCE: omitted fields MUST be preserved verbatim"
    )
    assert updated["arguments"] == {"a": 1} and updated["metadata"] == {"m": "x"}, (
        f"test_post_led_2 FAILED\n"
        f"WHY: FORBIDDEN-LED-1 violation — omitted arguments/metadata lost\n"
        f"EXPECTED: arguments={{'a': 1}}, metadata={{'m': 'x'}}\n"
        f"ACTUAL: {updated.get('arguments')!r}, {updated.get('metadata')!r}\n"
        f"GUIDANCE: omitted fields MUST be preserved verbatim"
    )
    assert updated["version"] == 2, (
        f"test_post_led_2 FAILED\n"
        f"WHY: POST-LED-2 violation — version must increment per update\n"
        f"EXPECTED: 2\nACTUAL: {updated.get('version')!r}\n"
        f"GUIDANCE: each update MUST bump version by exactly 1"
    )
    assert updated["updated_at"] > updated["created_at"], (
        f"test_post_led_2 FAILED\n"
        f"WHY: POST-LED-2 violation — updated_at not bumped\n"
        f"EXPECTED: updated_at > created_at\n"
        f"ACTUAL: {updated.get('updated_at')!r} <= {updated.get('created_at')!r}\n"
        f"GUIDANCE: updates MUST bump updated_at"
    )


# ============================================================================
# POST-LED-3 — sequential refinement ids
# ============================================================================

def test_post_led_3_refinement_ids_sequential(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-LED-3: record_refinement mints ids refine_0001… sequential
    - Category: positive (exact values, not ranges)
    - Risk tier: Medium
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    first = state.record_refinement("t1", "c1", "e1", "o1")
    second = state.record_refinement("t2", "c2", "e2", "o2")
    assert first == "refine_0001", (
        f"test_post_led_3 FAILED\n"
        f"WHY: POST-LED-3 violation — first refinement id wrong\n"
        f"EXPECTED: 'refine_0001'\nACTUAL: {first!r}\n"
        f"GUIDANCE: ids MUST start at refine_0001, zero-padded to 4 digits"
    )
    assert second == "refine_0002", (
        f"test_post_led_3 FAILED\n"
        f"WHY: POST-LED-3 violation — second refinement id wrong\n"
        f"EXPECTED: 'refine_0002'\nACTUAL: {second!r}\n"
        f"GUIDANCE: ids MUST be sequential refine_000N"
    )


# ============================================================================
# POST-LED-4 — overview shape
# ============================================================================

def test_post_led_4_overview_truncation_marker_and_refinements(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-LED-4: ≤20 entries/kind, '+N more' marker, 120-char
      content truncation, '[scope:id] title (path, vN)' lines, last 5
      refinements (LED-V4)
    - Category: boundary (21 entries on-point; 200-char content over boundary)
    - Risk tier: Medium
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    long_content = "x" * 200
    state.create_memory("LongOne", long_content, id="long1", path="p1")
    expected_render = "x" * 117 + "..."
    for i in range(20):
        state.create_memory(f"Filler{i}", f"c{i}", id=f"f{i:02d}")
    text = state.overview()
    assert expected_render in text, (
        f"test_post_led_4 FAILED\n"
        f"WHY: POST-LED-4 violation — 200-char content not truncated at 120 (117+'...')\n"
        f"EXPECTED: {'x' * 117}... (118 chars)\n"
        f"ACTUAL: truncation of long1 not rendered exactly\n"
        f"GUIDANCE: content > 120 chars renders first 117 chars + '...'"
    )
    assert "[local:long1] LongOne (p1, v1)" in text, (
        f"test_post_led_4 FAILED\n"
        f"WHY: POST-LED-4 violation — entry line format wrong\n"
        f"EXPECTED: '[local:long1] LongOne (p1, v1)'\n"
        f"ACTUAL: line for long1 not in exact '[scope:id] title (path, vN)' form\n"
        f"GUIDANCE: entry lines MUST use the exact bracket format with scope, id, path, version"
    )
    assert "+1 more" in text, (
        f"test_post_led_4 FAILED\n"
        f"WHY: POST-LED-4 violation — 21st entry must produce '+1 more' marker\n"
        f"EXPECTED: '+1 more' in overview\n"
        f"ACTUAL: marker absent (all 21 rendered or wrong count)\n"
        f"GUIDANCE: overview renders at most 20 entries/kind with exact '+N more' suffix"
    )
    for i in range(6):
        state.record_refinement(f"t{i}", "c", "e", "o")
    text = state.overview()
    assert "refine_0002" in text and "refine_0006" in text, (
        f"test_post_led_4 FAILED\n"
        f"WHY: POST-LED-4 violation — last 5 refinements must include 0002..0006\n"
        f"EXPECTED: refine_0002 and refine_0006 present\n"
        f"ACTUAL: recent refinements not rendered\n"
        f"GUIDANCE: overview shows exactly the last 5 refinements"
    )
    assert "refine_0001" not in text, (
        f"test_post_led_4 FAILED\n"
        f"WHY: POST-LED-4 violation — 6th-oldest refinement must be dropped\n"
        f"EXPECTED: refine_0001 absent\n"
        f"ACTUAL: refine_0001 still rendered\n"
        f"GUIDANCE: only the last 5 refinements appear"
    )


# ============================================================================
# INV-LED-1 — auto-id slug shape and length
# ============================================================================

def test_inv_led_1_auto_id_slug_and_cap(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-1: auto ids are [a-z0-9_] slugs ≤80 chars (LED-V3)
    - Category: boundary (80 on-point via long title; special chars stripped)
    - Risk tier: Medium
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    entry = state.create_memory("My Cool Tool!", "c")
    assert entry["id"] == "my_cool_tool", (
        f"test_inv_led_1 FAILED\n"
        f"WHY: INV-LED-1 violation — title not slugified to [a-z0-9_]\n"
        f"EXPECTED: 'my_cool_tool'\nACTUAL: {entry.get('id')!r}\n"
        f"GUIDANCE: auto ids slugify the title: lowercase, non-alnum → underscore"
    )
    long_entry = state.create_memory("T" * 100, "c")
    assert len(long_entry["id"]) == 80 and set(long_entry["id"]) <= set("t"), (
        f"test_inv_led_1 FAILED\n"
        f"WHY: INV-LED-1 violation — 100-char title must yield exactly 80-char id\n"
        f"EXPECTED: 80 chars of 't'\nACTUAL: len={len(long_entry.get('id', ''))}\n"
        f"GUIDANCE: auto ids cap at exactly 80 characters"
    )


def test_inv_led_1_non_alnum_title_rejected_not_empty_id(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-1: a title that slugifies to the empty string SHALL
      be rejected, never persisted under an empty id
    - Category: negative (equivalence class: no [a-z0-9] content at all)
    - Risk tier: Medium — empty id corrupts the id space silently
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    with pytest.raises(RlmLedgerError):
        state.create_memory("!!!", "c")
    persisted = state.list("memory")
    assert all(e["id"] for e in persisted), (
        f"test_inv_led_1 FAILED\n"
        f"WHY: INV-LED-1 violation — entry persisted under an empty id\n"
        f"EXPECTED: no empty-id entries\nACTUAL: {persisted!r}\n"
        f"GUIDANCE: non-slug titles must be rejected, not persisted"
    )


def test_inv_led_3_scope_immutable_on_update(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-3: scope is immutable post-create; update SHALL NOT
      relabel or move stores
    - Category: negative
    - Risk tier: High — scope/field divergence is silent state corruption
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    state.create_memory("LocalOne", "c", id="loc1")
    with pytest.raises(RlmLedgerError):
        state.update_memory("loc1", scope="global")
    fetched = state.get("memory", "loc1")
    assert fetched is not None and fetched["scope"] == "local", (
        f"test_inv_led_3 FAILED\n"
        f"WHY: INV-LED-3 violation — scope changed via update\n"
        f"EXPECTED: scope == 'local' after rejected update\n"
        f"ACTUAL: {fetched.get('scope')!r}\n"
        f"GUIDANCE: scope is chosen at creation and immutable afterward"
    )


def test_inv_led_4_list_and_overview_render_global_entries(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-4: list(kind) and overview() render both scopes;
      global entries appear as [global:id] lines
    - Category: positive
    - Risk tier: Medium — invisible global memory is silent data loss at the
      read surface
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    state.create_memory("Shared Thing", "gc", global_=True, id="shared1")
    listed = state.list("memory")
    listed_ids = {e["id"] for e in listed}
    assert "shared1" in listed_ids, (
        f"test_inv_led_4 FAILED\n"
        f"WHY: INV-LED-4 violation — global entry missing from list('memory')\n"
        f"EXPECTED: shared1 in list output\nACTUAL: {sorted(listed_ids)}\n"
        f"GUIDANCE: list renders both scopes"
    )
    text = state.overview()
    assert "[global:shared1] Shared Thing" in text, (
        f"test_inv_led_4 FAILED\n"
        f"WHY: INV-LED-4 violation — global entry missing from overview\n"
        f"EXPECTED: '[global:shared1] Shared Thing' line\n"
        f"ACTUAL: overview lacks the global line\n"
        f"GUIDANCE: overview renders global entries with the [global:id] prefix"
    )


def test_inv_led_lifetime_2_same_file_configuration_raises(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-LIFETIME-2: local and global stores SHALL have
      distinct files; same-path construction is a configuration error
    - Category: negative
    - Risk tier: High — aliasing one file as two stores self-clobbers
    - Adversarial: Implementation-blind
    """
    one_dir = tmp_path / "one"
    with pytest.raises(RlmLedgerError):
        HarnessState(session_dir=str(one_dir), global_state_dir=str(one_dir))


# ============================================================================
# INV-LED-2 — external modification reflected before next kernel access
# ============================================================================

def test_inv_led_2_external_write_visible_on_next_access(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-2: host-written and kernel-written state never clobber
      each other; external modification visible before next kernel-side access
      — reads AND mutations
    - Category: invariant (fault injection at the enforcement boundary: the
      external file write happens between kernel-side operations)
    - Risk tier: High — split-brain ledger loses host /refine writes
    - Adversarial: Implementation-blind

    Four surfaces in one pipeline: read (get), then each mutation kind —
    a store that reloads only on reads (the audited defect) fails at the
    create step because saving without reloading wipes the host entry.
    """
    state = make_state(tmp_path)
    state.create_memory("Mine", "kernel-side", id="mine1")
    state_file = tmp_path / "session" / "harness" / "harness_state.json"

    def inject_host_entry(marker: str) -> None:
        on_disk = json.loads(state_file.read_text())
        on_disk["entries"]["memory"][f"host_{marker}"] = {
            "id": f"host_{marker}", "kind": "memory", "title": f"Host {marker}",
            "content": "host-side", "path": "general", "scope": "local",
            "reference": None, "arguments": None, "metadata": None,
            "source": "agent", "version": 1,
            "created_at": "2026-08-15T00:00:00Z", "updated_at": "2026-08-15T00:00:00Z",
        }
        state_file.write_text(json.dumps(on_disk))

    # READ surface: external write visible at next get
    inject_host_entry("read")
    assert state.get("memory", "host_read") is not None, (
        f"test_inv_led_2 FAILED\n"
        f"WHY: INV-LED-2 violation — external write invisible at next read\n"
        f"EXPECTED: get('memory','host_read') returns the host entry\n"
        f"ACTUAL: None\n"
        f"GUIDANCE: the store MUST reflect external file modification before the next read"
    )

    # CREATE surface: a create after an external write must not wipe it
    inject_host_entry("create")
    state.create_memory("AfterHost", "c")
    survived = state.get("memory", "host_create")
    assert survived is not None and survived["title"] == "Host create", (
        f"test_inv_led_2 FAILED\n"
        f"WHY: INV-LED-2 violation — create clobbered a concurrent external write\n"
        f"EXPECTED: host_create entry survives the create + save round-trip\n"
        f"ACTUAL: {survived!r}\n"
        f"GUIDANCE: mutations MUST reload external state before saving"
    )

    # UPDATE surface
    inject_host_entry("update")
    state.update_memory("mine1", content="updated kernel-side")
    survived = state.get("memory", "host_update")
    assert survived is not None, (
        f"test_inv_led_2 FAILED\n"
        f"WHY: INV-LED-2 violation — update clobbered a concurrent external write\n"
        f"EXPECTED: host_update entry survives\nACTUAL: gone\n"
        f"GUIDANCE: mutations MUST reload external state before saving"
    )

    # DELETE surface: deleting one entry must not wipe others the deleter
    # never saw
    inject_host_entry("delete")
    state.delete_memory("mine1")
    survived = state.get("memory", "host_delete")
    assert survived is not None, (
        f"test_inv_led_2 FAILED\n"
        f"WHY: INV-LED-2 violation — delete clobbered a concurrent external write\n"
        f"EXPECTED: host_delete entry survives deletion of a different entry\n"
        f"ACTUAL: gone\n"
        f"GUIDANCE: mutations MUST reload external state before saving"
    )


# ============================================================================
# INV-LED-LIFETIME-1 — corrupt file: empty state + notice + clean recovery
# ============================================================================

def test_inv_led_lifetime_1_corrupt_file_notified_and_recovered(tmp_path, caplog):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-LIFETIME-1: corrupt/unreadable state file yields empty
      state AND emits a corruption notice naming the affected file; next save
      rewrites cleanly (F-108, CL15-D)
    - Category: invariant (fault injection: corrupt bytes at the load boundary)
    - Risk tier: High — silent data-loss masking
    - Adversarial: Implementation-blind
    """
    session_dir = tmp_path / "session"
    harness_dir = session_dir / "harness"
    harness_dir.mkdir(parents=True)
    state_file = harness_dir / "harness_state.json"
    state_file.write_text("{not valid json")

    with caplog.at_level(logging.WARNING, logger="rlm_ledger"):
        state = HarnessState(session_dir=str(session_dir), global_state_dir=str(tmp_path / "g"))
        assert state.list("memory") == [], (
            f"test_inv_led_lifetime_1 FAILED\n"
            f"WHY: INV-LED-LIFETIME-1 violation — corrupt file must yield empty state\n"
            f"EXPECTED: []\nACTUAL: {state.list('memory')!r}\n"
            f"GUIDANCE: unreadable JSON degrades to empty state, never raises"
        )
    notice = [r for r in caplog.records if "harness_state.json" in r.getMessage()]
    assert len(notice) >= 1, (
        f"test_inv_led_lifetime_1 FAILED\n"
        f"WHY: INV-LED-LIFETIME-1 violation — corruption not notified (CL15-D)\n"
        f"EXPECTED: ≥1 WARNING naming the affected file\n"
        f"ACTUAL: no corruption notice in log\n"
        f"GUIDANCE: the data loss MUST be observable — log a WARNING naming the file"
    )

    state.create_memory("Fresh", "after corruption")
    rewritten = json.loads(state_file.read_text())
    assert rewritten["schema"] == 1, (
        f"test_inv_led_lifetime_1 FAILED\n"
        f"WHY: INV-LED-LIFETIME-1 violation — next save must rewrite cleanly\n"
        f"EXPECTED: valid schema-1 JSON after recovery save\n"
        f"ACTUAL: {rewritten!r}\n"
        f"GUIDANCE: the first save after corruption replaces the bad file with valid state"
    )


# ============================================================================
# INV-LED-LIFETIME-2 — global routing (global_ kwarg + [global:id] prefix)
# ============================================================================

def test_inv_led_lifetime_2_global_kwarg_routes_to_global_file(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-LIFETIME-2: the global_ kwarg routes entries to the
      global scope (global is a reserved word)
    - Category: positive
    - Risk tier: Medium
    - Adversarial: Implementation-blind
    """
    state = make_state(tmp_path)
    entry = state.create_memory("Shared", "global content", global_=True)
    global_file = tmp_path / "global" / "harness" / "harness_state.json"
    local_file = tmp_path / "session" / "harness" / "harness_state.json"
    assert global_file.exists() and entry["id"] in global_file.read_text(), (
        f"test_inv_led_lifetime_2 FAILED\n"
        f"WHY: INV-LED-LIFETIME-2 violation — global_=True entry not in global file\n"
        f"EXPECTED: entry id present in {global_file}\n"
        f"ACTUAL: global file missing or lacks the entry\n"
        f"GUIDANCE: global_=True MUST persist under the global state file"
    )
    listed = state.list("memory")
    listed_scopes = {e["id"]: e["scope"] for e in listed}
    assert listed_scopes.get(entry["id"]) == "global", (
        f"test_inv_led_lifetime_2 FAILED\n"
        f"WHY: INV-LED-4 violation — global entry missing scope-true rendering in list\n"
        f"EXPECTED: {entry['id']} listed with scope 'global' (both scopes render)\n"
        f"ACTUAL: {listed_scopes!r}\n"
        f"GUIDANCE: list renders both scopes; global entries carry scope 'global'"
    )
    fetched = state.get("memory", f"[global:{entry['id']}]")
    assert fetched is not None and fetched["scope"] == "global", (
        f"test_inv_led_lifetime_2 FAILED\n"
        f"WHY: INV-LED-LIFETIME-2 violation — '[global:id]' prefix must resolve globally\n"
        f"EXPECTED: global-scoped entry via prefix selector\n"
        f"ACTUAL: {fetched!r}\n"
        f"GUIDANCE: the [global:id] prefix routes reads to the global store"
    )


# ============================================================================
# ERRORS-LED-1 — CRUD precondition failures
# ============================================================================

def test_errors_led_1_duplicate_create_and_missing_update_delete(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: ERRORS-LED-1: duplicate create / missing update / missing
      delete raise ValueError-equivalents naming the violated rule (LED-V2)
    - Category: error
    - Risk tier: Medium
    - Adversarial: Implementation-blind

    Audit F9: message content enforced for all three cases, not just
    duplicate.
    """
    state = make_state(tmp_path)
    state.create_memory("Once", "c", id="dup1")

    with pytest.raises(RlmLedgerError, match="already exists"):
        state.create_memory("Again", "c", id="dup1")

    with pytest.raises(RlmLedgerError, match="not found"):
        state.update_memory("missing1", title="x")

    with pytest.raises(RlmLedgerError, match="not found"):
        state.delete_memory("missing1")


def test_errors_led_1_hostile_on_disk_version_raises_domain_error(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: ERRORS-LED-1: malformed on-disk entry fields (non-integer
      version, booleans included) raise the domain error, not a raw TypeError
    - Category: error (durable-file boundary)
    - Risk tier: Medium — hostile/corrupt-but-parseable files are a durable
      trust boundary
    - Adversarial: Implementation-blind
    """
    session_dir = tmp_path / "session"
    harness_dir = session_dir / "harness"
    harness_dir.mkdir(parents=True)
    state_file = harness_dir / "harness_state.json"
    state_file.write_text(json.dumps({
        "schema": 1,
        "entries": {"memory": {"bad1": {
            "id": "bad1", "kind": "memory", "title": "Bad",
            "content": "c", "path": "general", "scope": "local",
            "reference": None, "arguments": None, "metadata": None,
            "source": "agent", "version": "one",
            "created_at": "2026-08-15T00:00:00Z", "updated_at": "2026-08-15T00:00:00Z",
        }}},
        "refinements": [],
    }))

    state = HarnessState(session_dir=str(session_dir), global_state_dir=str(tmp_path / "g"))
    with pytest.raises(RlmLedgerError):
        state.update_memory("bad1", title="x")


def test_errors_led_1_bool_version_rejected(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: ERRORS-LED-1 — version `true` (bool ⊂ int) is malformed, not 1
    - Category: boundary
    - Risk tier: Medium
    """
    session_dir = tmp_path / "session"
    harness_dir = session_dir / "harness"
    harness_dir.mkdir(parents=True)
    state_file = harness_dir / "harness_state.json"
    state_file.write_text(json.dumps({
        "schema": 1,
        "entries": {"memory": {"boolver": {
            "id": "boolver", "kind": "memory", "title": "Bool",
            "content": "c", "path": "general", "scope": "local",
            "reference": None, "arguments": None, "metadata": None,
            "source": "agent", "version": True,
            "created_at": "2026-08-15T00:00:00Z", "updated_at": "2026-08-15T00:00:00Z",
        }}},
        "refinements": [],
    }))
    state = HarnessState(session_dir=str(session_dir), global_state_dir=str(tmp_path / "g"))
    with pytest.raises(RlmLedgerError):
        state.update_memory("boolver", title="x")


def test_errors_led_1_reserved_update_field_raises_domain_error(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: ERRORS-LED-1 — invalid update arguments (reserved-field
      collisions) raise the domain error, not a raw TypeError
    - Category: negative
    - Risk tier: Medium
    """
    state = make_state(tmp_path)
    state.create_memory("T", "c", id="t1")
    with pytest.raises(RlmLedgerError, match="reserved"):
        state.update_memory("t1", kind="skill")
    with pytest.raises(RlmLedgerError, match="reserved"):
        state.update_memory("t1", version=5)


def test_inv_led_1_explicit_empty_id_rejected(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-1 — explicit empty id is equally invalid
    - Category: negative
    - Risk tier: Medium
    """
    state = make_state(tmp_path)
    with pytest.raises(RlmLedgerError):
        state.create_memory("T", "c", id="")
    assert all(e["id"] for e in state.list("memory"))


def test_inv_led_lifetime_2_symlinked_same_file_raises(tmp_path):
    """
    CONTRACT TRACEABILITY:
    - Enforces: INV-LED-LIFETIME-2 — path RESOLUTION, not lexical comparison;
      symlink-aliased dirs cannot alias one state file
    - Category: negative
    - Risk tier: High — inode-level aliasing self-clobbers
    """
    import os

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    os.symlink(real, link)
    with pytest.raises(RlmLedgerError):
        HarnessState(session_dir=str(real), global_state_dir=str(link))


# ============================================================================
# FORBIDDEN-LED-2 / REQ-RLM-0018 — public API surface exactly the documented
# shim (no agent loop, no credential surface)
# ============================================================================

def test_forbidden_led_2_public_api_exactly_documented():
    """
    CONTRACT TRACEABILITY:
    - Enforces: FORBIDDEN-LED-2 + REQ-RLM-0018: the Python store SHALL NOT run
      an agent loop or resolve provider credentials — observed as the module
      surface being exactly the documented shim API
    - Category: negative-space (exact set equality, deterministic)
    - Risk tier: Medium
    - Adversarial: Implementation-blind

    FOUR-CRITERIA GATE: C1 FORBIDDEN-LED-2/REQ-RLM-0018 · C2 adding any
    provider/loop API fails the exact-set assertion · C3 unique surface test ·
    C4 enforces the contracted prohibition, not a hypothetical
    """
    import rlm_ledger

    expected = {
        "KINDS", "SCOPES", "SCHEMA_VERSION", "ID_MAX_CHARS",
        "OVERVIEW_PER_KIND", "OVERVIEW_TRUNCATE_CHARS", "OVERVIEW_REFINEMENTS",
        "LOCAL_FILE", "GLOBAL_FILE", "ENTRY_VERSION_DEFAULT", "REFINEMENT_PREFIX",
        "RlmLedgerError", "HarnessState",
    }
    assert set(rlm_ledger.__all__) == expected, (
        f"test_forbidden_led_2 FAILED\n"
        f"WHY: FORBIDDEN-LED-2 violation — public surface differs from documented shim\n"
        f"EXPECTED: exactly {sorted(expected)}\n"
        f"ACTUAL: {sorted(rlm_ledger.__all__)}\n"
        f"GUIDANCE: the ledger is a state shim; any added public API (providers, "
        f"agent loops, credentials) violates REQ-RLM-0018"
    )
