/**
 * User message reminder tests (ketema/omp#27, SLICE-3 item 2, follow-up B).
 *
 * Targets the IMPLEMENTATION through the real extension: createRlmExtension registers its input handler, and the host
 * chains input handlers the way the harness does. No kernel starts in these tests.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: contracts/context_efficiency_enforcement.contract.ts
 * - POST-CTX27-21, POST-CTX27-22
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

describe("the reminder is appended to Ketema's own message (REQ-CTX27-33, REQ-CTX27-34)", () => {
	test("POST-CTX27-21: an interactive message is followed by a newline and the reminder text, with nothing wrapped around it", async () => {
		// Risk tier: HIGH — this is the position the model follows; a marker would let it be ignored over time.
		const { home, session } = await openReminderSession();
		try {
			for (const text of ["fix the build", "line one\nline two", "Why did this fail? Look at the log."]) {
				const expected = `${text}\n${USER_REMINDER_TEXT}`;
				const actual = await session.submit(text, "interactive");
				expect(
					actual,
					"POST-CTX27-21 violation: the message was not followed by a newline and the reminder, exactly\n" +
						`EXPECTED: ${JSON.stringify(expected)}\n` +
						`ACTUAL: ${JSON.stringify(actual)}\n` +
						"GUIDANCE: append the reminder to the user's own text with no marker, tag or label",
				).toBe(expected);
			}
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("POST-CTX27-22: slash, shell and python commands, other sources, empty text and an already reminded message stay unchanged", async () => {
		// Risk tier: HIGH — appending text to a command would break it, and a second copy would pile up on resubmit.
		const { home, session } = await openReminderSession();
		try {
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
				const actual = await session.submit(text, source);
				expect(
					actual,
					`POST-CTX27-22 violation: the ${label} was changed\n` +
						`EXPECTED: ${JSON.stringify(text)}\n` +
						`ACTUAL: ${JSON.stringify(actual)}\n` +
						"GUIDANCE: leave the message unchanged for this case",
				).toBe(text);
			}
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
