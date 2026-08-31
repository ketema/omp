import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import {
	CONTRACT_NATIVE_MODIFIER_DETECTION,
	decodeModifierFlags as decodeContractModifierFlags,
	isLocalSessionEnv as isContractLocalSessionEnv,
	MODIFIER_FLAG_MASKS,
	type ModifierFlagsState,
	type ModifierKey,
	NATIVE_SHIFT_ENTER_SEQUENCE,
} from "../../../requirements/contracts/native-modifier-detection.contract";

/**
 * Contract-derived CoreGraphics reader fake.
 *
 * Contract: requirements/contracts/native-modifier-detection.contract.ts
 * Derives: PROVIDER-1 (the external CoreGraphics call's own documented
 * shape — a synchronous CGEventFlags bitmask), consumed by POST-2, INV-1,
 * ERRORS-1. Injected through the implementation's test-only
 * __setCombinedSessionFlagsReaderForTest seam. Double type: Fake.
 */
const fakeReaderState = { flags: 0 };

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const sshKeys = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;
const savedSshEnv = Object.fromEntries(sshKeys.map(key => [key, process.env[key]]));

type NativeModifiers = typeof import("@oh-my-pi/pi-tui/native-modifiers");
type NativeModifiersTestHooks = typeof import("../src/native-modifiers-internal");
type ProcessTerminalConstructor = typeof import("@oh-my-pi/pi-tui/terminal")["ProcessTerminal"];

function nativeModifiers(): Promise<NativeModifiers> {
	return import("@oh-my-pi/pi-tui/native-modifiers");
}

function nativeModifiersTestHooks(): Promise<NativeModifiersTestHooks> {
	return import("../src/native-modifiers-internal");
}

async function processTerminal(): Promise<ProcessTerminalConstructor> {
	return (await import("@oh-my-pi/pi-tui/terminal")).ProcessTerminal;
}

function setPlatform(platform: string): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function clearSshEnvironment(): void {
	for (const key of sshKeys) delete process.env[key];
}

function restoreSshEnvironment(): void {
	for (const key of sshKeys) {
		const value = savedSshEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function resetFakeReader(flags = 0): void {
	fakeReaderState.flags = flags;
}

function failure(testName: string, clauseId: string, expected: unknown, actual: unknown, guidance: string): string {
	return [
		`1. WHAT: ${testName} FAILED`,
		`2. WHY: ${clauseId} violation - ${CONTRACT_NATIVE_MODIFIER_DETECTION[clauseId as keyof typeof CONTRACT_NATIVE_MODIFIER_DETECTION].description}`,
		`3. EXPECTED: ${JSON.stringify(expected)}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		`5. GUIDANCE: ${guidance}`,
	].join("\n");
}

function assertExact(
	testName: string,
	clauseId: keyof typeof CONTRACT_NATIVE_MODIFIER_DETECTION,
	actual: unknown,
	expected: unknown,
	guidance: string,
): void {
	expect(actual, failure(testName, clauseId, expected, actual, guidance)).toEqual(expected);
}

interface TerminalInputHarness {
	received: string[];
	feed(data: string): void;
	waitForReceived(count?: number, timeoutMs?: number): Promise<string[]>;
	dispose(): void;
}

async function startTerminalInputHarness(): Promise<TerminalInputHarness> {
	const previousHeadless = setTerminalHeadless(false);
	const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });

	const spies = [
		vi.spyOn(process, "kill").mockReturnValue(true),
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdout, "write").mockImplementation(() => true),
	];
	await nativeModifiers();
	const ProcessTerminal = await processTerminal();
	const terminal = new ProcessTerminal();
	const received: string[] = [];
	const listeners: Array<() => void> = [];
	terminal.start(
		data => {
			received.push(data);
			for (const listener of listeners) listener();
		},
		() => {},
	);

	return {
		received,
		feed(data) {
			process.stdin.emit("data", data);
		},
		async waitForReceived(count = 1, timeoutMs = 2000) {
			if (received.length >= count) return received;
			return new Promise<string[]>(resolve => {
				// Integration test waiting for asynchronous terminal input event; timeout bounds test hang.
				const timer = setTimeout(() => {
					cleanup();
					resolve(received);
				}, timeoutMs);
				const onData = () => {
					if (received.length >= count) {
						cleanup();
						resolve(received);
					}
				};
				const cleanup = () => {
					clearTimeout(timer);
					const idx = listeners.indexOf(onData);
					if (idx !== -1) listeners.splice(idx, 1);
				};
				listeners.push(onData);
			});
		},
		dispose() {
			terminal.stop();
			setTerminalHeadless(previousHeadless);
			for (const spy of spies) spy.mockRestore();
			if (stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (stdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", stdoutIsTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (stdinSetRawMode) Object.defineProperty(process.stdin, "setRawMode", stdinSetRawMode);
			else Reflect.deleteProperty(process.stdin, "setRawMode");
		},
	};
}

beforeEach(async () => {
	setPlatform("darwin");
	clearSshEnvironment();
	resetFakeReader();
	const { __setCombinedSessionFlagsReaderForTest } = await nativeModifiersTestHooks();
	__setCombinedSessionFlagsReaderForTest(() => fakeReaderState.flags);
});

afterEach(() => {
	restorePlatform();
	restoreSshEnvironment();
});

describe("native modifier API", () => {
	it("returns exactly five false values for zero flags and irrelevant low/high bits", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-1 — each ModifierKey is true iff its exact bit is set.
		 * Category: boundary; Test level: Unit; Risk tier: High — false positive input modifiers corrupt key dispatch.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-1 exists; [✓] C2 exact object equality;
		 * [✓] C3 unique no-modifier/noise equivalence class; [✓] C4 current CoreGraphics bitmask contract.
		 */
		const { decodeModifierFlags } = await nativeModifiers();
		const expected: ModifierFlagsState = { shift: false, control: false, option: false, command: false, fn: false };
		const irrelevantBits = 0x01000081;

		assertExact(
			"decodeModifierFlags zero flags",
			"POST-1",
			decodeModifierFlags(0),
			expected,
			"Report no modifier as pressed when no defined modifier bit is present.",
		);
		assertExact(
			"decodeModifierFlags irrelevant flags",
			"POST-1",
			decodeModifierFlags(irrelevantBits),
			expected,
			"Ignore raw event bits outside the five contracted modifier masks.",
		);
		assertExact(
			"decodeModifierFlags contract bridge for irrelevant flags",
			"POST-1",
			decodeModifierFlags(irrelevantBits),
			decodeContractModifierFlags(irrelevantBits),
			"Match the contract authority's deterministic bitmask interpretation.",
		);
	});

	it("reports each modifier when its exact CGEventFlags bit is set alone", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-1 — each ModifierKey is true iff its exact bit is set.
		 * Category: positive; Test level: Unit; Risk tier: High — each physical modifier is independently observable.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-1 exists; [✓] C2 exact five-field results;
		 * [✓] C3 one test per single-bit equivalence class; [✓] C4 current modifier API behavior.
		 */
		const { decodeModifierFlags, MODIFIER_FLAG_MASKS: implementationMasks } = await nativeModifiers();
		for (const key of Object.keys(MODIFIER_FLAG_MASKS) as ModifierKey[]) {
			const expected: ModifierFlagsState = {
				shift: key === "shift",
				control: key === "control",
				option: key === "option",
				command: key === "command",
				fn: key === "fn",
			};
			assertExact(
				`decodeModifierFlags ${key} bit`,
				"POST-1",
				decodeModifierFlags(MODIFIER_FLAG_MASKS[key]),
				expected,
				"Set only the ModifierKey whose exact CGEventFlags bit is present.",
			);
			assertExact(
				`MODIFIER_FLAG_MASKS ${key} contract bridge`,
				"POST-1",
				implementationMasks[key],
				MODIFIER_FLAG_MASKS[key],
				"Export the exact CoreGraphics mask specified by the contract.",
			);
		}
	});

	it("reports every modifier for the all-bits-set equivalence class", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-1 — each ModifierKey is true iff its exact bit is set.
		 * Category: boundary; Test level: Unit; Risk tier: Medium — chorded modifier states must not lose individual bits.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-1 exists; [✓] C2 exact complete state;
		 * [✓] C3 unique all-bits combined class; [✓] C4 current bitwise decoding guarantee.
		 */
		const { decodeModifierFlags } = await nativeModifiers();
		const allModifierBits = Object.values(MODIFIER_FLAG_MASKS).reduce((bits, mask) => bits | mask, 0);
		const expected: ModifierFlagsState = { shift: true, control: true, option: true, command: true, fn: true };
		assertExact(
			"decodeModifierFlags all modifier bits",
			"POST-1",
			decodeModifierFlags(allModifierBits),
			expected,
			"Retain every independently set modifier in a combined CGEventFlags value.",
		);
	});

	it("reads the combined session flags and distinguishes pressed from unpressed modifiers on darwin", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-2 — darwin query returns true iff the live combined-session bit is set.
		 * Category: positive/negative; Test level: Unit; Risk tier: High — native state is the recovery signal.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-2 exists; [✓] C2 exact booleans;
		 * [✓] C3 unique reader-fake success path; [✓] C4 current CoreGraphics query requirement.
		 * Mock Contract: native-modifier-detection.contract.ts POST-2; Double type: Fake.
		 */
		fakeReaderState.flags = MODIFIER_FLAG_MASKS.shift | MODIFIER_FLAG_MASKS.command;
		const { isNativeModifierPressed } = await nativeModifiers();
		assertExact(
			"isNativeModifierPressed shift",
			"POST-2",
			isNativeModifierPressed("shift"),
			true,
			"Return true exactly when the queried modifier bit is set in the current native state.",
		);
		assertExact(
			"isNativeModifierPressed command",
			"POST-2",
			isNativeModifierPressed("command"),
			true,
			"Return true exactly when the queried modifier bit is set in the current native state.",
		);
		assertExact(
			"isNativeModifierPressed control",
			"POST-2",
			isNativeModifierPressed("control"),
			false,
			"Return false when a different modifier bit is set.",
		);
		fakeReaderState.flags = Object.values(MODIFIER_FLAG_MASKS).reduce((bits, mask) => bits | mask, 0);
		for (const key of Object.keys(MODIFIER_FLAG_MASKS) as ModifierKey[]) {
			assertExact(
				`isNativeModifierPressed ${key} with all bits set`,
				"POST-2",
				isNativeModifierPressed(key),
				true,
				"Return true for every ModifierKey whose current native bit is set.",
			);
		}
	});

	it("returns false for every ModifierKey on non-darwin platform representatives", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-3 — every non-darwin platform returns false.
		 * Category: boundary; Test level: Unit; Risk tier: High — unsupported systems must not attempt macOS state reads.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-3 exists; [✓] C2 exact false results;
		 * [✓] C3 covers POSIX, Windows, and other non-darwin partitions; [✓] C4 current portability contract.
		 * Mock Contract: native-modifier-detection.contract.ts POST-2; Double type: Fake.
		 */
		const { isNativeModifierPressed } = await nativeModifiers();
		for (const platform of ["linux", "win32", "freebsd"]) {
			setPlatform(platform);
			fakeReaderState.flags = Object.values(MODIFIER_FLAG_MASKS).reduce((bits, mask) => bits | mask, 0);
			for (const key of Object.keys(MODIFIER_FLAG_MASKS) as ModifierKey[]) {
				assertExact(
					`isNativeModifierPressed ${key} on ${platform}`,
					"POST-3",
					isNativeModifierPressed(key),
					false,
					"Return false without treating a CoreGraphics result as available off macOS.",
				);
			}
		}
	});

	it("degrades a genuine CoreGraphics load failure to false without throwing", async () => {
		/**
		 * CONTRACT TRACEABILITY: INV-1 and ERRORS-1 — no FFI outcome propagates; failures degrade to false.
		 * Category: invariant/error; Test level: Unit; Risk tier: High — keyboard input cannot crash the TUI.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 INV-1 and ERRORS-1 exist; [✓] C2 fault is injected by
		 * pointing the real dlopen() call at a genuinely nonexistent path, so the actual try/catch in
		 * getCombinedSessionFlagsReader executes for real rather than having its outcome substituted;
		 * [✓] C3 unique genuine-loader-failure path; [✓] C4 current non-fatal FFI obligation.
		 * Mock Contract: native-modifier-detection.contract.ts PROVIDER-1, ERRORS-1; Double type: none —
		 * this exercises the real dlopen() call against a deliberately invalid path, not an injected outcome.
		 */
		const { isNativeModifierPressed } = await nativeModifiers();
		const { __setCombinedSessionFlagsReaderForTest, __setCoreGraphicsFrameworkPathForTest } =
			await nativeModifiersTestHooks();
		__setCoreGraphicsFrameworkPathForTest("/nonexistent/CoreGraphics.framework/CoreGraphics-does-not-exist");
		__setCombinedSessionFlagsReaderForTest(undefined);
		let result: boolean | undefined;
		let thrown: unknown;
		try {
			result = isNativeModifierPressed("shift");
		} catch (error) {
			thrown = error;
		}
		__setCoreGraphicsFrameworkPathForTest(undefined);
		assertExact(
			"isNativeModifierPressed genuine dlopen failure does not throw",
			"INV-1",
			thrown,
			undefined,
			"Contain native-query failures so input dispatch continues.",
		);
		assertExact(
			"isNativeModifierPressed genuine dlopen failure result",
			"ERRORS-1",
			result,
			false,
			"Degrade unavailable CoreGraphics state to an unpressed modifier.",
		);
	});

	it("exercises the real CoreGraphics dlopen path when the test seam is reset", async () => {
		/**
		 * CONTRACT TRACEABILITY: INV-2 — the resolved-reader cache is real per-process
		 * state, not just an injected value; the actual dlopen/closure-construction
		 * code (getCombinedSessionFlagsReader) must execute for real at least once.
		 * Category: invariant; Test level: Unit; Risk tier: High — the injection seam
		 * used by every other test in this file must not become the only code path
		 * ever exercised, or a defect in the real dlopen call would go undetected.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 INV-2 exists; [✓] C2 exact no-throw
		 * and typeof-boolean assertions on the genuine FFI call; [✓] C3 unique
		 * real-path coverage no other test in this file provides; [✓] C4 current
		 * non-fatal FFI obligation, not a hypothetical future one.
		 * Coverage note: this exercises the dlopen SUCCESS path (CoreGraphics.framework
		 * exists on every macOS test runner). The catch/unavailable-framework branch
		 * remains covered only via the direct `null` injection in the previous test —
		 * genuinely forcing a real dlopen failure would require FFI-level mocking,
		 * which this suite intentionally does not reintroduce.
		 */
		const { isNativeModifierPressed } = await nativeModifiers();
		const { __setCombinedSessionFlagsReaderForTest } = await nativeModifiersTestHooks();
		__setCombinedSessionFlagsReaderForTest(undefined);
		let result: boolean | undefined;
		let thrown: unknown;
		try {
			result = isNativeModifierPressed("shift");
		} catch (error) {
			thrown = error;
		}
		assertExact(
			"isNativeModifierPressed real dlopen path does not throw",
			"INV-2",
			thrown,
			undefined,
			"The genuine CoreGraphics dlopen and closure-construction path must not throw on a supported platform.",
		);
		assertExact(
			"isNativeModifierPressed real dlopen path returns a boolean",
			"INV-2",
			typeof result,
			"boolean",
			"The genuine CoreGraphics read must resolve to a boolean modifier state, not undefined or a thrown error.",
		);
	});

	it("keeps the test-only CoreGraphics reader module out of the package's export surface", async () => {
		/**
		 * Not part of the audited behavioral contract — packaging boundary only.
		 * native-modifiers-internal.ts holds two test-only state-mutation exports
		 * (__setCombinedSessionFlagsReaderForTest, __setCoreGraphicsFrameworkPathForTest).
		 * It must be reachable only by relative import from within this package's own
		 * tests, never through @oh-my-pi/pi-tui's package export map (neither the main
		 * barrel nor the generic "./*" subpath wildcard), so no consumer can reach or
		 * mutate this state.
		 */
		let thrown: unknown;
		try {
			// @ts-expect-error — deliberately probing a subpath the export map must reject.
			await import("@oh-my-pi/pi-tui/native-modifiers-internal");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
	});

	it("identifies local and SSH-marked environments without mutating their input", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-4/POST-5 — native Shift recovery is local-only; remote sessions forward bare Enter.
		 * Category: boundary; Test level: Unit; Risk tier: High — host modifier state must not govern SSH input.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-4 and POST-5 exist; [✓] C2 exact locality booleans;
		 * [✓] C3 distinct environment gate from terminal dispatch; [✓] C4 current local-session condition.
		 */
		const { isLocalSessionEnv } = await nativeModifiers();
		const localEnvironment = { TERM: "xterm-256color" };
		assertExact(
			"isLocalSessionEnv local environment",
			"POST-4",
			isLocalSessionEnv(localEnvironment),
			true,
			"Treat an environment without SSH markers as local.",
		);
		assertExact(
			"isLocalSessionEnv SSH_CONNECTION",
			"POST-5",
			isLocalSessionEnv({ SSH_CONNECTION: "client server" }),
			false,
			"Treat an SSH connection marker as remote.",
		);
		assertExact(
			"isLocalSessionEnv SSH_CLIENT",
			"POST-5",
			isLocalSessionEnv({ SSH_CLIENT: "client" }),
			false,
			"Treat an SSH client marker as remote.",
		);
		assertExact(
			"isLocalSessionEnv SSH_TTY",
			"POST-5",
			isLocalSessionEnv({ SSH_TTY: "/dev/ttys001" }),
			false,
			"Treat an SSH TTY marker as remote.",
		);
		assertExact(
			"isLocalSessionEnv contract bridge",
			"POST-4",
			isLocalSessionEnv(localEnvironment),
			isContractLocalSessionEnv(localEnvironment),
			"Match the contract authority's environment predicate.",
		);
	});
});

describe("ProcessTerminal native Shift+Enter recovery", () => {
	let terminal: TerminalInputHarness | undefined;

	afterEach(() => {
		terminal?.dispose();
		terminal = undefined;
	});

	it("substitutes the contracted Shift+Enter sequence for a local darwin bare carriage return", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-4 — terminal stdin dispatch substitutes NATIVE_SHIFT_ENTER_SEQUENCE only for local darwin Shift+Enter.
		 * Category: integration; Test level: Integration; Risk tier: High — regression recovery crosses native state and stdin boundaries.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-4 exists; [✓] C2 exact input-handler sequence;
		 * [✓] C3 unique affirmative wiring path; [✓] C4 current Shift+Enter recovery behavior.
		 * Mock Contract: native-modifier-detection.contract.ts POST-2; Double type: Fake.
		 * SEQ SELF-CHECK: [✓] ProcessTerminal constructed; [✓] observable input handler; [✓] no direct callee call; [✓] reader fake installed before lifecycle.
		 */
		fakeReaderState.flags = MODIFIER_FLAG_MASKS.shift;
		const { NATIVE_SHIFT_ENTER_SEQUENCE: implementationShiftEnterSequence } = await nativeModifiers();
		assertExact(
			"NATIVE_SHIFT_ENTER_SEQUENCE contract bridge",
			"POST-4",
			implementationShiftEnterSequence,
			NATIVE_SHIFT_ENTER_SEQUENCE,
			"Export the contracted sequence used to represent recovered Shift+Enter.",
		);
		terminal = await startTerminalInputHarness();
		terminal.feed("\r");
		assertExact(
			"ProcessTerminal recovered Shift+Enter",
			"POST-4",
			terminal.received,
			[NATIVE_SHIFT_ENTER_SEQUENCE],
			"Deliver the contracted Shift+Enter wire sequence when native Shift recovers a collapsed carriage return.",
		);
	});

	it("forwards bare carriage return unchanged when no recovery condition applies", async () => {
		/**
		 * CONTRACT TRACEABILITY: POST-5 — remote session, non-darwin, or Shift-up keeps bare carriage return unchanged.
		 * Category: integration/boundary; Test level: Integration; Risk tier: High — ordinary Enter remains submit.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 POST-5 exists; [✓] C2 exact handler data for each guard;
		 * [✓] C3 guards are distinct contract disjuncts; [✓] C4 current ordinary-input preservation.
		 * Mock Contract: native-modifier-detection.contract.ts POST-2; Double type: Fake.
		 * SEQ SELF-CHECK: [✓] ProcessTerminal constructed; [✓] observable input handler; [✓] no direct callee call; [✓] reader fake installed before lifecycle.
		 */
		const scenarios: Array<{ name: string; platform: string; ssh: boolean; flags: number }> = [
			{ name: "Shift up", platform: "darwin", ssh: false, flags: 0 },
			{ name: "remote SSH", platform: "darwin", ssh: true, flags: MODIFIER_FLAG_MASKS.shift },
			{ name: "non-darwin", platform: "linux", ssh: false, flags: MODIFIER_FLAG_MASKS.shift },
		];
		for (const scenario of scenarios) {
			setPlatform(scenario.platform);
			if (scenario.ssh) process.env.SSH_CONNECTION = "client server";
			else clearSshEnvironment();
			fakeReaderState.flags = scenario.flags;
			terminal = await startTerminalInputHarness();
			terminal.feed("\r");
			await terminal.waitForReceived(1);
			assertExact(
				`ProcessTerminal bare Enter with ${scenario.name}`,
				"POST-5",
				terminal.received,
				["\r"],
				"Forward ordinary carriage return unchanged unless every Shift+Enter recovery condition holds.",
			);
			terminal.dispose();
			terminal = undefined;
		}
	});

	it("does not rewrite Ctrl+Enter or legacy Option+Enter while native Shift is held", async () => {
		/**
		 * CONTRACT TRACEABILITY: FORBIDDEN-1 — native fallback SHALL NOT change ctrl+enter or option+enter dispatch.
		 * Category: forbidden; Test level: Integration; Risk tier: High — scoped recovery must not corrupt existing bindings.
		 * FOUR-CRITERIA TEST VALIDITY GATE: [✓] C1 FORBIDDEN-1 exists; [✓] C2 exact unchanged sequences;
		 * [✓] C3 distinct Ctrl and Option wire representations; [✓] C4 contracted negative space, not future-edit theater.
		 * Mock Contract: native-modifier-detection.contract.ts POST-2; Double type: Fake.
		 * SEQ SELF-CHECK: [✓] ProcessTerminal constructed; [✓] observable input handler; [✓] no direct callee call; [✓] reader fake installed before lifecycle.
		 */
		fakeReaderState.flags = MODIFIER_FLAG_MASKS.shift | MODIFIER_FLAG_MASKS.control | MODIFIER_FLAG_MASKS.option;
		terminal = await startTerminalInputHarness();
		const ctrlEnter = "\x1b[13;5u";
		const optionEnter = "\x1b\r";
		terminal.feed(ctrlEnter);
		terminal.feed(optionEnter);
		assertExact(
			"ProcessTerminal Ctrl+Enter and Option+Enter unchanged",
			"FORBIDDEN-1",
			terminal.received,
			[ctrlEnter, optionEnter],
			"Restrict native recovery to a bare carriage return rather than modifying existing modified-Enter sequences.",
		);
	});
});
