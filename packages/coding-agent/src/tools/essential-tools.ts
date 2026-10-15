/**
 * Canonical set of built-in tools that must stay top-level.
 *
 * These are the coding essentials the model always needs directly in its
 * callable schema. `read`/`write` are additionally the `xd://` transport
 * (`read xd://` lists devices, `write xd://<tool>` executes them), so demoting
 * them under xdev makes every mounted device unreachable.
 *
 * Adapter boundaries (extension `registerTool`, SDK custom tools, RPC host
 * tools) default an omitted `loadMode` to `"discoverable"`. A UI-only
 * re-register of a built-in — e.g. wrapping `read`/`write`/`bash`/`edit`/`glob`
 * to customize rendering — would then silently demote it to `discoverable` and,
 * with `tools.xdev` on, unmount it from the top-level schema (issue #5764).
 * {@link defaultLoadModeForToolName} pins these names to `"essential"` when the
 * definition omits `loadMode`, so re-registering a built-in never demotes it.
 */
import type { ToolLoadMode } from "@oh-my-pi/pi-agent-core";

/**
 * Built-in tool names whose classes declare `loadMode = "essential"`. Kept in
 * sync with the tool classes by `essential-tools.test.ts` (drift guard).
 */
export const ESSENTIAL_BUILTIN_TOOL_NAMES: Record<string, true> = {
	read: true,
	write: true,
	bash: true,
	edit: true,
	glob: true,
	find: true,
	eval: true,
	task: true,
	wait: true,
	learn: true,
	manage_skill: true,
	context_notes: true,
	new_context: true,
};

/**
 * Non-built-in tool names that also resolve to `"essential"`.
 *
 * These arrive through an adapter boundary (extension `registerTool`) with no
 * declared `loadMode`, so the `"discoverable"` default would demote them into
 * the `xd://` device catalog whenever `tools.xdev` is on. Kept separate from
 * {@link ESSENTIAL_BUILTIN_TOOL_NAMES} because that record mirrors built-in
 * tool classes and is drift-guarded against them.
 *
 * `ipython` is the session's persistent programmatic workbench; the
 * specification requires it top-level at the essential mode (POST-NATIVE-2)
 * and forbids demoting it to discoverable-only (FORBIDDEN-NATIVE-1).
 */
export const ESSENTIAL_NATIVE_TOOL_NAMES: Record<string, true> = {
	ipython: true,
};

/**
 * Resolve a tool's presentation mode at an adapter boundary. An explicit
 * `declared` mode always wins. When omitted, known essential built-in names
 * default to `"essential"` (so a re-register never demotes them); everything
 * else defaults to `"discoverable"`.
 */
export function defaultLoadModeForToolName(name: string, declared?: ToolLoadMode): ToolLoadMode {
	if (declared) return declared;
	// POST-NATIVE-2: `defaultLoadModeForToolName("ipython")` resolves "essential".
	return name in ESSENTIAL_BUILTIN_TOOL_NAMES || name in ESSENTIAL_NATIVE_TOOL_NAMES ? "essential" : "discoverable";
}
