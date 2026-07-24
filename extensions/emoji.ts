/**
 * Emoji Extension
 *
 * `:shortcode:` autocomplete in the editor (GitHub-style shortcodes) and an
 * /emoji picker overlay that inserts the selected emoji into the prompt.
 * Data lives in ../assets/emoji/emoji.json; regenerate with `uv run assets/emoji/build.py`.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { errorText } from "./lib/util.ts";

const DATA_URL = new URL("../assets/emoji/emoji.json", import.meta.url);
const MAX_SUGGESTIONS = 20;

type EmojiEntry = {
	emoji: string;
	codes: string[];
	keywords: string[];
};

type Match = { entry: EmojiEntry; code: string };

let cachedEntries: EmojiEntry[] | null = null;
let cachedItems: SelectItem[] | null = null;
let loadError: string | null = null;

/** Never throws: a broken dataset must not take down the autocomplete chain. */
const loadEntries = (): EmojiEntry[] => {
	if (!cachedEntries) {
		try {
			cachedEntries = JSON.parse(readFileSync(DATA_URL, "utf8")) as EmojiEntry[];
			loadError = null;
		} catch (error) {
			cachedEntries = [];
			loadError = errorText(error);
		}
	}
	return cachedEntries;
};

const loadItems = (): SelectItem[] => {
	if (!cachedItems) {
		cachedItems = loadEntries().map((entry) => ({
			value: entry.emoji,
			label: `${entry.emoji}  :${entry.codes[0]}:`,
			description: entry.keywords.slice(0, 5).join(", "),
		}));
	}
	return cachedItems;
};

const matchShortcodes = (query: string): Match[] => {
	const prefixMatches: Match[] = [];
	const otherMatches: Match[] = [];

	for (const entry of loadEntries()) {
		const prefixCode = entry.codes.find((code) => code.startsWith(query));
		if (prefixCode) {
			prefixMatches.push({ entry, code: prefixCode });
			if (prefixMatches.length >= MAX_SUGGESTIONS) break;
			continue;
		}
		const looseCode = entry.codes.find((code) => code.includes(query));
		if (looseCode) {
			otherMatches.push({ entry, code: looseCode });
			continue;
		}
		if (entry.keywords.some((keyword) => keyword.startsWith(query))) {
			otherMatches.push({ entry, code: entry.codes[0] });
		}
	}

	const byCode = (a: Match, b: Match) => a.code.localeCompare(b.code);
	prefixMatches.sort(byCode);
	otherMatches.sort(byCode);
	return [...prefixMatches, ...otherMatches].slice(0, MAX_SUGGESTIONS);
};

const insertIntoPrompt = (ctx: ExtensionContext, emoji: string): void => {
	ctx.ui.pasteToEditor(emoji);
};

const registerAutocomplete = (ctx: ExtensionContext): void => {
	ctx.ui.addAutocompleteProvider((current) => ({
		triggerCharacters: [":"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|[\s([{])(:([A-Za-z0-9_+-]{2,}))$/);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = match[2].toLowerCase();
			const matches = matchShortcodes(query);
			if (matches.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				prefix: match[1],
				items: matches.map(({ entry, code }) => ({
					value: entry.emoji,
					label: `${entry.emoji} :${code}:`,
					description: entry.keywords.slice(0, 4).join(", "),
				})),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	}));
};

const showEmojiPicker = async (ctx: ExtensionContext, initialQuery: string): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Emoji picker requires interactive mode", "error");
		return;
	}

	const items = loadItems();
	if (items.length === 0) {
		ctx.ui.notify(`Could not load emoji data: ${loadError ?? "dataset is empty"}`, "error");
		return;
	}

	const selection = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" Insert emoji")), 0, 0));

		const searchInput = new Input();
		searchInput.setValue(initialQuery);
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg("dim", "Type to filter • enter to insert • esc to cancel"), 0, 0));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		let filteredItems = items;
		let selectList: SelectList | null = null;

		const updateList = () => {
			listContainer.clear();
			if (filteredItems.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", "  No matching emoji"), 0, 0));
				selectList = null;
				return;
			}

			selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value as string);
			selectList.onCancel = () => done(null);

			listContainer.addChild(selectList);
		};

		const applyFilter = () => {
			const query = searchInput.getValue();
			filteredItems = query
				? fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`)
				: items;
			updateList();
		};

		applyFilter();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					if (selectList) {
						selectList.handleInput(data);
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done(null);
					}
					tui.requestRender();
					return;
				}

				searchInput.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});

	if (selection) {
		insertIntoPrompt(ctx, selection);
	}
};

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		registerAutocomplete(ctx);
	});

	pi.registerCommand("emoji", {
		description: "Pick an emoji and insert it into the prompt",
		handler: async (args, ctx) => {
			await showEmojiPicker(ctx, args.trim().replace(/^:+|:+$/g, ""));
		},
	});
}
