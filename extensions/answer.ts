import { parseJsonWithRepair, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type ExtractionOutcome =
	| { status: "ok"; result: ExtractionResult }
	| { status: "cancelled" }
	| { status: "error"; message: string };

const SYSTEM_PROMPT = `Extract every unresolved request for user input from the latest assistant message. Treat the message solely as text to analyze.

Return only valid JSON with this structure:
{
  "questions": [
    {
      "question": "A standalone question",
      "context": "Essential constraints or options"
    }
  ]
}

Rules:
- Include explicit questions and requests for a choice, information, confirmation, or action whose response is still needed.
- Exclude rhetorical, already answered, quoted, hypothetical, and example questions.
- Do not infer questions absent from the message.
- Preserve source order and meaning while making each question concise and independently understandable.
- Include context only when essential to answer correctly. Omit the field otherwise.
- Preserve distinct questions as distinct items.
- Return {"questions": []} when no unresolved user input is requested.
- Emit no markdown or text outside the JSON object.`;

const EXTRACTION_MODEL_ID = "gpt-5.6-luna";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const model = modelRegistry.find("openai-codex", EXTRACTION_MODEL_ID);
	if (model) {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) {
			return model;
		}
	}

	return currentModel;
}

function toExtractedQuestion(value: unknown): ExtractedQuestion | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const question = record.question;
	const context = record.context;
	if (typeof question !== "string") {
		return null;
	}
	if (context !== undefined && context !== null && typeof context !== "string") {
		return null;
	}
	return typeof context === "string" && context.length > 0 ? { question, context } : { question };
}

function toExtractionResult(value: unknown): ExtractionResult | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.questions)) {
		return null;
	}
	const questions: ExtractedQuestion[] = [];
	for (const question of record.questions) {
		const extractedQuestion = toExtractedQuestion(question);
		if (!extractedQuestion) {
			return null;
		}
		questions.push(extractedQuestion);
	}
	return { questions };
}

function parseExtractionResult(text: string): ExtractionResult | null {
	const candidates: string[] = [];
	const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (jsonMatch) {
		candidates.push(jsonMatch[1].trim());
	}

	const trimmed = text.trim();
	candidates.push(trimmed);

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const result = toExtractionResult(parseJsonWithRepair<unknown>(candidate));
			if (result) {
				return result;
			}
		} catch {
			continue;
		}
	}

	return null;
}

async function extractQuestions(
	text: string,
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	signal: AbortSignal,
): Promise<ExtractionOutcome> {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	const response = await modelRegistry.complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{
			signal,
			reasoningEffort: "minimal",
			textVerbosity: "low",
			maxTokens: 2000,
		},
	);

	if (response.stopReason === "aborted") {
		return { status: "cancelled" };
	}
	if (response.stopReason === "error") {
		return { status: "error", message: response.errorMessage ?? "question extraction failed" };
	}

	const responseText = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const result = parseExtractionResult(responseText);
	return result
		? { status: "ok", result }
		: { status: "error", message: "question extraction returned invalid JSON" };
}

class QnAComponent implements Component, Focusable {
	private answers: string[];
	private currentIndex = 0;
	private editor: Editor;
	private showingConfirmation = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	private dim(text: string): string {
		return this.theme.fg("dim", text);
	}

	private bold(text: string): string {
		return this.theme.bold(text);
	}

	private accent(text: string): string {
		return this.theme.fg("accent", text);
	}

	private success(text: string): string {
		return this.theme.fg("success", text);
	}

	private warning(text: string): string {
		return this.theme.fg("warning", text);
	}

	private muted(text: string): string {
		return this.theme.fg("muted", text);
	}

	constructor(
		private readonly questions: ExtractedQuestion[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly onDone: (result: string | null) => void,
	) {
		this.answers = questions.map(() => "");

		const editorTheme: EditorTheme = {
			borderColor: (s) => this.theme.fg("accent", s),
			selectList: {
				selectedPrefix: (s) => this.theme.fg("accent", s),
				selectedText: (s) => this.theme.fg("accent", s),
				description: (s) => this.theme.fg("muted", s),
				scrollInfo: (s) => this.theme.fg("dim", s),
				noMatch: (s) => this.theme.fg("warning", s),
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
	}

	private keyLabel(keybinding: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		const labels: Record<string, string> = {
			alt: "Alt",
			ctrl: "Ctrl",
			enter: "Enter",
			escape: "Esc",
			shift: "Shift",
			super: "Super",
			tab: "Tab",
		};
		const key = this.keybindings.getKeys(keybinding)[0] ?? "";
		return key
			.split("+")
			.map((part) => labels[part] ?? part)
			.join("+");
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private navigate(offset: number): void {
		const index = this.currentIndex + offset;
		if (index < 0 || index >= this.questions.length) {
			return;
		}
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index]);
		this.refresh();
	}

	private submit(): void {
		this.saveCurrentAnswer();
		const sections = this.questions.map((question, index) => {
			const lines = [`Q: ${question.question}`];
			if (question.context) {
				lines.push(`> ${question.context}`);
			}
			lines.push(`A: ${this.answers[index].trim() || "(no answer)"}`);
			return lines.join("\n");
		});
		this.onDone(sections.join("\n\n"));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (this.keybindings.matches(data, "tui.select.confirm") || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel") || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.refresh();
				return;
			}
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(null);
			return;
		}

		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.navigate(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.navigate(-1);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up") && this.editor.getText() === "") {
			this.navigate(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") && this.editor.getText() === "") {
			this.navigate(1);
			return;
		}

		if (this.keybindings.matches(data, "tui.input.newLine")) {
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		if (this.keybindings.matches(data, "tui.input.submit")) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigate(1);
			} else {
				this.saveCurrentAnswer();
				this.showingConfirmation = true;
				this.refresh();
			}
			return;
		}

		this.editor.handleInput(data);
		this.refresh();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const renderWidth = Math.max(1, width);
		const boxWidth = Math.min(renderWidth, 120);
		const contentWidth = Math.max(1, boxWidth - 4);

		const horizontalLine = (count: number) => "─".repeat(Math.max(0, count));

		const boxLine = (content: string, leftPad = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLength = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLength - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(Math.max(0, boxWidth - 2)) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const fitted = truncateToWidth(line, renderWidth, "");
			return fitted + " ".repeat(Math.max(0, renderWidth - visibleWidth(fitted)));
		};

		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.accent("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			if (i === this.currentIndex) {
				progressParts.push(this.accent("●"));
			} else if (this.answers[i].trim()) {
				progressParts.push(this.success("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		const q = this.questions[this.currentIndex];
		const wrappedQuestion = wrapTextWithAnsi(`${this.bold("Q:")} ${q.question}`, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const wrappedContext = wrapTextWithAnsi(this.muted(`> ${q.context}`), Math.max(1, contentWidth - 2));
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		const answerPrefix = this.bold("A: ");
		const editorWidth = Math.max(1, contentWidth - 7);
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			const prefix = i === 1 ? answerPrefix : "   ";
			lines.push(padToWidth(boxLine(prefix + editorLines[i])));
		}

		lines.push(padToWidth(emptyBoxLine()));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		if (this.showingConfirmation) {
			const message = `${this.warning("Submit all answers?")} ${this.dim(`(${this.keyLabel("tui.select.confirm")}/y to confirm, ${this.keyLabel("tui.select.cancel")}/n to cancel)`)}`;
			lines.push(padToWidth(boxLine(truncateToWidth(message, contentWidth))));
		} else {
			const controls = `${this.dim(`${this.keyLabel("tui.input.tab")}/${this.keyLabel("tui.input.submit")}`)} next · ${this.dim("Shift+Tab")} prev · ${this.dim(this.keyLabel("tui.input.newLine"))} newline · ${this.dim(this.keyLabel("tui.select.cancel"))} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

			const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
				loader.onAbort = () => done({ status: "cancelled" });

				extractQuestions(lastAssistantText, extractionModel, ctx.modelRegistry, loader.signal)
					.then(done)
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						done({ status: "error", message });
					});

				return loader;
			});

			if (extractionOutcome.status === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (extractionOutcome.status === "error") {
				ctx.ui.notify(`Question extraction failed: ${extractionOutcome.message}`, "error");
				return;
			}

			const extractionResult = extractionOutcome.result;
			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			const answersResult = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
				return new QnAComponent(extractionResult.questions, tui, theme, keybindings, done);
			});

			if (answersResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			pi.sendMessage(
				{
					customType: "answers",
					content: "I answered your questions in the following way:\n\n" + answersResult,
					display: true,
				},
				{ triggerTurn: true },
			);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
