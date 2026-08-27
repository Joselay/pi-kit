import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const HISTORY_LIMIT = 100;
const READ_CHUNK_SIZE = 256 * 1024;
const USER_ROLE_PATTERN = /"role"\s*:\s*"user"/;

function addPrompt(history: string[], text: string): void {
	const prompt = text.trim();
	if (!prompt || history.at(-1) === prompt) return;

	const duplicate = history.indexOf(prompt);
	if (duplicate !== -1) history.splice(duplicate, 1);
	history.push(prompt);
	if (history.length > HISTORY_LIMIT) history.shift();
}

function userPrompt(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;

	const { content } = entry.message;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else {
		for (const part of content) {
			if (part.type === "text") text += part.text;
		}
	}
	return text.trim() || undefined;
}

function collectPrompts(entries: SessionEntry[]): string[] {
	const prompts: string[] = [];
	for (const entry of entries) {
		const prompt = userPrompt(entry);
		if (prompt) addPrompt(prompts, prompt);
	}
	return prompts;
}

async function scanLinesBackwards(path: string, visit: (line: string) => boolean): Promise<boolean> {
	const file = await open(path, "r");
	try {
		let position = (await file.stat()).size;
		let remainder = Buffer.alloc(0);

		while (position > 0) {
			const length = Math.min(READ_CHUNK_SIZE, position);
			position -= length;

			const chunk = Buffer.allocUnsafe(length);
			let bytesRead = 0;
			while (bytesRead < length) {
				const result = await file.read(chunk, bytesRead, length - bytesRead, position + bytesRead);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			const data = remainder.length
				? Buffer.concat([chunk.subarray(0, bytesRead), remainder])
				: chunk.subarray(0, bytesRead);
			let lineEnd = data.length;

			for (let index = data.length - 1; index >= 0; index--) {
				if (data[index] !== 0x0a) continue;
				if (index + 1 < lineEnd && visit(data.subarray(index + 1, lineEnd).toString("utf8"))) {
					return true;
				}
				lineEnd = index;
			}
			remainder = Buffer.from(data.subarray(0, lineEnd));
		}

		return remainder.length > 0 && visit(remainder.toString("utf8"));
	} finally {
		await file.close();
	}
}

async function readSessionPrompts(
	directory: string,
	excluded: Set<string>,
	limit: number,
): Promise<string[]> {
	if (limit <= 0) return [];

	const newest: string[] = [];
	const seen = new Set(excluded);
	const files = (await readdir(directory))
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.reverse();

	for (const file of files) {
		const complete = await scanLinesBackwards(join(directory, file), (line) => {
			if (!USER_ROLE_PATTERN.test(line)) return false;
			try {
				const prompt = userPrompt(JSON.parse(line) as SessionEntry);
				if (!prompt || seen.has(prompt)) return false;

				seen.add(prompt);
				newest.push(prompt);
				return newest.length === limit;
			} catch {
				// A session may end with a partially written line.
			}
			return false;
		});
		if (complete) return newest.reverse();
	}
	return newest.reverse();
}

function decorateEditor(
	editor: EditorComponent,
	history: string[],
	onRender: (editor: EditorComponent, lines: string[], width: number) => string[],
	onInput: (editor: EditorComponent, data: string, before: string) => void,
): EditorComponent {
	for (const prompt of history) editor.addToHistory?.(prompt);

	const render = editor.render.bind(editor);
	editor.render = (width) => onRender(editor, render(width), width);

	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		const before = editor.getText();
		handleInput(data);
		onInput(editor, data, before);
	};
	return editor;
}

export default function recall(pi: ExtensionAPI): void {
	let browsePosition = 0;
	let historyTotal = 0;
	let knownPrompts = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		browsePosition = 0;
		if (ctx.mode !== "tui") return;

		const sessionPrompts = collectPrompts(ctx.sessionManager.buildContextEntries());
		const currentPrompts = new Set(sessionPrompts);
		let history: string[] = [];

		try {
			history = await readSessionPrompts(
				ctx.sessionManager.getSessionDir(),
				currentPrompts,
				HISTORY_LIMIT - sessionPrompts.length,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not read prompt history: ${message}`, "warning");
		}

		knownPrompts = new Set([...history, ...sessionPrompts]);
		historyTotal = Math.min(HISTORY_LIMIT, history.length + sessionPrompts.length);
		const previous = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return decorateEditor(
				editor,
				history,
				(editor, lines, width) => {
					if (!browsePosition || !lines.length) return lines;

					const border = "─── ";
					const counter = `History ${historyTotal - browsePosition + 1}/${historyTotal} `;
					const labelWidth = visibleWidth(border + counter);
					if (labelWidth > width || visibleWidth(lines[0]!) < labelWidth) return lines;

					const paint = editor.borderColor ?? ((text: string) => text);
					return [
						paint(border) +
							ctx.ui.theme.fg("dim", counter) +
							truncateToWidth(lines[0]!, width - labelWidth, ""),
						...lines.slice(1),
					];
				},
				(editor, data, before) => {
					if (editor.getText() === before) return;
					const previous =
						keybindings.matches(data, "tui.editor.cursorUp") ||
						keybindings.matches(data, "tui.editor.historyPrevious");
					const next =
						keybindings.matches(data, "tui.editor.cursorDown") ||
						keybindings.matches(data, "tui.editor.historyNext");

					if (previous) {
						browsePosition = Math.min(historyTotal, browsePosition + 1);
					} else if (next) {
						browsePosition = Math.max(0, browsePosition - 1);
					} else {
						browsePosition = 0;
					}
				},
			);
		});
	});

	pi.on("input", (event, ctx) => {
		browsePosition = 0;
		if (ctx.mode !== "tui" || historyTotal === HISTORY_LIMIT) return;

		const prompt = event.text.trim();
		if (!prompt || knownPrompts.has(prompt)) return;

		knownPrompts.add(prompt);
		historyTotal++;
	});
}
