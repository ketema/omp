# RECONCILIATION MANIFEST — ketema/omp onto upstream HEAD

**Status**: DRAFT — AWAITING USER APPROVAL. NO CUSTOMIZATION REPLAYED.
**Date**: 2026-09-08
**Repository**: `/Users/ketema/projects/omp`
**Reconciliation worktree**: `/Users/Shared/agents/can1357/oh-my-pi/reconcile-upstream-2026-09-08`
**Upstream base**: `upstream/main` @ `d720e81fb7`
**Fork main**: `origin/main` @ `576fed41a8`
**Merge base**: `858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`

## Safety net

- Published backup tags: `backup/fork-main-pre-reconcile-2026-09-08T115746Z` and `backup/local-main-pre-reconcile-2026-09-08T115746Z`, both at `576fed41a8`.
- `rerere.enabled=true`; `rerere.autoupdate=true`; local main has zero unpushed commits.
- Local tag `v17.2.10` points at `3e2e715b09`; fork/upstream tag points at `43c1b245e7`. Never overwrite before separate disposition.

## Risk

| Measure | Value | Verdict |
|---|---:|---|
| Published fork commits outside upstream | 162 | HIGH |
| Patch-unique commits | 144 | HIGH |
| Upstream commits absent from fork main | 2,896 | HIGH |
| Direct merge conflict markers | 394 | PROHIBITS linear merge |
| Local-main-only commits | 0 | clean |

A direct merge, force-rebase, or 162-commit linear cherry-pick is rejected. Use latest-behavior thematic squash-rewrite groups with one user gate per group. Regenerate lockfiles; never hand-resolve them.

## Coordination lock

Gemini left-pane worktree `feat/pinned-dock-full-remediation` is protected. Draft-observed tip `a01c1e07d147` is under active final audit and may advance. Refresh before replay. Never rebase, amend, reset, or edit that worktree.

## PR CI diagnosis

### PR #35 — pinned composer
- Linux native test calls missing `MacOSPowerAssertion.start()`. Upstream `8308f52618` replaces it with cross-platform `PowerAssertion`; PR #35 lacks that commit.
- Lint has 12 Biome errors: formatting, unused viewport/contract imports, and four template-curly warnings. The protected remediation tip supersedes PR #35's implementation.

### PR #36 — IPython prompt guardrails
- Current head passes lint, singleton, UI, runtime, native-unit, workspace, CLI and Nix checks.
- Sole current failure is the same stale Linux `MacOSPowerAssertion.start()` test. Upstream `8308f52618` resolves it.
- Clean local v2 prompt tip `cae922caa9` supersedes the original traceability wording/history.

## Published fork-main groups (all 162 commits)

| Group | Intent | Count | Status | Strategy | Conflict | Depends on |
|---|---|---:|---|---|---|---|
| G01-RLM-IPYTHON | Published RLM/IPython, ledger, kernel, runtime, recursion, safety, timeout, compression and supporting CI state | 123 | still-relevant | split into dependency-ordered squash-rewrite subgroups | HIGH | upstream/main |
| G02-SSH-ASKPASS | FIDO/YubiKey SSH askpass restoration | 13 | still-relevant | adapt/squash-rewrite | MEDIUM | upstream/main |
| G03-NATIVE-MODIFIERS | macOS native modifier recovery and Shift+Enter handling | 6 | still-relevant | adapt/squash-rewrite | HIGH | upstream/main |
| G04-HYGIENE-DOCS | Runtime ignore and documentation additions | 2 | orthogonal | cherry-pick or rewrite | LOW | upstream/main |
| G05-UPSTREAM-SYNC-MARKERS | Historical upstream sync markers | 2 | superseded | drop only after user disposition | NONE | none |
| G06-FORK-MERGES | Historical fork merge topology | 16 | superseded metadata | drop merge commits only after user disposition | NONE | all groups |

## Independent protected/topic tips

| Group | Tip | Commits beyond fork main | Status | Strategy | Depends on |
|---|---|---:|---|---|---|
| G07-PINNED-SPAWN | `a01c1e07d147` | 25 | protected; audit active | squash-rewrite final audited state | G01, G03 |
| G08-IPYTHON-PROMPT | `cae922caa9` | 5 | still relevant; supersedes PR #36 wording | replay clean v2 delta | G01 |
| G09-SNAPSHOT-EXTRAS | `8819f7ae2c` | 4 unique of 25 | partially outside main | inspect/adapt four; 21 equivalents already in G01 | G01 |
| G10-TIMEOUT-BRANCH | `328d2540b4` | 3 | possibly superseded | compare behavior; user disposition | G01 |
| G11-SHELL-ENV-PARITY | `a4d35911c0` | 2 | unmerged, still relevant | replay RED/GREEN pair | G01 |
| G12-PROVIDER-FALLBACK | `6aee285c68` | 25 | independent remote topic | preserve as gated topic | G01 |
| G13-OLD-PROMPT | `0a1bbd31c4` | 4 | superseded by G08 | drop only after approval | G08 |
| G14-OLD-PINNED-TIPS | `89a29af3ac`, `38c59eadb4`, `3c0b3cb171` | contained by G07 | superseded | no separate replay after containment recheck | G07 |
| G15-ORIGIN-UPSTREAM | `7e54061cbb` | 25 | already in current upstream | no replay after ancestry recheck | upstream/main |

## Proposed replay order

1. G04 hygiene/docs.
2. Split G01 into ledger → kernel → runtime → recursion → engines → safety → timeout → compression → host/package integration; gate each subgroup.
3. G09 snapshot extras, G10 timeout disposition, G11 shell parity.
4. G02 askpass and G03 native modifiers.
5. G08 clean IPython prompt guardrails.
6. G12 provider fallback after upstream provider-schema comparison.
7. G07 final audited pinned dock + spawn-model last, after refreshing its protected tip.
8. G05/G06/G13/G14/G15 drop only after explicit user disposition and containment/range-diff evidence.

Every replay group: scoped compile/typecheck/tests; constitutional audit; preserved/adapted/dropped summary; explicit user approval before merge into reconciliation branch.

## Non-loss verification

- Full `packages/rlm`/IPython runtime remains present and executable.
- Task/eval per-spawn `model` remains; omission uses on-disk configuration.
- Pinned dock behavior matches the final audited Gemini tip.
- Askpass, native modifiers, provider fallback, snapshot extras, timeout branch, shell parity, ignore/docs all receive explicit disposition.
- Range-diff covers published fork main and every independent tip.
- Full tests and audit must be clean before promotion; promotion is a separate destructive approval gate.

## Appendix A — every published fork commit assigned exactly once

| SHA | Group | Subject |
|---|---|---|
| `c430acd792d34834f09d090882ef1d185e5674df` | G02-SSH-ASKPASS | Resolve SSH askpass so FIDO/YubiKey git pushes get a PIN prompt |
| `90b525e986c01e0040832d517d6aab2ac2a4fc33` | G01-RLM-IPYTHON | Add persistent harness ledger with specification-driven tests |
| `d0e2d00d789240d8459c9c8b81116e9cf1ecd649` | G01-RLM-IPYTHON | Fix ledger concurrency, scope, and rendering defects found in review |
| `fac89c429934aa7360e69dc67133d07759097ec1` | G01-RLM-IPYTHON | Harden ledger validation after second independent review |
| `fd92b62986aa74f34c786f420aa4519164095e4b` | G01-RLM-IPYTHON | Consolidate ledger validation into one boundary layer |
| `c527480a8b0893cbd53f29a80777f334ae8bb616` | G01-RLM-IPYTHON | Close the validation perimeter by surface inventory, not by audit |
| `b53055a172b31238f2f07dde7b4161bada8baeda` | G01-RLM-IPYTHON | Gate constructor arguments and the global flag unconditionally |
| `b4b8c9b4103c2f739d36397ea76de7660befff1a` | G01-RLM-IPYTHON | Add kernel environment bootstrap with specification-driven tests |
| `c0ed7b4a13c58e576a81dd496bae9341460e7fb7` | G01-RLM-IPYTHON | Make the interpreter gate real: evaluate probes, compare identities, hold the lock |
| `b9cf51e55d7a6fc933420ad52fe90264b488edb5` | G01-RLM-IPYTHON | Harden bootstrap lock and resolution chain against real-world I/O races |
| `1513a93685a0661bd0fd507b2f6b3a1abf28fb48` | G01-RLM-IPYTHON | Close bootstrap audit concerns: real-uv skill installs, atomic takeover, live fast-path gate |
| `e0c3e16a91b7fec1e8e5b58bd56f93fa7ab52ef9` | G01-RLM-IPYTHON | Add kernel manager with serialized execution and snapshot durability |
| `4e82ab398896c70fb42dd7f5f451375286991260` | G01-RLM-IPYTHON | Fix kernel dispose lifecycle, snapshot atomicity, and abort poisoning; add alignment gate |
| `c9c1d23d9a0c5b6cb5d4da9e569b046c78c0f785` | G01-RLM-IPYTHON | Register rlm package in workspace lock |
| `4a9712afbf42deb28b3dcd5631dec586b6687475` | G01-RLM-IPYTHON | Add real-kernel transport, ipython tool, and extension wiring (SLICE-4) |
| `65e9df98ed0de8314e946263c32150a9b63304f4` | G01-RLM-IPYTHON | Add SLICE-5 RED: rlm-runtime shell and MCP/skills runtime tests (failing) |
| `8c0ffefeb076c0fa8a3481c5bea1c619c086f342` | G01-RLM-IPYTHON | Fix RLM kernel interrupt: deliver SIGINT to the process, not an unreadable stdin op |
| `9697a6961987344c011c813148bbc4ec9d2ac416` | G01-RLM-IPYTHON | Wire RLM extension into omp (SLICE-4 registration touchpoint) |
| `a125cd7a8032e405bae1b20fd5d5da0d8de3120c` | G01-RLM-IPYTHON | Commit RLM-port CCABDD specifications (requirements, contracts, plan) |
| `881d02f612ac6fc21e8184db8c4d9f09a7fb999a` | G01-RLM-IPYTHON | Gate compliance: RED phase complete |
| `06c7b3546f1103050875a34a200ec8ea491375fc` | G01-RLM-IPYTHON | feat(rlm): implement rlm-runtime package and mid-execute host request bridge (SLICE-5) |
| `04e6e236290ec5d8a46c3dddc47f2231388373b2` | G01-RLM-IPYTHON | fix(rlm): remediate SLICE-5 audit findings for transport escalation and runtime isolation |
| `fbb984ac7fbbb636807a7a5817adcbd20578d90a` | G01-RLM-IPYTHON | test(rlm): strengthen ERRORS-TRANS-2 tail truncation and POST-RT-4 MCP assertions |
| `f4b3eef185e4365fa9c25f323bf8bb7d372a819c` | G01-RLM-IPYTHON | docs(contracts): link REQ-RLM-0017 to FORBIDDEN-RT-1 in rlm-runtime contract |
| `e86d82c99ac5d61b7ad4f7a33e036cd14ed68397` | G01-RLM-IPYTHON | style(rlm): align packages/rlm with python-mastery and typescript-mastery standards |
| `992e1c1ba2c23c305aeae16e2f7c54d988cc7d6d` | G01-RLM-IPYTHON | docs(contracts): add BR-V5 validateGoalCreate and clarify REQ-RLM-0006 multi-slice scope |
| `cda19fb3c86c70e665df8bbd16a975d9376b4702` | G01-RLM-IPYTHON | test(rlm): add SLICE-6 RED tests for recursion, handles, registry, and attribution |
| `c1f3b1aecbc73f700fbc02ff6b51e71ae104e5fa` | G01-RLM-IPYTHON | test(rlm): enhance SLICE-6 RED tests with behavioral lifecycle and sequence scenarios |
| `f168550e6e96f7d22a2c0a11445aa644cc6d71ba` | G01-RLM-IPYTHON | Implement RLM subagent recursion: admission engine, registry, model resolution, attribution |
| `8eff3bfb965db824c9ff37fd51ac1955282e7089` | G01-RLM-IPYTHON | fix(tests): handle embedded quotes in TS string extraction for test_recursion_alignment |
| `1abb4b51767dc4a6b0c57113998dd9a8b9cccd2f` | G01-RLM-IPYTHON | chore(rlm): commit uv.lock for rlm-runtime package |
| `bae737b70f2dd91d5e196b6e8874b5ded57edb5c` | G01-RLM-IPYTHON | fix(rlm): address SLICE-6 audit findings (lazy caching, AP-1, traceability) |
| `e457ac2ff3d035eb722b3375823ae2d96d514dd6` | G01-RLM-IPYTHON | fix(rlm): address non-behavioral audit findings (theater test, error context, dead code, imports, magic number) |
| `8fba6bd3362ded3dde4e8aa20035d4dca87dc5ef` | G01-RLM-IPYTHON | docs(contracts): add rlmChildId and parentSessionId correlation to attribution types (F9) |
| `7d41ea00c83755bd8ccf067f117df6e20df3af47` | G01-RLM-IPYTHON | test(rlm): add RED test asserting rlmChildId and parentSessionId attribution correlation (F9) |
| `4e97243c14daa7aacb07dc0a6b18a994e69c8714` | G01-RLM-IPYTHON | feat(rlm): implement rlmChildId and parentSessionId correlation in attribution events (F9) |
| `1864e050a3f44b8579904470099bc14445d1b460` | G01-RLM-IPYTHON | fix(rlm): address error classes for Gate 0 (plan), Gate 4 (theater), and Gate 7 (types) |
| `a18315c895f3a90c6615be4636a9142362450941` | G01-RLM-IPYTHON | docs(plan): mark SLICE-6 AUDITED after clean constitutional audit (ZERO VIOLATIONS) |
| `de1dd30b81cd37a512a8a2f07fa52640c2264263` | G01-RLM-IPYTHON | test(rlm): add SLICE-7 RED specification and alignment tests for 4 ported engines |
| `403e203225b2673577b516eeb48d6aed329d375a` | G01-RLM-IPYTHON | feat(rlm): implement SLICE-7 four ported engines (refine, heartbeat, message, observe, router) |
| `7936b07f8d5d7368c5447a2a2e7b22c9cde6450d` | G01-RLM-IPYTHON | feat(rlm): support flexible observe options in AgentObserveEngine |
| `d8c7f09d5cd54cd9a210583fa5ab42a91cd0ca9b` | G01-RLM-IPYTHON | docs(plan): mark SLICE-7 AUDITED after clean audit and 143/143 tests passing |
| `53ef466e59597049016a95c179d7ac9d9c698d27` | G01-RLM-IPYTHON | docs(safety): declare SAFE-V1 and SAFE-V2 in contract and plan scope |
| `02f2de8976f97fd257614ccf60b1a04a63a63e05` | G01-RLM-IPYTHON | test(rlm): add SLICE-8 RED specification and alignment tests for safety enforcement |
| `2cb9e9c1c97fcf8ed5c0e7eb385c37f4df4d201b` | G01-RLM-IPYTHON | feat(rlm): implement SLICE-8 safety enforcement (credential filtering, trust posture, model crossing) |
| `870660c4e32d68774ef1cbe67cc2d9b766ae49e5` | G01-RLM-IPYTHON | fix(contracts): restore POST-SAFE-2 in RLM_SAFETY_CONTRACT dictionary |
| `c27b6545528ea73e8daf757ff9ddd98246df364c` | G01-RLM-IPYTHON | fix(contracts): complete RLM_SAFETY_CONTRACT dictionary with all 13 clauses |
| `e4397f550af5e82958ba788d0bad74ceb59ee53c` | G01-RLM-IPYTHON | docs(plan): mark SLICE-8 AUDITED and overall RLM port COMPLETED |
| `fe7febac2ae2deb4b506dc00a66e684d8f2ee9bc` | G01-RLM-IPYTHON | docs(rlm): add IEEE 29148 requirement manifest and 4-slice plan for RLM biomimetic integration |
| `5430f336569a69bcf2fc1a6f0ec72659f6ca763a` | G01-RLM-IPYTHON | test(rlm): add RED phase host mount tests and contract specifications |
| `6dd7ec2170a748f644d1aa57112427ac6406c42d` | G01-RLM-IPYTHON | docs(rlm): add biomimetic state architecture reference |
| `fe9c736aa3ce295b210255c988ffe1e06c593d3e` | G01-RLM-IPYTHON | Gate compliance: RED phase complete |
| `4599666a99b357e25932ebf1325f78b1d6a33ca5` | G01-RLM-IPYTHON | Mount RLM tool factory in host session assembly |
| `47194c7d6d81a6c91aadabb56a62d36d2a4f90db` | G01-RLM-IPYTHON | style(sdk): organize imports per biome rules |
| `a700632813ef61f16a3d571fee4432bcd8db747b` | G01-RLM-IPYTHON | refactor(contracts): address post-implementation audit clarification findings |
| `403320377031a11f6f3ac64a1b41657fe11ae40c` | G01-RLM-IPYTHON | test(rlm): add RED phase tests for top-level native ipython pinning |
| `b9852725d76eb3f9832c4ddd22e91e2883f547d2` | G01-RLM-IPYTHON | feat(rlm): pin native ipython tool essential and top-level |
| `fc625ba6770e616ef75447c8952bc25c558054fc` | G04-HYGIENE-DOCS | chore(gitignore): ignore RLM kernel-state files and runtime artifacts |
| `b37f8de038c5e6baafe99daec3de6dc59c6b7c62` | G01-RLM-IPYTHON | fix(contracts): correct keyword argument mismatch in native tool validator |
| `019752296b0692c858f809040454e7a04ec84463` | G01-RLM-IPYTHON | refactor(contracts,tests): address native-tool re-audit findings |
| `f570d763f6ed2d4dbcd11975e71a5501a9e674f9` | G01-RLM-IPYTHON | refactor: address round-2 native-tool re-audit findings |
| `af7b43b32f29c5bac6e1e19c121d9736968bcaca` | G01-RLM-IPYTHON | docs(changelog): document RLM ipython capability in coding-agent unreleased notes |
| `de915e8cca9ef8caf6c0d8c8230874fee62f53ea` | G01-RLM-IPYTHON | ci: upgrade actions to Node 24 and fix CI type check and install smoke |
| `73e5b6c51c863b39e750cdbccbd6421fdeda79ff` | G01-RLM-IPYTHON | build(rlm): add rlm tsconfig and publish package configuration |
| `2df1e779d04958339588a72439e860bebfb39137` | G01-RLM-IPYTHON | fix(rlm): guard session_start eager kernel startup against missing uv |
| `ecde52cdd95b37f85b21c9bc52ba7d6c702bbdb4` | G01-RLM-IPYTHON | chore(lockfile): update bun.lock for @oh-my-pi/pi-rlm@17.3.8 |
| `29f2bb81195f611d935a9edf211cb7420abbef80` | G01-RLM-IPYTHON | fix(ci): restore package.json writeFileSync for tarball overrides in install smoke |
| `000c631b981753cf348162e9baa806a88525c5e6` | G06-FORK-MERGES | Merge pull request #1 from ketema/feature/rlm-port |
| `5edb3dfdda3bf168870b952608b8ceb4bb320e20` | G01-RLM-IPYTHON | fix(rlm): embed Python runner assets and extract on-disk for standalone binary |
| `4743ecdc1fe218e0a3d8b508e43c54f1507a2d9b` | G06-FORK-MERGES | Merge pull request #2 from ketema/fix/rlm-embedded-assets |
| `151d1af0a564d717a040df46421b80b2bbe3b13f` | G01-RLM-IPYTHON | test(rlm): add unit tests for embedded assets and harden atomic extraction |
| `b1a559b424696992ef832738f08b5435c777fb89` | G06-FORK-MERGES | Merge pull request #3 from ketema/test/rlm-embedded-assets-spec |
| `bc6242303ff608f2bad79be5bf93a6f28575ac62` | G01-RLM-IPYTHON | fix(rlm): kernel execute() wall-clock timer (REQ-RLM-0023/0024) |
| `53d837b6620748989b589e99c106a95735793cb9` | G01-RLM-IPYTHON | fix(rlm): resolve Copilot F2 coverage gap; full IEEE 29148 compliance on parent manifest |
| `6430b1e839cd7cfb67f173ad8e23dc34089bbf24` | G06-FORK-MERGES | Merge pull request #5 from ketema/fix/rlm-execute-timeout |
| `54dc9c32dc57bc32bac5d418f05967fa3c846060` | G01-RLM-IPYTHON | test(rlm): RED for FORBIDDEN-KM-5 — abort-settled timer must not touch a later execute |
| `fcb74229e1409b57894d40a5dfe314a4904bd8d0` | G01-RLM-IPYTHON | fix(rlm): cancel execute timer on abort/grace settle (FORBIDDEN-KM-5, closes #6) |
| `a3470474d6cad0ac9e1e4e20ec2dec8e947ee07c` | G01-RLM-IPYTHON | test(rlm): abort-grace must not settle a later execute |
| `0e6fced46fdbdbe15917b165c7fcd327cf99d18c` | G01-RLM-IPYTHON | fix(rlm): abort-grace only settles the aborted execution |
| `cc1fcd1258f99964168ac48cba0b54b93cdae1ea` | G01-RLM-IPYTHON | style(rlm): format guard condition in abort grace callback |
| `4804b4fc2c6290c7904a04ef8846170a9312defa` | G06-FORK-MERGES | Merge pull request #7 from ketema/fix/rlm-abort-timer-cancel |
| `8088cb288d3e270b239b3e9d1602116a21372c34` | G01-RLM-IPYTHON | Mark RLM timeout plan complete |
| `096656c5823a5f4dfdaac5731a9789511308856c` | G06-FORK-MERGES | Merge pull request #9 from ketema/chore/rlm-timeout-plan-status |
| `262651241b450de61bb1d2f126863932722a0c3d` | G05-UPSTREAM-SYNC-MARKERS | Merge upstream v17.4.0 |
| `7a32a7f85fe4f416210a708d39f46cdd35eead11` | G06-FORK-MERGES | Merge pull request #11 from ketema/chore/sync-upstream-v17.4.0-signed |
| `f56010747dd667136614c919640b62312adbca8d` | G01-RLM-IPYTHON | test(rlm): add failing test for sequential execute after timeout desync (closes #12) |
| `c185824ef46aa019f1d8cb9d1a7bb8cd55419da8` | G01-RLM-IPYTHON | fix(rlm): synchronize transport execution state across timeouts and interrupts (closes #12) |
| `b6c7d02c9edb3d9330334b6ed321c5e7fad222fc` | G01-RLM-IPYTHON | docs(rlm): formalize IEEE requirements, plan schema, and CL12 contracts for issue #12 |
| `55aba4d5ab958d99a9482a062509e9f25ffd3bda` | G06-FORK-MERGES | Merge pull request #18 from ketema/fix/12-kernel-timeout-desync |
| `abfc74f21c6efd8fc796be6400a771441eb62460` | G01-RLM-IPYTHON | fix(rlm): guard snapshot flush during dispose on unstarted transport (SEQ-KM-4) |
| `79e1b737b8bd8661d4387d34df339fa9e5208f0e` | G01-RLM-IPYTHON | fix(#20): address review findings F1-F3 on contract enumeration, HOME fallback, comment parity |
| `12e68ed200ab42eff29df4fd8a791022c7320a86` | G06-FORK-MERGES | Merge pull request #20 from ketema/fix/rlm-unstarted-transport-dispose-hang |
| `312b41bf546d16097a33676bf46982ed40565975` | G05-UPSTREAM-SYNC-MARKERS | chore(upstream): merge upstream v18.0.4 into fork |
| `643f860204ac18cca2809bce57712956b40e3bd7` | G06-FORK-MERGES | Merge pull request #24 from ketema/sync/upstream-v18.0.4-signed |
| `1d702704b354a499e72703538f68e57ab6f8dc29` | G01-RLM-IPYTHON | test(rlm): formalize requirements, contracts, and adversarial tests for issue #15 |
| `ab44b8f1761dd9000e5f93d775e008f9df14cdab` | G01-RLM-IPYTHON | fix(rlm): implement transparent snapshot stream compression with magic auto-detect |
| `425e9872bfad28eb4b9800d27d7fd14876b2a896` | G01-RLM-IPYTHON | fix(rlm): address peer audit findings for fail-fast manifest write and wire telemetry |
| `f96c3b31f0cd951534a44b494e984c486384c347` | G01-RLM-IPYTHON | fix(#19): address review findings F1-F8 |
| `541beded5c07eea99a8b822e37ba08f7a02cef68` | G01-RLM-IPYTHON | refactor(rlm): stream compressed binary data directly to disk through lzma/gzip file interfaces |
| `bf083d1b3fa642cf15a861aa8b614120f3a12861` | G01-RLM-IPYTHON | fix(rlm): harden atomic manifest write, environment propagation, and test integration |
| `fb8fd58d1de3b8e5f11972528d9fef45dcaf7ce9` | G01-RLM-IPYTHON | fix(rlm): address peer review findings F9-F12 |
| `5c94d31304665674f8655c203356dc25a10f262f` | G01-RLM-IPYTHON | fix(ci): format kernel and transport with biome and align workspace test packages |
| `3c880bd9f8c9b7420df0961b240eddae3bbcf6f0` | G01-RLM-IPYTHON | fix(rlm): address copilot review findings for truncated header, atomic restore, and transport suite restoration |
| `2e95c0b3d9968bc91ccbf54e7ee4e0c7d0d5837f` | G01-RLM-IPYTHON | fix(rlm): address latest copilot review findings for stream counting, exact prefix matching, and manifest duration |
| `f10ce0f412d8b49704c4ba418a790422cefd36e7` | G01-RLM-IPYTHON | fix(rlm): enforce total schema parity and duration validation in snapshot contract |
| `5504f9cd16e384739355cbfd6b18d17def48b840` | G01-RLM-IPYTHON | test(rlm): enforce 100% clause traceability for POST-SNAP-TIME-1 and IP-2 |
| `060e5d93bf115010438a05632a9fc174c585cd4b` | G01-RLM-IPYTHON | fix(rlm): address copilot review batch across coupled commit, contract strictness, and fail-loud testing |
| `447ee29b9a1b8d54cd313bc0cbd6d86294169f45` | G01-RLM-IPYTHON | fix(rlm): address latest copilot review batch across namespace import, restore validation, dynamic lzma, and ci bucket |
| `29536f50575c5ed1962547e97f68c3c3ec3a142e` | G01-RLM-IPYTHON | fix(ci): add self-healing uv installation to setup-system-deps and cross-platform test cleanups |
| `c063f6ddf7700c28277311ae9c92091b167f0dcc` | G01-RLM-IPYTHON | fix(rlm): enforce direct atomic replace and auto-compression fallback mode |
| `46f87ec2e991c74643f11e3112a13125d362b9a6` | G01-RLM-IPYTHON | fix(rlm): guard sigint handler with active execution state tracking |
| `cb17c603e2705e53c42e5261f4c277875b00bbf6` | G01-RLM-IPYTHON | test(rlm): add KernelManager manifest compression telemetry test and pin uv installer |
| `86657db5e5433c1a2e0ff668effa3542352c9ebb` | G01-RLM-IPYTHON | fix(rlm): detect IPython-internal KeyboardInterrupt and cleanup ephemeral test venv |
| `f6283ce671aa70a840e344250e426843ea08f18a` | G01-RLM-IPYTHON | fix(rlm): protect full execution-state transition and surface error_before_exec |
| `3a75982b357b5177ad0f3a72e3b49ee1cb94332c` | G01-RLM-IPYTHON | fix(rlm): deterministic POST-TRANS-3 sync + remove non-null assertion (skill compliance) |
| `97321611f2de5be40d1c561be9d14840509ead2a` | G01-RLM-IPYTHON | fix(rlm): directory fsync, monotonic clock, Bun.which(), and process-leak teardown |
| `d15e52e0499ba0bb273e4fade3d5ce9bafe9158e` | G01-RLM-IPYTHON | fix(rlm): deterministic bootstrap round-trip test and typed assertions across compression/transport specs |
| `5912e9cfcdc542f01d0278ace77ad5d8ecd21e1d` | G01-RLM-IPYTHON | fix(rlm): use Bun.sleep() instead of a manual setTimeout promise in the bootstrap wire test |
| `8d63d0c7c902713a598dcf3d0a1f3d7ae33a4dca` | G01-RLM-IPYTHON | fix(rlm): freeze snapshot codec at bootstrap and eliminate the payload-absent rollback window |
| `161444f12066bb0909c5fdcd0ad6c0f95a120e1b` | G02-SSH-ASKPASS | Specify OMP askpass restoration |
| `640fd0ca93e35b837b7f6c9655ad7d993685bd7d` | G02-SSH-ASKPASS | Define OMP askpass restoration behavior |
| `a8cd86da6f772ec3c0f33e4ef2e73666b3c63908` | G02-SSH-ASKPASS | Plan OMP askpass source restoration |
| `a3b448c76145480c299a632bc47755befe1cffd9` | G02-SSH-ASKPASS | Activate OMP askpass restoration plan |
| `f90054999fcb6fb50a66a626eefa4398ed265392` | G02-SSH-ASKPASS | Add askpass environment regression tests |
| `434a660f85bc4407936368274501d918cdb593ab` | G02-SSH-ASKPASS | Restore OMP native askpass resolver |
| `dc11740dfe712b9491886d650fb9ef01d3860ea7` | G01-RLM-IPYTHON | Verify rlm-runtime dependency before running the compression test suite |
| `75c51e1e8cc5a6b5a09f4f613144397646e82e6c` | G01-RLM-IPYTHON | Track the codec-freeze invariant and align clause identifiers with the naming format |
| `a6176104f178b5d2ff2f04b7313b4e373b7ba51d` | G01-RLM-IPYTHON | Pin Python 3.14 for snapshot compression and add cold-start guards for Julia evaluation |
| `e570529a4558d9540a20bc4607f9fcb784712141` | G01-RLM-IPYTHON | Scope snapshot restore atomicity guarantee to dictionary binding atomicity |
| `a56f565e3918dbe8099dcbb2bda0f7cd8879e81a` | G01-RLM-IPYTHON | Fail fast with diagnostic error when Python runtime is unavailable |
| `b5f6134738518fe200b7810a8578e1f96d9f86a9` | G06-FORK-MERGES | Merge pull request #19 from ketema/fix/15-dill-compression |
| `4c6eb893a742b90bba48ba5e0ac3a7331bc7d5a9` | G03-NATIVE-MODIFIERS | test(tui): cover native modifier recovery |
| `08c8584227ae51b1a015b0aeb2eda45b348cea95` | G03-NATIVE-MODIFIERS | feat(tui): recover Shift+Enter from macOS modifier state |
| `4b2740cef6fa2f876562377fc097092ff588386c` | G03-NATIVE-MODIFIERS | fix(tui): recover Shift+Enter before paste classification |
| `ccdbfac10b2fa7df9a9d5757ce457a760eb6a346` | G01-RLM-IPYTHON | test(tui): await buffered ordinary Enter delivery |
| `debaae01515a2b27e750d5f08137759e4ca1c797` | G01-RLM-IPYTHON | refactor(tui): trim duplicate types and the FFI-level test mock |
| `b3f9cfdf6fd061832bbb2bb3775c7c21e60c2602` | G01-RLM-IPYTHON | test(tui): close contract identity, precondition, sequencing, and mock-coverage gaps |
| `65e2ced530d097fb17610fd83e94c98b112062e3` | G03-NATIVE-MODIFIERS | spec(tui): contract the CoreGraphics provider independently of its wrapper |
| `77f840eb7b1e22cb3925b1b54803f9a244b108a8` | G03-NATIVE-MODIFIERS | fix(tui): exercise a genuine CoreGraphics load failure in tests |
| `5c7fdf89a9a425901c32fc8d492260a977dc88ed` | G01-RLM-IPYTHON | style(tui): format per project rules |
| `6ac1dea7302e779cb4f968c3afedefb0df708386` | G01-RLM-IPYTHON | test(tui): point test-hook imports at not-yet-existing internal module |
| `26b7d7e4a8644f6191b0bc290f19ef780ed003f4` | G03-NATIVE-MODIFIERS | fix(tui): move native-modifiers test hooks out of the package barrel |
| `29d493fac5f461339a294ee9d8cae386f9e05768` | G01-RLM-IPYTHON | fix(tui): restore dropped ProcessTerminalConstructor type declaration |
| `d6da6b7bd1e2301eaa366e5b747e79bd2f34430e` | G01-RLM-IPYTHON | test(tui): assert the internal reader module is unreachable by package subpath |
| `5b207a7bc0af257bcbe881cf3635cf98210fbea8` | G01-RLM-IPYTHON | fix(tui): block the internal reader module from the package export map |
| `b6a7e5d9a6c7124dee142ad4980594ff87587411` | G01-RLM-IPYTHON | test(tui): drop inline typeof import() type queries from test helpers |
| `402f9bc1fa555eca0c167eb2a6317ab91969aabb` | G01-RLM-IPYTHON | test(tui): drop the packaging-boundary test that assumed the wrong export shape |
| `0a81c69bec62da8d3f7d4d7df92e21bfa85f62ed` | G01-RLM-IPYTHON | revert(tui): drop the null export-map entry, it broke the compiled binary build |
| `74203e9c61571cb609298539a28cdadaaa79ba2c` | G06-FORK-MERGES | Merge pull request #30 from ketema/feat/native-modifier-key-detection |
| `1c8d7971b40c74dbcc82c72cca706f1e954e5b66` | G06-FORK-MERGES | Merge branch 'fix/omp-native-ssh-askpass' into main |
| `a74f2b2c89328628dc745694b56787e161303355` | G02-SSH-ASKPASS | test(askpass): guard unavailable CI fallback |
| `6ad2f7236b5424f8030d663aa117ff250b6365c0` | G02-SSH-ASKPASS | style(askpass): satisfy CI formatting |
| `35f7fbae4c51a0088dc61c93ad986c73f9e453fa` | G02-SSH-ASKPASS | style(askpass): format fallback guard test |
| `f1b01380ae0c3c7b8f7abe27d917774e0df3d301` | G02-SSH-ASKPASS | style(askpass): organize guard test imports |
| `c13e781e754cf08ffbf3e31077ba315cbf7632c8` | G02-SSH-ASKPASS | docs(askpass): align review artifact names |
| `d40c9bdf23fdd49c51e46dfcd97f5c1c15a43060` | G02-SSH-ASKPASS | test(askpass): remove unreachable fallback guard |
| `d219ff156000790b77a93f76bc4f691097e86617` | G06-FORK-MERGES | Merge pull request #31 from ketema/fix/omp-native-ssh-askpass-pr |
| `33c620948fbb25d683de8dd7bb0046392e7dfe27` | G04-HYGIENE-DOCS | chore: ignore local agent runtime artifacts |
| `56d221186c60817c5435f855b3e85e404d9acbe1` | G01-RLM-IPYTHON | chore: ignore kernel state artifacts |
| `6d064956811d226eb3d2d7f7234cc58c2ec04695` | G06-FORK-MERGES | Merge pull request #32 from ketema/chore/ignore-local-runtime-artifacts |
| `7f9b71d14e93187e7ecbb837863e89cd2f9182f2` | G01-RLM-IPYTHON | docs(mcp): clarify xd virtual device execution syntax via IEEE-29148 |
| `576fed41a8e553d85738000d9cb14133d4945cc5` | G06-FORK-MERGES | Merge pull request #34 from ketema/docs/mcp-xdev-ieee-guidance |

## Appendix B — independent tip commits

### G07-PINNED-SPAWN

- `69b5dfea9142e28b3add51a91846894030d0567b` — Add failing tests for a pinned prompt dock
- `1f3aa5d826fd933e1215fb551a7104881c2609d1` — Pin the prompt dock while scrolling the transcript
- `01a4d818757471bc59d4810bcc0af3ee556d8e4a` — Name actors in the pinned-prompt requirements
- `ddeb96485d286595df622d8c1bc131b99a4bbceb` — Cover Composer start, preference toggle, and page keys
- `9326c178c060c7f74876cb8c5ffe2a0614187e39` — test(tui): lock always-on pinned prompt dock
- `89a29af3ace0dd19c3b15186bf17d5bbf29cc8be` — fix(tui): always pin the interactive prompt dock
- `29e232ea01de5726ff1378c0964d79111ed2655d` — test(task): require per-spawn model selector on the wire
- `adbfb7517cbbeb917308ef081784da56cfb14699` — feat(task): honor optional model on subagent spawn
- `3c0b3cb171bb5c7f4febbb1405ef977dbc33a843` — chore(build): pin nightly Rust through mise in this repo
- `1a596813c00ac2824d36e9cab50a73ea2ed8fee3` — Merge branch 'restore-spawn-model' into combine-pinned-spawn-model
- `32066f14c7e6be3b109903ae05e77bcd70d95063` — test(tui): lock concatenated wheel, windowed pinned paint, and drag-copy
- `731c858cfbf257d805f70c9e7b80253f92c1d1ba` — fix(tui): parse SGR streams, window pinned paint, copy on drag
- `ab7da9750f89f72dbe68cf339d4364507ca7c176` — fix(tui): empty pinnedScroll when dock fills the frame
- `6dc87402900e1ae6c90ab10c58aee4bf57468db9` — fix(tui): paint floating overlays on the pinned frame
- `fa914f1d8403f72e09badd6f668c5242d99edfe7` — test(pinned-dock): RED tests for full software scrollback, overlay compositing, and header retirement
- `b4c926ebfba8b61fc177ec55d9b445c954a84a94` — fix(pinned-dock): restore full software scrollback, overlay compositing, and header retirement
- `ca9e19006127715487cae76fe0707cda43ae1188` — test(pinned-dock): trim trailing padding in POST-PV-7 active message assertion
- `38c59eadb4c4f239065c0c9cbf7033ff43aa9677` — refactor(pinned-dock): complete contract clauses and full test coverage for all slices
- `cf114dc6f2571efb493266ecb44165e2eb5563d3` — test(pinned-dock): RED tests for Option A selection, SGR lifecycle, and full scrollback
- `3cac0fe6298c5d419f6a87a80188ff4eb63155b7` — fix(pinned-dock): complete Option A in-app selection, SGR 1006 lifecycle, and full scrollback
- `777755bb11d1250e732e60c85dfcda84e0d7e458` — refactor(pinned-dock): reconcile test suites with canonical contract
- `526c24d28bbdf239cc1f3586fa681c2b9824cd17` — refactor(pinned-dock): remove unused declarations for Biome zero diagnostics
- `f9dcddb52d86997196c0cda6a5fbef9737e58bf7` — refactor(pinned-dock): typecheck literal alignment and provider interface conformance
- `5851851b3c0a1a821daf951c541eb0747e8314dc` — refactor(pinned-dock): delete obsolete duplicate pinned-jitter-copy.test.ts
- `a01c1e07d147c9326c2d153c5255a028d7caf98d` — refactor(pinned-dock): delete obsolete duplicate tests in coding-agent

### G08-IPYTHON-PROMPT

- `ab5a7595bfd5e41967a48eb74e971223968e8e9a` — Add failing test for ipython tool write-path guidance
- `d77c5e1f1d248716a1276fa93eea3119b522c1b6` — Document write-path and snapshot-handle rules in the ipython tool
- `c9809ba39e3121502c41598d1be447452a7614b4` — docs(rlm): bind write-path guidance to the prompt contract
- `9d37247eb939753a6e78381c02827118106069a1` — docs(rlm): align tool prompt source annotation
- `cae922caa95211fc2f1d4594b4fade738ad13bdc` — docs(rlm): align prompt traceability indexes

### G09-SNAPSHOT-EXTRAS (unique only)

- `bf299ccfcda1131ec08ef5c0150c7851c3ad2da3` — fix(rlm): harden atomic manifest write, environment propagation, and test integration
- `b05416116416ec9ba5b0918dfe5343edcc272d69` — fix(rlm): address peer review findings F9-F12
- `53b03245a0835368de8fc69dc95e146f61fa6f52` — fix(rlm): address copilot review batch across coupled commit, contract strictness, and fail-loud testing
- `dc6e6a962684795d8349edd0df5de778d7f4202d` — fix(rlm): enforce direct atomic replace and auto-compression fallback mode

### G10-TIMEOUT-BRANCH

- `fdc8a71b930ad948c45ca1cb8bd951dc348e22a0` — test(rlm): formalize requirements, contracts, and regression tests for issue #12
- `ef2352455178a52adcea36f615513f385ce98dae` — fix(rlm): synchronize transport execution state across timeouts and interrupts (closes #12)
- `328d2540b403a514dc5adea1ba1ee2d8a3830786` — fix(plan): update manifest hash in plan files

### G11-SHELL-ENV-PARITY

- `c820ec2be65ce597375b35fa09e9644ba986276b` — test(rlm): add adversarial test suite for shell environment parity
- `a4d35911c09b2627504bbe65dd0638698b5a3dca` — feat(rlm): implement shell environment parity and safe allowlist propagation

### G12-PROVIDER-FALLBACK

- `34d57ffb5e7e0991296377648bec6d21c08ae6a8` — test(fallback): require authentic quota status before paid routing
- `d184ea3a0cd8b588a1e4c0a2440888e158f18ddb` — test(fallback): align retry event with exact selector
- `de7384a7b927a60b334f74940d844c7e902dc426` — test(fallback): isolate quota turnstile fixtures
- `562fdb2696a757d9a97d3a8ed3201c26e38e8f67` — wip(fallback): preserve unvalidated quota turnstile increment
- `6abfce58ef7279b90abb3d1426cc8dc4db49c923` — test(fallback): isolate paid retry lifecycle
- `700c2fa58af819316470f985354929ce99671129` — test(fallback): close identity and event-routing gaps
- `2f120ecbf8f8e317117ed5aa7ccb7b8c73a5cb2a` — wip(fallback): preserve unvalidated event turnstile increment
- `c094988324784236f9890fb2bb5f140c4936965a` — test(fallback): block proactive paid routing
- `521d918258ca2ff3e2e6b2eb922c12d7ea2673d5` — wip(fallback): preserve unvalidated paid-gate remediation
- `dd5fbe4162b0afc21d3bbe9a5473e5af440e0c46` — test(fallback): specify observable paid-route decisions
- `17fdd317bba023a05874787adb246ed0252a01b4` — wip(fallback): preserve unvalidated proactive paid-gate denial
- `021b56c40ffd2b57c0c583c109576d956578a982` — style(test): normalize paid-event assertions
- `27c50bec895844ef704481f7cdd90cd2caed5415` — feat(fallback): expose paid-route decisions
- `923eb08abd56e59b850b3f56accb727d832c06fe` — test(fallback): specify shared Vertex turnstile
- `a1e280c15f3accc1ae27a521ebe04816b788d0e0` — test(fallback): use valid public advisor lifecycle
- `33e6bea1f38c2a96e3df40be179924c9bf04f67f` — test(fallback): model complete advisor host contract
- `2b6a58f622bcbc20b3f74475a61802fd3a544653` — test(fallback): align advisor host return contracts
- `04d4289f29aa65a731a83b9f64c96365d6290133` — style(test): normalize advisor imports
- `6ac9d81a98e8e7ffc25bf5c45e18c14857aeb205` — test(fallback): reconcile nested paid waterfall
- `3c3cb59d743447b76c5e8212e4c6bcd74070b20b` — test(fallback): bind verified trust-anchor seam
- `11e9af002f4e1dce489fa098ea1e13260c9a8e05` — test(fallback): count denials by exact transition key
- `ae1d23307917c85c918a943a1a317e4518d538c0` — test(fallback): use canonical Vertex quota evidence
- `69661d92fecdf561f0382c4ba5d587c543053285` — test(fallback): verify each paid-tier notification
- `7bc79590a78d3301020fdd0cbc91d1d9cd80ff49` — refactor(fallback): unify paid-provider fallback authorization
- `6aee285c685024bd2b6e771d8bfe38d31bd5231b` — test(fallback): modernize shared policy test seams

## Accounting

- Published range rows: 162
- Published group sum: 162
- Duplicate published assignments: 0
- Unaccounted published commits: 0
- Independent tips: all listed; refresh G07 after Gemini final audit.
