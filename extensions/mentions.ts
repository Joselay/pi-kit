import {
	CustomEditor,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	CURSOR_MARKER,
	type EditorComponent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const SKILL_PREFIX = "skill:";
const FILE_MENTION_PATTERN = /(^|[\s([{])(@[^\x00-\x20\x7f"'`<>{}\[\]()]+)/g;
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

type CursorAwareEditor = EditorComponent & {
	focused?: boolean;
	getCursor: () => { line: number; col: number };
	getLines: () => string[];
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
					`(^|[\\s([{])(\\/(?:skill:)?(?:${names.map(escapeRegExp).join("|")}))(?=[\\s/]|${escapeRegExp(CURSOR_MARKER)}|$)`,
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

export function inSlashPalette(cursorLine: number, beforeCursor: string): boolean {
	return cursorLine === 0 && beforeCursor.trimStart().startsWith("/");
}

export function skillCandidates(index: SkillIndex, query: string): string[] {
	if (!query) return [];
	return index.names
		.filter((name) => name.length > query.length && name.startsWith(query))
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function isCursorAwareEditor(editor: EditorComponent): editor is CursorAwareEditor {
	const candidate = editor as Partial<CursorAwareEditor>;
	return typeof candidate.getCursor === "function" && typeof candidate.getLines === "function";
}

function ghostSuffix(editor: CursorAwareEditor, index: SkillIndex): string | undefined {
	const cursor = editor.getCursor();
	const line = editor.getLines()[cursor.line] ?? "";
	const beforeCursor = line.slice(0, cursor.col);
	if (inSlashPalette(cursor.line, beforeCursor)) return undefined;

	const afterCursor = line.slice(cursor.col);
	if (afterCursor !== "" && !afterCursor.startsWith(" ")) return undefined;

	const token = extractSkillToken(beforeCursor);
	if (!token) return undefined;
	const best = skillCandidates(index, token.query)[0];
	return best?.slice(token.query.length);
}

const CURSOR_CELL_START = "\x1b[7m";
const CURSOR_CELL_END = "\x1b[0m";

export function injectGhost(
	lines: string[],
	ghost: string,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	const lineIndex = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	if (lineIndex === -1) return lines;

	const line = lines[lineIndex]!;
	const markerEnd = line.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length;
	const cellStart = line.indexOf(CURSOR_CELL_START, markerEnd);
	if (cellStart === -1) return lines;

	const graphemeStart = cellStart + CURSOR_CELL_START.length;
	const cellEnd = line.indexOf(CURSOR_CELL_END, graphemeStart);
	if (cellEnd === -1) return lines;

	const cursorGrapheme = line.slice(graphemeStart, cellEnd);
	const after = line.slice(cellEnd + CURSOR_CELL_END.length);
	const trailing = after.trimEnd();
	const padding = visibleWidth(after) - visibleWidth(trailing);
	const cursorAtLineEnd = cursorGrapheme === " " && trailing === "";
	const budget = cursorAtLineEnd ? padding + 1 : padding;
	const text = [...ghost].slice(0, budget).join("");
	const head = text[0];
	if (!head) return lines;

	const painted =
		line.slice(0, cellStart) +
		CURSOR_CELL_START +
		head +
		CURSOR_CELL_END +
		(text.length > head.length ? theme.fg("dim", text.slice(head.length)) : "") +
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
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	return lines.map((line) => {
		FILE_MENTION_PATTERN.lastIndex = 0;
		return line.replace(
			FILE_MENTION_PATTERN,
			(_match, boundary: string, rawToken: string) => {
				const token = rawToken.replace(TRAILING_FILE_PUNCTUATION, "");
				const suffix = rawToken.slice(token.length);
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

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const token = extractSkillToken(beforeCursor);
			if (!token || inSlashPalette(cursorLine, beforeCursor)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const index = getIndex();
			const names = skillCandidates(index, token.query);
			if (names.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const explicitPrefix = token.prefix.startsWith(`/${SKILL_PREFIX}`);
			return {
				prefix: token.prefix,
				items: names.map((name) => ({
					value: explicitPrefix ? `/${SKILL_PREFIX}${name}` : `/${name}`,
					label: name,
					description: index.byName.get(name)?.description,
				})),
			};
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
					skillCandidates(getIndex(), token.query).length > 0
				) {
					return true;
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
			new CustomEditor(tui, theme, keybindings)) as EditorComponent;

		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const base = render(width);
			let highlighted = base;
			try {
				highlighted = highlightSkillMentions(base, getIndex(), ctx.ui.theme);
				highlighted = highlightFileMentions(highlighted, ctx.ui.theme);
			} catch {
			}

			if (
				isCursorAwareEditor(editor) &&
				editor.focused !== false &&
				!editor.isShowingAutocomplete?.()
			) {
				const ghost = ghostSuffix(editor, getIndex());
				if (ghost) return injectGhost(highlighted, ghost, ctx.ui.theme);
			}

			return highlighted;
		};

		return editor;
	});
}

export default function mentionsExtension(pi: ExtensionAPI) {
	const cache = createIndexCache(pi);
	const getIndex = cache.get;

	pi.on("resources_discover", () => {
		cache.invalidate();
	});

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
