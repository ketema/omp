/**
 * ipython output filing (REQ-CTX27-23 to REQ-CTX27-26, ketema/omp#27).
 *
 * A large stdout stays in the kernel as `out_<n>`, a copy is saved as a session artifact, and the tool result carries a
 * descriptor. All constants are redeclared here; alignment tests import both sides and assert equality.
 */

import { countTokens, Encoding } from "@oh-my-pi/pi-natives";

export const IPYTHON_FILE_THRESHOLD_TOKENS = 1500;
export const IPYTHON_OUTPUT_VAR_PREFIX = "out_";
export const IPYTHON_DESCRIPTOR_SAMPLE_LINES = 5;
export const IPYTHON_DESCRIPTOR_LINE_CUT = 100;
export const IPYTHON_ARTIFACT_TOOL_TYPE = "ipython";

/** Saves text as a session artifact and resolves its id (the shape of `ReadonlySessionManager.saveArtifact`). */
export type SaveArtifact = (content: string, toolType: string) => Promise<string | undefined>;

/** What the descriptor of one filed output is built from. */
export interface FiledOutputInfo {
	readonly n: number;
	readonly text: string;
	readonly tokens: number;
	readonly artifactId: string | null;
}

/** The tool result text that replaces a filed stdout. */
export function ipythonDescriptor(info: FiledOutputInfo): string {
	const name = `${IPYTHON_OUTPUT_VAR_PREFIX}${info.n}`;
	const lines = info.text.endsWith("\n") ? info.text.slice(0, -1).split("\n") : info.text.split("\n");
	const cut = (line: string): string => line.slice(0, IPYTHON_DESCRIPTOR_LINE_CUT);
	const head = lines.slice(0, IPYTHON_DESCRIPTOR_SAMPLE_LINES).map(cut);
	const tail =
		lines.length > IPYTHON_DESCRIPTOR_SAMPLE_LINES
			? lines
					.slice(Math.max(IPYTHON_DESCRIPTOR_SAMPLE_LINES, lines.length - IPYTHON_DESCRIPTOR_SAMPLE_LINES))
					.map(cut)
			: [];
	const bytes = new TextEncoder().encode(info.text).length;
	const out = [`[ipython output filed] ${name} | ${lines.length} lines | ${bytes} bytes | ${info.tokens} tokens`];
	out.push(`open (preferred): ${name} in ipython, e.g. ${name}.count("ERROR")`);
	out.push(
		info.artifactId === null
			? "full unchanged copy: unavailable (artifact save failed)"
			: `full unchanged copy: artifact://${info.artifactId} (page with :1-60; unchanged if ${name} is rebound)`,
	);
	out.push("head:", ...head);
	if (tail.length > 0) out.push("tail:", ...tail);
	return out.join("\n");
}

/**
 * The cell that binds the runner's stashed stdout to the first free `out_<n>` with n >= `start`, prints n, and leaves no
 * other name behind. The runner stashes every non-empty stdout, so the text is never sent to the kernel a second time.
 */
export function bindOutputCode(start: number): string {
	return [
		`_n = ${start}`,
		`while f"${IPYTHON_OUTPUT_VAR_PREFIX}{_n}" in globals():`,
		"    _n += 1",
		`globals()[f"${IPYTHON_OUTPUT_VAR_PREFIX}{_n}"] = _omp_last_stdout`,
		"del _omp_last_stdout",
		"print(_n)",
		"del _n",
	].join("\n");
}

/** o200k tokens of `text`, the same proxy counter the rest of omp uses. */
export function countOutputTokens(text: string): number {
	return countTokens(text, Encoding.O200kBase);
}
