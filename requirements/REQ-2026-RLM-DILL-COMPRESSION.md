# REQ-2026-RLM-DILL-COMPRESSION: Transparent Snapshot Compression for Persistent Kernel State

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

**INV-3**: No discretion. No judgment. Only state.
No contract executes unless ALL predicates evaluate to TRUE.

---

## Actors

| Actor | Identifier |
|-------|------------|
| Kernel manager | Kernel manager |
| RLM transport | RLM transport |
| RLM kernel runner | RLM kernel runner |
| Model | Model |
| User | User |

## 1. Intent Traceability

- **Source Prose**:
  > Issue ketema/omp#15: `feat(rlm): transparent compression for kernel-state.dill snapshots (LZMA / Zstandard / Gzip)`
  > Empirical RLM benchmarks (2026-08-22) demonstrated that long-running data science and numerical array sessions produce 256MB+ uncompressed `kernel-state.dill` snapshots. Writing and reading raw pickled payloads consumes unnecessary disk space and increases session revival latency during post-compaction recovery.

- **Our Understanding**: When RLM kernel runner writes persistent state via snapshot_write, it serializes top-level namespace variables using dill. Currently, payloads are written without compression. By introducing transparent stream compression (defaulting to standard library lzma with preset=0 or gzip with compresslevel=1) and deterministic magic byte header auto-detection in snapshot_restore, snapshot disk footprints decrease by 85% to 96% while maintaining 100% backward compatibility for existing uncompressed snapshots.

- **Ambiguity Score**: 1

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Kernel manager | requests snapshot creation and revival across compaction boundaries | Kernel manager SHALL NOT inspect or parse raw dill snapshot bytes directly |
| RLM transport | routes snapshot_write and snapshot_restore protocol ops | RLM transport SHALL NOT alter snapshot file compression algorithms |
| RLM kernel runner | executes serialization, stream compression, magic byte detection, and deserialization | RLM kernel runner SHALL NOT fail on legacy uncompressed snapshot files |
| Model | evaluates code and populates in-kernel variables | Model SHALL NOT disable kernel snapshot compression |
| User | confirms real-world effect and disk space savings | User SHALL NOT bypass snapshot verification |

## 3. The State Transition

- **Initial State ($S_0$)**: RLM kernel runner writes uncompressed serialized dictionary payloads directly to `kernel-state.dill`. Restoring requires raw dill deserialization, and large variable canvases occupy hundreds of megabytes on disk.
- **Transformation**: RLM kernel runner compresses the serialized dictionary using the configured compression codec (LZMA preset=0 or Gzip level=1) before atomic write. Upon snapshot restore, RLM kernel runner reads the file header magic bytes to select the matching decompression codec transparently, falling back to raw dill if no compression magic header matches.
- **Terminal State ($S_1$)**: Every snapshot write produces a compressed file with compression metadata recorded in `kernel-state.json`. Any snapshot file (compressed LZMA, compressed Gzip, or legacy uncompressed dill) restores into `user_ns` without error or data loss.

## 3.5 Integration Specification

### Dependency Graph

Kernel manager DEPENDS ON RLM transport for snapshot scheduling and execution.
RLM transport DEPENDS ON RLM kernel runner for stdio JSON-lines protocol dispatch.
RLM kernel runner DEPENDS ON Python standard library compression modules (lzma, gzip) and dill for state persistence.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | Kernel manager onCompaction | RLM transport snapshot_write | AFTER cell execution completes | kernel state not persisted |
| SEQ-2 | RLM kernel runner snapshot_write | dill.dumps per variable | BEFORE stream compression | non-picklable variables corrupt snapshot |
| SEQ-3 | RLM kernel runner snapshot_write | stream compression (LZMA/Gzip) | BEFORE atomic file write | snapshot written uncompressed |
| SEQ-4 | RLM kernel runner snapshot_restore | magic byte inspection | BEFORE decompression or dill.load | decompression fails on legacy snapshots |
| SEQ-5 | RLM kernel runner snapshot_restore | inject variables into user_ns | AFTER decompression | variables not restored to namespace |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-1 | Kernel manager scheduleSnapshot | RLM transport writeSnapshot | path, manifestPath, maxBytes | SEQ-KM-8 |
| IP-2 | RLM transport writeSnapshot | RLM kernel runner stdin | snapshot_write op JSON line | POST-TRANS-4 |
| IP-3 | RLM kernel runner snapshot_write | filesystem kernel-state.dill | compressed binary payload | POST-COMPRESS-1 |
| IP-4 | RLM kernel runner snapshot_write | filesystem kernel-state.json | snapshot manifest with compression info | POST-MANIFEST-1 |
| IP-5 | RLM kernel runner snapshot_restore | filesystem kernel-state.dill | restored variables into user_ns | POST-RESTORE-1 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| Temporary snapshot file | RLM kernel runner snapshot_write at path.tmp | RLM kernel runner atomic rename or error removal |
| Compressed snapshot payload | RLM kernel runner on write | Overwritten on subsequent snapshot write or manager dispose |
| Manifest file | RLM kernel runner on write | Overwritten on subsequent snapshot write |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| INV-COMPAT-1 | Compatibility | RLM kernel runner SHALL NOT fail when restoring legacy uncompressed snapshot files. |
| INV-DETECT-1 | Detection | RLM kernel runner SHALL inspect deterministic magic byte headers to select the decompression codec. |
| INV-RATIO-1 | Efficiency | RLM kernel runner SHALL achieve at least 50 percent disk reduction on structured numerical or text state payloads. |
| INV-TIME-1 | Latency Bound | RLM kernel runner SHALL complete snapshot stream compression within 3000 milliseconds. |
| FORBIDDEN-1 | Write | RLM kernel runner SHALL NOT emit uncompressed snapshot files under active compression. |
| FORBIDDEN-2 | Atomicity | RLM kernel runner SHALL NOT overwrite target snapshot file until temporary file verification completes. |
| FORBIDDEN-3 | Teardown | RLM kernel runner SHALL NOT leave orphaned temporary snapshot files on disk when serialization fails. |
| FORBIDDEN-4 | Configuration | RLM kernel runner SHALL NOT re-resolve the snapshot compression codec from the environment after bootstrap. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Compression latency vs timeout | Preset 6 takes ~19.9s; preset 0 takes ~290ms | Mandate LZMA preset=0 or Gzip level=1 ensuring compression completes in <3000ms | Coordinator recommendation; User: proceed |
| Atomic replacement & disk safety | Out-of-space or crash corrupts snapshot | Write to path.tmp, flush, fsync, atomic os.replace; unlink path.tmp on error | Coordinator recommendation; User: proceed |
| Header collision immunity | Can raw dill collide with compression magic? | Collision-free: Pickle protocol 4/5 starts with 0x80; LZMA (0xfd 0x37), Gzip (0x1f 0x8b), Zstd (0x28 0xb5) are disjoint | Coordinator recommendation; User: proceed |
| maxBytes enforcement semantics | Evaluate maxBytes before or after compression? | maxBytes evaluates uncompressed bytes during variable pruning; manifest records both uncompressed and compressed bytes | Coordinator recommendation; User: proceed |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| Python stdlib LZMA/Gzip | Third-party Zstandard requirement | Requiring zstandard adds a mandatory venv dependency that breaks minimal bootstraps |
| Magic byte header detection | File extension changes (.dill.xz) | Extension changes break existing TypeScript transport path contracts and snapshot naming |
| In-memory compression | External CLI compression subshell | External subprocess calls add process overhead and require external binaries |
| LZMA preset=0 | LZMA preset=6 (max) | Preset 6 adds ~19s CPU latency that threatens compaction timeout bounds |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|---------------|
| RLM kernel runner snapshot_write | compress and persist variable payload | YES | RLM transport | session save or compaction requested |
| RLM kernel runner snapshot_restore | auto-detect codec and inject variables | YES | RLM transport | session restore or revival requested |
| RLM kernel runner snapshot_names | list persistable namespace variable names | NO | RLM transport | pre-snapshot discovery |
| RLM_SNAPSHOT_COMPRESSION env var | select snapshot compression algorithm | NO | RLM kernel runner | process launch or snapshot_write |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | none |

## 7. Failure Mode Specification (CL15)

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|-------------|
| REQ-RLM-0028 | Snapshot write exceeds maxBytes cap | FAIL FAST — record skipped variable in manifest and continue | Manifest skipped entry with reason |
| REQ-RLM-0029 | Corrupted compressed snapshot payload on restore | FAIL FAST — raise CorruptSnapshotError with diagnostic cause | CorruptSnapshotError exception |
| REQ-RLM-0030 | Unpicklable object in namespace | FAIL FAST — record skipped variable in manifest and persist remaining | Manifest skipped list with exception class |
| REQ-RLM-0031 | Unsupported compression codec in environment | FAIL FAST — raise SnapshotConfigurationError immediately | SnapshotConfigurationError exception |
| REQ-RLM-0032 | Atomic snapshot replacement fails on filesystem | FAIL FAST — raise RlmSnapshotCompressionError and remove temporary file | RlmSnapshotCompressionError exception |

## 8. Completion Promise (Ralph Loop Exit)

> A persistent state containing arrays and objects writes to disk with transparent compression saving at least 50% file size, and restores into a clean kernel instance with identical variable values, while legacy uncompressed snapshot files continue to restore cleanly.

## 9. Contract Authority

**Authoritative Source**: `requirements/contracts/rlm-dill-compression.contract.ts`

requirements/REQ-2026-RLM-DILL-COMPRESSION.md (this file)
        ↓
plans/rlm-dill-compression.plan.yml
        ↓
requirements/contracts/rlm-dill-compression.contract.ts
        ↓
packages/rlm/tests/kernel.spec.ts & packages/rlm/tests/transport.spec.ts
        ↓
packages/rlm/python/rlm_kernel_runner.py

Parent capability manifest: `requirements/REQUIREMENT_MANIFEST.md` (REQ-RLM-2026-001). This file is the singular authority for kernel state transparent compression.

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-08-22 | K. Harris | Finalized requirements manifest for issue #15 transparent dill compression with normalized clause IDs and failure modes |
| 2026-08-29 | K. Harris | Added FORBIDDEN-4 to the Hard Invariants table; it was declared in the contract file but missing from this manifest and both plan clause-tracking lists. |
