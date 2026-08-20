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
 * sync with the tool classes by `issue-5764-registertool-loadmode.test.ts` (drift guard).
 */
export const ESSENTIAL_BUILTIN_TOOL_NAMES: Record<string, true> = {
	read: true,
	write: true,
	bash: true,
	edit: true,
	glob: true,
	computer: true,
	eval: true,
	task: true,
	hub: true,
	learn: true,
	manage_skill: true,
};

/**
 * Native (non-built-in-class) tool names pinned to `"essential"` load mode.
 * Distinct from {@link ESSENTIAL_BUILTIN_TOOL_NAMES}: that set's drift guard
 * requires every member to have a `BUILTIN_TOOLS` factory, but `ipython` is
 * registered by the RLM extension through `registerTool`, not `BUILTIN_TOOLS`.
 * Never demoted to `"discoverable"` regardless of adapter boundary
 * (REQ-RLM-0002, POST-NATIVE-2, FORBIDDEN-NATIVE-1).
 */
export const ESSENTIAL_NATIVE_TOOL_NAMES: Record<string, true> = {
	ipython: true,
};

/**
 * Resolve a tool's presentation mode at an adapter boundary. An explicit
 * `declared` mode always wins. When omitted, known essential built-in and
 * native names default to `"essential"` (so a re-register never demotes
 * them); everything else defaults to `"discoverable"`.
 */
export function defaultLoadModeForToolName(name: string, declared?: ToolLoadMode): ToolLoadMode {
	if (declared) return declared;
	return name in ESSENTIAL_BUILTIN_TOOL_NAMES || name in ESSENTIAL_NATIVE_TOOL_NAMES ? "essential" : "discoverable";
}
