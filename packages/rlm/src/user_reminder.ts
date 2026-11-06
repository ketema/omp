/**
 * The reminder appended to Ketema's own interactive message (REQ-CTX27-33, REQ-CTX27-34, ketema/omp#27).
 *
 * The text reads as part of his message: no marker, tag or label. It goes on the first eligible message of a session
 * only. The wording is Ketema's to edit; it is redeclared here and the alignment of both copies is checked by tests
 * that import both sides.
 */

export const USER_REMINDER_TEXT =
	"Remember to be context efficient. Use your ipython REPL for data work and never paste long output into your reply. Have you written this function before? Check memory and your helpers first. Follow every skill step exactly.";

/**
 * True when any user message among the session history `entries` holds the reminder text. A history entry is a message
 * entry whose message has role "user"; its content is a string or a list of parts with `text`.
 */
export function sessionHoldsReminder(entries: readonly unknown[]): boolean {
	for (const entry of entries) {
		const holder = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
		if (holder?.type !== "message" || holder.message?.role !== "user") continue;
		const content = holder.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(part => String((part as { text?: unknown } | null)?.text ?? "")).join("\n")
					: "";
		if (text.includes(USER_REMINDER_TEXT)) return true;
	}
	return false;
}

/**
 * The message text after the submit hook: the reminder on a new line, or the text unchanged when the session already
 * holds the reminder, the source is not interactive, the text is empty, it begins with `/`, `!` or `$`, or it already
 * ends with the reminder.
 */
export function userMessageWithReminder(text: string, source: string, reminderInSession: boolean): string {
	if (reminderInSession) return text;
	if (source !== "interactive") return text;
	if (text.trim() === "") return text;
	if (/^[/!$]/.test(text.trimStart())) return text;
	if (text.endsWith(USER_REMINDER_TEXT)) return text;
	return `${text}\n${USER_REMINDER_TEXT}`;
}
