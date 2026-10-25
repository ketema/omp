# Parked items: need a human decision (not repaired)

Source: in-session slice-completion audit of `f5611865` (PR #44). Each item below was NOT changed; no policy was relaxed.

## Findings 1, 3, 10: grammar / schema / traceability authority

**Observed (reproducible, read-only):**

- The governing plan schema is `~/.omp/agent/skills/req-elicit/plan_schema.py`, which imports `~/lib/clause_grammar.py`
  (the harness's own copy; `.claude` and `.agents` copies predate the grammar and accept the plan).
- Against it `plans/rlm_dill_resilient_restore.plan.json` returns 19 errors: `requirement_ids` absent on all 5 slices,
  clause IDs rejected in 13 fields, and `forgotten_invariants` shape.
- 37 of this slice's 43 contract clause IDs fail the grammar (a domain must be ONE segment, e.g. `POST-SESSION-MOVE-2` has
  two); the six `IP-N` IDs use the manifest-name prefix as a clause name; all 8 `REQ-RLM-REHYDRATE-00N` fail the
  requirement grammar. 108 of 110 pre-existing contract IDs on `origin/main` conform.
- `check_runtime_enforceable.py` (the contract skill's own checker) and the IEEE 29148 linter both pass.
- Slice-4/5 clauses all cite only `REQ-RLM-REHYDRATE-003`, and the manifest is still `Draft` with one commit.

**Why parked:** the repair is not thin. Canonicalizing 37+ IDs touches contracts, tests, plan, manifest and cited review
history, and changes cited identities; the traceability item changes requirement text. Both need a human decision.

**Options:**

1. Rename to the grammar (single-segment domains) and keep a legacy alias map (`POST-SESSION-MOVE-2` -> new ID) in the
   manifest so cited provenance (Copilot comment ids, commit messages) still resolves. Large, mechanical.
2. Keep the IDs and record an approved deviation from the grammar for this feature (needs your approval; it is a policy
   change, so I will not do it unprompted).
3. Treat the plan schema in `~/.omp` as not yet governing this repo's pre-existing artifacts (it is the harness's, not the
   repo's) and ratify which copy is authoritative.

**Recommendation:** option 1 behind a one-time alias map, after you ratify which schema copy governs.

**Decision needed from you:** which schema copy is authoritative, and option 1, 2 or 3.
