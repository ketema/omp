/**
 * Shared 5-point contract assertion helper (CL12-D).
 *
 * Used by RLM contract test suites (sdk-rlm-host-mount.test.ts,
 * sdk-rlm-native-tool.test.ts) to avoid duplicating the same throw-message
 * assembly across files (QS2 DRY).
 */
export function assert5Point(
	condition: boolean,
	details: {
		what: string;
		why: string;
		expected: string;
		actual: string;
		guidance: string;
	},
): void {
	if (!condition) {
		const message =
			`\n1. WHAT: ${details.what}\n` +
			`2. WHY: ${details.why}\n` +
			`3. EXPECTED: ${details.expected}\n` +
			`4. ACTUAL: ${details.actual}\n` +
			`5. GUIDANCE: ${details.guidance}\n`;
		throw new Error(message);
	}
}
