import {
	CustomEditor,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type EditorComponent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

const SKILL_PREFIX = "skill:";
const FILE_MENTION_PATTERN = /(^|[\s([{])(@[^\s"'`<>{}\[\]()]+)/g;
const TRAILING_FILE_PUNCTUATION = /[,:;!?]+$/;

type SkillMeta = {
	description: string;
	filePath: string;
	baseDir: string;
};

type SkillIndex = {
	byName: Map<string, SkillMeta>;
	names: string[];
	pattern?: RegExp;
};

type SkillToken = {
	prefix: string;
	query: string;
};

type SkillAwareEditor = EditorComponent & {
	focused?: boolean;
	getCursor?: () => { line: number; col: number };
	getLines?: () => string[];
	isShowingAutocomplete?: () => boolean;
};

function loadSkillIndex(pi: ExtensionAPI): SkillIndex {
	const byName = new Map<string, SkillMeta>();
	const commands = pi.getCommands();

	const reserved = new Set<string>(
		commands.filter((command) => command.source !== "skill").map((command) => command.name),
	);

	for (const command of commands) {
		if (command.source !== "skill") continue;
		const name = command.name.startsWith(SKILL_PREFIX)
			? command.name.slice(SKILL_PREFIX.length)
			: command.name;
		if (!name || reserved.has(name)) continue;
		if (byName.has(name)) continue;
		const filePath = command.sourceInfo?.path ?? "";
		const baseDir = command.sourceInfo?.baseDir ?? (filePath ? dirname(filePath) : "");
		byName.set(name, { description: command.description ?? "", filePath, baseDir });
	}

	const names = [...byName.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
	const pattern =
		names.length > 0
			? new RegExp(
					`(^|[\\s([{])(\\/(?:skill:)?(?:${names.map(escapeRegExp).join("|")}))(?=[\\s/]|$)`,
					"g",
				)
			: undefined;
	return { byName, names, pattern };
}

export function createIndexCache(pi: ExtensionAPI, ttlMs = 2000): { get: () => SkillIndex; invalidate: () => void } {
	let cached: SkillIndex | undefined;
	let loadedAt = 0;

	return {
		get: () => {
			const now = Date.now();
			if (!cached || now - loadedAt > ttlMs) {
				cached = loadSkillIndex(pi);
				loadedAt = now;
			}
			return cached;
		},
		invalidate: () => {
			cached = undefined;
		},
	};
}

export function splitSkillCommand(
	text: string,
	index: SkillIndex,
): { name: string; args: string } | undefined {
	const match = text.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
	const name = match?.[1];
	if (!name || !index.byName.has(name)) return undefined;
	return { name, args: (match[2] ?? "").trim() };
}

function findSkillMentions(text: string, index: SkillIndex): string[] {
	if (!index.pattern) return [];
	index.pattern.lastIndex = 0;
	return [
		...new Set(
			[...text.matchAll(index.pattern)].map((match) => skillNameFromToken(match[2] ?? "")),
		),
	];
}

function replaceSkillMentionsWithPaths(text: string, index: SkillIndex): string {
	if (!index.pattern) return text;
	index.pattern.lastIndex = 0;
	return text.replace(index.pattern, (_match, boundary: string, token: string) => {
		const name = skillNameFromToken(token);
		const filePath = index.byName.get(name)?.filePath;
		return filePath ? `${boundary}${filePath}` : `${boundary}${token}`;
	});
}

function skillNameFromToken(token: string): string {
	return token.slice(token.startsWith(`/${SKILL_PREFIX}`) ? SKILL_PREFIX.length + 1 : 1);
}

function buildSkillBlock(name: string, meta: SkillMeta): string | undefined {
	if (!meta.filePath) return undefined;
	try {
		const body = stripFrontmatter(readFileSync(meta.filePath, "utf-8")).trim();
		return `<skill name="${name}" location="${meta.filePath}">\nReferences are relative to ${meta.baseDir}.\n\n${body}\n</skill>`;
	} catch {
		return undefined;
	}
}

function extractSkillToken(beforeCursor: string): SkillToken | undefined {
	const match = beforeCursor.match(/(?:^|[\s([{])(\/(?:skill:)?([a-z0-9]*(-[a-z0-9]*)*))$/);
	if (!match?.[1]) return undefined;
	return { prefix: match[1], query: match[2] ?? "" };
}

function beforeCursorText(editor: SkillAwareEditor): string {
	if (editor.getCursor && editor.getLines) {
		const cursor = editor.getCursor();
		return (editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
	}
	return editor.getText();
}

function needsSpacer(editor: SkillAwareEditor): boolean {
	if (!editor.getCursor || !editor.getLines) return true;
	const cursor = editor.getCursor();
	const after = (editor.getLines()[cursor.line] ?? "").slice(cursor.col);
	return !after.startsWith(" ");
}

export function inSlashPalette(cursorLine: number, beforeCursor: string): boolean {
	return cursorLine === 0 && beforeCursor.trimStart().startsWith("/");
}

export function ghostCandidates(index: SkillIndex, query: string): string[] {
	if (!query) return [];
	return index.names
		.filter((name) => name.length > query.length && name.startsWith(query))
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function ghostSuffix(editor: SkillAwareEditor, index: SkillIndex): string | undefined {
	if (editor.getCursor && editor.getLines) {
		const cursor = editor.getCursor();
		const line = editor.getLines()[cursor.line] ?? "";
		if (inSlashPalette(cursor.line, line.slice(0, cursor.col))) return undefined;
		const after = line.slice(cursor.col);
		if (after !== "" && !after.startsWith(" ")) return undefined;
	}

	const token = extractSkillToken(beforeCursorText(editor));
	if (!token) return undefined;
	const best = ghostCandidates(index, token.query)[0];
	return best?.slice(token.query.length);
}

const CURSOR_CELL_START = "\x1b[7m";
const CURSOR_CELL_END = "\x1b[0m";

export function injectGhost(
	lines: string[],
	ghost: string,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	const lineIndex = lines.findIndex((line) => line.includes(CURSOR_CELL_START));
	if (lineIndex === -1) return lines;

	const line = lines[lineIndex]!;
	const cellStart = line.indexOf(CURSOR_CELL_START);
	const graphemeStart = cellStart + CURSOR_CELL_START.length;
	const cellEnd = line.indexOf(CURSOR_CELL_END, graphemeStart);
	if (cellEnd === -1) return lines;

	const cursorGrapheme = line.slice(graphemeStart, cellEnd);
	const after = line.slice(cellEnd + CURSOR_CELL_END.length);
	const trailing = after.trimEnd();
	const padding = visibleWidth(after) - visibleWidth(trailing);

	const cursorAtLineEnd = cursorGrapheme === " " && trailing === "";
	const budget = cursorAtLineEnd ? padding + 1 : padding;

	const graphemes = [...ghost];
	const head = graphemes[0];
	if (!head || budget < 1) return lines;
	const text = graphemes.slice(0, budget).join("");
	const tail = text.slice(head.length);

	const painted =
		line.slice(0, cellStart) +
		CURSOR_CELL_START +
		head +
		CURSOR_CELL_END +
		(tail ? theme.fg("dim", tail) : "") +
		(cursorAtLineEnd ? "" : cursorGrapheme) +
		after;

	const next = [...lines];
	next[lineIndex] = truncateToWidth(painted, visibleWidth(line), "");
	return next;
}

export function highlightSkillMentions(
	lines: string[],
	index: SkillIndex,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	const pattern = index.pattern;
	if (!pattern) return lines;

	return lines.map((line) => {
		pattern.lastIndex = 0;
		return line.replace(
			pattern,
			(_match, boundary: string, token: string) =>
				`${boundary}${theme.fg("accent", token)}`,
		);
	});
}

export function highlightFileMentions(
	lines: string[],
	cwd: string,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	return lines.map((line) => {
		FILE_MENTION_PATTERN.lastIndex = 0;
		return line.replace(
			FILE_MENTION_PATTERN,
			(_match, boundary: string, rawToken: string) => {
				const token = rawToken.replace(TRAILING_FILE_PUNCTUATION, "");
				const suffix = rawToken.slice(token.length);
				const mentionedPath = token.slice(1);
				if (!mentionedPath) return `${boundary}${rawToken}`;

				const expandedPath = mentionedPath.startsWith("~/")
					? resolve(homedir(), mentionedPath.slice(2))
					: mentionedPath;
				const absolutePath = isAbsolute(expandedPath)
					? expandedPath
					: resolve(cwd, expandedPath);

				if (!existsSync(absolutePath)) return `${boundary}${rawToken}`;
				return `${boundary}${theme.fg("syntaxString", token)}${suffix}`;
			},
		);
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getIndex: () => SkillIndex,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,

		getSuggestions(lines, cursorLine, cursorCol, options) {
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			try {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const token = extractSkillToken(beforeCursor);
				if (
					token &&
					!inSlashPalette(cursorLine, beforeCursor) &&
					ghostCandidates(getIndex(), token.query).length > 0
				) {
					return false;
				}
			} catch {
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function installEditor(ctx: ExtensionContext, getIndex: () => SkillIndex): void {
	const previousEditor = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = (previousEditor?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as SkillAwareEditor;

		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const base = render(width);
			let highlighted = base;
			try {
				highlighted = highlightSkillMentions(base, getIndex(), ctx.ui.theme);
				highlighted = highlightFileMentions(highlighted, ctx.cwd, ctx.ui.theme);
			} catch {
			}

			if (editor.focused === false || editor.isShowingAutocomplete?.()) return highlighted;
			try {
				const ghost = ghostSuffix(editor, getIndex());
				return ghost ? injectGhost(highlighted, ghost, ctx.ui.theme) : highlighted;
			} catch {
				return highlighted;
			}
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			try {
				if (
					typeof editor.insertTextAtCursor === "function" &&
					!editor.isShowingAutocomplete?.() &&
					keybindings.matches(data, "tui.input.tab")
				) {
					const ghost = ghostSuffix(editor, getIndex());
					if (ghost) {
						editor.insertTextAtCursor(`${ghost}${needsSpacer(editor) ? " " : ""}`);
						return;
					}
				}
			} catch {
			}

			handleInput(data);
		};

		return editor;
	});
}

export default function mentionsExtension(pi: ExtensionAPI) {
	const cache = createIndexCache(pi);
	const getIndex = cache.get;

	pi.on("session_start", (_event, ctx) => {
		cache.invalidate();
		if (ctx.mode !== "tui") return;

		installEditor(ctx, getIndex);
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, getIndex));
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return;

		if (event.text.startsWith(`/${SKILL_PREFIX}`)) return;

		try {
			const index = getIndex();

			const command = splitSkillCommand(event.text, index);
			if (command) {
				const block = buildSkillBlock(command.name, index.byName.get(command.name)!);
				if (block) {
					const args = command.args
						? replaceSkillMentionsWithPaths(command.args, index)
						: "";
					return {
						action: "transform",
						text: args ? `${block}\n\n${args}` : block,
					};
				}
			}

			const mentions = findSkillMentions(event.text, index);
			if (mentions.length === 0) return;

			return {
				action: "transform",
				text: replaceSkillMentionsWithPaths(event.text, index),
			};
		} catch {
			return;
		}
	});
}
