# SLICE-1 Surface Inventory — validation perimeter enumeration

Companion to commit fixing audit-round-4 findings. Purpose: draw the
perimeter by ENUMERATION (every public surface × every clause family),
not by audit discovery. The next audit checks completeness against this
inventory; a surface missing here is a specification defect, not an
implementation freedom.

## Entry field universe (from create)

| Field | Type | Origin |
|---|---|---|
| id | str | create arg / auto-slug |
| kind | str | fixed set KINDS |
| title | str | create/update arg |
| content | str | create/update arg |
| path | str | create/update arg |
| scope | str | fixed set SCOPES, store-owned, immutable post-create |
| reference | dict \| None | create/update arg |
| arguments | dict \| None | create/update arg |
| metadata | dict \| None | create/update arg |
| source | str | reserved, impl-owned |
| created_at | str | reserved, impl-owned |
| updated_at | str | reserved, impl-owned |
| version | int (bool excluded) | reserved, impl-owned |

Health-check fields: ALL caller-settable fields (title, content, path,
reference, arguments, metadata, version). Reserved impl-owned fields
(id/kind/source/timestamps) are structurally guaranteed by load.

## Public surface × clause-family matrix

X = enforced at that surface. — = not applicable.

| Surface | ARG-TYPE (ERRORS-LED-1) | HEALTH (ERRORS-LED-1 retain-raise) | RELOAD (INV-LED-2) | SCOPE (INV-LED-3/4) | ID-VALID (INV-LED-1) | PERSIST (POST-LED-1) |
|---|---|---|---|---|---|---|
| create_{memory,skill,subagent,prompt_note} | X (title/content/path str; ref/args/meta dict\|None; id str non-ws; global_ bool) | — (entry is fresh) | X (before save) | X (routes by scope; stamps) | X (auto-slug non-empty; explicit non-ws; ≤80) | X |
| update_* | X (id str; field names reserved-guarded; field value types) | X (before mutation) | X | X (immutable; refuse change) | — | X |
| delete_* | X (id str) | — (removal is the remediation path; malformed entries MUST be deletable) | X | — | — | X |
| get | X (id str; unhashable caught) | X (before return) | X | — (returns stamped scope) | — | — |
| list | — (kind only) | X (every returned entry) | X | — (stamped at load) | — | — |
| overview | — (kind implicit) | X (every rendered entry) | X | X ([scope:id] lines) | — | — |
| record_refinement | X (4 strs) | — | X | — | — | X |
| HarnessState.__init__ | X (dirs str\|None; global_ distinct resolved paths) | — | — (initial load) | X (store ownership) | — | — |
| _Store.load | — | — (file-structure validation only; malformed FIELDS retained) | — | X (stamps scope) | — | — |

## Load-boundary file-structure validation (complete)

Corrupt at ANY of these levels → WARNING naming file + skip that unit
(whole file / kind bucket / entry), never a raw exception from __init__:

1. Whole file: unreadable, non-JSON, non-dict, wrong schema, entries non-dict,
   refinements non-list → empty state + WARNING (INV-LED-LIFETIME-1)
2. Kind bucket: non-dict value under a known kind → skip bucket + WARNING
3. Entry: non-dict value under an id → skip entry + WARNING
4. Entry FIELDS: retained (NOT dropped, NOT validated here) — raise the
   domain error on access per ERRORS-LED-1 (get/list/overview/update)
5. Refinement rows: non-dict → skip row + WARNING; dict → str-coerced fields
   tolerated (historical rows; no caller-facing lie possible)

## Remediation path for toxic entries

delete_* is the ONLY surface that does NOT health-check: deleting a
retained-malformed entry is the specified remediation (F8 resolution).
Clauses say "accessed or mutated" — deletion is removal, and a toxic
entry must be removable or the store has no recovery path.

## Dead code eliminated this round

- _update's version re-check after _check_entry_health (health covers it)
- duplicate _require_str(title) in auto-id branch
