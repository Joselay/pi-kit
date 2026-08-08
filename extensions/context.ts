import {
	type BuildSystemPromptOptions,
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
	formatSkillsForPrompt,
	getAgentDir,
	getLastAssistantUsage,
	sessionEntryToContextMessages,
	SettingsManager,
	shouldCompact,
	type Skill,
	type SourceInfo,
	type Theme,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokensCompact(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}


function tokensOf(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

type SegmentId =
	| "system"
	| "append"
	| "contextFiles"
	| "skills"
	| "builtinTools"
	| "extensionTools"
	| "messages"
	| "reserved"
	| "free";

type ItemScope = "global" | "project" | "package" | "session";

type BreakdownItem = { label: string; tokens: number; scope?: ItemScope };

type Segment = {
	id: SegmentId;
	label: string;
	tokens: number;
	note?: string;
	items: BreakdownItem[];
};

type ContextBreakdown = {
	contextWindow: number;
	used: number;
	free: number;
	measurement?: "provider-anchored" | "estimated";
	measured?: boolean;
	willCompact: boolean | null;
	unattributed: SegmentId[];
	segments: Segment[];
};

type ContextInput = {
	contextWindow: number;
	cwd: string;
	systemPrompt: string;
	promptOptions: Pick<
		BuildSystemPromptOptions,
		"appendSystemPrompt" | "contextFiles" | "skills" | "customPrompt" | "selectedTools" | "cwd"
	>;
	formatSkills: (skills: Skill[]) => string;
	tools: readonly ToolInfo[];
	activeTools: readonly string[];
	messageTokens: number;
	reportedTokens: number | null;
	compaction: Required<CompactionSettings>;
};

function contextFileBlock(file: { path: string; content: string }): string {
	return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

function contextFilesSection(files: readonly { path: string; content: string }[]): string {
	if (files.length === 0) return "";
	return (
		`\n\n<project_context>\n\n` +
		`Project-specific instructions and guidelines:\n\n` +
		files.map(contextFileBlock).join("") +
		`</project_context>\n`
	);
}

function skillsHeaderChars(skills: readonly Skill[], formatSkills: (skills: Skill[]) => string): number {
	if (skills.length === 0) return 0;
	const once = formatSkills([...skills]).length;
	const twice = formatSkills([...skills, ...skills]).length;
	return Math.max(0, 2 * once - twice);
}

function skillItemTokens(skill: Skill, formatSkills: (skills: Skill[]) => string): number {
	const chars = formatSkills([skill, skill]).length - formatSkills([skill]).length;
	return tokensOf(" ".repeat(Math.max(0, chars)));
}

function scopeOf(sourceInfo: SourceInfo): ItemScope {
	if (sourceInfo.origin === "package") return "package";
	if (sourceInfo.scope === "project") return "project";
	return sourceInfo.scope === "temporary" ? "session" : "global";
}

function scopeOfPath(path: string, cwd: string): ItemScope {
	const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return path === cwd || path.startsWith(root) ? "project" : "global";
}

function wireTool(tool: ToolInfo): { name: string; description: string; parameters: unknown } {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function estimateToolsTokens(tools: readonly ToolInfo[]): number {
	if (tools.length === 0) return 0;
	return tokensOf(safeJsonStringify(tools.map(wireTool)));
}

function toolItems(tools: readonly ToolInfo[]): BreakdownItem[] {
	return tools
		.map((tool) => ({
			label: tool.name,
			tokens: tokensOf(safeJsonStringify(wireTool(tool))),
			scope: tool.sourceInfo.source === "builtin" ? undefined : scopeOf(tool.sourceInfo),
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

function splitToolSegments(activeTools: readonly ToolInfo[]): { builtin: Segment; extension: Segment } {
	const builtinTools = activeTools.filter((tool) => tool.sourceInfo.source === "builtin");
	const extensionTools = activeTools.filter((tool) => tool.sourceInfo.source !== "builtin");
	const builtinItems = toolItems(builtinTools);
	const extensionItems = toolItems(extensionTools);

	const builtinWeight = builtinItems.reduce((sum, item) => sum + item.tokens, 0);
	const extensionWeight = extensionItems.reduce((sum, item) => sum + item.tokens, 0);
	const weight = builtinWeight + extensionWeight;
	const total = estimateToolsTokens(activeTools);

	let builtinTokens = 0;
	let extensionTokens = 0;
	if (weight > 0 && total > 0) {
		builtinTokens = Math.round((builtinWeight / weight) * total);
		extensionTokens = total - builtinTokens;
	} else if (total > 0) {
		builtinTokens = Math.round((builtinTools.length / activeTools.length) * total);
		extensionTokens = total - builtinTokens;
	}

	return {
		builtin: {
			id: "builtinTools",
			label: "Built-in schemas",
			tokens: builtinTokens,
			note: builtinTools.length === 1 ? "1 tool" : `${builtinTools.length} tools`,
			items: builtinItems,
		},
		extension: {
			id: "extensionTools",
			label: "Custom schemas",
			tokens: extensionTokens,
			note: extensionTools.length === 1 ? "1 tool" : `${extensionTools.length} tools`,
			items: extensionItems,
		},
	};
}

function buildBreakdown(input: ContextInput): ContextBreakdown {
	const { systemPrompt, promptOptions, formatSkills } = input;
	const unattributed: SegmentId[] = [];

	const cwdSuffix = `\nCurrent working directory: ${promptOptions.cwd.replace(/\\/g, "/")}`;
	let base = systemPrompt;
	let cwdText = "";
	if (base.endsWith(cwdSuffix)) {
		base = base.slice(0, -cwdSuffix.length);
		cwdText = cwdSuffix;
	} else {
		unattributed.push("system");
	}

	const takeSuffix = (id: SegmentId, section: string, expected: boolean): string => {
		if (!expected) return "";
		if (!section || !base.endsWith(section)) {
			unattributed.push(id);
			return "";
		}
		base = base.slice(0, -section.length);
		return section;
	};

	const files = promptOptions.contextFiles ?? [];
	const skills = (promptOptions.skills ?? []).filter((skill) => formatSkills([skill]).length > 0);
	const skillsExact = formatSkills([...skills]);
	const skillsExpected = skills.length > 0 && (promptOptions.selectedTools?.includes("read") ?? true);
	const skillsText = takeSuffix("skills", skillsExact, skillsExpected);
	const filesText = takeSuffix("contextFiles", contextFilesSection(files), files.length > 0);
	const appendExact = promptOptions.appendSystemPrompt ? `\n\n${promptOptions.appendSystemPrompt}` : "";
	const appendText = takeSuffix("append", appendExact, Boolean(promptOptions.appendSystemPrompt));
	base += cwdText;
	const skillsHeader = skillsText.length > 0 ? skillsHeaderChars(skills, formatSkills) : 0;

	const active = new Set(input.activeTools);
	const activeTools = input.tools.filter((tool) => active.has(tool.name));
	const { builtin, extension } = splitToolSegments(activeTools);

	const systemLabel = promptOptions.customPrompt ? "Custom system prompt" : "System prompt";
	const promptTexts = [base, appendText, filesText, skillsText];
	const promptTokenParts = allocateCells(
		promptTexts.map((text) => text.length),
		tokensOf(systemPrompt),
	);

	const segments: Segment[] = [
		{ id: "system", label: systemLabel, tokens: promptTokenParts[0]!, items: [] },
		{ id: "append", label: "Appended prompt", tokens: promptTokenParts[1]!, items: [] },
		{
			id: "contextFiles",
			label: "Context files",
			tokens: promptTokenParts[2]!,
			note: filesText.length === 0 ? undefined : files.length === 1 ? "1 file" : `${files.length} files`,
			items:
				filesText.length === 0
					? []
					: files.map((file) => ({
							label: file.path,
							tokens: tokensOf(contextFileBlock(file)),
							scope: scopeOfPath(file.path, input.cwd),
						})),
		},
		{
			id: "skills",
			label: "Skills",
			tokens: promptTokenParts[3]!,
			note: skillsText.length === 0 ? undefined : skills.length === 1 ? "1 skill" : `${skills.length} skills`,
			items:
				skillsText.length === 0
					? []
					: skills
							.map((skill) => ({
								label: skill.name,
								tokens:
									skillsHeader > 0
										? skillItemTokens(skill, formatSkills)
										: tokensOf(" ".repeat(Math.max(0, formatSkills([skill]).length))),
								scope: scopeOf(skill.sourceInfo),
							}))
							.sort((a, b) => b.tokens - a.tokens),
		},
		builtin,
		extension,
	];

	segments.push({ id: "messages", label: "Messages", tokens: input.messageTokens, items: [] });

	const estimatedUsed = segments.reduce((sum, segment) => sum + segment.tokens, 0);
	const measurement = input.reportedTokens === null ? "estimated" : "provider-anchored";
	const used = input.reportedTokens ?? estimatedUsed;

	if (measurement === "provider-anchored") {
		const fitted = allocateCells(
			segments.map((segment) => segment.tokens),
			used,
		);
		segments.forEach((segment, index) => {
			segment.tokens = fitted[index]!;
		});
	}

	for (const segment of segments) {
		if (segment.items.length === 0) continue;
		const fitted = allocateCells(
			segment.items.map((item) => item.tokens),
			segment.tokens,
		);
		segment.items.forEach((item, index) => {
			item.tokens = fitted[index]!;
		});
	}

	const { compaction } = input;
	const reserved = compaction.enabled
		? Math.max(0, Math.min(compaction.reserveTokens, input.contextWindow - used))
		: 0;
	const free = Math.max(0, input.contextWindow - used - reserved);
	segments.push({ id: "free", label: "Free space", tokens: free, items: [] });
	if (reserved > 0) {
		segments.push({ id: "reserved", label: "Autocompact reserve", tokens: reserved, items: [] });
	}

	return {
		contextWindow: input.contextWindow,
		used,
		free,
		measurement,
		willCompact: measurement === "provider-anchored"
			? shouldCompact(used, input.contextWindow, compaction)
			: null,
		unattributed,
		segments: segments.filter(
			(segment) => segment.tokens > 0 || segment.id === "messages" || segment.id === "free",
		),
	};
}

function allocateCells(tokens: readonly number[], cells: number): number[] {
	const counts = tokens.map(() => 0);
	const total = tokens.reduce((sum, value) => sum + value, 0);
	if (total <= 0 || cells <= 0) return counts;

	const exact = tokens.map((value) => (value / total) * cells);
	exact.forEach((value, index) => {
		counts[index] = Math.floor(value);
	});

	let spare = cells - counts.reduce((sum, value) => sum + value, 0);
	const byRemainder = exact
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((a, b) => b.remainder - a.remainder);
	for (const { index } of byRemainder) {
		if (spare <= 0) break;
		counts[index]! += 1;
		spare -= 1;
	}
	return counts;
}


const GRID_COLUMNS = 10;
const GRID_ROWS = 10;
const CELLS = GRID_COLUMNS * GRID_ROWS;
const GUTTER = "   ";
const INDENT = "  ";

const CELL_SEPARATOR = " ";
const HEAVY_GLYPH = "⛁";
const LIGHT_GLYPH = "⛀";
const EMPTY_GLYPH = "⛶";

const LIGHT_SHARE = 0.1;

const TREE_BRANCH = "├";
const TREE_END = "└";

function glyphFor(segment: Pick<Segment, "id" | "tokens">, used: number): string {
	if (segment.id === "free") return EMPTY_GLYPH;
	if (segment.id === "reserved") return LIGHT_GLYPH;
	if (used <= 0 || segment.tokens <= 0) return LIGHT_GLYPH;
	return segment.tokens / used < LIGHT_SHARE ? LIGHT_GLYPH : HEAVY_GLYPH;
}

type Paint = (text: string) => string;

const RESET = "\x1b[0m";

function hexColor(hex: string): Paint {
	const red = Number.parseInt(hex.slice(1, 3), 16);
	const green = Number.parseInt(hex.slice(3, 5), 16);
	const blue = Number.parseInt(hex.slice(5, 7), 16);
	const ansi = `\x1b[38;2;${red};${green};${blue}m`;
	return (text) => `${ansi}${text}${RESET}`;
}

const SEGMENT_PAINT: Record<SegmentId, Paint> = {
	system: hexColor("#22d3ee"),
	append: hexColor("#ff79c6"),
	contextFiles: hexColor("#ffb86c"),
	skills: hexColor("#c792ea"),
	builtinTools: hexColor("#82aaff"),
	extensionTools: hexColor("#ff5370"),
	messages: hexColor("#22da6e"),
	reserved: hexColor("#6272a4"),
	free: hexColor("#4b5263"),
};

function paintSegment(id: SegmentId, text: string): string {
	return SEGMENT_PAINT[id](text);
}

function percentOf(tokens: number, window: number): string {
	if (window <= 0) return "—";
	const percent = (tokens / window) * 100;
	if (percent > 0 && percent < 0.1) return "<0.1%";
	return `${percent.toFixed(1)}%`;
}

function measurementOf(breakdown: ContextBreakdown): "provider-anchored" | "estimated" {
	return breakdown.measurement ?? (breakdown.measured === false ? "estimated" : "provider-anchored");
}

function padEndVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartVisible(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function gridCells(breakdown: ContextBreakdown): SegmentId[] {
	const segments = breakdown.segments;
	const counts = allocateCells(
		segments.map((segment) => segment.tokens),
		CELLS,
	);

	const freeIndex = segments.findIndex((segment) => segment.id === "free");
	const reservedIndex = segments.findIndex((segment) => segment.id === "reserved");
	const donors = [freeIndex, reservedIndex].filter((index) => index >= 0);

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		if (segment.id === "free" || segment.id === "reserved") continue;
		if (segment.tokens <= 0 || counts[index]! > 0) continue;

		const donor = donors.find((d) => counts[d]! > 0);
		if (donor === undefined) break;
		counts[donor]! -= 1;
		counts[index]! += 1;
	}

	const cells: SegmentId[] = [];
	segments.forEach((segment, index) => {
		for (let i = 0; i < counts[index]!; i++) cells.push(segment.id);
	});
	while (cells.length < CELLS) cells.push("free");
	return cells.slice(0, CELLS);
}

function legendRow(segment: Segment, breakdown: ContextBreakdown, theme: Theme, labelWidth: number): string {
	const swatch = paintSegment(segment.id, glyphFor(segment, breakdown.used));
	const label = theme.fg("text", padEndVisible(`${segment.label}:`, labelWidth));
	const tokens = theme.fg("text", padStartVisible(`${formatTokensCompact(segment.tokens)} tokens`, 14));
	const percent = theme.fg("muted", padStartVisible(`(${percentOf(segment.tokens, breakdown.contextWindow)})`, 9));
	const note = segment.note ? theme.fg("dim", `  ${segment.note}`) : "";
	return `${swatch} ${label}${tokens}${percent}${note}`;
}

type RenderOptions = {
	model: string;
};

function renderContext(breakdown: ContextBreakdown, theme: Theme, options: RenderOptions): string[] {
	const lines: string[] = [];
	const measurement = measurementOf(breakdown);
	const approximate = measurement === "estimated" ? "~" : "";
	const used = `${approximate}${formatTokensCompact(breakdown.used)}/${formatTokensCompact(breakdown.contextWindow)} tokens`;
	lines.push(
		`${theme.fg("accent", theme.bold("Context"))} ${theme.fg("dim", "·")} ${theme.fg("text", options.model)} ${theme.fg("dim", "·")} ${theme.fg("text", used)} ${theme.fg("muted", `(${percentOf(breakdown.used, breakdown.contextWindow)})`)}`,
		theme.fg(
			"dim",
			measurement === "provider-anchored"
				? "Provider-anchored total; section split estimated"
				: "Estimated with pi's token estimator; no current provider total",
		),
	);
	if (breakdown.unattributed.length > 0) {
		lines.push(
			theme.fg(
				"warning",
				`Could not safely isolate: ${[...new Set(breakdown.unattributed)].join(", ")}; counted in system prompt`,
			),
		);
	}
	lines.push("");

	const cells = gridCells(breakdown);
	const byId = new Map(breakdown.segments.map((segment) => [segment.id, segment]));
	const labelWidth = Math.max(...breakdown.segments.map((segment) => visibleWidth(segment.label))) + 2;
	for (let row = 0; row < GRID_ROWS; row++) {
		const painted = cells
			.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS)
			.map((id) => {
				const segment = byId.get(id) ?? { id, tokens: 0 };
				return paintSegment(id, glyphFor(segment, breakdown.used));
			})
			.join(CELL_SEPARATOR);
		const segment = breakdown.segments[row];
		lines.push(segment ? `${INDENT}${painted}${GUTTER}${legendRow(segment, breakdown, theme, labelWidth)}` : `${INDENT}${painted}`);
	}
	const overflowIndent = `${INDENT}${" ".repeat(GRID_COLUMNS * (1 + CELL_SEPARATOR.length) - CELL_SEPARATOR.length)}${GUTTER}`;
	for (const segment of breakdown.segments.slice(GRID_ROWS)) {
		lines.push(`${overflowIndent}${legendRow(segment, breakdown, theme, labelWidth)}`);
	}

	const listed = breakdown.segments.filter((segment) => segment.items.length > 0);
	const itemWidth = Math.max(
		...listed.flatMap((segment) => segment.items.map((item) => visibleWidth(item.label) + 1)),
		0,
	);
	for (const segment of listed) {
		lines.push("", `${INDENT}${paintSegment(segment.id, `${segment.label}:`)}`);
		segment.items.forEach((item, index) => {
			const last = index === segment.items.length - 1;
			const branch = theme.fg("dim", `${last ? TREE_END : TREE_BRANCH} `);
			const label = theme.fg("text", padEndVisible(`${item.label}:`, itemWidth));
			const tokens = theme.fg("muted", padStartVisible(`${formatTokensCompact(item.tokens)} tokens`, 15));
			const scope = item.scope ? theme.fg("dim", `  ${item.scope}`) : "";
			lines.push(`${INDENT}  ${branch}${label}${tokens}${scope}`);
		});
	}

	return lines;
}


const ENTRY_TYPE = "context";

type ContextEntryData = {
	model: string;
	breakdown: ContextBreakdown;
};

function compactionSettings(ctx: ExtensionCommandContext): Required<CompactionSettings> {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
	} catch {
		return DEFAULT_COMPACTION_SETTINGS;
	}
}

function estimateMessageTokens(ctx: ExtensionCommandContext): number {
	return ctx.sessionManager
		.buildContextEntries()
		.flatMap((entry) => sessionEntryToContextMessages(entry))
		.filter((message) => message.role !== "bashExecution" || !message.excludeFromContext)
		.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function usageParts(ctx: ExtensionCommandContext): { reported: number | null; messages: number } {
	const usage = ctx.getContextUsage();
	const entries = ctx.sessionManager.buildContextEntries();
	const lastAssistantUsage = getLastAssistantUsage(entries);
	const messages = estimateMessageTokens(ctx);

	if (lastAssistantUsage && usage?.tokens != null) {
		const contextMessages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
		const usageIndex = contextMessages.findLastIndex(
			(message) => message.role === "assistant" && message.usage === lastAssistantUsage,
		);
		const excludedTrailing = usageIndex < 0
			? 0
			: contextMessages
					.slice(usageIndex + 1)
					.filter((message) => message.role === "bashExecution" && message.excludeFromContext)
					.reduce((sum, message) => sum + estimateTokens(message), 0);
		return { reported: Math.max(0, usage.tokens - excludedTrailing), messages };
	}
	return { reported: null, messages };
}

function modelLabel(ctx: ExtensionCommandContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
}

function snapshot(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextBreakdown | undefined {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const { reported, messages } = usageParts(ctx);
	const promptOptions = ctx.getSystemPromptOptions();

	return buildBreakdown({
		contextWindow,
		cwd: ctx.cwd,
		systemPrompt: ctx.getSystemPrompt(),
		promptOptions,
		formatSkills: formatSkillsForPrompt,
		tools: pi.getAllTools(),
		activeTools: promptOptions.selectedTools ?? pi.getActiveTools(),
		messageTokens: messages,
		reportedTokens: reported,
		compaction: compactionSettings(ctx),
	});
}

export default function context(pi: ExtensionAPI) {
	pi.registerEntryRenderer<ContextEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data?.breakdown) return undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				return renderContext(data.breakdown, theme, { model: data.model })
					.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
			},
		};
	});

	pi.registerCommand("context", {
		description: "Show what fills the context window: prompt, files, skills, tools, messages",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const breakdown = snapshot(pi, ctx);
			if (!breakdown) {
				if (ctx.hasUI) ctx.ui.notify("No model selected, so there is no context window to report on.", "warning");
				return;
			}

			pi.appendEntry<ContextEntryData>(ENTRY_TYPE, {
				model: modelLabel(ctx),
				breakdown,
			});
		},
	});
}
