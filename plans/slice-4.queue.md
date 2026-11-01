# SLICE-4 Decision Queue (QS6 / CL4-A)

## Q-SLICE4-01 — In-process `bun:sqlite` connection close vs `INV-L15586-01` lock retention on `-wal`

- **Status:** PARKED (awaiting Ketema's decision)
- **Date:** 2026-10-31
- **Dependent Clause IDs:** `POST-RAWIO-3`, `POST-RAWIO-3b`, `FORBIDDEN-RAWIO-3`
- **Dependent Test Assertion:** `afterReadWalLock.blocked === true` (`peerPosixWriteLockBlocked(walPath)`) after `ReadTool` executes structured SQLite reads on `dbPath` and `symlinkToDbTxt` in `packages/coding-agent/test/tools/raw-io-helper.test.ts` (Test 3).

### Conflicting Texts (Verbatim)

1. **`INV-L15586-01` (`requirements/REQUIREMENT_MANIFEST_15586_LOCK_LOSS.md`):**
   > `omp SHALL NOT close, inside the omp process, a file descriptor for a file opened by a Trigger Path.`
2. **`REQ-L15586-31` (`requirements/REQUIREMENT_MANIFEST_15586_LOCK_LOSS.md`):**
   > `WHILE a host file is classified as a SQLite-Family File, ReadTool and WriteTool SHALL access that target only through the Raw-I/O Helper or a SQLite connection, leaving ordinary files on the fast in-process path.`
3. **`POST-RAWIO-3` (`contracts/raw_io_helper.contract.py` / `.ts`):**
   > `When ReadTool receives a host file path, it forwards session.rawIoHelperOptions on every helper request, classifies the target out of process through the Raw-I/O Helper before any in-process file open, and accesses a SQLite-Family target only through the Raw-I/O Helper (recording a 'read' entry in onRequest) or a SQLite connection while retaining every POSIX advisory lock omp holds on that inode.`
4. **`FORBIDDEN-RAWIO-3` (`contracts/raw_io_helper.contract.py` / `.ts`):**
   > `ReadTool and WriteTool SHALL NOT open or close a raw in-process file descriptor on a SQLite-Family File (including during SQLite header sniffing, WAL-version inspection, editable-file header checks, or byte reads/writes).`

### Live Reproduction Evidence (Linux & macOS `bun:sqlite`)

- When `omp` holds a live WAL transaction on `dbPath` (`BEGIN IMMEDIATE`) and a POSIX record lock (`lockf(fd, F_TLOCK=2, 0n)`) on `${dbPath}-wal`:
  - Before a second `bun:sqlite` connection opens: `.db` write lock is `LOCKED` (`SQLITE_BUSY`), and `${dbPath}-wal` record lock is `LOCKED` (`EAGAIN` / `EACCES`).
  - When `ReadTool` (`readSqlite`) opens an in-process readonly `new Database(dbPath, { readonly: true })`, queries `sqlite_master`, and calls `db.close()`:
    - Inside `libsqlite3` (`os_unix.c`), `.db` and `-shm` descriptors are reference-counted in `unixInodeInfo` across connections in the same process, so `db.close()` does **not** close the `.db` or `-shm` descriptors and the WAL write lock on `dbPath` stays `LOCKED`.
    - However, because SQLite itself places WAL locks on `.db` and `-shm` rather than `-wal`, `libsqlite3` does **not** place `-wal` in `unixInodeInfo`: `db.close()` calls `sqlite3WalClose()`, which closes that connection's file descriptor on `${dbPath}-wal` inside the `omp` process, releasing any POSIX record lock `omp` held on `${dbPath}-wal` (`-wal` probe becomes `ACQUIRED`).

### Bounded Options for Ketema

- **Option A (Recommended): Run `ReadTool` / `WriteTool` SQLite-Family database queries and row mutations inside the out-of-process Raw-I/O Helper subprocess as well.**
  - *Effect:* `omp` never opens or closes any `SQLite-Family` file descriptor in-process (neither raw fd nor `sqlite3WalClose` `-wal` fd), satisfying `INV-L15586-01` unconditionally across `.db`, `-wal`, `-shm`, and `-journal`. Test 3 remains unchanged and passes completely.
- **Option B: Keep the in-process `bun:sqlite` connection for structured SQLite reads/writes and narrow the requirement/contract guarantee to the target's own inode / SQLite's `.db` and `-shm` locks.**
  - *Effect:* Preserves `REQ-L15586-31`'s in-process SQLite connection branch, amends `INV-L15586-01` / `POST-RAWIO-3` to permit `sqlite3WalClose()` closing the companion `-wal` fd when a secondary in-process SQLite connection closes, and reorders Test 3's `-wal` lock acquisition to after the `.db` reads.

### Recommendation

**Option A** — running structured SQLite tool reads/writes in the out-of-process helper subprocess eliminates the last in-process descriptor close (`sqlite3WalClose`) on `-wal` without relaxing `INV-L15586-01`.
