/**
 * The reminder appended to Ketema's own interactive messages (REQ-CTX27-33, REQ-CTX27-34, ketema/omp#27).
 *
 * The text reads as part of his message: no marker, tag or label. The wording is Ketema's to edit; it is redeclared here
 * and the alignment of both copies is checked by tests that import both sides.
 */

export const USER_REMINDER_TEXT =
	"Remember to be context efficient. Use your ipython REPL for data work and never paste long output into your reply. Have you written this function before? Check memory and your helpers first. Follow every skill step exactly.";

/**
 * The message text after the submit hook: the reminder on a new line, or the text unchanged when the source is not
 * interactive, the text is empty, it begins with `/`, `!` or `$`, or it already ends with the reminder.
 */
export function userMessageWithReminder(text: string, source: string): string {
	if (source !== "interactive") return text;
	if (text.trim() === "") return text;
	if (/^[/!$]/.test(text.trimStart())) return text;
	if (text.endsWith(USER_REMINDER_TEXT)) return text;
	return `${text}\n${USER_REMINDER_TEXT}`;
}
