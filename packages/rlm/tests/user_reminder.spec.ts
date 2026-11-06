/**
 * User message reminder tests (ketema/omp#27, SLICE-3 item 2, follow-ups B and B2).
 *
 * Targets the IMPLEMENTATION through the real extension: createRlmExtension registers its input handler, and the host
 * chains input handlers the way the harness does and records each message in the session history that the handler
 * reads through sessionManager.getEntries(). No kernel starts in these tests.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: contracts/context_efficiency_enforcement.contract.ts
 * - POST-CTX27-21, POST-CTX27-22, POST-CTX27-23
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { USER_REMINDER_TEXT } from "../../../contracts/context_efficiency_enforcement.contract.ts";
import { openRealSession } from "./real_extension.ts";

async function openReminderSession() {
	const home = fs.mkdtempSync(join(os.tmpdir(), "omp-reminder-"));
	const session = await openRealSession(home, join(home, "artifacts"), {
		createKernel: () => {
			throw new Error("the reminder tests start no kernel");
		},
	});
	return { home, session };
}

/** Runs `body` against a fresh session and always removes its temporary home. */
async function withSession(
	body: (session: Awaited<ReturnType<typeof openReminderSession>>["session"]) => Promise<void>,
) {
	const { home, session } = await openReminderSession();
	try {
		await body(session);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("the reminder goes on the first eligible message of a session (REQ-CTX27-33, REQ-CTX27-34)", () => {
	test("POST-CTX27-21: the first interactive message is followed by a newline and the reminder text, with nothing wrapped around it", async () => {
		// Risk tier: HIGH — this is the position the model follows; a marker would let it be ignored over time.
		for (const text of ["fix the build", "line one\nline two", "Why did this fail? Look at the log."]) {
			await withSession(async session => {
				const expected = `${text}\n${USER_REMINDER_TEXT}`;
				const actual = await session.submit(text, "interactive");
				expect(
					actual,
					"POST-CTX27-21 violation: the message was not followed by a newline and the reminder, exactly\n" +
						`EXPECTED: ${JSON.stringify(expected)}\n` +
						`ACTUAL: ${JSON.stringify(actual)}\n` +
						"GUIDANCE: append the reminder to the user's own text with no marker, tag or label",
				).toBe(expected);
			});
		}
	});

	test("POST-CTX27-22: slash, shell and python commands, other sources, empty text and an already reminded message stay unchanged", async () => {
		// Risk tier: HIGH — appending text to a command would break it, and a second copy would pile up on resubmit.
		const cases: Array<[string, string, string]> = [
			["slash command", "/compact", "interactive"],
			["slash command with leading spaces", "  /help", "interactive"],
			["shell command", "!ls -la", "interactive"],
			["python command", "$print(1)", "interactive"],
			["empty text", "", "interactive"],
			["blank text", "   \n", "interactive"],
			["rpc source", "fix it", "rpc"],
			["extension source", "fix it", "extension"],
			["already reminded", `fix it\n${USER_REMINDER_TEXT}`, "interactive"],
		];
		for (const [label, text, source] of cases) {
			await withSession(async session => {
				const actual = await session.submit(text, source);
				expect(
					actual,
					`POST-CTX27-22 violation: the ${label} was changed\n` +
						`EXPECTED: ${JSON.stringify(text)}\n` +
						`ACTUAL: ${JSON.stringify(actual)}\n` +
						"GUIDANCE: leave the message unchanged for this case",
				).toBe(text);
			});
		}
	});

	test("POST-CTX27-22 / POST-CTX27-23: only the first eligible message of a session carries the reminder, commands and other sources before it do not use it up", async () => {
		// Risk tier: HIGH — a repeated reminder on every message triggered a memory-search ritual on 4 of 6 task turns (session 01a1aeb5).
		await withSession(async session => {
			expect(await session.submit("/compact", "interactive")).toBe("/compact");
			expect(await session.submit("rpc one", "rpc")).toBe("rpc one");
			const first = await session.submit("fix the build", "interactive");
			expect(
				first,
				"POST-CTX27-22 violation: the first eligible message after a command and an rpc message did not get the reminder\n" +
					`ACTUAL: ${JSON.stringify(first)}\n` +
					"GUIDANCE: commands and other sources do not use up the single reminder",
			).toBe(`fix the build\n${USER_REMINDER_TEXT}`);
			for (const text of ["now the tests", "and the lint"]) {
				const later = await session.submit(text, "interactive");
				expect(
					later,
					"POST-CTX27-22 violation: a later message of the session carried the reminder again\n" +
						`EXPECTED: ${JSON.stringify(text)}\n` +
						`ACTUAL: ${JSON.stringify(later)}\n` +
						"GUIDANCE: the session already holds the reminder, so leave later messages unchanged",
				).toBe(text);
			}
		});
	});

	test("POST-CTX27-23: a resumed session that already holds the reminder in an earlier user message gets none, and only a user message counts", async () => {
		// Risk tier: HIGH — the session history, not the process, decides; a resume or compaction must not trigger a second copy.
		const holders: Array<[string, unknown, boolean]> = [
			[
				"user message as a string",
				{ type: "message", message: { role: "user", content: `earlier\n${USER_REMINDER_TEXT}` } },
				true,
			],
			[
				"user message as text parts",
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `earlier\n${USER_REMINDER_TEXT}` }] },
				},
				true,
			],
			[
				"assistant message quoting the text",
				{ type: "message", message: { role: "assistant", content: USER_REMINDER_TEXT } },
				false,
			],
			[
				"earlier user message without the text",
				{ type: "message", message: { role: "user", content: "/help" } },
				false,
			],
			["non-message entry", { type: "compaction", summary: USER_REMINDER_TEXT }, false],
		];
		for (const [label, entry, holdsReminder] of holders) {
			await withSession(async session => {
				session.history.push(entry);
				const text = "continue the slice";
				const actual = await session.submit(text, "interactive");
				const expected = holdsReminder ? text : `${text}\n${USER_REMINDER_TEXT}`;
				expect(
					actual,
					`POST-CTX27-23 violation: with ${label} in the history the reminder was ${holdsReminder ? "appended again" : "not appended"}\n` +
						`EXPECTED: ${JSON.stringify(expected)}\n` +
						`ACTUAL: ${JSON.stringify(actual)}\n` +
						"GUIDANCE: the session holds the reminder exactly when an earlier user message entry contains the text",
				).toBe(expected);
			});
		}
	});
});
