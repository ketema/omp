/**
 * Reads Bun's own `bun test` run summary (POST-CI-RLM-NOSKIP-1,
 * contracts/rlm-session-isolation.contract.ts).
 *
 * The no-skip gate judges what the runner actually reported, never spec source text: a computed or aliased
 * skip (`test["skip"](...)`, `const t = test; t.skip(...)`) shows up in the summary, and a comment that merely
 * mentions `test.skip` does not.
 */

/** Sum of the skipped and todo counts in Bun's summary lines (` 2 skip`, ` 1 todo`); 0 when there are none. */
export function skippedOrTodoCount(runOutput: string): number {
	let total = 0;
	for (const line of runOutput.split("\n")) {
		const match = /^\s*(\d+) (?:skip|todo)\b/.exec(line);
		if (match) total += Number(match[1]);
	}
	return total;
}
