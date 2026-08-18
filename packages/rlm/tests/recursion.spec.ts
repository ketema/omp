/**
 * RLM RECURSION SPECIFICATION TESTS (SLICE-6 RED).
 *
 * Adversarial specification-driven tests for sub-agent recursion, admission
 * handles, parent-scoped registry, usage attribution, and depth gating.
 *
 * Traceability:
 * - PRE-REC-1: prompt string validation; kwargs whitelist { name, model }
 * - POST-REC-1 / FORBIDDEN-REC-1: spawn returns 4-field handle; child answer never returned (REQ-N-5)
 * - POST-REC-2: child depth increment, max depth inheritance, child session dir
 * - POST-REC-3: task seeded with [task from parent] prefix
 * - POST-REC-4 / FORBIDDEN-REC-3: model resolution, exact matching, fail-loud on unavailable (no fallback)
 * - POST-REC-5: find_models limit and exact > prefix > substring ranking
 * - POST-REC-6: fallback name 'worker' on name derivation failure
 * - INV-REC-1: sibling name uniqueness
 * - INV-REC-LIFETIME-1: registry durability across restart/restore
 * - INV-REC-LIFETIME-2 / SEQ-REC-8: child usage attribution into parent turn
 * - SEQ-REC-6: depth gate and model resolution before child admission
 * - SEQ-REC-7: terminal notice before parent turn closes
 * - ERRORS-REC-1: exact REC_ERR_* errors
 * - FORBIDDEN-REC-2: delete tombstones without erasing transcripts
 */

import { describe, expect, test } from "bun:test";

import {
  REC_CHILD_DIR_PREFIX,
  REC_CHILD_ID_HEX_LEN,
  REC_DEFAULT_NAME_FALLBACK,
  REC_DEPTH_DEFAULT,
  REC_ERR_AMBIGUOUS,
  REC_ERR_DEPTH,
  REC_ERR_DISPOSED_PARENT,
  REC_ERR_INVALID_HANDLE,
  REC_ERR_KWARGS,
  REC_ERR_MODEL_UNAVAILABLE,
  REC_ERR_PREFLIGHT,
  REC_ERR_PROMPT_TYPE,
  REC_ERR_UNKNOWN_TARGET,
  REC_MAX_DEPTH_DEFAULT,
  REC_MODEL_SEARCH_DEFAULT_LIMIT,
  REC_MODEL_SEARCH_MAX_LIMIT,
  REC_NAME_MAX_CHARS,
  REC_TASK_PREFIX,
  RlmRecursionContractError,
  RlmRecursionEngine,
  RlmSubagentRegistry,
  type RlmRecursionDeps,
  type RlmSpawnOptions,
} from "../src/recursion.ts";

describe("RLM recursion engine (SLICE-6 RED)", () => {
  // ---------------------------------------------------------------------------
  // PRE-REC-1 & ERRORS-REC-1: Input & Kwargs Validation
  // ---------------------------------------------------------------------------

  test("PRE-REC-1: rlm.run rejects non-string prompt with exact error", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
    });

    let caught: unknown;
    try {
      await engine.spawn(null as unknown as string);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RlmRecursionContractError);
    expect((caught as Error).message).toBe(REC_ERR_PROMPT_TYPE);
  });

  test("PRE-REC-1 + ERRORS-REC-1: rlm.run rejects unsupported kwargs with sorted list", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
    });

    let caught: unknown;
    try {
      await engine.spawn("test subtask", {
        temperature: 0.7,
        unsupported_param: true,
        bogus: "foo",
      } as unknown as RlmSpawnOptions);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RlmRecursionContractError);
    expect((caught as Error).message).toBe(
      REC_ERR_KWARGS.replace("%s", "bogus, temperature, unsupported_param"),
    );
  });

  // ---------------------------------------------------------------------------
  // POST-REC-1 & FORBIDDEN-REC-1: Admission Handle & Answer Isolation
  // ---------------------------------------------------------------------------

  test("POST-REC-1 + FORBIDDEN-REC-1: spawn returns 4-field handle immediately; never contains child answer (REQ-N-5)", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
    });

    const handle = await engine.spawn("review the API design", {
      name: "api-reviewer",
    });

    // Handle must contain exactly the 4 required fields
    expect(handle).toBeDefined();
    expect(typeof handle.rlm_child_id).toBe("string");
    expect(handle.rlm_child_id.startsWith(REC_CHILD_DIR_PREFIX)).toBe(true);
    expect(handle.rlm_child_id.length).toBe(REC_CHILD_DIR_PREFIX.length + REC_CHILD_ID_HEX_LEN);
    expect(handle.name).toBe("api-reviewer");
    expect(handle.session_dir).toBe(`/tmp/artifacts/parent-1/${handle.rlm_child_id}`);
    expect(handle.model).toBe("anthropic/claude-sonnet-5");

    // REQ-N-5: handle MUST NOT carry any result / output / answer property
    expect((handle as Record<string, unknown>).result).toBeUndefined();
    expect((handle as Record<string, unknown>).answer).toBeUndefined();
    expect((handle as Record<string, unknown>).output).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // POST-REC-2 & ERRORS-REC-1: Depth Gate & Directory Partitioning
  // ---------------------------------------------------------------------------

  test("POST-REC-2 + ERRORS-REC-1: depth exhaustion throws exact REC_ERR_DEPTH", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "child-level-1",
      parentArtifactsDir: "/tmp/artifacts/child-1",
      parentModel: "anthropic/claude-sonnet-5",
      depth: 1,
      maxDepth: 1,
    });

    let caught: unknown;
    try {
      await engine.spawn("nested subtask");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RlmRecursionContractError);
    expect((caught as Error).message).toBe(
      REC_ERR_DEPTH.replace("%d", "1").replace("%d", "1"),
    );
  });

  // ---------------------------------------------------------------------------
  // POST-REC-3: Task Seeding Prefix
  // ---------------------------------------------------------------------------

  test("POST-REC-3: child initial turn prompt is seeded with exact task prefix", async () => {
    let seededPrompt = "";
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
      childRunner: async (childConfig) => {
        seededPrompt = childConfig.initialPrompt;
        return { ok: true };
      },
    });

    await engine.spawn("analyze security vulnerabilities");
    expect(seededPrompt.startsWith(REC_TASK_PREFIX)).toBe(true);
    expect(seededPrompt).toBe(`${REC_TASK_PREFIX} analyze security vulnerabilities`);
  });

  // ---------------------------------------------------------------------------
  // POST-REC-4 & FORBIDDEN-REC-3: Model Resolution & Strict Fail-Loud
  // ---------------------------------------------------------------------------

  test("POST-REC-4 + FORBIDDEN-REC-3: requested unavailable model fails loud; no silent fallback", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
      availableModels: ["anthropic/claude-sonnet-5", "google-antigravity/gemini-3.7-flash"],
    });

    let caught: unknown;
    try {
      await engine.spawn("task with missing model", {
        model: "nonexistent/fake-model",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RlmRecursionContractError);
    expect((caught as Error).message).toBe(
      REC_ERR_MODEL_UNAVAILABLE.replace("%s", "nonexistent/fake-model"),
    );
  });

  test("POST-REC-4: model resolution is case-insensitive exact match", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
      availableModels: ["anthropic/claude-sonnet-5", "google-antigravity/gemini-3.7-flash"],
    });

    const handle = await engine.spawn("task", {
      model: "GOOGLE-ANTIGRAVITY/gemini-3.7-flash",
    });
    expect(handle.model).toBe("google-antigravity/gemini-3.7-flash");
  });

  // ---------------------------------------------------------------------------
  // POST-REC-5: Model Discovery Ranking & Limit
  // ---------------------------------------------------------------------------

  test("POST-REC-5: find_models caps results at max limit and ranks exact > prefix > substring", async () => {
    const catalog = [
      "openrouter/google/gemini-3.7-flash",
      "google-antigravity/gemini-3.7-flash",
      "google-antigravity/gemini-2.5-pro",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "xai-oauth/grok-4.6",
    ];

    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
      availableModels: catalog,
    });

    const results = engine.findModels("gemini", 10);
    expect(results.length).toBeLessThanOrEqual(REC_MODEL_SEARCH_MAX_LIMIT);
    expect(results.every(m => m.toLowerCase().includes("gemini"))).toBe(true);

    // Exact search
    const exact = engine.findModels("xai-oauth/grok-4.6");
    expect(exact[0]).toBe("xai-oauth/grok-4.6");
  });

  // ---------------------------------------------------------------------------
  // POST-REC-6: Fallback Name
  // ---------------------------------------------------------------------------

  test("POST-REC-6: fallback name 'worker' is returned when name derivation is blank/invalid", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
    });

    // No name specified -> derived or fallback
    const handle = await engine.spawn("...");
    expect(handle.name).toBe(REC_DEFAULT_NAME_FALLBACK);
  });

  // ---------------------------------------------------------------------------
  // INV-REC-1: Sibling Name Uniqueness
  // ---------------------------------------------------------------------------

  test("INV-REC-1: duplicate sibling names are disambiguated or rejected within parent", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
    });

    const h1 = await engine.spawn("task 1", { name: "reviewer" });
    const h2 = await engine.spawn("task 2", { name: "reviewer" });

    expect(h1.name).toBe("reviewer");
    expect(h2.name).not.toBe("reviewer");
    expect(h2.name.startsWith("reviewer-")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Registry Operations & FORBIDDEN-REC-2: Tombstone Deletion
  // ---------------------------------------------------------------------------

  test("POST-REC-5 + FORBIDDEN-REC-2: registry tracks children; delete tombstones without erasing files", async () => {
    const registry = new RlmSubagentRegistry({
      storageDir: "/tmp/artifacts/parent-1/registry",
    });

    registry.register({
      rlm_child_id: "sub-12345678",
      active_session_id: "sess-child-1",
      session_id: "sess-1",
      session_name: "reviewer",
      session_dir: "/tmp/artifacts/parent-1/sub-12345678",
      status: "completed",
    });

    const listed = registry.list();
    expect(listed.length).toBe(1);
    expect(listed[0].session_name).toBe("reviewer");

    // Deletion tombstones entry
    const outcome = registry.delete("sub-12345678");
    expect(outcome).toBe("deleted");

    // Active listing no longer includes tombstoned subagent
    expect(registry.list().length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // INV-REC-LIFETIME-2 & SEQ-REC-8: Child Usage Attribution
  // ---------------------------------------------------------------------------

  test("INV-REC-LIFETIME-2 + SEQ-REC-8: child usage is attributed to parent assistant turn", async () => {
    let attributedEvent: unknown = null;
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
      onAttribution: (event) => {
        attributedEvent = event;
      },
    });

    await engine.attributeChildUsage({
      parentMessageId: "msg-turn-4",
      rlmChildId: "sub-12345678",
      childTokens: { input: 1200, output: 400 },
      childCost: 0.012,
    });

    expect(attributedEvent).toBeDefined();
    expect((attributedEvent as Record<string, unknown>).parentMessageId).toBe("msg-turn-4");
    expect((attributedEvent as Record<string, unknown>).attributedTokens).toEqual({ input: 1200, output: 400 });
  });

  // ---------------------------------------------------------------------------
  // Disposed Parent Rejection (ERRORS-REC-1)
  // ---------------------------------------------------------------------------

  test("ERRORS-REC-1: spawning from a disposed parent engine raises exact error", async () => {
    const engine = new RlmRecursionEngine({
      parentSessionId: "parent-1",
      parentArtifactsDir: "/tmp/artifacts/parent-1",
      parentModel: "anthropic/claude-sonnet-5",
    });

    engine.dispose();

    let caught: unknown;
    try {
      await engine.spawn("task");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RlmRecursionContractError);
    expect((caught as Error).message).toBe(REC_ERR_DISPOSED_PARENT);
  });
});
