import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { parseRateLimitReason } from "@oh-my-pi/pi-ai";
import { $env, logger } from "@oh-my-pi/pi-utils";
import type { PaidCostProvider, PaidFallbackDenialReasonCode } from "./agent-session-events";

/**
 * SharedFallbackPolicy — the single boundary every automatic fallback surface
 * (TurnRecovery's error-driven and usage-aware paths, SessionAdvisors
 * recovery, and the SDK's deferred session-creation resolver) must cross
 * before applying a Google Vertex or OpenRouter candidate for the contracted
 * Gemini 3.7 Flash continuity route.
 *
 * This module is an independent implementation artifact. It does NOT import
 * from `contracts/omp_quota_router.contract.py` (CL11-F): constants,
 * categories, and algorithms below are redeclared from the contract's WHAT,
 * not coupled to its HOW.
 *
 * Contract clauses governing this module: PRE-QR-7, PRE-QR-8, PRE-QR-12,
 * PRE-QR-13, PRE-QR-14, POST-QR-16, POST-QR-18..20, POST-QR-24..30,
 * INV-QR-12..16, INV-QR-18, INV-QR-19, SEQ-QR-12..18, ERRORS-QR-9..14,
 * FORBIDDEN-QR-13, FORBIDDEN-QR-14, FORBIDDEN-QR-16, FORBIDDEN-QR-17.
 */

// ---------------------------------------------------------------------------
// Canonical selector identity (redeclared independently — CL11-F)
// ---------------------------------------------------------------------------

const ANTIGRAVITY_PROVIDER = "google-antigravity";
const ANTIGRAVITY_GEMINI_ID = "gemini-3.7-flash-tiered";
const VERTEX_PROVIDER = "google-vertex";
const VERTEX_GEMINI_ID = "gemini-3.7-flash";
const OPENROUTER_PROVIDER = "openrouter";

/** REQ-QR-028 / PRE-QR-13: the pinned Vertex Cloud Billing identity. */
export const VERTEX_FALLBACK_PROJECT = "semantic-embedder-stg";
export const VERTEX_FALLBACK_LOCATION = "global";

export interface SelectorIdentity {
	provider: string;
	id: string;
}

/** Parses `provider/id[:level]` into a bare `{provider, id}` pair. */
function selectorIdentity(selector: string | SelectorIdentity): SelectorIdentity {
	if (typeof selector !== "string") return selector;
	const slashIndex = selector.indexOf("/");
	if (slashIndex < 0) return { provider: selector, id: "" };
	const provider = selector.slice(0, slashIndex);
	const rest = selector.slice(slashIndex + 1);
	const colonIndex = rest.lastIndexOf(":");
	const id = colonIndex < 0 ? rest : rest.slice(0, colonIndex);
	return { provider, id };
}

type GovernedSelectorKind = "antigravity" | "vertex";

function governedSelectorKind(selector: string | SelectorIdentity): GovernedSelectorKind | undefined {
	const { provider, id } = selectorIdentity(selector);
	if (provider === ANTIGRAVITY_PROVIDER && id === ANTIGRAVITY_GEMINI_ID) return "antigravity";
	if (provider === VERTEX_PROVIDER && id === VERTEX_GEMINI_ID) return "vertex";
	return undefined;
}

/**
 * True for the exact contracted Vertex Gemini 3.7 Flash continuity candidate.
 * Exported domain concept shared verbatim by TurnRecovery, SessionAdvisors,
 * and the SDK deferred resolver — inlining would let the three surfaces drift.
 */
export function isVertexGeminiCandidate(candidate: SelectorIdentity | string | null | undefined): boolean {
	if (candidate === null || candidate === undefined) return false;
	return governedSelectorKind(candidate) === "vertex";
}

/**
 * True for any OpenRouter candidate. Matches the pre-existing broad
 * provider-based recognition (`isOpenRouterPaidCandidate`) so every already-
 * contracted OpenRouter denial path keeps routing through this policy.
 */
export function isOpenRouterCandidate(candidate: { provider: string } | string | null | undefined): boolean {
	if (candidate === null || candidate === undefined) return false;
	const provider = typeof candidate === "string" ? selectorIdentity(candidate).provider : candidate.provider;
	return provider === OPENROUTER_PROVIDER;
}

/** True for the exact contracted Antigravity Gemini 3.7 Flash selector. */
export function isAntigravityGeminiCandidate(candidate: SelectorIdentity | string | null | undefined): boolean {
	if (candidate === null || candidate === undefined) return false;
	return governedSelectorKind(candidate) === "antigravity";
}

/** True when this candidate must cross the SharedFallbackPolicy boundary before being applied. */
export function isGovernedPaidCandidate(candidate: SelectorIdentity | string | null | undefined): boolean {
	return isVertexGeminiCandidate(candidate) || isOpenRouterCandidate(candidate);
}

// ---------------------------------------------------------------------------
// Provider outcome classification (independent port of the contract's
// `_classify_provider_outcome` — SEQ-QR-13, POST-QR-25, ERRORS-QR-14)
// ---------------------------------------------------------------------------

export type ProviderOutcomeCategory =
	| "success"
	| "quota_exhausted"
	| "rate_limited"
	| "service_unavailable"
	| "auth"
	| "config"
	| "timeout"
	| "transport"
	| "malformed"
	| "model"
	| "unknown";

/** Raw, trusted evidence for one provider attempt's outcome. */
export interface FallbackAttemptEvidence {
	httpStatus: number | undefined;
	errorMessage: string;
	/** Whether OMP's own retry/backoff budget for this selector is exhausted. */
	retryExhausted: boolean;
	/** Whether the failure was independently classified as an auth failure. */
	authFailure: boolean;
}

/**
 * Classifies raw Antigravity/Vertex evidence into an outcome category.
 * Independent re-derivation of the contract's `_classify_provider_outcome`
 * (POST-QR-25): only the canonical parser's `QUOTA_EXHAUSTED` /
 * `INSUFFICIENT_G1_CREDITS_BALANCE` verdicts classify a 429 as
 * `quota_exhausted`; every other 429 — including bare `RESOURCE_EXHAUSTED` /
 * `RATE_LIMIT_EXCEEDED` wrappers — stays `rate_limited` (transient).
 * `service_unavailable` requires both a Vertex selector AND retry exhaustion
 * (ERRORS-QR-14); the same signal before exhaustion remains timeout/transport.
 */
export function classifyProviderOutcome(
	selectorKind: GovernedSelectorKind,
	evidence: FallbackAttemptEvidence,
): ProviderOutcomeCategory {
	const { httpStatus, errorMessage, retryExhausted, authFailure } = evidence;
	if (httpStatus === 429) {
		const reason = parseRateLimitReason(errorMessage);
		return reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE"
			? "quota_exhausted"
			: "rate_limited";
	}
	if (httpStatus === 401 || httpStatus === 403 || authFailure) return "auth";
	if (httpStatus === 400) return "model";
	if (httpStatus === 408 || httpStatus === 504) {
		return selectorKind === "vertex" && retryExhausted ? "service_unavailable" : "timeout";
	}
	if (httpStatus !== undefined && httpStatus >= 500) {
		return selectorKind === "vertex" && retryExhausted ? "service_unavailable" : "transport";
	}
	return "unknown";
}

// ---------------------------------------------------------------------------
// PRE-QR-13 / POST-QR-27 / INV-QR-19: Vertex credential and location boundary
// ---------------------------------------------------------------------------

/**
 * Returns a diagnostic when the ambient environment would route the
 * contracted Vertex fallback through the Express/API-key branch, a
 * non-pinned project, or a conflicting location override — `undefined` when
 * the boundary is clean. Scoped to THIS fallback route only: the general
 * `google-vertex` provider hosts other Gemini/Claude catalog entries under
 * other projects/locations that this check must not disturb.
 */
export function describeVertexCredentialBoundaryViolation(): string | undefined {
	if ($env.GOOGLE_CLOUD_API_KEY) {
		return "GOOGLE_CLOUD_API_KEY is set; the Vertex paid-fallback route requires ADC, not the Express/API-key branch (PRE-QR-13)";
	}
	const project = $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	if (project && project !== VERTEX_FALLBACK_PROJECT) {
		return `GOOGLE_CLOUD_PROJECT is "${project}", not the contracted "${VERTEX_FALLBACK_PROJECT}" (PRE-QR-13)`;
	}
	const conflicting = $env.GOOGLE_VERTEX_LOCATION || $env.VERTEX_LOCATION;
	if (conflicting && conflicting !== VERTEX_FALLBACK_LOCATION) {
		return `A conflicting Vertex location override ("${conflicting}") is set; the paid-fallback route requires "${VERTEX_FALLBACK_LOCATION}" (PRE-QR-13)`;
	}
	const canonicalLocation = $env.GOOGLE_CLOUD_LOCATION;
	if (canonicalLocation && canonicalLocation !== VERTEX_FALLBACK_LOCATION) {
		return `GOOGLE_CLOUD_LOCATION is "${canonicalLocation}", not the contracted "${VERTEX_FALLBACK_LOCATION}" (PRE-QR-13)`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// PRE-QR-14 / REQ-QR-030: Keychain-backed classifier/notifier trust anchors
// ---------------------------------------------------------------------------

const TRUST_ANCHOR_SERVICE = "com.kharri04.omp.paid-fallback";
const CLASSIFIER_ACCOUNT = "classifier";
const NOTIFIER_ACCOUNT = "notifier";
const MIN_TRUST_ANCHOR_BYTES = 32;

export class FallbackTrustAnchorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FallbackTrustAnchorError";
	}
}

export interface FallbackTrustAnchors {
	classifierKey: Buffer;
	notifierKey: Buffer;
}

/** Reads one fixed Keychain identity's secret. Never logs or returns the raw value on failure. */
function readKeychainSecret(account: string): Buffer | undefined {
	try {
		const stdout = execFileSync(
			"security",
			["find-generic-password", "-w", "-a", account, "-s", TRUST_ANCHOR_SERVICE],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const trimmed = stdout.toString("utf8").replace(/\r?\n$/, "");
		return trimmed.length > 0 ? Buffer.from(trimmed, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/**
 * PRE-QR-14 / REQ-QR-030: resolves distinct classifier and notifier MAC keys
 * from two fixed Keychain identities at trusted bootstrap. Fails fast —
 * never falls back to a weaker mechanism — when either identity is missing,
 * too short, or identical. Never logs or returns the raw secret bytes.
 */
export function resolveFallbackTrustAnchors(): FallbackTrustAnchors {
	if (process.platform !== "darwin") {
		throw new FallbackTrustAnchorError(
			"PRE-QR-14: paid-fallback trust anchors require macOS Keychain and are unavailable on this platform",
		);
	}
	const classifierKey = readKeychainSecret(CLASSIFIER_ACCOUNT);
	const notifierKey = readKeychainSecret(NOTIFIER_ACCOUNT);
	if (!classifierKey || !notifierKey) {
		throw new FallbackTrustAnchorError(
			"PRE-QR-14: classifier and notifier trust anchors are unavailable from Keychain",
		);
	}
	if (classifierKey.length < MIN_TRUST_ANCHOR_BYTES || notifierKey.length < MIN_TRUST_ANCHOR_BYTES) {
		throw new FallbackTrustAnchorError(
			`PRE-QR-14: trust anchors must contain at least ${MIN_TRUST_ANCHOR_BYTES} bytes`,
		);
	}
	if (classifierKey.equals(notifierKey)) {
		throw new FallbackTrustAnchorError("PRE-QR-14: classifier and notifier trust anchors must be distinct");
	}
	return { classifierKey, notifierKey };
}

// ---------------------------------------------------------------------------
// Decision-scoped state (POST-QR-18..20, POST-QR-30, SEQ-QR-18)
// ---------------------------------------------------------------------------

interface ClassifiedReceipt {
	classification: ProviderOutcomeCategory;
	httpStatus: number | undefined;
	issuedAt: number;
	/** HMAC-SHA256 over the receipt material, keyed by the classifier trust anchor. */
	receiptMac: string;
}

/**
 * Mutable per-(session, decision) tracking. Genuinely dynamic: entries are
 * inserted as evidence/authorizations arrive over the episode's lifetime and
 * the whole entry is deleted by `releaseDecision` — not a static lookup.
 */
interface DecisionState {
	evidence: Map<GovernedSelectorKind, ClassifiedReceipt>;
	pending: Map<string, Promise<PaidTransitionAuthorization>>;
	settled: Map<string, PaidTransitionAuthorization & { authorized: true }>;
	notified: Set<string>;
}

export interface PaidTransitionRequest {
	sessionId: string;
	decisionId: string;
	toSelector: string | SelectorIdentity;
}

export type PaidTransitionAuthorization =
	| {
			authorized: true;
			costProvider: PaidCostProvider;
			authoritativeQuotaSignal: ProviderOutcomeCategory;
			emittedAt: number;
	  }
	| {
			authorized: false;
			reasonCode: PaidFallbackDenialReasonCode;
			denialReason: string;
	  };

/**
 * Owns the paid-suffix authorization boundary for one process: subscription
 * outcome classification, session-and-decision-scoped single-flight
 * authorization, single-notification claiming, and the Vertex credential
 * boundary. TurnRecovery, SessionAdvisors, and the SDK deferred resolver each
 * hold a reference obtained from {@link getSharedFallbackPolicy}.
 */
export class SharedFallbackPolicy {
	readonly #anchors: FallbackTrustAnchors;
	readonly #decisions = new Map<string, DecisionState>();

	constructor(anchors: FallbackTrustAnchors) {
		this.#anchors = anchors;
	}

	#getOrCreateDecision(sessionId: string, decisionId: string): DecisionState {
		const key = `${sessionId}\u0000${decisionId}`;
		let decision = this.#decisions.get(key);
		if (!decision) {
			decision = { evidence: new Map(), pending: new Map(), settled: new Map(), notified: new Set() };
			this.#decisions.set(key, decision);
		}
		return decision;
	}

	/** Releases a decision's tracked state once its fallback episode ends. */
	releaseDecision(sessionId: string, decisionId: string): void {
		this.#decisions.delete(`${sessionId}\u0000${decisionId}`);
	}

	/**
	 * SEQ-QR-13: classifies one Antigravity/Vertex attempt's raw evidence and
	 * binds the resulting receipt to this session-and-decision. Only the two
	 * governed selectors are recorded; any other selector is a no-op, since no
	 * other outcome gates a paid transition.
	 */
	recordSubscriptionAttempt(
		sessionId: string,
		decisionId: string,
		selector: string | SelectorIdentity,
		evidence: FallbackAttemptEvidence,
	): void {
		const kind = governedSelectorKind(selector);
		if (!kind) return;
		const decision = this.#getOrCreateDecision(sessionId, decisionId);
		const classification = classifyProviderOutcome(kind, evidence);
		const issuedAt = Date.now();
		const material = [sessionId, decisionId, kind, evidence.httpStatus, classification, issuedAt].join("|");
		decision.evidence.set(kind, {
			classification,
			httpStatus: evidence.httpStatus,
			issuedAt,
			receiptMac: createHmac("sha256", this.#anchors.classifierKey).update(material).digest("hex"),
		});
	}

	/** Shapes a denial. Called from four distinct gate branches in `#evaluate` — keeps their shape in lockstep. */
	#deny(reasonCode: PaidFallbackDenialReasonCode, denialReason: string): PaidTransitionAuthorization {
		return { authorized: false, reasonCode, denialReason };
	}

	/** Shapes an authorization. Called from both gate branches in `#evaluate` — keeps their shape in lockstep. */
	#authorize(
		costProvider: PaidCostProvider,
		authoritativeQuotaSignal: ProviderOutcomeCategory,
	): PaidTransitionAuthorization {
		return { authorized: true, costProvider, authoritativeQuotaSignal, emittedAt: Date.now() };
	}

	async #evaluate(decision: DecisionState, toSelector: string | SelectorIdentity): Promise<PaidTransitionAuthorization> {
		const identity = selectorIdentity(toSelector);

		if (identity.provider === VERTEX_PROVIDER && identity.id === VERTEX_GEMINI_ID) {
			// SEQ-QR-14 / INV-QR-12: Vertex requires authentic Antigravity quota_exhausted evidence.
			const antigravity = decision.evidence.get("antigravity");
			if (!antigravity) {
				return this.#deny("missing_receipt", "No Antigravity outcome evidence is bound to this decision yet");
			}
			if (antigravity.classification !== "quota_exhausted") {
				return this.#deny(
					"not_quota_exhausted",
					`Antigravity classified as "${antigravity.classification}", not quota_exhausted (SEQ-QR-14)`,
				);
			}
			const boundaryViolation = describeVertexCredentialBoundaryViolation();
			if (boundaryViolation) {
				return this.#deny("vertex_credential_boundary", boundaryViolation);
			}
			return this.#authorize("google-vertex", "quota_exhausted");
		}

		if (identity.provider === OPENROUTER_PROVIDER) {
			// POST-QR-19 / SEQ-QR-15: OpenRouter requires the bound Antigravity receipt
			// PLUS a distinct qualifying Vertex receipt for the same decision.
			const antigravity = decision.evidence.get("antigravity");
			if (!antigravity || antigravity.classification !== "quota_exhausted") {
				return this.#deny(
					"missing_receipt",
					"No qualifying Antigravity quota-exhaustion receipt is bound to this decision (POST-QR-19)",
				);
			}
			const vertex = decision.evidence.get("vertex");
			if (!vertex) {
				return this.#deny("missing_receipt", "No Vertex outcome evidence is bound to this decision yet (SEQ-QR-15)");
			}
			if (vertex.classification !== "quota_exhausted" && vertex.classification !== "service_unavailable") {
				return this.#deny(
					"not_quota_exhausted",
					`Vertex classified as "${vertex.classification}", not quota_exhausted or retry-exhausted service_unavailable (ERRORS-QR-14)`,
				);
			}
			return this.#authorize("openrouter", vertex.classification);
		}

		return this.#deny("missing_receipt", "Candidate is not a governed paid-fallback selector");
	}

	/**
	 * POST-QR-30 / SEQ-QR-18: session-and-decision-scoped single-flight
	 * authorization. Concurrent callers for the same (session, decision,
	 * candidate) share one in-flight evaluation; once authorized, later callers
	 * receive the same recorded decision without re-classifying. Denials are
	 * never cached — fresh evidence (e.g. retry exhaustion) must be able to
	 * flip a later call to authorized.
	 */
	async authorizePaidTransition(request: PaidTransitionRequest): Promise<PaidTransitionAuthorization> {
		const decision = this.#getOrCreateDecision(request.sessionId, request.decisionId);
		const identity = selectorIdentity(request.toSelector);
		const cacheKey = `${identity.provider}/${identity.id}`;

		const settled = decision.settled.get(cacheKey);
		if (settled) return settled;
		const pending = decision.pending.get(cacheKey);
		if (pending) return pending;

		const work = this.#evaluate(decision, request.toSelector).then(result => {
			decision.pending.delete(cacheKey);
			if (result.authorized) decision.settled.set(cacheKey, result);
			return result;
		});
		decision.pending.set(cacheKey, work);
		return work;
	}

	/**
	 * Returns true exactly once per (session, decision, candidate) — the
	 * caller that receives `true` owns emitting the `paid_fallback_active`
	 * notification; every other concurrent or later caller receives `false`
	 * and must not independently notify (POST-QR-30).
	 */
	claimNotification(sessionId: string, decisionId: string, toSelector: string | SelectorIdentity): boolean {
		const decision = this.#getOrCreateDecision(sessionId, decisionId);
		const identity = selectorIdentity(toSelector);
		const cacheKey = `${identity.provider}/${identity.id}`;
		if (decision.notified.has(cacheKey)) return false;
		decision.notified.add(cacheKey);
		return true;
	}
}

// ---------------------------------------------------------------------------
// Process-wide singleton with a test-only override seam
// ---------------------------------------------------------------------------

let policyInstance: SharedFallbackPolicy | undefined;
let policyOverride: SharedFallbackPolicy | undefined;

/**
 * Lazily resolves trust anchors and returns the process-wide
 * SharedFallbackPolicy. Fails fast (throws `FallbackTrustAnchorError`) when
 * trust anchors are unavailable — callers must treat that as "deny the paid
 * transition", never as license to bypass this boundary.
 */
export function getSharedFallbackPolicy(): SharedFallbackPolicy {
	if (policyOverride) return policyOverride;
	policyInstance ??= new SharedFallbackPolicy(resolveFallbackTrustAnchors());
	return policyInstance;
}

/**
 * Best-effort access to the process-wide SharedFallbackPolicy for automatic
 * fallback surfaces (TurnRecovery, SessionAdvisors, the SDK deferred
 * resolver): unavailable trust anchors deny the paid transition rather than
 * throwing through unrelated turn/session machinery (PRE-QR-14).
 */
export function resolveSharedFallbackPolicyOrDeny(): SharedFallbackPolicy | undefined {
	try {
		return getSharedFallbackPolicy();
	} catch (error) {
		logger.debug("SharedFallbackPolicy trust anchors unavailable; paid fallback denied", { error: String(error) });
		return undefined;
	}
}

/** Test-only: install or clear a SharedFallbackPolicy override. Never call from production code. */
export function __setSharedFallbackPolicyForTests(policy: SharedFallbackPolicy | undefined): void {
	policyOverride = policy;
	policyInstance = undefined;
}
