/**
 * Skill shortcuts
 *
 * Type `/imagegen` instead of `/skill:imagegen` — at line start or mid-text
 * (`hello /image…`).
 *
 * Pi natively lists skills only at message start and only as `/skill:name`
 * (see pi-tui CombinedAutocompleteProvider: slash suggestions require
 * `textBeforeCursor.startsWith("/")`). This extension layers on top:
 * - wraps the editor to force-trigger autocomplete on a mid-text skill token
 * - supplies skill suggestions via addAutocompleteProvider
 * - rewrites leading `/name` → `/skill:name` so pi's native expansion runs
 * - colors matched skill tokens in the editor
 *
 * Skills come from `pi.getCommands()` (source === "skill") — pi's own live
 * command registry — so this stays in sync with settings (enableSkillCommands),
 * project trust, extra `skills` paths, and resources_discover contributions.
 * Mid-text mentions are cosmetic: pi only *expands* a skill when the whole
 * message starts with `/skill:` (agent-session `_expandSkillCommand`).
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorComponent,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const SKILL_PREFIX = "skill:";

const SKILL_COLORS: ThemeColor[] = [
	"accent",
	"mdLink",
	"syntaxKeyword",
	"syntaxFunction",
	"success",
	"warning",
	"syntaxVariable",
	"syntaxType",
];

/**
 * Built-in interactive commands — never steal these short names.
 * pi does not surface these through getCommands(), so they are listed here.
 */
const BUILTIN_COMMANDS = new Set([
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
	"exit",
	"help",
	"clear",
]);

type SkillMeta = {
	description: string;
	/** Absolute path to the skill's SKILL.md (from pi's sourceInfo). */
	filePath: string;
	/** Directory the skill's relative references resolve against. */
	baseDir: string;
};

type SkillIndex = {
	/** Skill name → metadata. */
	byName: Map<string, SkillMeta>;
	/** Non-skill command names (extension + prompt) — reserved for short form. */
	reserved: Set<string>;
	/** Longest name first so the highlight regex prefers full matches. */
	names: string[];
};

/** `/image` or `/skill:image` at a token boundary before the cursor. */
type SkillToken = {
	/** Full matched token including leading `/` (e.g. `/image`, `/skill:im`). */
	prefix: string;
	/** Name fragment after `/` or `/skill:`. */
	query: string;
	longForm: boolean;
};

/**
 * Runtime Editor surface we need. EditorComponent is the public extension
 * contract; getCursor/getLines/tryTriggerAutocomplete exist on the pi-tui Editor
 * but aren't all declared on EditorComponent, hence the optional-chained access.
 */
type SkillAwareEditor = EditorComponent & {
	getCursor?: () => { line: number; col: number };
	getLines?: () => string[];
	isShowingAutocomplete?: () => boolean;
	tryTriggerAutocomplete?: (explicitTab?: boolean) => void;
};

type KeyMatcher = {
	matches: (data: string, action: string) => boolean;
};

/** Live skill index derived from pi's own command registry. */
function loadSkillIndex(pi: ExtensionAPI): SkillIndex {
	const byName = new Map<string, SkillMeta>();
	const reserved = new Set<string>(BUILTIN_COMMANDS);

	for (const command of pi.getCommands()) {
		if (command.source === "skill") {
			const name = command.name.startsWith(SKILL_PREFIX)
				? command.name.slice(SKILL_PREFIX.length)
				: command.name;
			if (!name || BUILTIN_COMMANDS.has(name)) continue;
			if (byName.has(name)) continue;
			const filePath = command.sourceInfo?.path ?? "";
			const baseDir = command.sourceInfo?.baseDir ?? (filePath ? dirname(filePath) : "");
			byName.set(name, { description: command.description ?? "", filePath, baseDir });
		} else {
			// Extension/prompt command names must not be shadowed by short form.
			reserved.add(command.name);
		}
	}

	const names = [...byName.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
	return { byName, reserved, names };
}

/** Strip a leading `---` YAML frontmatter block (mirrors pi's stripFrontmatter). */
function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return normalized;
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return normalized;
	return normalized.slice(end + 4).trim();
}

/**
 * Every `/name` (or `/skill:name`) mention of a known skill in the text, in
 * order, deduped. A mention is an explicit slash token — plain words never
 * count, so this stays deterministic and intentional.
 */
function findSkillMentions(text: string, index: SkillIndex): string[] {
	const re = /(?:^|[\s([{])\/(?:skill:)?([a-z0-9]+(?:-[a-z0-9]+)*)/g;
	const found: string[] = [];
	for (const match of text.matchAll(re)) {
		const name = match[1];
		if (name && index.byName.has(name) && !found.includes(name)) found.push(name);
	}
	return found;
}

/**
 * Build the exact `<skill>` block pi injects for `/skill:name`
 * (agent-session `_expandSkillCommand`). Returns undefined if the file
 * can't be read, so a bad skill never blocks the message.
 */
function buildSkillBlock(name: string, meta: SkillMeta): string | undefined {
	if (!meta.filePath) return undefined;
	try {
		const body = stripFrontmatter(readFileSync(meta.filePath, "utf-8")).trim();
		return `<skill name="${name}" location="${meta.filePath}">\nReferences are relative to ${meta.baseDir}.\n\n${body}\n</skill>`;
	} catch {
		return undefined;
	}
}

function colorForSkill(name: string): ThemeColor {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 33 + name.charCodeAt(i)) >>> 0;
	return SKILL_COLORS[hash % SKILL_COLORS.length]!;
}

/**
 * Skill slash token at end of text-before-cursor.
 * Matches start-of-line and mid-text (`hello /image`), not paths (`/usr/bin`).
 * Boundary style matches pi docs / github-issue-autocomplete / emoji examples.
 */
function extractSkillToken(beforeCursor: string): SkillToken | undefined {
	const match = beforeCursor.match(/(?:^|[\s([{])(\/(?:skill:)?([a-z0-9]*(-[a-z0-9]*)*))$/);
	if (!match?.[1]) return undefined;
	return {
		prefix: match[1],
		query: match[2] ?? "",
		longForm: match[1].startsWith("/skill:"),
	};
}

function beforeCursorText(editor: SkillAwareEditor): string {
	if (editor.getCursor && editor.getLines) {
		const cursor = editor.getCursor();
		return (editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
	}
	// Fallback when only EditorComponent is available (cursor assumed at end).
	return editor.getText();
}

function skillItems(index: SkillIndex, query: string, longForm: boolean): AutocompleteItem[] {
	const candidates = index.names
		.filter((name) => !index.reserved.has(name))
		.map((name) => ({
			name,
			label: longForm ? `skill:${name}` : name,
			description: `skill — ${index.byName.get(name)?.description ?? ""}`,
		}));

	return fuzzyFilter(candidates, query, (item) => item.name).map((item) => ({
		// Full token so mid-line applyCompletion can replace the prefix as-is.
		value: longForm ? `/skill:${item.name}` : `/${item.name}`,
		label: item.label,
		description: item.description,
	}));
}

function applyTokenCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	value: string,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const beforePrefix = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
	const afterCursor = currentLine.slice(cursorCol);
	const spacer = afterCursor.startsWith(" ") || afterCursor.startsWith("\n") ? "" : " ";
	const insertion = `${value}${spacer}`;
	const newLine = `${beforePrefix}${insertion}${afterCursor}`;
	const next = [...lines];
	next[cursorLine] = newLine;
	return {
		lines: next,
		cursorLine,
		cursorCol: beforePrefix.length + insertion.length,
	};
}

function mergeStartOfLineSuggestions(
	skillMatches: AutocompleteItem[],
	builtIn: AutocompleteSuggestions | null,
	tokenPrefix: string,
): AutocompleteSuggestions | null {
	if (skillMatches.length === 0) return builtIn;
	if (!builtIn) return { items: skillMatches, prefix: tokenPrefix };

	const shortNames = new Set(skillMatches.map((item) => item.value.replace(/^\/(?:skill:)?/, "")));

	const filteredExisting = builtIn.items.filter((item) => {
		if (item.value.startsWith("skill:")) {
			return !shortNames.has(item.value.slice("skill:".length));
		}
		if (shortNames.has(item.value)) return false;
		return true;
	});

	const existingValues = new Set<string>();
	for (const item of filteredExisting) {
		existingValues.add(item.value);
		existingValues.add(item.value.startsWith("/") ? item.value : `/${item.value}`);
	}

	const merged = [
		...skillMatches.filter((item) => !existingValues.has(item.value) && !existingValues.has(item.value.slice(1))),
		...filteredExisting,
	];

	return {
		items: merged,
		prefix: builtIn.prefix.startsWith("/") ? builtIn.prefix : tokenPrefix,
	};
}

function highlightSkillTokens(line: string, index: SkillIndex, theme: ExtensionContext["ui"]["theme"]): string {
	if (index.names.length === 0 || !line.includes("/")) return line;

	const pattern = new RegExp(
		`(\\/(?:skill:)?(?:${index.names.map(escapeRegExp).join("|")}))(?=[\\s/]|$)`,
		"g",
	);

	return line.replace(pattern, (token) => {
		const name = token.startsWith("/skill:") ? token.slice("/skill:".length) : token.slice(1);
		if (!index.byName.has(name)) return token;
		return theme.fg(colorForSkill(name), token);
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skillNameFromCompletionValue(value: string): string | undefined {
	if (value.startsWith("/skill:")) return value.slice("/skill:".length);
	if (value.startsWith("/")) return value.slice(1);
	return undefined;
}

function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getIndex: () => SkillIndex,
): AutocompleteProvider {
	// Note: pi-tui rejects "/" in setAutocompleteTriggerCharacters — the mid-text
	// open is done by the editor handleInput hook below, not via triggers.
	return {
		triggerCharacters: current.triggerCharacters,

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			// Any failure in our layer must fall back to pi's own provider so the
			// editor never loses its native slash/path completion.
			try {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const token = extractSkillToken(beforeCursor);

				if (!token) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const index = getIndex();
				const matches = skillItems(index, token.query, token.longForm);
				const atLineStart = beforeCursor.slice(0, beforeCursor.length - token.prefix.length).trim() === "";

				// Line start: merge with built-in slash commands (`/model`, templates, …).
				if (atLineStart) {
					const builtIn = await current.getSuggestions(lines, cursorLine, cursorCol, options);
					return mergeStartOfLineSuggestions(matches, builtIn, token.prefix);
				}

				// Mid-text (`hello /image`): skills only. No path fallthrough.
				if (matches.length === 0) return null;

				return {
					items: matches,
					prefix: token.prefix,
				};
			} catch {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			try {
				const name = skillNameFromCompletionValue(item.value);
				if (name && prefix.startsWith("/") && getIndex().byName.has(name)) {
					return applyTokenCompletion(lines, cursorLine, cursorCol, item.value, prefix);
				}
			} catch {
				// fall through to pi's default insertion
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			try {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				// Block forced file completion while typing a skill token (Tab path).
				if (extractSkillToken(beforeCursor)) return false;
			} catch {
				// fall through to pi's default decision
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
		const kb = keybindings as KeyMatcher;

		// Display-only highlight. pi reads submitted text via getText(), never
		// render(), so injected ANSI can never reach the model or session. On any
		// error we return pi's original rendered lines unchanged.
		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const base = render(width);
			try {
				return base.map((line) => highlightSkillTokens(line, getIndex(), ctx.ui.theme));
			} catch {
				return base;
			}
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			// Tab on a mid-text skill token: open the skill menu (pi would force file
			// completion, then shouldTriggerFileCompletion returns false and aborts).
			// Only intercept when the trigger method actually exists, otherwise fall
			// through so Tab keeps pi's native behavior instead of being swallowed.
			try {
				if (
					typeof editor.tryTriggerAutocomplete === "function" &&
					!editor.isShowingAutocomplete?.() &&
					kb.matches(data, "tui.input.tab") &&
					extractSkillToken(beforeCursorText(editor))
				) {
					editor.tryTriggerAutocomplete(true);
					return;
				}
			} catch {
				// fall through to pi's native input handling
			}

			// Base editor handling always runs — our layer only augments it.
			handleInput(data);

			// Pi only auto-opens slash autocomplete at message start and forbids `/`
			// as a triggerCharacter — force-open when a skill token is under the cursor.
			try {
				if (editor.isShowingAutocomplete?.()) return;
				if (!extractSkillToken(beforeCursorText(editor))) return;
				editor.tryTriggerAutocomplete?.(false);
			} catch {
				// ignore — the keystroke is already applied by base handleInput
			}
		};

		return editor;
	});
}

export default function skillsExtension(pi: ExtensionAPI) {
	// getCommands() is live per call, so the index always reflects the current
	// session (settings, trust, reloads) with no manual refresh needed.
	const getIndex = () => loadSkillIndex(pi);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Editor first, then autocomplete wrapper — addAutocompleteProvider refreshes
		// the provider on the active editor after the custom editor is installed.
		installEditor(ctx, getIndex);
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, getIndex));
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return;

		try {
			// A `/name` mention of a skill — anywhere in the message — deterministically
			// injects that skill's full content, so mentioning it always loads it.
			// pi's native expansion only fires for a leading `/skill:`; this covers
			// mid-text and short form by replicating the same <skill> block.
			const index = getIndex();
			const mentions = findSkillMentions(event.text, index);
			if (mentions.length === 0) return;

			const blocks: string[] = [];
			for (const name of mentions) {
				const block = buildSkillBlock(name, index.byName.get(name)!);
				if (block) blocks.push(block);
			}
			if (blocks.length === 0) return;

			// Prepend the skill block(s); the user's original wording is kept intact
			// so their request context stays attached. The transformed text no longer
			// starts with `/skill:`, so pi's native expansion is a no-op (no double-inject).
			return {
				action: "transform",
				text: `${blocks.join("\n\n")}\n\n${event.text}`,
			};
		} catch {
			// Never block input — let the original text pass through unchanged.
			return;
		}
	});
}
