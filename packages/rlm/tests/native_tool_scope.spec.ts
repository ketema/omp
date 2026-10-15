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
 * Not exercised here (no test; reported to the coordinator): POST-NATIVE-2
 * (load-mode resolution), INV-NATIVE-1 (disposal-spanning lifetime),
 * FORBIDDEN-NATIVE-1 (no demotion for a PRE-NATIVE-1 session).
 *
 * CL11-B CONSISTENCY CHECK — PASS. PRE-NATIVE-1 excludes read-only selections
 * from POST-NATIVE-1's domain, so FORBIDDEN-NATIVE-2 (read-only: ipython absent)
 * and POST-NATIVE-1 (non-read-only: ipython present) govern disjoint session
 * classes and cannot contradict one another. No ERROR clause contradicts a PRE.
 *
 * EQUIVALENCE PARTITION RECORD (session tool selection, per PRE-NATIVE-1):
 *   Class A — toolNames undefined (full default set): NOT read-only
 *             -> POST-NATIVE-1 applies. Representative: omit `toolNames`.
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
 * read-only session reaches the native tool today. The POST-NATIVE-1 guard
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
  assertIpythonAbsentForReadOnly,
  isReadOnlyToolSelection,
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

describe("RLM native tool session scope (RED — FORBIDDEN-NATIVE-2 / POST-NATIVE-1)", () => {
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
     * CONFIGURATION NOTE (reported to the coordinator, not silently encoded):
     * this guard runs with device mounting disabled, the configuration in which
     * POST-NATIVE-1's observable is satisfied at HEAD. With device mounting
     * enabled (the product default) the native tool is presented as a mounted
     * device rather than a top-level entry, so POST-NATIVE-1 is NOT satisfied
     * there today. That gap is outside this slice's scope and no test here
     * encodes a weakened disjunction ("top-level OR mounted") in its place.
     *
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [x] C1 VALID: cites POST-NATIVE-1, present in
     *       contracts/rlm-native-tool.contract.ts
     *   [x] C2 VALUABLE: NO — exact-set equality pins exactly one native-tool
     *       entry, so both removal and duplicate registration fail it; the
     *       contract's own validator must also accept the surface.
     *   [x] C3 NON-DUPLICATIVE: the only test observing a non-read-only session;
     *       the sibling tests observe read-only sessions, the complementary class.
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
});
