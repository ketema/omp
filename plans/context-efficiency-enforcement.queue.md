# Decision queue: context-efficiency-enforcement

Only Ketema unparks an entry. Work continues on clauses that do not depend on a parked clause.

## Q1: Kernel at session launch vs the session isolation contract (2026-11-05) - RESOLVED: option 3, decided by Ketema 2026-11-05


**Resolution:** Ketema chose option 3 ("I choose option 3. resource management is critical on this system."): start the kernel at launch only when the session owns an artifacts directory; in-memory sessions stay lazy. POST-CTX27-11 and REQ-CTX27-22 are amended accordingly. Any older clause that still fails for an owned-directory session is amended narrowly and recorded in the amendment ledger.
**Parked clause:** POST-CTX27-11 (REQ-CTX27-22): "When a top-level session starts, the IPython kernel is started before any user message or ipython call, so the workbench report exists and the restored helpers are bound."

**Conflicting text** (`contracts/rlm-session-isolation.contract.ts`, requirement REQ-RLM-REHYDRATE-003):

- POST-SESSION-NO-SIDE-EFFECT-1: "A lifecycle event (session_start, session_switch, session_branch) for a session with no owned artifacts directory creates NO filesystem entry and sends NO message into the host transcript: the host loads this extension in every unrestricted session, including in-memory ones that never use ipython. The fallback isolated directory is allocated, and its single rlm-warning emitted, only when a kernel is first constructed for that session ..."
- Other clauses whose tests fail when `session_start` constructs the kernel: POST-SESSION-NO-OWNED-DIR-ISOLATION-1, POST-SESSION-FALLBACK-ISOLATION-1, POST-SESSION-RESOLUTION-GATE-1, POST-SESSION-TRANSITION-GEN-1, POST-SESSION-SHUTDOWN-RACE-1, POST-SESSION-MOVE-3, POST-TOOL-SESSION-BINDING-1, ERRORS-TOOL-SESSION-CHANGED-1 (12 failing tests in `packages/rlm`, found by running the whole rlm suite against the uncommitted implementation).

**Why it is not thin:** relaxing POST-SESSION-NO-SIDE-EFFECT-1 removes a guarantee that REQ-RLM-REHYDRATE-003 backs, and the other clauses assume a lazy kernel.

**Dependent clauses:** POST-CTX27-9, POST-CTX27-10 and ERRORS-CTX27-3 in their committed form (RED commit `2636a82934`) assert the message after `session_start` alone, so they depend on this decision too.

**Options:**

1. Amend `rlm-session-isolation.contract.ts` narrowly: in a top-level session, `session_start` constructs the kernel after directory resolution and sends the one workbench message. Every other isolation guarantee stays (resolved directory only, one kernel per resolution, isolated fallback directory announced by its single rlm-warning). Cost: every top-level session starts a Python kernel even if it never uses ipython, and about 8 existing clauses and their tests change.
2. Keep the kernel lazy and send the workbench message when the kernel is first built, delivered at the next step boundary (`deliverAs: "aside"`). No conflict and no idle kernels. The model learns about its workbench only after its first ipython call, so REQ-CTX27-22 is dropped.
3. Start the kernel at launch only when the session owns an artifacts directory (a persisted session), and keep in-memory sessions lazy. This leaves POST-SESSION-NO-SIDE-EFFECT-1 intact for the sessions it names. Cost: some of the other clauses may still need amending.

**Recommendation:** option 1 if idle kernels are acceptable on this Mac, because it is the behavior Ketema asked for; option 3 if kernel count matters (about 77 Python processes were seen earlier).

**State of the work:** implementation edits to `tool.ts`, `workbench.ts`, `extension.ts`, `session_lifecycle.ts` are uncommitted in the worktree. Nothing is committed that fails an existing test.
