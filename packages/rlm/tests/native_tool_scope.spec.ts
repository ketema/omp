/**
 * RED PHASE — read-only scoping of the RLM native tool (FORBIDDEN-NATIVE-2).
 *
 * Targets the IMPLEMENTATION artifact: a live host session built by
 * `createAgentSession(...)` from @oh-my-pi/pi-coding-agent. The contract file is
 * imported for clause constants and executable validators ONLY; the
 * implementation never imports the contract (CL11-F Contract-Implementation
 * Independence) and these tests are the bridge asserting the host session
 * satisfies the specification.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: contracts/rlm-native-tool.contract.ts
 * - Authority: "CL12-C SINGULAR AUTHORITY ... for the top-level native
 *   presentation of the RLM ipython tool"
 * - PRE clauses:       1  (PRE-NATIVE-1)
 * - POST clauses:      2  (POST-NATIVE-1, POST-NATIVE-2)
 * - INV clauses:       1  (INV-NATIVE-1)
 * - FORBIDDEN clauses: 2  (FORBIDDEN-NATIVE-1, FORBIDDEN-NATIVE-2)
 * - ERRORS:            1  (RlmNativeToolContractError, carries `clauseId`)
 * - Validators:        isReadOnlyToolSelection, assertIpythonAbsentForReadOnly,
 *                      assertActiveIpython, assertEssentialLoadMode
 *
 * CLAUSE REGISTRY (clauses exercised by THIS file):
 * - PRE-NATIVE-1:       session tool assembly is unrestricted (restrictToolNames
 *                       false) AND the session is not a read-only tool selection
 *                       (an explicit toolNames list omitting "write" is
 *                       read-only; an absent list is the full default set).
 * - POST-NATIVE-1:      after initialization of a session satisfying
 *                       PRE-NATIVE-1, ipython is present in the top-level active
 *                       tools array getActiveToolNames() (REQ-RLM-0002).
 * - FORBIDDEN-NATIVE-2: a read-only session SHALL NOT surface ipython in
 *                       getActiveToolNames() and SHALL NOT mount it under xd://
 *                       (getMountedXdevToolNames()).
 * - POST-NATIVE-2:      the presentation mode resolved for the native tool is
 *                       `essential` (observed at the session surface; the SCOPE
 *                       NOTE on that test records what the clause's literal
 *                       phrasing additionally names and why it is not asserted).
 * - FORBIDDEN-NATIVE-1: a session satisfying PRE-NATIVE-1 SHALL NOT unmount
 *                       ipython from the top-level active tool array or demote
 *                       ipython to discoverable-only status.
 * Not exercised here (no test; reported to the coordinator): INV-NATIVE-1 — the
 * disposal-spanning lifetime obligation. Every test here observes a single
 * post-initialization instant, not the interval through disposal.
 *
 * CL11-B CONSISTENCY CHECK — PASS. PRE-NATIVE-1 excludes read-only selections
 * from POST-NATIVE-1's domain, so FORBIDDEN-NATIVE-2 (read-only: ipython absent)
 * and POST-NATIVE-1 (non-read-only: ipython present) govern disjoint session
 * classes and cannot contradict one another. No ERROR clause contradicts a PRE.
 *
 * EQUIVALENCE PARTITION RECORD (session tool selection, per PRE-NATIVE-1):
 *   Class A — toolNames undefined (full default set): NOT read-only
 *             -> POST-NATIVE-1 applies. Representative: omit `toolNames`. BOTH
 *                presentation configurations are observed for this class,
 *                because whether a discoverable-only demotion target exists at
 *                all depends on it: device mounting ENABLED (the product
 *                default) and DISABLED.
 *   Class B — explicit list CONTAINING "write":       NOT read-only
 *             -> POST-NATIVE-1 applies. Indistinguishable from Class A at the
 *                session surface; covered at the predicate surface in
 *                native_tool_scope_validators.test.ts (one representative per
 *                class; a second session boot would be a same-class duplicate).
 *   Class C — explicit list OMITTING "write":         read-only
 *             -> FORBIDDEN-NATIVE-2 applies. Representative:
 *                ["read", "grep", "glob", "web_search"]. Boundary [] covered at
 *                the predicate surface.
 *
 * COMBINATORIAL CROSS-PRODUCT GATE — resolved, not a product. FORBIDDEN-NATIVE-2
 * names TWO observables (top-level active array AND xd:// mount set). Whether a
 * violation can land on the mount set at all is decided by whether device
 * mounting is enabled for the session, so the axes are DEPENDENT: with mounting
 * enabled the violation is observable in the mount set, with mounting disabled
 * every enabled tool is presented top-level and the violation is observable in
 * the active array. Sum, not product: one session boot per
 * (selection class, reachable observable) pair = three boots total.
 *
 * RISK TIER: HIGH — the native tool executes arbitrary Python (file writes,
 * `%%bash`, subprocess). Reaching it from a session whose tool list was
 * explicitly denied `write` converts a denial of working-tree writes into a
 * decorative one; the loss class is irrecoverable (arbitrary filesystem and
 * process effects), and the path is exercised by every read-only session.
 *
 * TEST PYRAMID LEVEL: Integration. The obligation is only observable through the
 * wiring between session assembly and tool presentation; no single component
 * contract can express it.
 *
 * RED EXPECTATION AT AUTHORING TIME: the FORBIDDEN-NATIVE-2 tests FAIL — a
 * read-only session reaches the native tool today. The POST-NATIVE-1,
 * FORBIDDEN-NATIVE-1 and POST-NATIVE-2 tests in the product-default
 * presentation configuration also FAIL — a full-default session carries the
 * native tool in the discoverable-only device catalog instead of the top-level
 * active array. The POST-NATIVE-1 guard in the mounting-disabled configuration
 * PASSES and must keep passing: the fix must scope the tool away from read-only
 * sessions WITHOUT removing it from full-default sessions.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";

import {
  assertActiveIpython,
  assertEssentialLoadMode,
  assertIpythonAbsentForReadOnly,
  isReadOnlyToolSelection,
  NATIVE_TOOL_LOAD_MODE,
  NATIVE_TOOL_NAME,
} from "../../../contracts/rlm-native-tool.contract.ts";

/** 5-point failure message (CL11-D). Point 5 is behavioral: WHAT, never HOW. */
const fivePoint = (points: {
  what: string;
  why: string;
  expected: string;
  actual: string;
  guidance: string;
}): string =>
  [
    `1. WHAT: ${points.what} FAILED`,
    `2. WHY: ${points.why}`,
    `3. EXPECTED: ${points.expected}`,
    `4. ACTUAL: ${points.actual}`,
    `5. GUIDANCE: ${points.guidance}`,
  ].join("\n");

describe("RLM native tool session scope (RED — FORBIDDEN-NATIVE-2 / POST-NATIVE-1 / POST-NATIVE-2 / FORBIDDEN-NATIVE-1)", () => {
  const tempDirs: string[] = [];

  // Built once: `ModelRegistry` eagerly loads bundled models and
  // `discoverAuthStorage` opens the auth DB — identical for every session here
  // and the dominant slice of a cold boot. Every test still gets its own
  // `Settings` and in-memory `SessionManager`, so no mutable state is shared.
  let modelRegistry!: ModelRegistry;
  let registryAuthDir: string;

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-native-tool-scope-"));
    tempDirs.push(dir);
    return dir;
  };

  beforeAll(async () => {
    registryAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-native-tool-scope-auth-"));
    modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    modelRegistry.authStorage.close();
    fs.rmSync(registryAuthDir, { recursive: true, force: true });
  });

  /**
   * Object Mother: the minimum session options that satisfy PRE-NATIVE-1's
   * first conjunct — `restrictToolNames` is omitted, so tool assembly is
   * unrestricted. Discovery of rules/extensions/MCP/LSP is off because none of
   * them participate in the clause; each test overrides ONLY the field under
   * test (`toolNames`, `settings`).
   */
  const unrestrictedSessionOptions = (cwd: string, settings: Settings): CreateAgentSessionOptions => ({
    cwd,
    agentDir: cwd,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settings,
    model: getBundledModel("openai", "gpt-4o-mini"),
    disableExtensionDiscovery: true,
    skills: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    rules: [],
    workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
  });

  test("FORBIDDEN-NATIVE-2: a read-only session neither mounts nor surfaces the native Python tool when device mounting is on", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Contract: contracts/rlm-native-tool.contract.ts
     * - Enforces: FORBIDDEN-NATIVE-2 — "A read-only session
     *   (isReadOnlyToolSelection(toolNames) is true) SHALL NOT surface ipython in
     *   getActiveToolNames() and SHALL NOT mount it under xd://
     *   (getMountedXdevToolNames())."
     * - Category: negative (negative-space obligation)
     * - Risk tier: HIGH — arbitrary Python execution reachable from a session
     *   explicitly denied working-tree writes
     * - Equivalence class: C (explicit list omitting "write"), observable = xd://
     *   mount set (device mounting enabled — the product default)
     * - Adversarial: contract-governed, implementation-aware
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-2, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: "can the implementation be wrong and this test pass?" =
     *       NO. Exact-set equality on the contract-governed projection: the set
     *       of native-tool entries must be exactly empty at BOTH surfaces, so a
     *       mount, a top-level activation, or a duplicate of either fails it.
     *   [x] C3 NON-DUPLICATIVE: the only test observing the xd:// mount set for a
     *       read-only session; the sibling test observes the top-level array in
     *       the mounting-disabled configuration, a different surface.
     *   [x] C4 NOT FUTURE-EDIT: FORBIDDEN-NATIVE-2 is a written clause, and the
     *       forbidden outcome is produced by behaviour the session performs today
     *       (it populates both surfaces during initialization) — making this test
     *       fail requires existing behaviour to be wrong, not a new feature.
     */
    // ARRANGE: explicit tool list granting read but omitting write — the
    // canonical read-only selection named by the clause.
    const readOnlyToolNames = ["read", "grep", "glob", "web_search"];
    const tempDir = makeTempDir();
    const settings = Settings.isolated();

    expect(
      isReadOnlyToolSelection(readOnlyToolNames),
      fivePoint({
        what: "read-only precondition for FORBIDDEN-NATIVE-2",
        why: "PRE-NATIVE-1 violation — the selection under test is not classified read-only, so the clause under test would not apply",
        expected:
          "isReadOnlyToolSelection(['read','grep','glob','web_search']) === true (explicit list omitting 'write')",
        actual: `isReadOnlyToolSelection(${JSON.stringify(readOnlyToolNames)}) === ${isReadOnlyToolSelection(readOnlyToolNames)}`,
        guidance:
          "An explicit tool list that omits write must be classified as a read-only session; only an absent list is the full default set.",
      }),
    ).toBe(true);

    expect(
      cfgToolsXdev.get(settings),
      fivePoint({
        what: "device-mounting precondition for FORBIDDEN-NATIVE-2",
        why: "FORBIDDEN-NATIVE-2 observable missing — the mount-set half of the clause only has a surface when discoverable tools mount as devices",
        expected: "device mounting enabled for this session, so the xd:// mount set is a live observable",
        actual: `device mounting enabled = ${cfgToolsXdev.get(settings)}`,
        guidance:
          "This test asserts the mount-set half of the clause; it requires a session configuration in which rarely-used tools are mounted as devices rather than presented top-level.",
      }),
    ).toBe(true);

    // ACT: initialize the session through the real creation path.
    const { session } = await createAgentSession({
      ...unrestrictedSessionOptions(tempDir, settings),
      toolNames: readOnlyToolNames,
    });

    try {
      const mountedToolNames = session.getMountedXdevToolNames();
      const activeToolNames = session.getActiveToolNames();

      // ASSERT (surface 1 of 2): the device catalog must carry no native tool.
      expect(
        mountedToolNames.filter(name => name === NATIVE_TOOL_NAME),
        fivePoint({
          what: "read-only session mounts the arbitrary-Python tool as a device",
          why: "FORBIDDEN-NATIVE-2 violation — a session whose explicit tool list omits write reached the arbitrary-Python tool through the device catalog",
          expected: `no ${NATIVE_TOOL_NAME} entry in the mounted device set (exactly [])`,
          actual: `mounted devices = ${JSON.stringify(mountedToolNames)}`,
          guidance:
            "A session that was explicitly denied working-tree writes must finish initialization with no reachable arbitrary-code-execution tool: it must be absent from the device catalog, not merely hidden from the top-level list.",
        }),
      ).toEqual([]);

      // ASSERT (surface 2 of 2): the top-level callable surface likewise.
      expect(
        activeToolNames.filter(name => name === NATIVE_TOOL_NAME),
        fivePoint({
          what: "read-only session surfaces the arbitrary-Python tool top-level",
          why: "FORBIDDEN-NATIVE-2 violation — the tool appears in the top-level active array of a read-only session",
          expected: `no ${NATIVE_TOOL_NAME} entry in getActiveToolNames() (exactly [])`,
          actual: `active tools = ${JSON.stringify(activeToolNames)}`,
          guidance:
            "Denying write must deny every tool that can write; the top-level callable surface of such a session must not include a tool that executes arbitrary code.",
        }),
      ).toEqual([]);

      // ASSERT (contract bridge): the contract's own executable validator,
      // fed the implementation's observable, must accept it.
      try {
        assertIpythonAbsentForReadOnly(readOnlyToolNames, { activeToolNames });
      } catch (cause) {
        throw new Error(
          fivePoint({
            what: "contract validator rejected the live read-only session surface",
            why: `FORBIDDEN-NATIVE-2 violation — ${(cause as Error).message}`,
            expected: "the contract validator accepts the session's active tool array for a read-only selection",
            actual: `active tools = ${JSON.stringify(activeToolNames)}`,
            guidance:
              "The observable tool surface of a read-only session must satisfy the specification's own acceptance check without exception.",
          }),
        );
      }
    } finally {
      await session.dispose();
    }
  });

  // ---- Post-audit repair (audit finding #6): predicate classes at the SESSION
  // surface. The implementation's redeclared predicate was previously exercised
  // by only two boots (undefined, read-only list). Human decision 2026-10-15:
  // read-only means GRANTS "read" AND OMITS "write".
  test("PRE-NATIVE-1: a write-capable explicit selection is not read-only and retains the native Python tool", async () => {
    const tempDir = makeTempDir();
    const settings = Settings.isolated();
    const { session } = await createAgentSession({
      ...unrestrictedSessionOptions(tempDir, settings),
      toolNames: ["bash", "edit"],
    });
    try {
      const activeToolNames = session.getActiveToolNames();
      const mountedToolNames = session.getMountedXdevToolNames();
      expect(
        activeToolNames.includes(NATIVE_TOOL_NAME),
        fivePoint({
          what: "a write-capable explicit selection lost the native Python tool",
          why: "PRE-NATIVE-1 violation — a selection granting working-tree writes was classified read-only",
          expected: "ipython present in getActiveToolNames()",
          actual: `active = ${JSON.stringify(activeToolNames)}; devices = ${JSON.stringify(mountedToolNames)}`,
          guidance:
            "A session that can write the working tree and run shell is not a write-denied session; it must finish initialization with the native Python tool directly callable.",
        }),
      ).toBe(true);
    } finally {
      await session.dispose();
    }
  });


  test("FORBIDDEN-NATIVE-2: a read-only session does not surface the native Python tool when every enabled tool is presented top-level", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Contract: contracts/rlm-native-tool.contract.ts
     * - Enforces: FORBIDDEN-NATIVE-2 — "A read-only session ... SHALL NOT surface
     *   ipython in getActiveToolNames() ..."
     * - Category: negative (negative-space obligation)
     * - Risk tier: HIGH — same escalation, reached through the configuration in
     *   which no device indirection exists at all
     * - Equivalence class: C (explicit list omitting "write"), observable =
     *   top-level active array (device mounting disabled)
     * - Adversarial: contract-governed, implementation-aware
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-2, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: NO — exact-set equality on the full top-level array is
     *       asserted against the caller's own selection, so adding ANY tool the
     *       session was not granted fails it; the clause-scoped projection pins
     *       the native tool specifically.
     *   [x] C3 NON-DUPLICATIVE: distinct configuration AND distinct surface from
     *       the sibling test — a fix that gates only the device mount would pass
     *       the sibling and fail here.
     *   [x] C4 NOT FUTURE-EDIT: the session already assembles a top-level array
     *       in this configuration; the test bounds that existing behaviour.
     */
    // ARRANGE: same read-only selection, but device mounting disabled — this
    // configuration presents every enabled tool top-level, so the top-level
    // array is where the forbidden outcome lands.
    const readOnlyToolNames = ["read", "grep", "glob", "web_search"];
    const tempDir = makeTempDir();
    const settings = Settings.isolated();
    cfgToolsXdev.set(settings, false);

    expect(
      isReadOnlyToolSelection(readOnlyToolNames),
      fivePoint({
        what: "read-only precondition for FORBIDDEN-NATIVE-2",
        why: "PRE-NATIVE-1 violation — the selection under test is not classified read-only, so the clause under test would not apply",
        expected:
          "isReadOnlyToolSelection(['read','grep','glob','web_search']) === true (explicit list omitting 'write')",
        actual: `isReadOnlyToolSelection(${JSON.stringify(readOnlyToolNames)}) === ${isReadOnlyToolSelection(readOnlyToolNames)}`,
        guidance:
          "An explicit tool list that omits write must be classified as a read-only session; only an absent list is the full default set.",
      }),
    ).toBe(true);

    // ACT
    const { session } = await createAgentSession({
      ...unrestrictedSessionOptions(tempDir, settings),
      toolNames: readOnlyToolNames,
    });

    try {
      const activeToolNames = session.getActiveToolNames();

      // ASSERT (clause projection): no native tool entry, exactly.
      expect(
        activeToolNames.filter(name => name === NATIVE_TOOL_NAME),
        fivePoint({
          what: "read-only session surfaces the arbitrary-Python tool top-level with device mounting off",
          why: "FORBIDDEN-NATIVE-2 violation — the tool appears in the top-level active array of a session whose explicit tool list omits write",
          expected: `no ${NATIVE_TOOL_NAME} entry in getActiveToolNames() (exactly [])`,
          actual: `active tools = ${JSON.stringify(activeToolNames)}`,
          guidance:
            "Removing the device indirection must not reveal an arbitrary-code-execution tool to a session that was explicitly denied working-tree writes; the denial has to hold in every presentation configuration.",
        }),
      ).toEqual([]);

      // ASSERT (exact surface): with no device indirection and no write grant,
      // the top-level surface is exactly the caller's selection.
      expect(
        [...activeToolNames].sort(),
        fivePoint({
          what: "read-only top-level surface is not the caller's selection",
          why: "FORBIDDEN-NATIVE-2 violation — an unselected tool was added to the top-level array of a read-only session",
          expected: `exactly the requested read-only selection ${JSON.stringify([...readOnlyToolNames].sort())}`,
          actual: `active tools = ${JSON.stringify([...activeToolNames].sort())}`,
          guidance:
            "When no tool is mounted as a device, a read-only session's top-level surface must be exactly the tools the caller asked for — no arbitrary-code-execution tool added on its behalf.",
        }),
      ).toEqual([...readOnlyToolNames].sort());

      // ASSERT (contract bridge)
      try {
        assertIpythonAbsentForReadOnly(readOnlyToolNames, { activeToolNames });
      } catch (cause) {
        throw new Error(
          fivePoint({
            what: "contract validator rejected the live read-only session surface",
            why: `FORBIDDEN-NATIVE-2 violation — ${(cause as Error).message}`,
            expected: "the contract validator accepts the session's active tool array for a read-only selection",
            actual: `active tools = ${JSON.stringify(activeToolNames)}`,
            guidance:
              "The observable tool surface of a read-only session must satisfy the specification's own acceptance check without exception.",
          }),
        );
      }
    } finally {
      await session.dispose();
    }
  });

  test("POST-NATIVE-1: a full default session keeps the native Python tool in the top-level active array", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Contract: contracts/rlm-native-tool.contract.ts
     * - Enforces: POST-NATIVE-1 — "After initialization of a session satisfying
     *   PRE-NATIVE-1, ipython is present in the top-level active tools array
     *   getActiveToolNames() (REQ-RLM-0002)." PRE-NATIVE-1 is satisfied here:
     *   tool assembly is unrestricted and `toolNames` is absent, which
     *   isReadOnlyToolSelection classifies as NOT read-only.
     * - Category: positive (regression guard)
     * - Risk tier: HIGH — the opposite failure of the sibling tests: an
     *   over-broad scoping fix that treats an absent tool list like a read-only
     *   one would silently strip the tool from every default session.
     * - Equivalence class: A (toolNames undefined — full default set)
     * - Adversarial: contract-governed, implementation-aware
     *
     * CONFIGURATION NOTE: this guard runs with device mounting disabled, the
     * configuration in which POST-NATIVE-1's observable is satisfied at HEAD.
     * The product-default configuration (device mounting enabled), in which the
     * native tool is presented as a mounted device rather than a top-level
     * entry, is observed by the three sibling tests below — which fail at HEAD.
     * No test here encodes a weakened disjunction ("top-level OR mounted") in
     * place of the clause.
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites POST-NATIVE-1, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: NO — exact-set equality pins exactly one native-tool
     *       entry, so both removal and duplicate registration fail it; the
     *       contract's own validator must also accept the surface.
     *   [x] C3 NON-DUPLICATIVE: the only test observing a non-read-only session
     *       with device mounting DISABLED; the read-only tests observe the
     *       complementary selection class, and the default-configuration
     *       siblings observe the configuration in which a demotion target
     *       exists.
     *   [x] C4 NOT FUTURE-EDIT: POST-NATIVE-1 is a written clause and this is a
     *       positive obligation on behaviour the session performs today.
     */
    // ARRANGE: no `toolNames` at all — the full default set, which the contract
    // predicate classifies as NOT read-only.
    const tempDir = makeTempDir();
    const settings = Settings.isolated();
    cfgToolsXdev.set(settings, false);

    expect(
      isReadOnlyToolSelection(undefined),
      fivePoint({
        what: "non-read-only precondition for POST-NATIVE-1",
        why: "PRE-NATIVE-1 violation — an absent tool list was classified as a read-only selection",
        expected:
          "isReadOnlyToolSelection(undefined) === false (an absent list is the full default set, not a read-only selection)",
        actual: `isReadOnlyToolSelection(undefined) === ${isReadOnlyToolSelection(undefined)}`,
        guidance:
          "Only an explicit tool list that omits write denotes a read-only session; a session that never restricted its tools retains the full default grant.",
      }),
    ).toBe(false);

    // ACT
    const { session } = await createAgentSession(unrestrictedSessionOptions(tempDir, settings));

    try {
      const activeToolNames = session.getActiveToolNames();

      // ASSERT: present exactly once in the top-level array.
      expect(
        activeToolNames.filter(name => name === NATIVE_TOOL_NAME),
        fivePoint({
          what: "full default session lost the native Python tool from its top-level array",
          why: "POST-NATIVE-1 violation — a session satisfying PRE-NATIVE-1 finished initialization without exactly one top-level native-tool entry",
          expected: `exactly one ${NATIVE_TOOL_NAME} entry in getActiveToolNames()`,
          actual: `active tools = ${JSON.stringify(activeToolNames)}`,
          guidance:
            "Scoping the arbitrary-Python tool away from sessions that were denied write must not remove it from sessions that hold the full default grant, and must not register it twice.",
        }),
      ).toEqual([NATIVE_TOOL_NAME]);

      // ASSERT (contract bridge)
      try {
        assertActiveIpython({ activeToolNames });
      } catch (cause) {
        throw new Error(
          fivePoint({
            what: "contract validator rejected the live full-default session surface",
            why: `POST-NATIVE-1 violation — ${(cause as Error).message}`,
            expected: "the contract validator accepts the session's active tool array for a non-read-only selection",
            actual: `active tools = ${JSON.stringify(activeToolNames)}`,
            guidance:
              "A session holding the full default tool grant must expose the native Python tool on its top-level callable surface.",
          }),
        );
      }
    } finally {
      await session.dispose();
    }
  });

  test("POST-NATIVE-1: a full default session keeps the native Python tool in the top-level active array under the default presentation configuration", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Contract: contracts/rlm-native-tool.contract.ts
     * - Enforces: POST-NATIVE-1 — "After initialization of a session satisfying
     *   PRE-NATIVE-1, ipython is present in the top-level active tools array
     *   getActiveToolNames() (REQ-RLM-0002)." PRE-NATIVE-1 is satisfied here:
     *   tool assembly is unrestricted and `toolNames` is absent, which
     *   isReadOnlyToolSelection classifies as NOT read-only.
     * - Category: positive
     * - Risk tier: HIGH — POST-NATIVE-1 is unconditional on presentation
     *   configuration, and the default configuration is the one every shipped
     *   session runs in. A failure here means the clause is unsatisfied for
     *   effectively every real session, not for a rare corner.
     * - Equivalence class: A (toolNames undefined — full default set),
     *   presentation configuration = product default (device mounting ENABLED,
     *   so a discoverable-only demotion target exists).
     * - Test pyramid level: Integration — the obligation is only observable
     *   through the wiring between session assembly and tool presentation.
     * - Adversarial: contract-governed, implementation-aware
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites POST-NATIVE-1, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: "can the implementation be wrong and this test pass?" =
     *       NO. Exact-set equality on the clause projection pins exactly one
     *       top-level entry, so removal, duplicate registration, and presence on
     *       some OTHER surface instead all fail it. A session that merely carries
     *       the tool somewhere reachable does not satisfy this test.
     *   [x] C3 NON-DUPLICATIVE: the sibling POST-NATIVE-1 guard observes the same
     *       surface only with device mounting DISABLED, where no demotion target
     *       exists; at authoring time that guard PASSES while this test FAILS,
     *       which is the proof they are not one observation. The
     *       FORBIDDEN-NATIVE-1 sibling observes the device catalog, a different
     *       surface: an implementation that dropped the tool from the session
     *       entirely fails this test and passes that one.
     *   [x] C4 NOT FUTURE-EDIT: POST-NATIVE-1 is a written clause and the session
     *       already assembles a top-level active array during initialization —
     *       this bounds existing behaviour rather than awaiting a feature.
     */
    // ARRANGE: no `toolNames` at all — the full default set, which the contract
    // predicate classifies as NOT read-only. Settings are left untouched: nothing
    // here turns device mounting off, so the session is assembled exactly the way
    // a shipped default session is.
    const tempDir = makeTempDir();
    const settings = Settings.isolated();

    expect(
      isReadOnlyToolSelection(undefined),
      fivePoint({
        what: "non-read-only precondition for POST-NATIVE-1",
        why: "PRE-NATIVE-1 violation — an absent tool list was classified as a read-only selection",
        expected:
          "isReadOnlyToolSelection(undefined) === false (an absent list is the full default set, not a read-only selection)",
        actual: `isReadOnlyToolSelection(undefined) === ${isReadOnlyToolSelection(undefined)}`,
        guidance:
          "Only an explicit tool list that omits write denotes a read-only session; a session that never restricted its tools retains the full default grant.",
      }),
    ).toBe(false);

    expect(
      cfgToolsXdev.get(settings),
      fivePoint({
        what: "default-configuration precondition for POST-NATIVE-1",
        why: "configuration drift — this test must exercise the shipped default configuration, in which a discoverable-only demotion target exists, and it changes no setting to get there",
        expected: "device mounting enabled for a session built from untouched default settings",
        actual: `device mounting enabled = ${cfgToolsXdev.get(settings)}`,
        guidance:
          "This test pins the clause in the presentation configuration that ships on by default; if that default ever flips, the clause still needs an observation in the configuration where rarely-used tools are presented as devices.",
      }),
    ).toBe(true);

    // ACT: initialize the session through the real creation path.
    const { session } = await createAgentSession(unrestrictedSessionOptions(tempDir, settings));

    try {
      const activeToolNames = session.getActiveToolNames();
      const mountedToolNames = session.getMountedXdevToolNames();

      // ASSERT: present exactly once in the top-level array. Both surfaces are
      // reported so a failure names WHERE the tool ended up instead.
      expect(
        activeToolNames.filter(name => name === NATIVE_TOOL_NAME),
        fivePoint({
          what: "full default session does not carry the native Python tool in its top-level active array",
          why: "POST-NATIVE-1 violation — a session satisfying PRE-NATIVE-1 finished initialization without exactly one top-level native-tool entry",
          expected: `exactly one ${NATIVE_TOOL_NAME} entry in getActiveToolNames()`,
          actual: `active tools = ${JSON.stringify(activeToolNames)}; discoverable-only devices = ${JSON.stringify(mountedToolNames)}`,
          guidance:
            "A session holding the full default tool grant must finish initialization with the native Python tool on its top-level callable surface, registered once. Being reachable by some other route does not satisfy this: the top-level array is the observable the clause names.",
        }),
      ).toEqual([NATIVE_TOOL_NAME]);

      // ASSERT (contract bridge): the contract's own executable validator, fed
      // the implementation's observable, must accept it.
      try {
        assertActiveIpython({ activeToolNames });
      } catch (cause) {
        throw new Error(
          fivePoint({
            what: "contract validator rejected the live default-configuration session surface",
            why: `POST-NATIVE-1 violation — ${(cause as Error).message}`,
            expected: "the contract validator accepts the session's active tool array for a non-read-only selection",
            actual: `active tools = ${JSON.stringify(activeToolNames)}; discoverable-only devices = ${JSON.stringify(mountedToolNames)}`,
            guidance:
              "The top-level tool surface of a full-default session must satisfy the specification's own acceptance check without exception.",
          }),
        );
      }
    } finally {
      await session.dispose();
    }
  });

  test("FORBIDDEN-NATIVE-1: a full default session does not demote the native Python tool to a discoverable-only device", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Contract: contracts/rlm-native-tool.contract.ts
     * - Enforces: FORBIDDEN-NATIVE-1 — "A session satisfying PRE-NATIVE-1 SHALL
     *   NOT unmount ipython from the top-level active tool array or demote
     *   ipython to discoverable-only status."
     * - Category: negative (negative-space obligation)
     * - Risk tier: HIGH — the directive this contract records asks for the tool
     *   at the highest presentation priority the session can give it. A silent
     *   demotion leaves the session nominally carrying the tool while the model
     *   no longer sees it, so the capability is lost without any error.
     * - Equivalence class: A (toolNames undefined — full default set),
     *   presentation configuration = product default (device mounting ENABLED —
     *   the only configuration in which the forbidden outcome has a surface).
     * - Test pyramid level: Integration.
     * - Adversarial: contract-governed, implementation-aware
     *
     * OBSERVABLE: the device catalog (getMountedXdevToolNames()) IS the
     * discoverable-only presentation. A name there is offered to the model as a
     * device to be discovered rather than as a top-level tool, which is exactly
     * the demotion the clause forbids. The contract exposes no executable
     * validator for this clause, so the assertion states the clause text
     * directly against the implementation's observable.
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites FORBIDDEN-NATIVE-1, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: "can the implementation be wrong and this test pass?" =
     *       NO. Exact-set equality on the clause projection: native-tool entries
     *       in the device catalog must be exactly none, so leaving it mounted —
     *       or mounting it in addition to activating it — fails.
     *   [x] C3 NON-DUPLICATIVE: the only test observing the device catalog of a
     *       NON-read-only session. The POST-NATIVE-1 sibling observes the
     *       top-level array: an implementation that dropped the tool from the
     *       session entirely passes this test and fails that one.
     *   [x] C4 NOT FUTURE-EDIT: the session already populates a device catalog
     *       during initialization and already places this tool in it — the
     *       forbidden outcome is produced by behaviour performed today.
     */
    // ARRANGE: full default grant, untouched settings — the same session class
    // POST-NATIVE-1 governs, observed on the other presentation surface.
    const tempDir = makeTempDir();
    const settings = Settings.isolated();

    expect(
      isReadOnlyToolSelection(undefined),
      fivePoint({
        what: "non-read-only precondition for FORBIDDEN-NATIVE-1",
        why: "PRE-NATIVE-1 violation — an absent tool list was classified as a read-only selection, so the clause under test would not apply",
        expected:
          "isReadOnlyToolSelection(undefined) === false (an absent list is the full default set, not a read-only selection)",
        actual: `isReadOnlyToolSelection(undefined) === ${isReadOnlyToolSelection(undefined)}`,
        guidance:
          "Only an explicit tool list that omits write denotes a read-only session; a session that never restricted its tools retains the full default grant.",
      }),
    ).toBe(false);

    expect(
      cfgToolsXdev.get(settings),
      fivePoint({
        what: "default-configuration precondition for FORBIDDEN-NATIVE-1",
        why: "FORBIDDEN-NATIVE-1 observable missing — the demotion this clause forbids only has a surface when rarely-used tools are presented as devices",
        expected: "device mounting enabled for a session built from untouched default settings",
        actual: `device mounting enabled = ${cfgToolsXdev.get(settings)}`,
        guidance:
          "This test asserts that the native Python tool is not presented as a discoverable device; it requires the session configuration in which such a presentation is possible at all.",
      }),
    ).toBe(true);

    // ACT
    const { session } = await createAgentSession(unrestrictedSessionOptions(tempDir, settings));

    try {
      const mountedToolNames = session.getMountedXdevToolNames();
      const activeToolNames = session.getActiveToolNames();

      // ASSERT: the discoverable-only catalog must carry no native-tool entry.
      expect(
        mountedToolNames.filter(name => name === NATIVE_TOOL_NAME),
        fivePoint({
          what: "full default session presents the native Python tool as a discoverable-only device",
          why: "FORBIDDEN-NATIVE-1 violation — a session satisfying PRE-NATIVE-1 demoted the native tool to discoverable-only status",
          expected: `no ${NATIVE_TOOL_NAME} entry in the discoverable-only device set (exactly [])`,
          actual: `discoverable-only devices = ${JSON.stringify(mountedToolNames)}; active tools = ${JSON.stringify(activeToolNames)}`,
          guidance:
            "A session holding the full default tool grant must offer the native Python tool to the model directly, never as a device the model has to discover before it can call it.",
        }),
      ).toEqual([]);
    } finally {
      await session.dispose();
    }
  });

  test("POST-NATIVE-2: a full default session registers the native Python tool with the essential presentation mode", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Contract: contracts/rlm-native-tool.contract.ts
     * - Enforces: POST-NATIVE-2 — "defaultLoadModeForToolName('ipython')
     *   evaluates to 'essential'."
     * - Category: positive
     * - Risk tier: HIGH — the contract's stated WHAT ("exposed directly in the
     *   top-level native active tools array ... with `essential` load mode") and
     *   the user directive it records both require the top presentation
     *   priority. A session that pins the tool top-level while still classifying
     *   it as a discover-on-demand tool satisfies neither, and the classification
     *   is what every later presentation decision reads.
     * - Equivalence class: A (toolNames undefined — full default set),
     *   presentation configuration = product default.
     * - Test pyramid level: Integration — the observed value is the mode the
     *   SESSION resolved for the registered tool, not a pure function result.
     * - Adversarial: contract-governed, implementation-aware
     *
     * SCOPE NOTE (reported to the coordinator, not silently encoded): the clause
     * text names an internal resolver. The host session surface does not expose
     * that resolver; what it exposes is the presentation mode the session
     * resolved for the registered tool, which this test reads through the public
     * session lookup. That value is a necessary consequence of the clause — were
     * the default resolution for this name `essential`, a registration that
     * declares no mode of its own would carry `essential` here. The converse is
     * NOT pinned: an implementation that reaches `essential` by declaring the
     * mode on the registration itself satisfies this test and the contract's
     * stated WHAT while leaving the clause's literal phrasing about the resolver
     * unobserved. Asserting the resolver directly would mean reaching past the
     * session surface into implementation internals, which this test does not do.
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites POST-NATIVE-2, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: NO for the session-surface obligation — exact equality
     *       against the contract's own constant, so any other resolved mode
     *       (including an unregistered tool, which resolves to none) fails. The
     *       SCOPE NOTE records the single direction this does not pin.
     *   [x] C3 NON-DUPLICATIVE: the only test observing the resolved presentation
     *       mode; the siblings observe which array the name lands in. An
     *       implementation that forced the name top-level without changing its
     *       presentation mode passes both siblings and fails this test.
     *   [x] C4 NOT FUTURE-EDIT: POST-NATIVE-2 is a written clause and the session
     *       already resolves a presentation mode for this tool at registration;
     *       this bounds that existing resolution.
     */
    // ARRANGE: full default grant, untouched settings.
    const tempDir = makeTempDir();
    const settings = Settings.isolated();

    expect(
      isReadOnlyToolSelection(undefined),
      fivePoint({
        what: "non-read-only precondition for POST-NATIVE-2",
        why: "PRE-NATIVE-1 violation — an absent tool list was classified as a read-only selection",
        expected:
          "isReadOnlyToolSelection(undefined) === false (an absent list is the full default set, not a read-only selection)",
        actual: `isReadOnlyToolSelection(undefined) === ${isReadOnlyToolSelection(undefined)}`,
        guidance:
          "Only an explicit tool list that omits write denotes a read-only session; a session that never restricted its tools retains the full default grant.",
      }),
    ).toBe(false);

    // ACT
    const { session } = await createAgentSession(unrestrictedSessionOptions(tempDir, settings));

    try {
      const registeredNativeTool = session.getToolByName(NATIVE_TOOL_NAME);

      // ASSERT: the mode the session resolved equals the mode the contract names.
      expect(
        registeredNativeTool?.loadMode,
        fivePoint({
          what: "full default session registered the native Python tool at a lower presentation priority than the contract requires",
          why: "POST-NATIVE-2 violation — the presentation mode resolved for the native tool is not the essential mode",
          expected: `resolved presentation mode for ${NATIVE_TOOL_NAME} === ${JSON.stringify(NATIVE_TOOL_LOAD_MODE)}`,
          actual: `registered = ${registeredNativeTool !== undefined}; resolved presentation mode = ${JSON.stringify(registeredNativeTool?.loadMode)}`,
          guidance:
            "A session holding the full default tool grant must classify the native Python tool as one the model always sees directly, not as one it discovers on demand; the mode the session resolves for it must equal the mode the specification names.",
        }),
      ).toBe(NATIVE_TOOL_LOAD_MODE);

      // ASSERT (contract bridge)
      try {
        assertEssentialLoadMode(registeredNativeTool?.loadMode);
      } catch (cause) {
        throw new Error(
          fivePoint({
            what: "contract validator rejected the presentation mode resolved by the live session",
            why: `POST-NATIVE-2 violation — ${(cause as Error).message}`,
            expected: "the contract validator accepts the presentation mode the session resolved for the native tool",
            actual: `resolved presentation mode = ${JSON.stringify(registeredNativeTool?.loadMode)}`,
            guidance:
              "The presentation mode a full-default session resolves for the native Python tool must satisfy the specification's own acceptance check without exception.",
          }),
        );
      }
    } finally {
      await session.dispose();
    }
  });
});
