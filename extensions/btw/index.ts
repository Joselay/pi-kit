import {
	buildSessionContext,
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Message, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import {
	Container,
	Input,
	Markdown,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import { errorText, messageText } from "../lib/util.ts";

const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

/** Terminal rows/cols left free around the overlay (all four sides). */
const BTW_OVERLAY_MARGIN = 1;
const BTW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BTW_SPINNER_INTERVAL_MS = 80;

/** Overlay size as a fraction of the terminal. Kept in sync with the frame drawn in render(). */
const BTW_OVERLAY_WIDTH_PCT = 62;
const BTW_OVERLAY_HEIGHT_PCT = 85;

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

type SessionThinkingLevel = "off" | AiThinkingLevel;

type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage["usage"];
};

type BtwResetDetails = {
	timestamp: number;
};

type OverlayRuntime = {
	handle?: OverlayHandle;
	refresh?: () => void;
	close?: () => void;
	finish?: () => void;
	setDraft?: (value: string) => void;
	closed?: boolean;
};

type SideSessionRuntime = {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
};

type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	args: string;
	status: "running" | "done" | "error";
};

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createBtwResourceLoader(ctx: ExtensionContext, appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT]): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => appendSystemPrompt,
		extendResources: () => {},
		reload: async () => {},
	};
}

function extractEventAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}

	const maybeMessage = message as { role?: unknown; content?: unknown };
	if (maybeMessage.role !== "assistant" || !Array.isArray(maybeMessage.content)) {
		return "";
	}

	return maybeMessage.content
		.filter((part): part is { type: "text"; text: string } => {
			if (!part || typeof part !== "object") {
				return false;
			}
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Reasoning text the model actually emitted, if the provider streams thinking parts. */
function extractEventThinkingText(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}

	const maybeMessage = message as { role?: unknown; content?: unknown };
	if (maybeMessage.role !== "assistant" || !Array.isArray(maybeMessage.content)) {
		return "";
	}

	return maybeMessage.content
		.filter((part): part is { type: "thinking"; thinking: string } => {
			if (!part || typeof part !== "object") {
				return false;
			}
			const candidate = part as { type?: unknown; thinking?: unknown };
			return candidate.type === "thinking" && typeof candidate.thinking === "string";
		})
		.map((part) => part.thinking)
		.join("\n")
		.trim();
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const message = session.state.messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}

	return null;
}

function buildSeedMessages(ctx: ExtensionContext, thread: BtwDetails[]): Message[] {
	const seed: Message[] = [];

	try {
		const contextMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
		seed.push(...(contextMessages.filter((message) => "role" in message) as Message[]));
	} catch {
		// Ignore context seed failures and continue with an empty side thread.
	}

	for (const item of thread) {
		seed.push(
			{
				role: "user",
				content: [{ type: "text", text: item.question }],
				timestamp: item.timestamp,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: item.answer }],
				provider: item.provider,
				model: item.model,
				api: ctx.model?.api ?? "openai-responses",
				usage:
					item.usage ??
					{
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				stopReason: "stop",
				timestamp: item.timestamp,
			},
		);
	}

	return seed;
}

function formatThread(thread: BtwDetails[]): string {
	return thread
		.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
		.join("\n\n---\n\n");
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}


class BtwOverlay extends Container implements Focusable {
	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: ExtensionContext["ui"]["theme"];
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (width: number, theme: ExtensionContext["ui"]["theme"]) => string[];
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		keybindings: KeybindingsManager,
		getTranscript: (width: number, theme: ExtensionContext["ui"]["theme"]) => string[],
		onSubmit: (value: string) => void,
		onDismiss: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.getTranscript = getTranscript;
		this.onSubmitCallback = onSubmit;
		this.onDismissCallback = onDismiss;

		this.input = new Input();
		this.input.onSubmit = (value) => {
			this.onSubmitCallback(value);
		};
		this.input.onEscape = () => {
			this.onDismissCallback();
		};
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDismissCallback();
			return;
		}

		this.input.handleInput(data);
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	/** One padded column inside each border, so text never touches the frame. */
	private static readonly PAD = 1;

	/** Wrap already-sized content in the border, padding it out to exactly contentWidth. */
	private frameLine(content: string, contentWidth: number): string {
		const truncated = truncateToWidth(content, contentWidth, "");
		const padding = Math.max(0, contentWidth - visibleWidth(truncated));
		const gutter = " ".repeat(BtwOverlay.PAD);
		const border = this.theme.fg("borderMuted", "│");
		return `${border}${gutter}${truncated}${" ".repeat(padding)}${gutter}${border}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom" | "middle"): string {
		const [left, right] = edge === "top" ? ["┌", "┐"] : edge === "bottom" ? ["└", "┘"] : ["├", "┤"];
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	override render(width: number): string[] {
		// The overlay already sized us (width/minWidth in overlayOptions) and centers this
		// component within that box, so fill the width we're handed rather than shrinking.
		// The compositor centers with floor(): when the leftover columns are odd the right
		// gap ends up one wider, so give up one column and shift the frame right by one to
		// make both sides exactly equal.
		const terminalCols = process.stdout.columns ?? width;
		const leftover = Math.max(0, terminalCols - BTW_OVERLAY_MARGIN * 2 - width);
		const shift = leftover % 2;
		const indent = " ".repeat(shift);
		const dialogWidth = Math.max(24, width - shift);
		const innerWidth = dialogWidth - 2;
		const contentWidth = Math.max(1, innerWidth - BtwOverlay.PAD * 2);

		const terminalRows = process.stdout.rows ?? 30;
		// Mirror the overlay's resolved maxHeight exactly (percentage of the terminal,
		// clamped by the vertical margins) so the frame fills its box and stays centered.
		const availRows = terminalRows - BTW_OVERLAY_MARGIN * 2;
		const wantedHeight = Math.max(8, Math.min(Math.floor((terminalRows * BTW_OVERLAY_HEIGHT_PCT) / 100), availRows));
		// Same floor()-rounding story vertically: match the leftover rows' parity so the
		// top and bottom gaps come out equal.
		const dialogHeight = (availRows - wantedHeight) % 2 === 1 ? wantedHeight - 1 : wantedHeight;
		// 4 header lines + separator + input + bottom border
		const chromeHeight = 7;
		const transcriptHeight = Math.max(3, dialogHeight - chromeHeight);

		// Markdown renders to contentWidth already — no manual wrapping needed
		const transcript = this.getTranscript(contentWidth, this.theme);
		const visibleTranscript = transcript.slice(-transcriptHeight);
		const transcriptPadding = Math.max(0, transcriptHeight - visibleTranscript.length);

		const previousFocused = this.input.focused;
		this.input.focused = false;
		// Input hardcodes a "> " prompt; swap it for a themed glyph of the same width.
		const rendered = this.input.render(contentWidth)[0] ?? "";
		const prompt = this.theme.fg("accent", "❯ ");
		const body = rendered.startsWith("> ") ? rendered.slice(2) : rendered;
		const placeholder = this.theme.fg("dim", "Ask on the side — stays out of the main chat");
		const inputLine = this.input.getValue()
			? prompt + body
			: `${prompt}\x1b[7m \x1b[27m${placeholder}`;
		this.input.focused = previousFocused;

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold("BTW side chat")), contentWidth),
			this.frameLine(this.theme.fg("muted", "Separate side conversation · Enter submit · Esc close"), contentWidth),
			this.borderLine(innerWidth, "middle"),
		];

		for (const line of visibleTranscript) {
			lines.push(this.frameLine(line, contentWidth));
		}
		for (let i = 0; i < transcriptPadding; i++) {
			lines.push(this.frameLine("", contentWidth));
		}

		lines.push(this.borderLine(innerWidth, "middle"));
		lines.push(this.frameLine(inputLine, contentWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));

		return shift ? lines.map((line) => indent + line) : lines;
	}
}

export default function (pi: ExtensionAPI) {
	let thread: BtwDetails[] = [];
	let pendingQuestion: string | null = null;
	let pendingAnswer = "";
	let pendingError: string | null = null;
	let pendingThinking = "";
	let pendingToolCalls: ToolCallInfo[] = [];
	let sideBusy = false;
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;

	const mdTheme = getMarkdownTheme();

	function spinner(): string {
		return BTW_SPINNER_FRAMES[spinnerFrame % BTW_SPINNER_FRAMES.length];
	}

	function startSpinner(): void {
		if (spinnerTimer) {
			return;
		}
		spinnerFrame = 0;
		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % BTW_SPINNER_FRAMES.length;
			syncOverlay();
		}, BTW_SPINNER_INTERVAL_MS);
		spinnerTimer.unref?.();
	}

	function stopSpinner(): void {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
	}

	function getModelKey(ctx: ExtensionContext): string {
		const model = ctx.model;
		// Include thinking level so changing it recreates the side session.
		return model ? `${model.provider}/${model.id}/${pi.getThinkingLevel()}` : "none";
	}

	function renderMarkdownLines(text: string, width: number): string[] {
		if (!text) return [];
		try {
			const md = new Markdown(text, 0, 0, mdTheme);
			return md.render(width);
		} catch {
			// Fall back to plain text wrapping if Markdown rendering fails
			return text.split("\n").flatMap((line) => {
				if (!line) return [""];
				const wrapped: string[] = [];
				for (let i = 0; i < line.length; i += width) {
					wrapped.push(line.slice(i, i + width));
				}
				return wrapped.length > 0 ? wrapped : [""];
			});
		}
	}

	function formatToolArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		switch (toolName) {
			case "bash":
				return typeof a.command === "string" ? truncateToWidth(a.command.split("\n")[0], 50, "…") : "";
			case "read":
			case "write":
			case "edit":
				return typeof a.path === "string" ? a.path : "";
			default: {
				const first = Object.values(a)[0];
				return typeof first === "string" ? truncateToWidth(first.split("\n")[0], 40, "…") : "";
			}
		}
	}

	function renderToolCallLines(toolCalls: ToolCallInfo[], theme: ExtensionContext["ui"]["theme"], width: number): string[] {
		const lines: string[] = [];
		for (const tc of toolCalls) {
			const icon = tc.status === "running" ? spinner() : tc.status === "error" ? "✗" : "✓";
			const color = tc.status === "error" ? "error" : tc.status === "done" ? "success" : "accent";
			const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", tc.toolName);
			const argsText = tc.args ? theme.fg("toolOutput", ` ${tc.args}`) : "";
			lines.push(truncateToWidth(`  ${label}${argsText}`, width, ""));
		}
		return lines;
	}

	function getTranscriptLines(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		try {
			return getTranscriptLinesInner(width, theme);
		} catch (error) {
			return [theme.fg("error", `Render error: ${errorText(error)}`)];
		}
	}

	function getTranscriptLinesInner(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		if (thread.length === 0 && !pendingQuestion && !pendingAnswer && !pendingError) {
			return [theme.fg("muted", "No BTW messages yet. Type a question below.")];
		}

		const lines: string[] = [];
		// No message cap — the overlay tail-slices to whatever fits its height.
		for (const item of thread) {
			// User message
			const userText = item.question.trim().split("\n")[0];
			lines.push(theme.fg("mdHeading", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
			lines.push("");

			// Assistant message rendered as markdown
			const mdLines = renderMarkdownLines(item.answer, width);
			lines.push(...mdLines);
			lines.push("");
		}

		if (pendingQuestion) {
			const userText = pendingQuestion.trim().split("\n")[0];
			lines.push(theme.fg("mdHeading", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));

			// Show tool calls inline
			if (pendingToolCalls.length > 0) {
				lines.push(...renderToolCallLines(pendingToolCalls, theme, width));
			}

			if (pendingError) {
				lines.push(theme.fg("error", `✗ ${pendingError}`));
			} else if (pendingAnswer) {
				lines.push("");
				const mdLines = renderMarkdownLines(pendingAnswer, width);
				lines.push(...mdLines);
			} else if (pendingToolCalls.length === 0) {
				// Sits on the exact line the answer will occupy (same leading blank line and
				// same column as the markdown body) so the text replaces it in place.
				lines.push("");
				// Only claim "Thinking" when the model actually streamed reasoning parts;
				// otherwise we're just waiting on the request.
				const reasoningTail = pendingThinking
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
					.pop();
				lines.push(theme.fg("accent", spinner()) + theme.fg("muted", reasoningTail ? " Thinking…" : " Waiting for model…"));
				if (reasoningTail) {
					lines.push(theme.fg("thinkingText", truncateToWidth(reasoningTail, width, "…")));
				}
			}
		}

		// Trim trailing empty line
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	}

	function syncOverlay(): void {
		overlayRuntime?.refresh?.();
	}

	function scheduleOverlayRefresh(): void {
		if (overlayRefreshTimer) {
			return;
		}

		overlayRefreshTimer = setTimeout(() => {
			overlayRefreshTimer = null;
			syncOverlay();
		}, 16);
	}

	function dismissOverlay(): void {
		overlayRuntime?.close?.();
		overlayRuntime = null;
		stopSpinner();
		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	function setOverlayDraft(value: string): void {
		overlayDraft = value;
		overlayRuntime?.setDraft?.(value);
	}

	async function disposeSideSession(): Promise<void> {
		const current = activeSideSession;
		activeSideSession = null;
		if (!current) {
			return;
		}

		try {
			current.unsubscribe();
		} catch {
			// Ignore unsubscribe errors during cleanup.
		}

		try {
			await current.session.abort();
		} catch {
			// Ignore abort errors during cleanup.
		}
		current.session.dispose();

		stopSpinner();
		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	async function resetThread(ctx: ExtensionContext | ExtensionCommandContext, persist = true): Promise<void> {
		thread = [];
		pendingQuestion = null;
		pendingAnswer = "";
		pendingError = null;
		pendingThinking = "";
		pendingToolCalls = [];
		sideBusy = false;
		setOverlayDraft("");
		await disposeSideSession();
		if (persist) {
			const details: BtwResetDetails = { timestamp: Date.now() };
			pi.appendEntry(BTW_RESET_TYPE, details);
		}
		syncOverlay();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		await disposeSideSession();
		thread = [];
		pendingQuestion = null;
		pendingAnswer = "";
		pendingError = null;
		pendingThinking = "";
		pendingToolCalls = [];
		sideBusy = false;
		overlayDraft = "";
		const branch = ctx.sessionManager.getBranch();
		let lastResetIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === BTW_RESET_TYPE) {
				lastResetIndex = i;
			}
		}

		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) {
				continue;
			}
			const details = entry.data as BtwDetails | undefined;
			if (!details?.question || !details.answer) {
				continue;
			}
			thread.push(details);
		}

		syncOverlay();
	}

	async function createSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
			tools: ["read", "bash", "edit", "write"],
			resourceLoader: createBtwResourceLoader(ctx),
		});

		const seedMessages = buildSeedMessages(ctx, thread);
		if (seedMessages.length > 0) {
			session.agent.state.messages = seedMessages as typeof session.agent.state.messages;
		}

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (!sideBusy || !pendingQuestion) {
				return;
			}

			switch (event.type) {
				case "message_start":
				case "message_update":
				case "message_end": {
					const streamed = extractEventAssistantText(event.message);
					if (streamed) {
						pendingAnswer = streamed;
						pendingError = null;
					}
					const reasoning = extractEventThinkingText(event.message);
					if (reasoning) {
						pendingThinking = reasoning;
					}
					scheduleOverlayRefresh();
					return;
				}
				case "tool_execution_start": {
					pendingToolCalls.push({
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: formatToolArgs(event.toolName, event.args),
						status: "running",
					});
					scheduleOverlayRefresh();
					return;
				}
				case "tool_execution_end": {
					const tc = pendingToolCalls.find((t) => t.toolCallId === event.toolCallId);
					if (tc) {
						tc.status = event.isError ? "error" : "done";
					}
					scheduleOverlayRefresh();
					return;
				}
				case "turn_end": {
					scheduleOverlayRefresh();
					return;
				}
				default:
					return;
			}
		});

		return {
			session,
			modelKey: getModelKey(ctx),
			unsubscribe,
		};
	}

	async function ensureSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const expectedModelKey = getModelKey(ctx);
		if (activeSideSession && activeSideSession.modelKey === expectedModelKey) {
			return activeSideSession;
		}

		await disposeSideSession();
		activeSideSession = await createSideSession(ctx);
		return activeSideSession;
	}

	async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			return;
		}

		if (overlayRuntime) {
			// Either the overlay is live (re-show it) or creation is still in
			// flight (onHandle pending) — never start a second one.
			overlayRuntime.handle?.setHidden(false);
			overlayRuntime.handle?.focus();
			overlayRuntime.refresh?.();
			return;
		}

		const runtime: OverlayRuntime = {};
		const closeRuntime = () => {
			if (runtime.closed) {
				return;
			}
			runtime.closed = true;
			runtime.handle?.hide();
			if (overlayRuntime === runtime) {
				overlayRuntime = null;
			}
			runtime.finish?.();
		};
		runtime.close = closeRuntime;
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new BtwOverlay(
						tui,
						theme,
						keybindings,
						(width, t) => getTranscriptLines(width, t),
						(value) => {
							void submitFromOverlay(ctx, value);
						},
						() => {
							void closeOverlayFlow(ctx);
						},
					);

					overlay.focused = true;
					overlay.setDraft(overlayDraft);
					runtime.setDraft = (value) => overlay.setDraft(value);
					runtime.refresh = () => {
						overlay.focused = runtime.handle?.isFocused() ?? false;
						tui.requestRender();
					};
					runtime.close = () => {
						overlayDraft = overlay.getDraft();
						closeRuntime();
					};

					if (runtime.closed) {
						done();
					}

					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: `${BTW_OVERLAY_WIDTH_PCT}%`,
						minWidth: 56,
						maxHeight: `${BTW_OVERLAY_HEIGHT_PCT}%`,
						anchor: "center",
						margin: BTW_OVERLAY_MARGIN,
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) {
							closeRuntime();
						}
					},
				},
			)
			.catch((error) => {
				if (overlayRuntime === runtime) {
					overlayRuntime = null;
				}
				notify(ctx, errorText(error), "error");
			});
	}

	async function summarizeThread(ctx: ExtensionContext, items: BtwDetails[]): Promise<string> {
		const model = ctx.model;
		if (!model) {
			throw new Error("No active model selected.");
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model,
			thinkingLevel: "off",
			tools: [],
			resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT]),
		});

		try {
			await session.prompt(formatThread(items), { source: "extension" });
			const response = getLastAssistantMessage(session);
			if (!response) {
				throw new Error("Summary finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("Summary request was aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Summary request failed.");
			}

			return messageText(response).trim() || "(No summary generated)";
		} finally {
			try {
				await session.abort();
			} catch {
				// Ignore abort errors during temporary session teardown.
			}
			session.dispose();
		}
	}

	async function injectSummaryIntoMain(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (thread.length === 0) {
			notify(ctx, "No BTW thread to summarize.", "warning");
			return;
		}

		try {
			const summary = await summarizeThread(ctx, thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}

			await resetThread(ctx);
			notify(ctx, "Injected BTW summary into main chat.", "info");
		} catch (error) {
			notify(ctx, errorText(error), "error");
		}
	}

	async function closeOverlayFlow(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI) {
			return;
		}

		if (thread.length === 0) {
			return;
		}

		const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
		if (choice === "Inject summary into main chat") {
			await injectSummaryIntoMain(ctx);
		}
	}

	async function runBtwPrompt(ctx: ExtensionCommandContext, question: string): Promise<void> {
		if (sideBusy) {
			notify(ctx, "BTW is still processing the previous message.", "warning");
			return;
		}

		const model = ctx.model;
		if (!model) {
			notify(ctx, "No active model selected.", "error");
			return;
		}

		// Claim sideBusy before any awaits so a second submit can't slip past the check.
		sideBusy = true;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok === false) {
				const message = auth.error;
				notify(ctx, message, "error");
				return;
			}

			const side = await ensureSideSession(ctx);
			if (!side) {
				notify(ctx, "Unable to create BTW side session.", "error");
				return;
			}

			pendingQuestion = question;
			pendingAnswer = "";
			pendingError = null;
			pendingThinking = "";
			pendingToolCalls = [];
			// Started here, after ensureSideSession(): disposing a session stops the spinner.
			startSpinner();
			syncOverlay();

			await side.session.prompt(question, { source: "extension" });
			const response = getLastAssistantMessage(side.session);
			if (!response) {
				throw new Error("BTW request finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("BTW request aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "BTW request failed.");
			}

			const answer = messageText(response).trim() || "(No text response)";
			pendingAnswer = answer;
			const details: BtwDetails = {
				question,
				answer,
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
				usage: response.usage,
			};
			thread.push(details);
			pi.appendEntry(BTW_ENTRY_TYPE, details);

			pendingQuestion = null;
			pendingAnswer = "";
			pendingToolCalls = [];
		} catch (error) {
			const message = errorText(error);
			pendingError = message;
			notify(ctx, message, "error");
		} finally {
			sideBusy = false;
			stopSpinner();
			syncOverlay();
		}
	}

	async function submitFromOverlay(ctx: ExtensionContext | ExtensionCommandContext, rawValue: string): Promise<void> {
		const question = rawValue.trim();
		if (!question) {
			return;
		}

		if (!("waitForIdle" in ctx)) {
			notify(ctx, "BTW submit requires command context. Re-open with /btw.", "warning");
			return;
		}

		setOverlayDraft("");
		await runBtwPrompt(ctx, question);
	}

	pi.registerCommand("btw", {
		description: "Open a simple BTW side-chat popover. `/btw <text>` asks immediately, `/btw` opens the side thread.",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				if (thread.length > 0 && ctx.hasUI) {
					const choice = await ctx.ui.select("BTW side chat:", [
						"Continue previous conversation",
						"Start fresh",
					]);
					if (choice === "Continue previous conversation") {
						// Dispose session so it's recreated with fresh main context on next submit
						await disposeSideSession();
						await ensureOverlay(ctx);
					} else if (choice === "Start fresh") {
						await resetThread(ctx, true);
						await ensureOverlay(ctx);
					}
					// null = user cancelled (Esc), do nothing
				} else {
					// No reset entry needed when the thread is already empty.
					await resetThread(ctx, thread.length > 0);
					await ensureOverlay(ctx);
				}
				return;
			}

			await ensureOverlay(ctx);
			await runBtwPrompt(ctx, question);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_shutdown", async () => {
		await disposeSideSession();
		dismissOverlay();
	});
}
