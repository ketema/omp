/**
 * Authority text is never elided (ketema/omp#27, item 3, SLICE-4).
 *
 * Targets the IMPLEMENTATION through the real tool path: the real ReadTool wrapped by wrapToolWithMetaNotice (the same
 * wrapper the registry applies), real files above tools.artifactSpillThreshold, real skill:// resolution through
 * loadSkills and setActiveSkills, and Settings.isolated() defaults. Only the memory and bash results come from a tool
 * double, because those tools need a live MCP server and a live shell; the real-session proof is a separate live run.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: contracts/context_efficiency_enforcement.contract.ts
 * - POST-CTX27-24, POST-CTX27-25, POST-CTX27-26, POST-CTX27-27, POST-CTX27-28
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills, resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgToolsArtifactSpillThreshold } from "@oh-my-pi/pi-coding-agent/tools/settings";

import {
	authorityReadKind as contractAuthorityReadKind,
	MEMORY_AUTHORITY_TOOLS,
} from "../../../../contracts/context_efficiency_enforcement.contract.ts";

const SPILL_THRESHOLD_BYTES = 50 * 1024;

const ALL_DEFAULT_SOURCES_DISABLED = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

/** A document of `lines` numbered lines, each `width` characters wide; line N reads `LINE-N-...` so any slice is checkable. */
function numberedDoc(lines: number, width = 60): string {
	return Array.from({ length: lines }, (_, i) => `LINE-${i + 1}-`.padEnd(width, "x")).join("\n");
}

function textOf(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

/** The notices omp adds when it hides part of a result. */
const HIDING_MARKERS = [
	/middle lines/i,
	/elided/i,
	/Showing lines/i,
	/Read artifact:\/\//i,
	/Full output: artifact:\/\//i,
];
function hidingMarkers(text: string): string[] {
	return HIDING_MARKERS.filter(marker => marker.test(text)).map(marker => marker.source);
}

describe("authority text is never elided (REQ-CTX27-35 to REQ-CTX27-38)", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(async () => {
		testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "authority-text-")));
		manager = SessionManager.inMemory(testDir);
	});

	afterEach(async () => {
		resetActiveSkillsForTests();
		resetRegisteredArtifactDirsForTests();
		await manager.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function makeSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
	}

	async function makeToolContext(): Promise<AgentToolContext> {
		return {
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(await AuthStorage.create(":memory:"), path.join(testDir, "models.yml")),
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
	}

	/** The real ReadTool behind the real wrapper. */
	function realRead() {
		return wrapToolWithMetaNotice(new ReadTool(makeSession()));
	}

	/** A tool named `name` that returns `text`, behind the real wrapper. */
	function doubleTool(name: string, text: string): AgentTool {
		const tool = {
			name,
			label: name,
			description: "test double",
			parameters: {},
			execute: async () => ({ content: [{ type: "text", text }], details: {} }),
		} as unknown as AgentTool;
		return wrapToolWithMetaNotice(tool);
	}

	/** A skill under a `.omp/agent/skills/<name>/` layout, with a SKILL.md and a references file, both above the spill threshold. */
	async function makeSkillTree(name: string) {
		const skillsRoot = path.join(testDir, ".omp", "agent", "skills");
		const baseDir = path.join(skillsRoot, name);
		await fs.mkdir(path.join(baseDir, "references"), { recursive: true });
		const skillBody = numberedDoc(1200);
		const refBody = numberedDoc(2400);
		await Bun.write(
			path.join(baseDir, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${name} skill.\n---\n${skillBody}`,
		);
		await Bun.write(path.join(baseDir, "references", "guide.md"), refBody);
		const { skills } = await loadSkills({ ...ALL_DEFAULT_SOURCES_DISABLED, customDirectories: [skillsRoot] });
		setActiveSkills(skills);
		return {
			baseDir,
			skillBody,
			refBody,
			skillFile: path.join(baseDir, "SKILL.md"),
			refFile: path.join(baseDir, "references", "guide.md"),
		};
	}

	it("POST-CTX27-24: a skill:// read with no range returns the whole skill, though it exceeds the spill threshold", async () => {
		// Risk tier: HIGH — a skill loads once per session; a hidden middle is never recovered (01a1ac70 lost 321 lines).
		const { skillBody } = await makeSkillTree("big-skill");
		expect(Buffer.byteLength(skillBody), "fixture check: the skill must exceed the spill threshold").toBeGreaterThan(
			SPILL_THRESHOLD_BYTES,
		);
		registerArtifactsDir(testDir);
		const result = await realRead().execute(
			"c-skill",
			{ path: "skill://big-skill" },
			undefined,
			undefined,
			await makeToolContext(),
		);
		const text = textOf(result);
		const missing = [1, 400, 401, 724, 1199, 1200].filter(n => !text.includes(`LINE-${n}-`));
		expect(
			missing,
			"POST-CTX27-24 violation: lines of the skill never reached the model\n" +
				`MISSING LINES: ${JSON.stringify(missing)}\n` +
				`HIDING MARKERS: ${JSON.stringify(hidingMarkers(text))}\n` +
				"GUIDANCE: a skill:// read with no range returns the whole file in one result, with no elision",
		).toEqual([]);
		expect(
			hidingMarkers(text),
			"POST-CTX27-24 violation: the skill result carries an elision, paging or artifact notice\n" +
				"GUIDANCE: no spill artifact and no paging notice for a whole skill read",
		).toEqual([]);
	});

	it("POST-CTX27-24: a references file under a skills directory is returned whole, not paged", async () => {
		// Risk tier: HIGH — Ketema included reference files: skills are that critical (Z20).
		const { refFile, refBody } = await makeSkillTree("ref-skill");
		expect(
			Buffer.byteLength(refBody),
			"fixture check: the reference must exceed the spill threshold",
		).toBeGreaterThan(SPILL_THRESHOLD_BYTES);
		const text = textOf(
			await realRead().execute("c-ref", { path: refFile }, undefined, undefined, await makeToolContext()),
		);
		const missing = [1, 300, 301, 1200, 2399, 2400].filter(n => !text.includes(`LINE-${n}-`));
		expect(
			missing,
			"POST-CTX27-24 violation: lines of the reference file never reached the model\n" +
				`MISSING LINES: ${JSON.stringify(missing)}\n` +
				`HIDING MARKERS: ${JSON.stringify(hidingMarkers(text))}\n` +
				"GUIDANCE: a file under a skills directory is returned whole in one result, never paged or elided",
		).toEqual([]);
		expect(
			hidingMarkers(text),
			"POST-CTX27-24 violation: the reference result carries an elision or paging notice",
		).toEqual([]);
	});

	it("POST-CTX27-25: an xd:// tool doc read and a memory recall, search or list result above the threshold arrive whole", async () => {
		// Risk tier: HIGH — tool docs and memory recalls are authority text (Z20).
		const big = numberedDoc(1500);
		expect(Buffer.byteLength(big)).toBeGreaterThan(SPILL_THRESHOLD_BYTES);
		const context = await makeToolContext();
		const calls: Array<[string, string, Record<string, string>]> = [
			["xd:// doc read", "read", { path: "xd://mcp__memory_recall" }],
			...MEMORY_AUTHORITY_TOOLS.map((tool): [string, string, Record<string, string>] => [
				`memory ${tool}`,
				"write",
				{ path: `xd://mcp__${tool}`, content: "{}" },
			]),
		];
		for (const [label, toolName, params] of calls) {
			const text = textOf(
				await doubleTool(toolName, big).execute(`c-${label}`, params, undefined, undefined, context),
			);
			const missing = [1, 500, 1000, 1500].filter(n => !text.includes(`LINE-${n}-`));
			expect(
				missing,
				`POST-CTX27-25 violation: the ${label} lost lines\n` +
					`MISSING LINES: ${JSON.stringify(missing)}\n` +
					`HIDING MARKERS: ${JSON.stringify(hidingMarkers(text))}\n` +
					"GUIDANCE: xd:// docs and memory results are never middle-elided or spilled",
			).toEqual([]);
			expect(hidingMarkers(text), `POST-CTX27-25 violation: the ${label} carries an elision notice`).toEqual([]);
		}
	});

	it("POST-CTX27-26: a raw ranged read of a skill reference returns exactly the requested lines", async () => {
		// Risk tier: HIGH — a range names the lines the model asked to see.
		const { refFile } = await makeSkillTree("range-skill");
		const text = textOf(
			await realRead().execute(
				"c-range",
				{ path: `${refFile}:raw:1000-1004` },
				undefined,
				undefined,
				await makeToolContext(),
			),
		);
		const expected = [1000, 1001, 1002, 1003, 1004].map(n => `LINE-${n}-`.padEnd(60, "x")).join("\n");
		const returnedLines = text.split("\n").filter(line => line.startsWith("LINE-"));
		expect(
			returnedLines.join("\n"),
			"POST-CTX27-26 violation: the ranged read did not return exactly the requested lines\n" +
				`EXPECTED: ${JSON.stringify(expected)}\n` +
				`ACTUAL (first 400 chars): ${JSON.stringify(text.slice(0, 400))}\n` +
				"GUIDANCE: a range returns those lines and no other line of the file",
		).toBe(expected);
		expect(
			hidingMarkers(text).filter(marker => !/Showing lines/i.test(marker)),
			"POST-CTX27-26 violation: the ranged read carries an elision notice\nGUIDANCE: a continuation hint is allowed, an elision is not",
		).toEqual([]);
	});

	it("POST-CTX27-27: a bash result above the threshold still spills to an artifact with a head and tail, and the setting is unchanged", async () => {
		// Risk tier: HIGH — only authority text is exempt; a 60 KB bash result must stay out of context.
		const big = numberedDoc(1000);
		expect(Buffer.byteLength(big)).toBeGreaterThan(SPILL_THRESHOLD_BYTES);
		expect(cfgToolsArtifactSpillThreshold.get(Settings.isolated())).toBe(50);
		const text = textOf(
			await doubleTool("bash", big).execute(
				"c-bash",
				{ command: "echo" },
				undefined,
				undefined,
				await makeToolContext(),
			),
		);
		expect(
			text.length < big.length && /artifact:\/\//i.test(text) && !text.includes("LINE-500-"),
			"POST-CTX27-27 violation: a large bash result was not spilled to an artifact with a head and tail\n" +
				`ACTUAL: length ${text.length} of ${big.length}, has artifact notice ${/artifact:\/\//i.test(text)}\n` +
				"GUIDANCE: results whose authorityReadKind is null keep the existing spill",
		).toBe(true);
	});

	it("POST-CTX27-27: a large ordinary file read is still paged with a continuation, not returned whole", async () => {
		// Risk tier: HIGH — paging of ordinary files is unchanged; only skill files are exempt.
		const plain = path.join(testDir, "notes", "big.txt");
		await fs.mkdir(path.dirname(plain), { recursive: true });
		await Bun.write(plain, numberedDoc(2400));
		const text = textOf(
			await realRead().execute("c-plain", { path: plain }, undefined, undefined, await makeToolContext()),
		);
		expect(
			text.includes("LINE-1-") && !text.includes("LINE-2400-") && /Use :\d+/.test(text),
			"POST-CTX27-27 violation: an ordinary large file was not paged as before\n" +
				`ACTUAL (last 200 chars): ${JSON.stringify(text.slice(-200))}\n` +
				"GUIDANCE: only authority text is exempt from paging",
		).toBe(true);
	});

	it("POST-CTX27-28: the implementation classifier agrees with the contract on every path shape", async () => {
		// Risk tier: HIGH — the exemption keys on this classifier; a drift between twins would hide or expose the wrong text.
		// Dynamic only while the module does not exist (RED): a static import would crash the whole file instead of failing this one clause. GREEN replaces it with a static import.
		const implementation = await import("../../src/tools/authority-text").catch(error => {
			throw new Error(`POST-CTX27-28 violation: the implementation classifier module is missing: ${String(error)}`);
		});
		const cases: Array<[string, string]> = [
			["read", "skill://x"],
			["read", "skill://x/references/y.md"],
			["read", "SKILL://x"],
			["read", "/Users/k/.omp/agent/skills/x/SKILL.md"],
			["read", "/Users/k/.claude/skills/x/references/g.md:1-60"],
			["read", "/Users/k/.agents/skills/x/a.md:raw"],
			["read", "xd://mcp__memory_recall"],
			["write", "xd://mcp__memory_recall"],
			["write", "xd://mcp__memory_search"],
			["write", "xd://mcp__memory_list"],
			["write", "xd://mcp__memory_remember"],
			["write", "xd://mcp__ccabdd_state_machine_get_state"],
			["bash", "skill://x"],
			["read", "/tmp/skills/x.md"],
			["read", "/Users/k/projects/p/file.ts"],
			["read", ""],
		];
		const disagreements = cases.filter(
			([tool, p]) => implementation.authorityReadKind(tool, p) !== contractAuthorityReadKind(tool, p),
		);
		expect(
			disagreements,
			"POST-CTX27-28 violation: the implementation and contract classifiers disagree\n" +
				`DISAGREEMENTS: ${JSON.stringify(disagreements)}\n` +
				"GUIDANCE: redeclare the same rules in src/tools/authority-text.ts",
		).toEqual([]);
		expect(cases.filter(([tool, p]) => contractAuthorityReadKind(tool, p) !== null).length).toBeGreaterThan(8);
	});
});
