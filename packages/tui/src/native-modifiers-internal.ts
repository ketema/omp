import { dlopen, FFIType } from "bun:ffi";

/** CGEventSourceStateID for the combined local+remote session state. */
const CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE = 0;

let coreGraphicsFrameworkPath = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
let combinedSessionFlagsReader: (() => number) | null | undefined;

/**
 * Internal: lazily dlopen()s CoreGraphics and caches the CGEventSourceFlagsState
 * reader (or `null` on genuine load failure). Not exported through
 * src/index.ts's package barrel — native-modifiers.ts imports this directly.
 */
export function getCombinedSessionFlagsReader(): (() => number) | null {
	if (combinedSessionFlagsReader !== undefined) return combinedSessionFlagsReader;
	try {
		const coreGraphics = dlopen(coreGraphicsFrameworkPath, {
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

/**
 * Test-only: force the CoreGraphics flags reader to a specific function, or to
 * `null` to simulate an unavailable framework. Pass `undefined` to reset the
 * lazy cache so the next call re-attempts the real dlopen. Not part of the
 * audited behavioral contract — pure test infrastructure. This module is
 * deliberately excluded from src/index.ts's package barrel (native-modifiers.ts
 * does not re-export it); import it directly by subpath
 * (`@oh-my-pi/pi-tui/native-modifiers-internal`) from tests only.
 */
export function __setCombinedSessionFlagsReaderForTest(reader: (() => number) | null | undefined): void {
	combinedSessionFlagsReader = reader;
}

/**
 * Test-only: point the CoreGraphics dlopen call at an alternate path — a
 * genuinely nonexistent path forces the real dlopen() call to throw and
 * exercises the actual catch block, rather than injecting its outcome via
 * __setCombinedSessionFlagsReaderForTest. Pass `undefined` to restore the
 * real framework path. Not part of the audited behavioral contract — pure
 * test infrastructure.
 */
export function __setCoreGraphicsFrameworkPathForTest(path: string | undefined): void {
	coreGraphicsFrameworkPath = path ?? "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
}
