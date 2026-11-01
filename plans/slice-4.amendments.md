# SLICE-4 Amendments Ledger (QS6 / CL4-A)

## 2026-10-31 — Batch 1 thin contract refinements (`c7d1271e69` → amended)

- **B1 (`python-mastery` compliance):** Removed `from __future__ import annotations`, adopted PEP 695 `type ClassificationKind = ...`, added `slots=True` to all `@dataclass(slots=True, frozen=True)` records, and made `entry_kind` keyword-only in `classify_resolved_target_pure`.
- **B2 (Fail-fast on unrecognized `entry_kind` / `entryKind`):** Both `classify_resolved_target_pure` and `validateClassificationRecord` now reject any `entry_kind` / `entryKind` outside `("file", "missing", "directory", "special")` by raising `RawIoClassificationMismatchError("POST-RAWIO-1", ...)` (CL9).
- **B3 (Clause singularity and deduplication):** Split `FORBIDDEN-RAWIO-1` into `FORBIDDEN-RAWIO-1` (`INV-L15586-02`: helper SHALL NOT open a SQLite connection) and `FORBIDDEN-RAWIO-1b` (`INV-L15586-03`, `REQ-L15586-08`: omp SHALL NOT fall back to an in-process file open when the helper is unavailable or fails), and removed the duplicate no-fallback phrase from `ERRORS-RAWIO-1`. Split `FORBIDDEN-RAWIO-2` into `FORBIDDEN-RAWIO-2` (`INV-L15586-13`: helper SHALL NOT run as an in-process thread or Worker) and `FORBIDDEN-RAWIO-2b` (`INV-L15586-12`: omp SHALL NOT receive a file descriptor opened by a Trigger Path from another process).
- **B4 (POSIX-only path scope):** Removed Windows drive-letter branches from `validate_target_path` / `validateTargetPath`; `PRE-RAWIO-1` requires a non-empty POSIX absolute path starting with `/` (macOS and Linux).
- **N1 (`REQ-L15586-31` citation alignment):** Removed `REQ-L15586-31` from `POST-RAWIO-1` (which contracts classification only); `REQ-L15586-31` and `SEQ-2`/`IP-2` tool-access ordering will be contracted in Batch 2 when `ReadTool` and `WriteTool` are wired.
- **N3 (`validate_helper_failure_error` exception class):** Changed empty-message rejection in `validate_helper_failure_error` / `validateHelperFailureError` to raise `RawIoClassificationMismatchError("ERRORS-RAWIO-1", ...)` instead of `RawIoHelperUnavailableError`.

## 2026-10-31 — Batch 1 RED review thin contract refinements (`51b6f1c738` → `CONTRACTS`)

- **B1 (`POST-RAWIO-2` public client and selector surface):** Added `POST-RAWIO-2` (`REQ-L15586-05`, `REQ-L15586-08`, `SEQ-5`, `SEQ-6`, `IP-2`), constants `RAW_IO_WORKER_SELECTORS_MODULE`, `RAW_IO_CLIENT_MODULE`, `RAW_IO_CLASSIFY_FN_NAME`, `RAW_IO_STOP_FN_NAME`, types `RawIoClassifyOptions` / `RawIoClientSurface` / `RawIoClassifyOptionsSpec`, and validator `validate_classify_options` / `validateClassifyOptions` so the helper selector, client entry point, fault-injection option `helperSpawnCommand.cmd`, and `stopRawIoHelper()` teardown are explicitly contracted before `RED`.
- **N4 (`POST-RAWIO-1` / `POST-RAWIO-1b` clause singularity):** Split `POST-RAWIO-1` into `POST-RAWIO-1` (classification rule and returned `RawIoTargetClassification` record, `REQ-L15586-05`, `IP-2`) and `POST-RAWIO-1b` (no descriptor closed inside `omp` and POSIX advisory locks retained across classification, `INV-L15586-01`, `REQ-L15586-05`, `REQ-L15586-28`).
- **N5 (`isEntryKind` type guard):** Replaced the `rawEntryKind as EntryKind` cast in `contracts/raw_io_helper.contract.ts` with a pure `isEntryKind(value: unknown): value is EntryKind` type guard (`typescript-mastery`).

## 2026-10-31 — Batch 2 CONTRACTS (`7c632c4379` → `CONTRACTS`)

- **Carry-over (`POST-RAWIO-2` split into `-2`, `-2b`, `-2c`):** Split `POST-RAWIO-2` into `POST-RAWIO-2` (worker-selector export and CLI dispatch), `POST-RAWIO-2b` (`classifyRawIoTarget`, `readRawIoBytes`, and `writeRawIoBytes` client functions with `helperSpawnCommand` and `timeoutMs`), and `POST-RAWIO-2c` (`stopRawIoHelper` teardown).
- **R1 (Helper timeout bound in `ERRORS-RAWIO-1` and `POST-RAWIO-2b`):** Added `RAW_IO_DEFAULT_TIMEOUT_MS = 5000` and `options.timeoutMs` validation in `validate_classify_options` / `validateClassifyOptions`; `ERRORS-RAWIO-1` explicitly contracts timeout failure naming the operation and target path without falling back to an in-process open (`REQ-L15586-08`, `INV-L15586-03`).
- **R2 & R3 (`POST-RAWIO-1` resolved-path suffix and missing-target classification):** `POST-RAWIO-1` explicitly specifies that non-regular/missing targets (`entryKind` in `'missing' | 'directory' | 'special'`) always return `kind=entryKind` with `isSqliteFamily=false` even when their path ends in `-wal`/`-shm`/`-journal`, and only existing regular files whose `resolvedPath` (never `targetPath` alone) ends in `-wal`/`-shm`/`-journal` return `kind='sqlite_sidecar'`.
- **Batch 2 `ReadTool` and `WriteTool` clauses (`POST-RAWIO-3`, `POST-RAWIO-3b`, `POST-RAWIO-3c`, `FORBIDDEN-RAWIO-3`):** Contracted out-of-process classification before any in-process open and `SQLite-Family` access exclusively via the Raw-I/O Helper or a SQLite connection for `ReadTool` (`POST-RAWIO-3`) and `WriteTool` (`POST-RAWIO-3b`), fast-path in-process access for `'non_sqlite'` files (`POST-RAWIO-3c`), and prohibition of any raw in-process file descriptor open/close on a `SQLite-Family File` (`FORBIDDEN-RAWIO-3`), plus pure validator `validate_tool_access_route` / `validateToolAccessRoute` (`REQ-L15586-05`, `REQ-L15586-31`, `SEQ-2`, `IP-2`, `INV-L15586-01`, `INV-L15586-04`).

## 2026-10-31 — Batch 2 RED review thin contract refinement (`ee906a9097` → `CONTRACTS`)

- **B3 (`POST-RAWIO-3c` observable seam for `non_sqlite` fast path):** Refined `POST-RAWIO-3c` so `ReadTool` and `WriteTool` honor an optional `session.rawIoHelperOptions: RawIoClassifyOptions` override (including `helperSpawnCommand` and `onRequest(entry: RawIoHelperRequestEntry)`), and added `RawIoHelperRequestEntry`, `VALID_HELPER_OPERATIONS`, and `validate_non_sqlite_helper_log` / `validateNonSqliteHelperLog` to verify that for a `'non_sqlite'` target the Raw-I/O Helper receives a `'classify'` request and zero `'read'` or `'write'` byte requests (`REQ-L15586-31`, `SEQ-2`, `IP-2`), without asserting lock loss on ordinary files.
- **B4 (`onRequest` firing guarantee and positive-control validator across `POST-RAWIO-2b`, `POST-RAWIO-3`, `POST-RAWIO-3b`, `POST-RAWIO-3c`):** Specified in `POST-RAWIO-2b` that `options.onRequest` is invoked exactly once for each request the Raw-I/O Helper receives across every operation (`'classify'`, `'read'`, `'write'`) with that request's `operation` and `targetPath`; specified in `POST-RAWIO-3` and `POST-RAWIO-3b` that `ReadTool` and `WriteTool` forward `session.rawIoHelperOptions` on every helper request and record `'read'` / `'write'` entries in `onRequest` for `SQLite-Family` helper targets; and added `validate_sqlite_family_helper_log` / `validateSqliteFamilyHelperLog` as the positive-control validator so `POST-RAWIO-3c`'s zero `'read'`/`'write'` assertion for `'non_sqlite'` files cannot pass on a silent hook.

## 2026-11-01 — T4/R1 = A timeout semantics (`b2a5319865` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "A for the timeout question")
- **`POST-RAWIO-2b` & `ERRORS-RAWIO-1` (`T4/R1 = A` + `B7`/`B8`):**
  - `classify` requests use a fixed limit (`options.timeoutMs`, default `RAW_IO_DEFAULT_TIMEOUT_MS = 5000` ms).
  - `read` and `write` byte requests transfer in bounded chunks (`RAW_IO_PROGRESS_CHUNK_BYTES = 65536`) and time out only when the helper makes no progress for `options.timeoutMs` (`RAW_IO_DEFAULT_TIMEOUT_MS = 5000` ms), where each `{type: 'progress', id, bytesProcessed}` message sent by the helper for the active request resets that request's no-progress timer.
  - Requests on a shared helper are dispatched serially; queued requests have no running timeout while waiting behind an earlier active request. When the helper begins the active request it emits `{type: 'started', id}`, which starts the fixed `options.timeoutMs` timer for `classify` and the no-progress `options.timeoutMs` timer for `read` and `write`; if `{type: 'started', id}` does not arrive within `options.timeoutMs` of the active request being sent to the helper, that also times out.
  - On a timeout, `omp` kills the helper subprocess (so a timed-out `write` cannot land after the error, and any other in-flight or queued requests on the shared helper also fail closed naming their operation and target path without falling back to an in-process open).
  - A timeout error names the operation and target path and, for a `write`, explicitly states that its outcome is unknown (`validate_helper_failure_error(..., timed_out=True)` / `validateHelperFailureError(..., { timedOut: true })` and `evaluate_timeout_semantics` / `evaluateTimeoutSemantics`; `REQ-L15586-08`, `INV-L15586-03`).

## 2026-11-01 — Contract alignment with approved `INV-L15586-01` (`Q-SLICE4-01 = B`, `3dab5ce720` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "B. is correct." / "Approved text.", following the approved requirement change in `requirements/REQUIREMENT_MANIFEST_15586_LOCK_LOSS.md`).
- **`POST-RAWIO-3`, `POST-RAWIO-3b`, `FORBIDDEN-RAWIO-3`:**
  - Aligned `POST-RAWIO-3` and `POST-RAWIO-3b` with `INV-L15586-01` and Ketema's `1a`/`2a` direction: `ReadTool` and `WriteTool` keep helper routing for every `SQLite-Family` target (including `-wal`, `-shm`, and `-journal` sidecars) as built, explicitly state that closing the tool's own SQLite connection is permitted (because SQLite retains `.db` and `-shm` locks across secondary connection closes), and retain every POSIX advisory lock SQLite holds on the database file and its `-shm` file, and every POSIX advisory lock `omp` holds on a `SQLite-Family` target that the tool accesses through the Raw-I/O Helper (`B9`).
  - Aligned `FORBIDDEN-RAWIO-3` to keep forbidding raw in-process descriptor opens/closes on `SQLite-Family` files during header sniffing, WAL-version inspection, editable-file header checks, and byte reads/writes while stating explicitly that a SQLite connection's own descriptors managed by SQLite are not raw descriptors (`INV-L15586-01`, `Q-SLICE4-01`).

## 2026-11-01 — Queued requests behind a timed-out request (`fb0e6862a2` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "queued requests should be retried. b.")
- **`ERRORS-RAWIO-1` & `POST-RAWIO-2b`:**
  - When a timeout kills the shared helper, only the active request that timed out fails (naming its operation and target path, and for a `write` stating that its outcome is unknown).
  - Requests still queued at the kill (which were never sent to the killed helper because requests are dispatched strictly serially) are dispatched once, in their original order, to a newly spawned helper (and `options.onRequest` fires once for each queued request when it is sent to the fresh helper).
  - A retried request that then fails or times out on the fresh helper fails with the usual error naming its operation and target path, with no second retry and no in-process fallback (`evaluate_timeout_semantics` / `evaluateTimeoutSemantics` validates `queued_requests_count` and `queued_action='retry_on_fresh_helper'`).

## 2026-11-01 - Acceptance of values no requirement names. Decided By: User (Ketema, verbatim: "read each. approved").

- `RAW_IO_DEFAULT_TIMEOUT_MS = 5000` (5,000 ms default timeout bound).
- `RAW_IO_PROGRESS_CHUNK_BYTES = 65536` (64 KiB chunk size for `read`/`write` progress).
- `{type: 'started', id}` and `{type: 'progress', id, bytesProcessed}` IPC messages and the pre-start timeout when `{type: 'started', id}` does not arrive within `options.timeoutMs`.
- Module specifiers (`RAW_IO_WORKER_SELECTORS_MODULE = '@oh-my-pi/pi-coding-agent/cli/worker-selectors'`, `RAW_IO_CLIENT_MODULE = '@oh-my-pi/pi-coding-agent/tools/raw-io-client'`), function names (`classifyRawIoTarget`, `readRawIoBytes`, `writeRawIoBytes`, `stopRawIoHelper`), and the worker selector `RAW_IO_WORKER_ARG = '__omp_worker_raw_io'`.
- The test seams (`options.helperSpawnCommand`, `options.timeoutMs`, `options.onRequest`, and `session.rawIoHelperOptions`).
- The classification labels (`'sqlite_db'`, `'sqlite_sidecar'`, `'non_sqlite'`, `'missing'`, `'directory'`, `'special'`), entry-kind labels (`'file'`, `'missing'`, `'directory'`, `'special'`), and the `R3` missing-target rule (non-regular/missing paths return `kind=entryKind`, `isSqliteFamily=false` even when ending in `-wal`/`-shm`/`-journal`).
- The POSIX absolute-path precondition (`PRE-RAWIO-1`: non-empty string starting with `/`).
- Retention of `omp`'s POSIX advisory locks on helper-accessed `SQLite-Family` targets (`B9` in `POST-RAWIO-3` / `POST-RAWIO-3b`).

## 2026-11-01 — Split `ERRORS-RAWIO-1` / `ERRORS-RAWIO-1b` (`B10`/`B11`), crash queue retry (`Q1 = a`), and 5s post-`SIGKILL` bound (`Q2 = b`) (`da88b9e34c` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "1-a, 2-b : 5 sec")
- **`B10` / `B11` (`ERRORS-RAWIO-1` split into `ERRORS-RAWIO-1` and `ERRORS-RAWIO-1b`):**
  - `ERRORS-RAWIO-1` (per-request error from a live helper): IF a live Raw-I/O Helper returns a per-request error for the active request, `omp` fails only that active request naming its operation and target path, leaves the live helper subprocess and any queued requests untouched, and does not fall back to an in-process open.
  - `ERRORS-RAWIO-1b` (helper-level failure: cannot start, crash, or timeout): covers helper-level failures with kill/replace and queued-request retry.
- **`Q1 = a` (Helper crash vs. queued requests):** When the helper crashes (exits or errors at the helper level while a request is active), only the active request fails; requests still queued behind it (which were never sent to the crashed helper) are retried once, in their original order, on a fresh helper, exactly as after a timeout.
- **`Q2 = b` (`RAW_IO_KILL_WAIT_TIMEOUT_MS = 5000`):** After sending `SIGKILL` to the helper on a timeout, `omp` waits at most `options.killWaitTimeoutMs` (default `RAW_IO_KILL_WAIT_TIMEOUT_MS = 5000` ms) for the helper to exit. If the helper exits within `killWaitTimeoutMs`, `omp` reports the timeout error as before; if the helper is still alive after `killWaitTimeoutMs`, `omp` reports the error anyway, and for a `write` states both that its outcome is unknown and that it may still land (`validate_helper_failure_error(..., helper_still_alive_after_kill=True)` / `validateHelperFailureError(..., { helperStillAliveAfterKill: true })` and `evaluate_timeout_semantics` / `evaluateTimeoutSemantics`).

## 2026-11-01 — Unstopped helper queue failure (`D1 = a`) and `ERRORS-RAWIO-1c` split with fixed `RAW_IO_KILL_WAIT_TIMEOUT_MS = 5000` (`D2 = a`) (`48fbad3f7f` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "1-a , 2-a")
- **`D1 = a` (Do not retry queued requests if killed helper has not exited within 5s):** If a timed-out Raw-I/O Helper has not exited within `RAW_IO_KILL_WAIT_TIMEOUT_MS` (`5000` ms) after `SIGKILL`, `omp` SHALL NOT retry queued requests on a fresh helper; instead it fails each queued request naming its operation and target path with an error stating that the previous helper could not be stopped. Queued requests are retried on a fresh helper only when the failed helper is confirmed gone (exited or crashed).
- **`D2 = a` (Remove `options.killWaitTimeoutMs`; split `ERRORS-RAWIO-1c` with `verification='tool'`):** Removed `options.killWaitTimeoutMs` so the post-`SIGKILL` wait is the fixed constant `RAW_IO_KILL_WAIT_TIMEOUT_MS = 5000`. Split the "helper still alive after the 5s kill wait" behavior (the `'may still land'` wording for a timed-out `write`, and `D1 = a` failing queued requests with `'could not be stopped'`) into `ERRORS-RAWIO-1c` with `verification='tool'` (code/validator inspection, since unprivileged user-space tests cannot make a process survive `SIGKILL`), while `ERRORS-RAWIO-1b` remains `verification='test'`.

## 2026-11-01 — Export `resolveTimeoutAfterKillWait` and verify `ERRORS-RAWIO-1c` by test (`8fa5a18cd2` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "a is correct")
- **`POST-RAWIO-2b` & `ERRORS-RAWIO-1c` (`verification='test'`):**
  - Contracted `resolveTimeoutAfterKillWait(input: { operation, targetPath, timeoutMs, helperExited, queuedRequests }) -> { activeError, retryQueueOnFreshHelper, queuedErrors }` (`RAW_IO_RESOLVE_KILL_WAIT_FN_NAME = 'resolveTimeoutAfterKillWait'`) on `@oh-my-pi/pi-coding-agent/tools/raw-io-client`, plus pure validator `validate_kill_wait_resolution` / `validateKillWaitResolution`.
  - Changed `ERRORS-RAWIO-1c` to `verification='test'` (verified by unit test calling the real exported `resolveTimeoutAfterKillWait` production function with `helperExited=false`, while `ERRORS-RAWIO-1b`'s tests exercise `helperExited=true` live; the wiring that passes `helperExited=false` after the 5s `RAW_IO_KILL_WAIT_TIMEOUT_MS` wait is checked by reading the code during the slice audit, because no unprivileged test can create a process that survives `SIGKILL`).
  - Identifier `RAW_IO_RESOLVE_KILL_WAIT_FN_NAME = 'resolveTimeoutAfterKillWait'`: Approved by Ketema 2026-11-01, verbatim: "Yes the name is fine."

## 2026-11-01 — Refuse new writes to a target while its timed-out helper has not exited (`G3 = a`, `9a36cf0b66` → `CONTRACTS`)

- Decided By: User (Ketema, 2026-11-01, verbatim: "yes. understood and accepted.")
- **`ERRORS-RAWIO-1d` (`G3 = a`, unbounded in-memory write block until old helper exits):**
  - While a timed-out `write`'s Raw-I/O Helper has not been observed to exit (tracked in-memory for the life of the `omp` process with no time cap; does not survive an `omp` restart), `omp` refuses any new `write` request to that same target path with an error naming `'write'` and the target path and stating that the previous helper is still alive and to fix the mount or restart `omp`, while allowing `read` and `classify` requests and `write` requests to other files to proceed on a fresh helper, and lifts the block when the old helper's exit is observed (`REQ-L15586-08`, `INV-L15586-03`).
  - `RAW_IO_REGISTER_UNEXITED_WRITE_FN_NAME = 'registerUnexitedWriteTarget'` and `blockFutureWritesToTarget` on `RawIoKillWaitResolution` (Decided By: Claude + oMACarchy — exported seam so tests can register an unexited write target with a controlled exit promise and verify the refusal and lift without mocking `omp` internals).
