import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal, GoalModeState } from "../goals/state";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { TodoItem } from "../tools/todo";
import type { CustomMessage } from "./messages";

/** Stable machine-readable reasons a candidate is denied paid OpenRouter fallback (REQ-QR-022). */
export type PaidFallbackDenialReasonCode =
	| "not_google_antigravity"
	| "non-429"
	| "auth"
	| "candidate_suppressed"
	| "candidate_not_found"
	| "effort_ceiling_exceeded"
	| "context_window_exceeded"
	/** SEQ-QR-14/15: the required predecessor's classified signal does not qualify (e.g. rate_limited, not quota_exhausted). */
	| "not_quota_exhausted"
	/** POST-QR-18/19: no receipt is bound to this decision yet for the required predecessor selector. */
	| "missing_receipt"
	/** PRE-QR-13/POST-QR-27: Vertex ADC/project/location boundary is violated (Express/API-key branch or conflicting location). */
	| "vertex_credential_boundary"
	/** PRE-QR-14: the classifier/notifier Keychain trust anchors could not be resolved. */
	| "trust_anchor_unavailable";

/** Paid provider about to incur cost for one authorized transition (POST-QR-28 "provider about to incur cost"). */
export type PaidCostProvider = "google-vertex" | "openrouter";

/** Session-specific events that extend the core AgentEvent. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| (Extract<AgentEvent, { type: "agent_end" }> & {
			/** False when an async delivery will resume the session before its true final settle. */
			isTerminal?: boolean;
	  })
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason. */
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "model_changed" }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "paid_fallback_active";
			from: string;
			to: string;
			role?: string;
			source?: string;
			emittedAt: number;
			correlationId: string;
			requestedEffort?: string;
			attemptedPosition: number;
			authoritativeQuotaSignal: string;
			/** Paid provider about to incur cost for this transition (POST-QR-28). Absent for non-governed (legacy) paid transitions. */
			costProvider?: PaidCostProvider;
	  }
	| {
			type: "paid_fallback_denied";
			from: string;
			to: string;
			role: string;
			reasonCode: PaidFallbackDenialReasonCode;
			status: string;
			attemptedPosition: number;
			correlationId: string;
			emittedAt: number;
	  }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level. */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };

/** Listener function for agent session events. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
