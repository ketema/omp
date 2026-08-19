/**
 * RLM ENGINES SPECIFICATION TESTS (SLICE-7 RED).
 *
 * Adversarial specification-driven tests for the four ported engines:
 * 1. Refine loop engine (refine.status, refine.run)
 * 2. Heartbeat scheduler engine (heartbeat.list, create, update, delete)
 * 3. Agent message routing bus (agent_message.list_agents, send)
 * 4. Agent observe reader (agent_observe.list, get, recent)
 *
 * Traceability:
 * - REQ-RLM-0010: 4 ported engines from prime-agent with real machinery (Z-2 a-full)
 * - POST-BR-2: handler registration gated by capability enablement
 * - POST-BR-3: full F-150..F-163 semantics delivered with real machinery
 * - POST-BR-4: refine.run returns exact BR_REFINE_NOTE scheduling string
 * - POST-BR-6: agent_message.send returns receipt with deliveryStatus
 * - FORBIDDEN-BR-3 / BR-V3: heartbeat update strictly validates pause | resume
 * - INV-BR-1 / ERRORS-BR-1: disabled/unknown handlers answer exact unavailability string
 */

import { describe, expect, test } from "bun:test";

import {
  BR_ERR_UNAVAILABLE,
  BR_HEARTBEAT_STATUSES,
  BR_MESSAGE_ROLES,
  BR_REFINE_NOTE,
  RlmBridgeContractError,
  validateHeartbeatUpdate,
  validateMessageRole,
} from "../../../requirements/contracts/rlm-bridge.contract.ts";

import {
  AgentMessageEngine,
  AgentObserveEngine,
  HeartbeatEngine,
  RefineEngine,
  RlmBridgeRouter,
} from "../src/engines.ts";

describe("RLM Ported Engines (SLICE-7 RED)", () => {
  // ===========================================================================
  // 1. Refine Loop Engine (F-155, F-156, POST-BR-3, POST-BR-4)
  // ===========================================================================
  describe("Refine Loop Engine", () => {
    test("POST-BR-3: refine.status returns initial idle state", async () => {
      const engine = new RefineEngine();
      const status = await engine.status();
      expect(status).toEqual({ pending: false, in_flight: false });
    });

    test("POST-BR-4: refine.run schedules refinement and returns exact scheduling note without blocking", async () => {
      const engine = new RefineEngine();
      const response = await engine.run({ global: false });
      expect(response).toEqual({
        note: BR_REFINE_NOTE,
        scheduled: true,
      });

      const status = await engine.status();
      expect(status.pending).toBe(true);
    });

    test("ERRORS-BR-1: refine.run rejects invalid non-boolean global parameter", async () => {
      const engine = new RefineEngine();
      let caught: unknown = null;
      try {
        await engine.run({ global: "not-a-boolean" as unknown as boolean });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RlmBridgeContractError);
    });
  });

  // ===========================================================================
  // 2. Heartbeat Scheduler Engine (F-157..F-160, POST-BR-3, FORBIDDEN-BR-3, BR-V3)
  // ===========================================================================
  describe("Heartbeat Scheduler Engine", () => {
    test("POST-BR-3: heartbeat.create adds new heartbeat and lists active entries", async () => {
      const engine = new HeartbeatEngine();
      const hb = await engine.create({
        instruction: "check background jobs",
        interval: "30s",
        label: "job-monitor",
      });

      expect(typeof hb.id).toBe("string");
      expect(hb.id.length).toBeGreaterThan(0);
      expect(hb.instruction).toBe("check background jobs");
      expect(hb.interval).toBe("30s");
      expect(hb.label).toBe("job-monitor");
      expect(hb.status).toBe("active");

      const listing = await engine.list({ include_inactive: false });
      expect(listing.heartbeats.length).toBe(1);
      expect(listing.heartbeats[0].id).toBe(hb.id);
    });

    test("FORBIDDEN-BR-3 + BR-V3: heartbeat.update validates status to pause | resume strictly", async () => {
      const engine = new HeartbeatEngine();
      const hb = await engine.create({
        instruction: "periodic sync",
      });

      // Valid pause update
      const paused = await engine.update({
        id: hb.id,
        status: "pause",
      });
      expect(paused.status).toBe("pause");

      // Listing active heartbeats excludes paused
      const activeOnly = await engine.list({ include_inactive: false });
      expect(activeOnly.heartbeats.length).toBe(0);

      // Listing including inactive heartbeats shows paused
      const all = await engine.list({ include_inactive: true });
      expect(all.heartbeats.length).toBe(1);

      // Valid resume update
      const resumed = await engine.update({
        id: hb.id,
        status: "resume",
      });
      expect(resumed.status).toBe("active");

      // FORBIDDEN-BR-3: invalid status like "stop" or "disabled" must fail loud
      let caught: unknown = null;
      try {
        await engine.update({
          id: hb.id,
          status: "stop" as unknown as "pause",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RlmBridgeContractError);
    });

    test("POST-BR-3: heartbeat.delete removes entry by id", async () => {
      const engine = new HeartbeatEngine();
      const hb = await engine.create({ instruction: "temp tick" });
      const delResult = await engine.delete({ id: hb.id });
      expect(delResult).toEqual({ deleted: true });

      const all = await engine.list({ include_inactive: true });
      expect(all.heartbeats.length).toBe(0);
    });
  });

  // ===========================================================================
  // 3. Agent Message Routing Bus (F-161, F-162, POST-BR-3, POST-BR-6, BR-V4)
  // ===========================================================================
  describe("Agent Message Routing Bus", () => {
    test("POST-BR-3 + BR-V4: list_agents enumerates allowable family targets", async () => {
      const bus = new AgentMessageEngine({
        currentAgentId: "sub-12345678",
        family: {
          parent: "parent-session-1",
          siblings: ["sub-87654321"],
          children: ["sub-child-001"],
        },
      });

      const agents = await bus.listAgents();
      expect(agents.map(a => a.role)).toEqual(expect.arrayContaining(["parent", "sibling", "child"]));
    });

    test("POST-BR-6: send delivers message to target and returns receipt", async () => {
      const deliveredMessages: unknown[] = [];
      const bus = new AgentMessageEngine({
        currentAgentId: "sub-12345678",
        family: {
          parent: "parent-session-1",
          siblings: ["sub-87654321"],
          children: [],
        },
        transport: {
          async deliver(msg) {
            deliveredMessages.push(msg);
            return { ok: true };
          },
        },
      });

      const receipt = await bus.send({
        target: "sub-87654321",
        role: "sibling",
        message: "hello from sibling",
      });

      expect(typeof receipt.id).toBe("string");
      expect(receipt.target).toBe("sub-87654321");
      expect(receipt.message).toBe("hello from sibling");
      expect(receipt.deliveryStatus).toBe("delivered");
      expect(deliveredMessages.length).toBe(1);
    });

    test("ERRORS-BR-1 + BR-V4: send rejects target outside nuclear family", async () => {
      const bus = new AgentMessageEngine({
        currentAgentId: "sub-12345678",
        family: {
          parent: "parent-session-1",
          siblings: [],
          children: [],
        },
      });

      let caught: unknown = null;
      try {
        await bus.send({
          target: "unrelated-agent-999",
          role: "stranger" as unknown as "parent",
          message: "illegal ping",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RlmBridgeContractError);
    });
  });

  // ===========================================================================
  // 4. Agent Observe Reader (F-163, POST-BR-3)
  // ===========================================================================
  describe("Agent Observe Reader", () => {
    test("POST-BR-3: observe.list and observe.recent retrieve bounded subagent context", async () => {
      const observer = new AgentObserveEngine({
        provider: {
          async listObservable() {
            return [{ rlmChildId: "sub-child-001", name: "scout", status: "completed" }];
          },
          async readRecent(target, limit, maxChars) {
            return {
              target,
              lines: ["line 1", "line 2"].slice(0, limit),
              truncated: false,
            };
          },
        },
      });

      const list = await observer.list();
      expect(list.length).toBe(1);
      expect(list[0].name).toBe("scout");

      const recent = await observer.recent({ target: "sub-child-001", limit: 5, max_chars: 1000 });
      expect(recent.target).toBe("sub-child-001");
      expect(recent.lines).toEqual(["line 1", "line 2"]);
    });
  });

  // ===========================================================================
  // 5. RlmBridgeRouter: Capability Dispatch & Gating (POST-BR-2, INV-BR-1)
  // ===========================================================================
  describe("RlmBridgeRouter Capability Gating", () => {
    test("POST-BR-2 + INV-BR-1: router dispatches enabled capabilities and answers exact error when disabled", async () => {
      const router = new RlmBridgeRouter({
        modelInfo: { id: "gemini-3.7-flash", provider: "google", input: 200000 },
        refine: new RefineEngine(),
        heartbeat: undefined, // disabled
        agentMessage: undefined, // disabled
        agentObserve: undefined, // disabled
      });

      // Always-on model.info works
      const info = await router.dispatch("model.info", {});
      expect(info).toEqual({ id: "gemini-3.7-flash", provider: "google", input: 200000 });

      // Enabled refine works
      const refineStatus = await router.dispatch("refine.status", {});
      expect(refineStatus).toEqual({ pending: false, in_flight: false });

      // Disabled heartbeat answers exact unavailability string per INV-BR-1 / F-166
      let caught: unknown = null;
      try {
        await router.dispatch("rlm_heartbeat.list", {});
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RlmBridgeContractError);
      expect((caught as Error).message).toBe(
        BR_ERR_UNAVAILABLE.replace("%s", "rlm_heartbeat.list"),
      );
    });
  });
});
