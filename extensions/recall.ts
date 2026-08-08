import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const HISTORY_LIMIT = 100;

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
	const text =
		typeof content === "string"
			? content
			: content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
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

function readSessionPrompts(directory: string): string[] {
	const history: string[] = [];
	const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort();

	for (const file of files) {
		for (const line of readFileSync(join(directory, file), "utf8").split("\n")) {
			if (!line) continue;
			try {
				const prompt = userPrompt(JSON.parse(line) as SessionEntry);
				if (prompt) addPrompt(history, prompt);
			} catch {
				// A session may end with a partially written line.
			}
		}
	}
	return history;
}

function decorateEditor(
	editor: EditorComponent,
	history: string[],
	onRender: (editor: EditorComponent, lines: string[], width: number) => void,
	onInput: (editor: EditorComponent, data: string, before: string) => void,
): EditorComponent {
	for (const prompt of history) editor.addToHistory?.(prompt);

	const render = editor.render.bind(editor);
	editor.render = (width) => {
		const lines = [...render(width)];
		onRender(editor, lines, width);
		return lines;
	};

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

	pi.on("session_start", (_event, ctx) => {
		browsePosition = 0;
		if (ctx.mode !== "tui") return;

		const sessionPrompts = collectPrompts(ctx.sessionManager.buildContextEntries());
		const currentPrompts = new Set(sessionPrompts);
		let history: string[] = [];

		try {
			history = readSessionPrompts(ctx.sessionManager.getSessionDir()).filter(
				(prompt) => !currentPrompts.has(prompt),
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
					if (!browsePosition || !lines.length) return;

					const border = "─── ";
					const counter = `History ${historyTotal - browsePosition + 1}/${historyTotal} `;
					const labelWidth = visibleWidth(border + counter);
					if (labelWidth > width || visibleWidth(lines[0]!) < labelWidth) return;

					const paint = editor.borderColor ?? ((text: string) => text);
					lines[0] =
						paint(border) +
						ctx.ui.theme.fg("dim", counter) +
						truncateToWidth(lines[0]!, width - labelWidth, "");
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
		const prompt = event.text.trim();
		if (!prompt || knownPrompts.has(prompt)) return;

		knownPrompts.add(prompt);
		if (ctx.mode === "tui") historyTotal = Math.min(HISTORY_LIMIT, historyTotal + 1);
	});
}
