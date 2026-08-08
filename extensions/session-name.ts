import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const ACCENT = "borderAccent" as const;
const RIGHT_INSET = 1;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BORDER_DECORATIONS = /[─↑↓\d\s.…]+/g;

type Paint = (text: string) => string;

function decorateEditor(
	editor: EditorComponent,
	decorate: (lines: string[], width: number) => void,
): EditorComponent {
	const render = editor.render.bind(editor);
	editor.render = (width: number): string[] => {
		const lines = [...render(width)];
		decorate(lines, width);
		return lines;
	};
	return editor;
}

function plainText(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function isBorderLine(line: string): boolean {
	const text = plainText(line);
	return text.includes("─") && text.replace(BORDER_DECORATIONS, "").length === 0;
}

function paintBorder(line: string, paint: Paint): string {
	return line.replace(/─+/g, paint);
}

function bottomBorderIndex(lines: string[]): number | undefined {
	for (let index = lines.length - 1; index > 0; index--) {
		if (isBorderLine(lines[index]!)) return index;
	}
	return undefined;
}

function badge(name: string, paint: Paint): string {
	return paint(`\x1b[7m ${name} \x1b[27m`);
}

function addRightLabel(line: string, label: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const fitted = truncateToWidth(label, Math.max(0, width - 2), "");
	const left = truncateToWidth(line, Math.max(1, width - visibleWidth(fitted) - 1), "");
	const gap = Math.max(0, width - visibleWidth(left) - visibleWidth(fitted) - 1);
	return `${left}${paint("─".repeat(gap))}${fitted}${paint("─")}`;
}

export default function sessionName(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return decorateEditor(editor, (lines, width) => {
				const name = pi.getSessionName()?.trim();
				if (!name || !lines.length || !plainText(lines[0]!).includes("─")) return;

				const currentTheme = ctx.ui.theme;
				const paint = (text: string) => currentTheme.fg(ACCENT, text);
				const bottom = bottomBorderIndex(lines);
				if (bottom === undefined) return;

				lines[0] = paintBorder(lines[0]!, paint);
				lines[bottom] = paintBorder(lines[bottom]!, paint);
				const label = `${badge(name, paint)}${paint("─".repeat(RIGHT_INSET))}`;
				lines[0] = addRightLabel(lines[0]!, label, width, paint);
			});
		});
	});

	pi.on("session_info_changed", () => requestRender?.());
	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
