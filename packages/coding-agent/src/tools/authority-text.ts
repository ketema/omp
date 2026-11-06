/**
 * Authority text: results omp never elides (REQ-CTX27-35, REQ-CTX27-36, ketema/omp#27, item 3).
 *
 * Skills (`skill://` and files under skills directories, including `references/`), `xd://` tool docs and memory recall,
 * search and list results are text the model must read in full: a skill loads once per session and again only after a
 * compaction, so a hidden middle is never recovered. The classifier is redeclared here; tests import it and the contract
 * and assert they agree.
 */

export type AuthorityKind = "skill" | "xd_doc" | "memory";

// POST-CTX27-25: the memory tools whose recall, search and list results are authority text.
const MEMORY_AUTHORITY_TOOLS: readonly string[] = ["memory_recall", "memory_search", "memory_list"];

/**
 * POST-CTX27-28: the kind of authority text a tool call returns, or null for any other call. A trailing line selector
 * (`:5-9`, `:raw`) does not change the kind.
 */
export function authorityReadKind(toolName: string, path: string): AuthorityKind | null {
	const target = path.trim();
	if (toolName === "read") {
		// POST-CTX27-24: a skill file, by scheme or by location under a skills directory.
		if (/^skill:\/\//i.test(target)) return "skill";
		if (/\/\.(?:omp\/agent|claude|agents)\/skills\/[^/]+\//.test(target)) return "skill";
		// POST-CTX27-25: an xd:// tool doc.
		if (/^xd:\/\//i.test(target)) return "xd_doc";
		return null;
	}
	if (toolName === "write") {
		// POST-CTX27-25: an MCP tool executes as a write to its xd:// device.
		const memory = /^xd:\/\/mcp__(memory_[a-z]+)$/i.exec(target);
		if (memory?.[1] !== undefined && MEMORY_AUTHORITY_TOOLS.includes(memory[1].toLowerCase())) return "memory";
	}
	return null;
}
