# SLICE-8 amendment ledger (ketema/omp #15586, REQ-L15586-26)

Thin amendments under QS6 / FM-2.4, recorded for Ketema's review at acceptance.

| Date | Clause | Requirement IDs | Kind | Rationale |
|---|---|---|---|---|
| 2026-11-03 | SEQ-TOOL-2, FORBIDDEN-TOOL-3 (`contracts/rlm-tool.contract.ts`) | REQ-L15586-26, REQ-RLM-0014 | Addition (port) | Ported from oMACarchy's candidate commit 1af466aaac (candidate/rlm-rehydration). REQ-L15586-26 carries the fix only when the reproducing test fails on the Shared Commit; it fails on c888612e00 with `unknown flags: --OMP_RLM_AGENT_DIR, --RLM_KERNEL_VENV` (exit 2 instead of the missing-file exit 1). |
| 2026-11-03 | all `RLM_TOOL_CONTRACT` entries | REQ-RLM-0014 | Carrier normalization | Bare-string clause entries become `{ verification: 'test', text }` because design-by-contract requires a verification method on every clause of a substantively touched contract. Clause IDs and obligation text are unchanged. |
| 2026-11-03 | plans/rlm_cli_parameters.plan.yml | REQ-L15586-26 | Not carried | The candidate's separate plan file is not carried; SLICE-8 of `plans/15586-lock-loss.plan.yml` is the single plan for this work (CL11-C). Its amendment notes are kept in `plans/rlm_cli_parameters.amendments.md`. |

Contract gate: the contract is TypeScript, so the Python AST checker does not apply. Native check on the Mac: the contract imports, all 14 clauses declare a verification method, `validateRlmIsolationFlagValues` returns string values unchanged (including `@`-prefixed) and throws `RlmToolContractError` citing SEQ-TOOL-2 on a non-string value.
