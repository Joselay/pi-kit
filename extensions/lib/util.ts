// Small helpers shared across extensions. Not an extension itself: pi only
// auto-loads extensions/*.ts and subdirectories with an index.ts, so lib/ is
// import-only.

/** Human-readable message for an unknown thrown value. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Flatten whitespace and truncate to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Joined text of a message's string-or-blocks content ("" when none). */
export function messageText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}
