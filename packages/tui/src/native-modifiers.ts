import { dlopen, FFIType } from "bun:ffi";

/** CGEventFlags bit for each modifier, per CoreGraphics/CGEventTypes.h. */
export const MODIFIER_FLAG_MASKS = {
	shift: 0x00020000,
	control: 0x00040000,
	option: 0x00080000,
	command: 0x00100000,
	fn: 0x00800000,
} as const;

/** CGEventSourceStateID for the combined local+remote session state. */
export const CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE = 0;

/** Kitty keyboard protocol CSI-u sequence synthesized for a recovered Shift+Enter. */
export const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

export type ModifierKey = keyof typeof MODIFIER_FLAG_MASKS;

export interface ModifierFlagsState {
	shift: boolean;
	control: boolean;
	option: boolean;
	command: boolean;
	fn: boolean;
}

/** POST-1, INV-1: Decode a raw CGEventFlags value without observable side effects. */
export function decodeModifierFlags(flags: number): ModifierFlagsState {
	return {
		shift: (flags & MODIFIER_FLAG_MASKS.shift) !== 0,
		control: (flags & MODIFIER_FLAG_MASKS.control) !== 0,
		option: (flags & MODIFIER_FLAG_MASKS.option) !== 0,
		command: (flags & MODIFIER_FLAG_MASKS.command) !== 0,
		fn: (flags & MODIFIER_FLAG_MASKS.fn) !== 0,
	};
}

/** POST-4: SSH-marked environments do not use the native recovery path. */
export function isLocalSessionEnv(env: Record<string, string | undefined>): boolean {
	return !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY;
}

const CORE_GRAPHICS_FRAMEWORK = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
let combinedSessionFlagsReader: (() => number) | null | undefined;

function getCombinedSessionFlagsReader(): (() => number) | null {
	if (combinedSessionFlagsReader !== undefined) return combinedSessionFlagsReader;
	try {
		const coreGraphics = dlopen(CORE_GRAPHICS_FRAMEWORK, {
			CGEventSourceFlagsState: { args: [FFIType.i32], returns: FFIType.u64 },
		});
		combinedSessionFlagsReader = () =>
			Number(coreGraphics.symbols.CGEventSourceFlagsState(CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE));
	} catch {
		// bun:ffi/CoreGraphics unavailable; native modifier recovery remains non-fatal.
		combinedSessionFlagsReader = null;
	}
	return combinedSessionFlagsReader;
}

/** POST-2, POST-3, INV-1, ERRORS-1: Query CoreGraphics without exposing FFI failure. */
export function isNativeModifierPressed(key: ModifierKey): boolean {
	if (process.platform !== "darwin") return false;
	try {
		const flags = getCombinedSessionFlagsReader()?.();
		return flags === undefined ? false : decodeModifierFlags(flags)[key];
	} catch {
		return false;
	}
}
