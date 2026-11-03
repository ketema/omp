# SLICE-4 Decision Queue (QS6 / CL4-A)

## Q-SLICE4-01 — In-process `bun:sqlite` connection close vs `INV-L15586-01` lock retention on `-wal`

- **Status:** RESOLVED — Option B
- **Decided By:** User (Ketema, 2026-11-01, verbatim: `'B. is correct.'`)
- **Date:** 2026-10-31 (resolved 2026-11-01)
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

### Resolution (2026-11-01)

- **Decision:** **Option B** (`Decided By: User`, Ketema, 2026-11-01, verbatim: `'B. is correct.'`; additional direction: `'Only cover reads that cause the error state we are trying to prevent'`, `1a` cover reads and writes, `2a` leave the `-wal`/`-journal` helper routing as built).
- **Supporting Evidence:**
  1. Upstream issue `#15586` states that opening and closing a second `bun:sqlite` connection in the same process does not drop the locks (`libsqlite3`'s `unixInodeInfo` retains `.db` and `-shm` descriptors and locks across secondary connection closes).
  2. Upstream PR `#15591` intentionally keeps the read tool's second `bun:sqlite` connection in-process.
  3. Live Mac and Linux probes confirm that SQLite holds POSIX `fcntl` locks only on `.db` and `-shm`, never on `-wal` or `-journal`.
  4. No `omp` source takes its own `lockf`, `fcntl`, or `flock` POSIX advisory lock on `-wal` or `-journal`.
- **Action Taken:** Narrowed `INV-L15586-01` in `requirements/REQUIREMENT_MANIFEST_15586_LOCK_LOSS.md` (`sha256:864d90616b2176293150547d3e44af553580225de6b1e00bf97503b6eef8a96d`) to prohibit reading or writing a SQLite database file or its `-shm` file through a raw file descriptor inside the `omp` process while keeping the `-wal`/`-journal` helper routing as built.
