/**
 * Native Modifier Detection Contract — specification authority.
 *
 * Gives the TUI a general, always-available way to ask "is this macOS
 * modifier key physically held down right now", independent of whatever a
 * terminal/multiplexer chain (Ghostty -> tmux -> herdr) chooses to forward
 * over the wire. Also closes the specific Shift+Enter gap: when a nested
 * terminal chain collapses Shift+Enter to a bare, unmodified `\r` before it
 * ever reaches omp, the native macOS keyboard-state read recovers the lost
 * Shift signal and omp treats it as newline (its existing default binding)
 * instead of submit.
 *
 * Traceability: shift+enter regression, memory
 * `shift-enter-regression-root-cause-2026-08-30`; ported from the native
 * modifier detection Ketema Harris authored in the prime-agent repo
 * (packages/tui/src/native-modifiers.ts, commit f8b234b60,
 * "feat(tui,core): add native modifier helpers, key protocol negotiation,
 * and bound context discovery"), re-implemented on Bun's built-in FFI
 * (bun:ffi) instead of a compiled N-API addon since omp runs on Bun.
 *
 * Scope: this contract governs the general-purpose modifier query API and
 * ONLY the Shift+Enter dispatch fallback. It does not add new Enter-key
 * semantics for control/option/command/fn (User: "I am not asking that ALL
 * modifier keys plus enter = a new line. I only want that to be shift
 * enter (all other defaults left alone)"); those existing behaviors
 * (ctrl+enter, legacy option+enter, plain enter) are unchanged by this
 * contract's implementation.
 *
 * The implementation does NOT import from this file; tests import both.
 */

// =============================================================================
// Artifact 1: Importable Constants
// =============================================================================

/** CGEventFlags bit for each modifier, per CoreGraphics/CGEventTypes.h. */
export const MODIFIER_FLAG_MASKS = {
  shift: 0x00020000, // kCGEventFlagMaskShift
  control: 0x00040000, // kCGEventFlagMaskControl
  option: 0x00080000, // kCGEventFlagMaskAlternate
  command: 0x00100000, // kCGEventFlagMaskCommand
  fn: 0x00800000, // kCGEventFlagMaskSecondaryFn
} as const;

/** CGEventSourceStateID for the combined local+remote session state. */
export const CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE = 0;

/** Kitty keyboard protocol CSI-u sequence synthesized for a recovered Shift+Enter. */
export const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

// =============================================================================
// Artifact 2: Types & Interfaces
// =============================================================================

export type ModifierKey = keyof typeof MODIFIER_FLAG_MASKS;

export interface ModifierFlagsState {
  shift: boolean;
  control: boolean;
  option: boolean;
  command: boolean;
  fn: boolean;
}

// =============================================================================
// Artifact 3: Callable Pure Validators
// =============================================================================

/**
 * PRE-1: `flags` SHALL be a finite, non-negative integer (a raw CGEventFlags
 *   bitmask; only bits 0x10000-0x800000 are meaningful, higher/lower bits are
 *   ignored, never rejected).
 * POST-1: Returns an object with exactly the five ModifierKey properties,
 *   each `true` iff `(flags & MODIFIER_FLAG_MASKS[key]) !== 0`.
 * INV-1: Pure and deterministic — no I/O, no side effects, same input always
 *   produces the same output.
 */
export function decodeModifierFlags(flags: number): ModifierFlagsState {
  const result = {} as ModifierFlagsState;
  for (const key of Object.keys(MODIFIER_FLAG_MASKS) as ModifierKey[]) {
    result[key] = (flags & MODIFIER_FLAG_MASKS[key]) !== 0;
  }
  return result;
}

/**
 * PRE-1: none (no environment variables are mutated or required).
 * POST-1: Returns `true` iff none of SSH_CONNECTION, SSH_CLIENT, SSH_TTY are
 *   set in the given environment (mirrors the existing no-SSH predicate in
 *   packages/tui/src/terminal.ts's shouldEnableModifyOtherKeysFallback).
 */
export function isLocalSessionEnv(env: Record<string, string | undefined>): boolean {
  return !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY;
}

// =============================================================================
// Artifact 4: CONTRACT_NATIVE_MODIFIER_DETECTION Traceability Dictionary
// =============================================================================

export const CONTRACT_NATIVE_MODIFIER_DETECTION = {
  "POST-1": {
    id: "POST-1",
    description: "decodeModifierFlags(flags) reports each modifier true iff its exact CGEventFlags bit is set",
    verification: "test",
  },
  "POST-2": {
    id: "POST-2",
    description:
      "isNativeModifierPressed(key) on darwin with CoreGraphics FFI available returns true iff the modifier's bit is set in the live CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) read",
    verification: "test",
  },
  "POST-3": {
    id: "POST-3",
    description: "isNativeModifierPressed(key) returns false on every non-darwin platform",
    verification: "test",
  },
  "POST-4": {
    id: "POST-4",
    description:
      "terminal.ts substitutes NATIVE_SHIFT_ENTER_SEQUENCE for a bare \\r fast-path sequence when isLocalSessionEnv(env) is true, platform is darwin, and isNativeModifierPressed('shift') is true",
    verification: "test",
  },
  "POST-5": {
    id: "POST-5",
    description:
      "terminal.ts forwards a bare \\r sequence unchanged when the native shift check does not fire (remote session, non-darwin, or shift not held) — no behavior change for the ordinary case",
    verification: "test",
  },
  "INV-1": {
    id: "INV-1",
    description: "isNativeModifierPressed never throws for any ModifierKey, on any platform, regardless of FFI outcome",
    verification: "test",
  },
  "ERRORS-1": {
    id: "ERRORS-1",
    description:
      "dlopen/symbol-lookup/FFI call failures inside isNativeModifierPressed are caught internally and degrade to false; no exception propagates to the caller (matches the existing non-fatal FFI convention already used by shouldEnableModifyOtherKeysFallback / #enableWindowsVTInput in terminal.ts)",
    verification: "test",
  },
  "FORBIDDEN-1": {
    id: "FORBIDDEN-1",
    description:
      "The Shift+Enter native fallback SHALL NOT change dispatch behavior for ctrl+enter, option+enter (legacy \\x1b\\r), plain enter, or any other existing Enter-modifier combination",
    verification: "test",
  },
} as const;
