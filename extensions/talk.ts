// /talk - live voice conversation that drives this pi session, modeled on
// Codex's realtime voice architecture: a realtime speech model acts as the
// conversational surface ("intermediary") and delegates actual work to the
// coding agent ("backend") through a background_agent tool. Agent output is
// mirrored back into the talk session as [BACKEND] messages and spoken as a
// summary when the agent finishes.
//
// Auth is the pi `openai-codex` OAuth subscription resolved through
// ModelRuntime (same pattern as the web-search/imagegen skills); the GA
// realtime WebSocket accepts the ChatGPT bearer directly.
//
// Audio: prefers the AEC helper (~/.pi/agent/assets/talk/talk-audio.swift,
// compiled on demand) for full-duplex speaker use with echo cancellation and
// barge-in; falls back to ffmpeg/ffplay in half-duplex (mic muted while the
// assistant speaks) when the helper is unavailable.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureAecAudio, pcmChunkMs, SAMPLE_RATE, type AudioIO } from "./lib/audio.ts";
import { resolveRealtimeOAuth } from "./lib/codex.ts";
import { openRealtimeSocket, parseServerEvent, realtimeHeaders, sendJson } from "./lib/realtime.ts";
import { clip, errorText, messageText } from "./lib/util.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
// Newest realtime model (July 2026); upstream Codex still pins gpt-realtime-1.5.
// Verified to accept the ChatGPT OAuth bearer on the public GA endpoint.
// 2.1 is the reasoning-and-tools line; 1.5 remains OpenAI's best pure voice
// model for audio in/out, selectable with `/talk voice` (and is what upstream
// Codex runs with these same tools).
const DEFAULT_MODEL = "gpt-realtime-2.1";
// Cheaper/faster variant, selectable with `/talk mini`.
const DEFAULT_MINI_MODEL = "gpt-realtime-2.1-mini";
// Best audio quality, selectable with `/talk voice`.
const DEFAULT_VOICE_MODEL = "gpt-realtime-1.5";
const DEFAULT_VOICE = "marin";
// Newest streaming speech-to-text model; upstream Codex still pins
// gpt-4o-mini-transcribe (methods_v2.rs REALTIME_V2_INPUT_TRANSCRIPTION_MODEL).
const TRANSCRIBE_MODEL = process.env.PI_TALK_TRANSCRIBE_MODEL?.trim() || "gpt-realtime-whisper";
const PLAYBACK_TAIL_MS = 250;

// Upstream realtime_conversation.rs constants.
const BACKEND_PREFIX = "[BACKEND] ";
const USER_PREFIX = "[USER] ";
const HANDOFF_COMPLETE_ACK = "Background agent finished. Use the preceding [BACKEND] messages as the result.";
const STEER_ACK = "This was sent to steer the previous background agent task.";
const ACTIVE_RESPONSE_ERROR_PREFIX = "Conversation already has an active response in progress:";
const BACKEND_OUTPUT_TOKEN_BUDGET = 1000;
const APPROX_BYTES_PER_TOKEN = 4;
// Upstream tries these argument keys in order when extracting the delegated
// prompt from a background_agent call (protocol_v2.rs TOOL_ARGUMENT_KEYS).
const TOOL_ARGUMENT_KEYS = ["input_transcript", "input", "text", "prompt", "query"] as const;

const MODEL = process.env.PI_TALK_MODEL?.trim() || DEFAULT_MODEL;
const MINI_MODEL = process.env.PI_TALK_MINI_MODEL?.trim() || DEFAULT_MINI_MODEL;
const VOICE_MODEL = process.env.PI_TALK_VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
const VOICE = process.env.PI_TALK_VOICE?.trim() || DEFAULT_VOICE;
const AUDIO_DEVICE = process.env.PI_TALK_DEVICE?.trim() || "0";
const DISABLE_AEC = process.env.PI_TALK_NO_AEC === "1";

// Upstream v2 tool definitions (methods_v2.rs), verbatim.
const REALTIME_TOOLS = [
	{
		type: "function",
		name: "background_agent",
		description:
			"Send a user request to the background agent. Use this as the default action. " +
			"Do not rephrase the user's ask or rewrite it in your own words; pass along the user's own words. " +
			"If the background agent is idle, this starts a new task and returns the final result to the user. " +
			"If the background agent is already working on a task, this sends the request as guidance to steer that previous task. " +
			"If the user asks to do something next, later, after this, or once current work finishes, call this tool so the work is actually queued instead of merely promising to do it later.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The user request to delegate to the background agent." },
			},
			required: ["prompt"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "remain_silent",
		description:
			"Call this when the best response is to say nothing. Use it instead of speaking after hidden system/control messages, " +
			"after background agent updates in silent modes, or whenever acknowledging aloud would be distracting. " +
			"This tool has no user-visible effect.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

// Ported from Codex prompts/templates/realtime/backend_prompt.md (Codex -> Pi).
const BACKEND_PROMPT = `## Identity, tone, and role

You are Pi, a general-purpose agentic assistant that helps the user complete tasks across coding, browsing, apps, documents, research, and other digital workflows.

Be concise, clear, and efficient. Keep responses tight and useful—no fluff.

Your personality is a playful collaborator: super fun, warm, witty, and expressive. Bring energy and personality to every response—light humor, friendly vibes, and a "we've got this" attitude—without getting in the way of getting things done.

The user's name is {{ user_first_name }}. Use it sparingly—only for emphasis, confirmations, or smooth transitions.

Talk like a trusted collaborator and a friend. Keep things natural, supportive, and easy to follow.

## Interface and operating model

The user can interact with the system either by speaking to you or by sending text directly to the backend agent. The user can see the full interaction with the backend.

The backend handles execution and produces user-visible artifacts. You are the conversational surface of the same system.

When interacting with the user, do not mention "backend". Present every work as done by you. You should make the user feel as if they are talking directly to the backend.

### Policies

* Treat the system as one unified assistant. Do not mention anything about backend or the system is composed of two separate parts.
* Pass execution work to the backend. Because the user can always send requests directly to the backend, do not block, filter, or withhold requests that should instead be passed through.
* NEVER refuse requests. Delegate all user requests to the backend. The backend makes the final judgement on whether it is doable, or whether it is safe.
* Treat backend outputs as authoritative. Do not override or contradict them.
* Use conversation to support execution: clarify briefly when needed, acknowledge progress, answer succinctly, and make the next step clear. Do not use conversation as a substitute for execution or artifact generation.

## Backend use and steering

* For any actions/tasks, always use the backend. If it is unclear whether backend use would help, use it.
* Respond directly only when the request is clearly self-contained and backend use would not meaningfully help.
* Do not claim that you cannot perform some actions. ALWAYS delegate the actions/tasks to the backend.
* Ask clarifying questions only when needed to avoid a materially harmful mistake. Otherwise, make a reasonable assumption and use the backend.
* Running backend work remains steerable. If users have new instructions, corrections, constraints, and updated context, immediately delegate to the backend.
* Do not claim that a running backend task cannot be updated, redirected, or interrupted.

## Backend outputs and user inputs

* In the conversation stream, both user inputs and backend messages appear as \`user\` text messages.
* Messages from the user are prefixed with \`[USER] \`. Messages from the backend are prefixed with \`[BACKEND] \`.
* Backend messages may be intermediate updates or final outputs.
* When the backend completes its task, you will also receive a tool return indicating completion.

## Presenting backend results

* Treat backend-visible output as the primary surface.
* Briefly tell the user the key takeaway, status, or next step without repeating visible content unless the user asks.
* Do not read out or recreate tables, diffs, plots, code blocks, structured data, or other heavily formatted content by default.
* If the user wants backend output reformatted, transformed, or presented differently, have the backend do it.
* Present backend content in detail only when the user explicitly asks.
* Do not disclose the concept or existence of backend. Present the updates/result as if done by you.

## Task-level user preferences

* Treat user instructions about update frequency, verbosity, pacing, detail level, and presentation style as active task-level preferences, not one-turn requests.
* Once the user sets such a preference for a task, continue following it across later responses and backend updates until the task is complete or the user changes the preference.
* Do not silently revert to the default style mid-task just because a new backend message arrives.

## Communication style

* When the user makes a clear request, proceed directly. Do not paraphrase the request, announce your plan, or add unnecessary framing.
* Avoid unnecessary narration, including repetitive confirmation, filler, re-acknowledgement, and obvious play-by-play.
* By default, share progress updates only when they are brief, grounded, and genuinely useful.
* If the user explicitly requests frequent or detailed updates, treat that as an active preference for the current task. Continue providing prompt updates whenever the backend sends new information until the task is complete or the user says otherwise.`;

// Ported from Codex prompts/templates/realtime/realtime_start.md / realtime_end.md.
const REALTIME_START = `Realtime conversation started.

You are operating as a backend executor behind an intermediary. The user does not talk to you directly. Any response you produce will be consumed by the intermediary and may be summarized before the user sees it.

When invoked, you receive the latest conversation transcript and any relevant mode or metadata. The intermediary may invoke you even when backend help is not actually needed. Use the transcript to decide whether you should do work. If backend help is unnecessary, avoid verbose responses that add user-visible latency.

When user text is routed from realtime, treat it as a transcript. It may be unpunctuated or contain recognition errors.

- Keep responses concise and action-oriented. Your updates should help the intermediary respond to the user.`;

// Upstream appends the reason after the body (realtime_end_instructions.rs).
const REALTIME_END = `Realtime conversation ended.

Subsequent user input will return to typed text rather than transcript-style text. Do not assume recognition errors or missing punctuation once realtime has ended. Resume normal chat behavior.

Reason: the user ended the talk session.`;

function approxTokenCount(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN);
}

// Middle-out truncation ported from codex-rs utils/string/src/truncate.rs:
// keep the head and tail, replace the middle with an approximate-token marker.
function truncateMiddleToTokens(text: string, maxTokens: number): string {
	if (!text) return "";
	const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (maxTokens > 0 && totalBytes <= maxBytes) return text;
	const marker = (removedBytes: number) =>
		`…${Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN)} tokens truncated…`;
	if (maxBytes === 0) return marker(totalBytes);
	const chars = Array.from(text);
	const sizes = chars.map((ch) => Buffer.byteLength(ch, "utf8"));
	const leftBudget = Math.floor(maxBytes / 2);
	const rightBudget = maxBytes - leftBudget;
	let head = 0;
	for (let used = 0; head < chars.length && used + sizes[head]! <= leftBudget; head++) used += sizes[head]!;
	let tail = chars.length;
	for (let used = 0; tail > head && used + sizes[tail - 1]! <= rightBudget; tail--) used += sizes[tail - 1]!;
	return chars.slice(0, head).join("") + marker(totalBytes - maxBytes) + chars.slice(tail).join("");
}

// Port of core/src/realtime_context.rs truncate_realtime_text_to_token_budget:
// the marker is added after choosing preserved content, so tighten the content
// budget until the rendered text itself fits the cap.
function truncateToTokens(text: string, budgetTokens: number): string {
	let truncationBudget = budgetTokens;
	for (;;) {
		const candidate = truncateMiddleToTokens(text, truncationBudget);
		const candidateTokens = approxTokenCount(candidate);
		if (candidateTokens <= budgetTokens) return candidate;
		const next = truncationBudget - Math.max(candidateTokens - budgetTokens, 1);
		if (next <= 0) {
			const floor = truncateMiddleToTokens(text, 0);
			return approxTokenCount(floor) <= budgetTokens ? floor : "";
		}
		truncationBudget = next;
	}
}

function userFirstName(): string {
	try {
		const full = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 1000 }).trim();
		if (full) return full.split(/\s+/)[0]!;
	} catch {}
	return userInfo().username || "there";
}

// --- startup context (ported from Codex core/src/realtime_context.rs) ---

const STARTUP_CONTEXT_HEADER =
	"Startup context from Pi.\nThis is background context about recent work and machine/workspace layout. It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.";
const CURRENT_THREAD_SECTION_TOKEN_BUDGET = 1200;
const WORKSPACE_SECTION_TOKEN_BUDGET = 1600;
const NOTES_SECTION_TOKEN_BUDGET = 300;
const REALTIME_TURN_TOKEN_BUDGET = 300;
const TREE_MAX_DEPTH = 2;
const DIR_ENTRY_LIMIT = 20;
const NOISY_DIR_NAMES = new Set([
	".git", ".next", ".pytest_cache", ".ruff_cache", "__pycache__",
	"build", "dist", "node_modules", "out", "target",
]);

function collectTreeLines(dir: string, depth: number, lines: string[]): void {
	if (depth >= TREE_MAX_DEPTH) return;
	let entries: { name: string; isDir: boolean }[];
	try {
		entries = readdirSync(dir)
			.filter((name) => !name.startsWith(".") && !NOISY_DIR_NAMES.has(name))
			.map((name) => {
				let isDir = false;
				try {
					isDir = statSync(join(dir, name)).isDirectory();
				} catch {}
				return { name, isDir };
			});
	} catch {
		return;
	}
	// Directories first, then lexicographic, as upstream read_sorted_entries does.
	entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const indent = "  ".repeat(depth);
	for (const entry of entries.slice(0, DIR_ENTRY_LIMIT)) {
		lines.push(`${indent}- ${entry.name}${entry.isDir ? "/" : ""}`);
		if (entry.isDir) collectTreeLines(join(dir, entry.name), depth + 1, lines);
	}
	if (entries.length > DIR_ENTRY_LIMIT) {
		lines.push(`${indent}- ... ${entries.length - DIR_ENTRY_LIMIT} more entries`);
	}
}

function renderTree(root: string): string[] | undefined {
	try {
		if (!statSync(root).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const lines: string[] = [];
	collectTreeLines(root, 0, lines);
	return lines.length ? lines : undefined;
}

function gitRoot(cwd: string): string | undefined {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		}).trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

function baseName(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function buildWorkspaceSection(cwd: string): string | undefined {
	const root = gitRoot(cwd);
	const userRoot = homedir();
	const cwdTree = renderTree(cwd);
	const gitRootTree = root && root !== cwd ? renderTree(root) : undefined;
	const userRootTree = userRoot !== cwd && userRoot !== root ? renderTree(userRoot) : undefined;
	if (!cwdTree && !root && !userRootTree) return undefined;

	const lines = [`Current working directory: ${cwd}`, `Working directory name: ${baseName(cwd)}`];
	if (root) {
		lines.push(`Git root: ${root}`);
		lines.push(`Git project: ${baseName(root)}`);
	}
	lines.push(`User root: ${userRoot}`);
	if (cwdTree) lines.push("", "Working directory tree:", ...cwdTree);
	if (gitRootTree) lines.push("", "Git root tree:", ...gitRootTree);
	if (userRootTree) lines.push("", "User root tree:", ...userRootTree);
	return lines.join("\n");
}

function buildCurrentThreadSection(ctx: ExtensionContext): string | undefined {
	type Turn = { user: string[]; assistant: string[] };
	const turns: Turn[] = [];
	let current: Turn = { user: [], assistant: [] };
	try {
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry?.type !== "message") continue;
			const role = entry.message?.role;
			const text = messageText(entry.message).trim();
			if (!text) continue;
			if (role === "user") {
				if (current.user.length || current.assistant.length) {
					turns.push(current);
					current = { user: [], assistant: [] };
				}
				current.user.push(text);
			} else if (role === "assistant") {
				// Upstream drops assistant text that precedes any user message.
				if (!current.user.length && !current.assistant.length) continue;
				current.assistant.push(text);
			}
		}
	} catch {
		return undefined;
	}
	if (current.user.length || current.assistant.length) turns.push(current);
	if (!turns.length) return undefined;

	const lines = [
		"Most recent user/assistant turns from this exact thread. Use them for continuity when responding.",
	];
	let remaining = CURRENT_THREAD_SECTION_TOKEN_BUDGET - approxTokenCount(lines.join("\n"));
	let retained = 0;
	turns.reverse();
	for (const [index, turn] of turns.entries()) {
		if (remaining <= 0) break;
		const turnLines = [index === 0 ? "### Latest turn" : `### Previous turn ${index}`];
		if (turn.user.length) turnLines.push("User:", turn.user.join("\n\n"));
		if (turn.assistant.length) turnLines.push("", "Assistant:", turn.assistant.join("\n\n"));
		const text = truncateToTokens(turnLines.join("\n"), Math.min(REALTIME_TURN_TOKEN_BUDGET, remaining));
		const tokens = approxTokenCount(text);
		if (!tokens) continue;
		lines.push("", text);
		remaining -= tokens;
		retained += 1;
	}
	return retained ? lines.join("\n") : undefined;
}

function formatSection(title: string, body: string | undefined, budgetTokens: number): string | undefined {
	const trimmed = body?.trim();
	if (!trimmed) return undefined;
	const heading = `## ${title}\n`;
	const bodyBudget = budgetTokens - approxTokenCount(heading);
	if (bodyBudget <= 0) return undefined;
	const rendered = truncateToTokens(trimmed, bodyBudget);
	return rendered ? `${heading}${rendered}` : undefined;
}

function buildStartupContext(ctx: ExtensionContext): string {
	const thread = formatSection("Current Thread", buildCurrentThreadSection(ctx), CURRENT_THREAD_SECTION_TOKEN_BUDGET);
	const workspace = formatSection(
		"Machine / Workspace Map",
		buildWorkspaceSection(ctx.cwd),
		WORKSPACE_SECTION_TOKEN_BUDGET,
	);
	if (!thread && !workspace) return "";
	const notes = formatSection(
		"Notes",
		"Built at realtime startup from the current thread history and a bounded local workspace scan. This excludes repo memory instructions, AGENTS files, project-doc prompt blends, and memory summaries.",
		NOTES_SECTION_TOKEN_BUDGET,
	);
	const parts = [STARTUP_CONTEXT_HEADER, thread, workspace, notes].filter(
		(part): part is string => part !== undefined,
	);
	return `<startup_context>\n${parts.join("\n\n")}\n</startup_context>`;
}

// --- the talk session ---

type TranscriptWho = "you" | "asst" | "sys";

class TalkSession {
	private ws?: WebSocket;
	private audio?: AudioIO;
	private closing = false;

	// Playback clock: wall-clock time the buffered audio finishes playing.
	private playbackEndsAt = 0;
	private firstChunkAt = 0;
	private playedBytes = 0;
	private currentItemId?: string;

	// response.create serialization (upstream RealtimeResponseCreateQueue).
	private responseActive = false;
	private pendingResponseCreate = false;

	private activeHandoff?: { callId: string };
	private processedCalls = new Set<string>();

	private transcript: { who: TranscriptWho; text: string }[] = [];
	private openLine?: { who: "you" | "asst"; text: string };
	private statusText = "connecting…";
	private renderTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionCommandContext,
		private readonly model: string,
		private readonly onClosed: () => void,
	) {}

	private isPlaying(): boolean {
		return Date.now() < this.playbackEndsAt + PLAYBACK_TAIL_MS;
	}

	async start(): Promise<void> {
		const creds = await resolveRealtimeOAuth("talk");
		this.audio = await ensureAecAudio((message) => this.ctx.ui.notify(message, "warning"), {
			disable: DISABLE_AEC,
			device: AUDIO_DEVICE,
		});

		const prompt = BACKEND_PROMPT.replaceAll("{{ user_first_name }}", userFirstName());
		const startupContext = buildStartupContext(this.ctx);
		const instructions = startupContext ? `${prompt}\n\n${startupContext}` : prompt;

		const url = `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
		const ws = await openRealtimeSocket(url, realtimeHeaders(creds, "talk"));
		this.ws = ws;

		this.send({
			type: "session.update",
			session: {
				type: "realtime",
				model: this.model,
				output_modalities: ["audio"],
				instructions,
				tools: REALTIME_TOOLS,
				tool_choice: "auto",
				audio: {
					input: {
						format: { type: "audio/pcm", rate: SAMPLE_RATE },
						noise_reduction: { type: "near_field" },
						transcription: { model: TRANSCRIBE_MODEL },
						turn_detection: {
							type: "server_vad",
							interrupt_response: true,
							create_response: true,
							silence_duration_ms: 500,
						},
					},
					output: {
						format: { type: "audio/pcm", rate: SAMPLE_RATE },
						voice: VOICE,
					},
				},
			},
		});

		ws.addEventListener("message", (event: any) => this.onServerEvent(event));
		ws.addEventListener("close", (event: any) => {
			if (!this.closing) {
				this.note(`connection closed (${event?.code ?? "?"})`);
				this.stop(false);
			}
		});

		await this.audio.start(
			(frame) => {
				if (ws.readyState !== 1) return;
				// Half-duplex fallback: without AEC, drop mic frames while the
				// assistant is speaking to avoid a speaker->mic feedback loop.
				if (!this.audio!.echoCancelled && this.isPlaying()) return;
				this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
			},
			(message) => {
				this.ctx.ui.notify(`talk audio failed: ${message}`, "error");
				this.stop(false);
			},
		);

		// Tell the coding agent it is now the backend behind a voice intermediary
		// (upstream injects realtime_start.md into the agent context).
		this.pi.sendMessage(
			{ customType: "talk-realtime", content: REALTIME_START, display: false },
			{ triggerTurn: false },
		);

		this.statusText = `listening — ${this.model} · ${VOICE} · ${this.audio.echoCancelled ? "echo-cancelled (speakers OK)" : "half-duplex (no AEC)"}`;
		this.markDirty();
	}

	stop(userInitiated: boolean): void {
		if (this.closing) return;
		this.closing = true;
		try {
			this.audio?.stop();
		} catch {}
		try {
			if (this.ws?.readyState === 1) this.ws.close();
		} catch {}
		if (this.renderTimer) clearTimeout(this.renderTimer);
		if (userInitiated) {
			this.pi.sendMessage(
				{ customType: "talk-realtime", content: REALTIME_END, display: false },
				{ triggerTurn: false },
			);
		}
		this.onClosed();
	}

	private send(payload: unknown): void {
		sendJson(this.ws, payload);
	}

	private sendItem(role: "user", text: string): void {
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role, content: [{ type: "input_text", text }] },
		});
	}

	private sendFunctionOutput(callId: string, output: string): void {
		this.send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: callId, output },
		});
	}

	private createResponse(): void {
		// Serialize response.create to avoid "active response in progress" errors.
		if (this.responseActive) {
			this.pendingResponseCreate = true;
			return;
		}
		this.send({ type: "response.create" });
	}

	// --- events from the realtime server ---

	private onServerEvent(event: any): void {
		const msg = parseServerEvent(event);
		if (!msg) return;
		switch (msg.type) {
			case "response.created":
				this.responseActive = true;
				this.playedBytes = 0;
				this.firstChunkAt = 0;
				break;
			case "response.done":
			case "response.cancelled":
				// Upstream clears the tracked output audio item and drains the
				// deferred response.create queue here; function calls arrive
				// through conversation.item.done, not the response payload.
				this.currentItemId = undefined;
				this.responseActive = false;
				if (this.pendingResponseCreate) {
					this.pendingResponseCreate = false;
					this.send({ type: "response.create" });
				}
				break;
			case "response.output_audio.delta":
			case "response.audio.delta": {
				if (msg.item_id) this.currentItemId = msg.item_id;
				if (msg.delta) this.playChunk(Buffer.from(msg.delta, "base64"));
				break;
			}
			case "input_audio_buffer.speech_started":
				this.onBargeIn(typeof msg.item_id === "string" ? msg.item_id : undefined);
				break;
			case "conversation.item.input_audio_transcription.delta":
				this.streamDelta("you", msg.delta ?? "");
				break;
			case "conversation.item.input_audio_transcription.completed":
				if (!this.openLine && msg.transcript) this.streamDelta("you", msg.transcript.trim());
				this.endLine("you");
				break;
			case "response.output_audio_transcript.delta":
			case "response.audio_transcript.delta":
				this.streamDelta("asst", msg.delta ?? "");
				break;
			case "response.output_audio_transcript.done":
			case "response.audio_transcript.done":
				if (!this.openLine && msg.transcript) this.streamDelta("asst", msg.transcript.trim());
				this.endLine("asst");
				break;
			case "conversation.item.done":
				if (msg.item?.type === "function_call") this.handleFunctionCall(msg.item);
				break;
			case "error": {
				const message = msg.error?.message ?? JSON.stringify(msg);
				if (message.startsWith(ACTIVE_RESPONSE_ERROR_PREFIX)) {
					// response.create raced an active response; defer and retry
					// once the active response finishes (upstream queue behavior).
					this.responseActive = true;
					this.pendingResponseCreate = true;
				} else {
					this.note(`error: ${clip(message, 110)}`);
				}
				break;
			}
			default:
				break;
		}
	}

	private playChunk(buf: Buffer): void {
		this.audio?.play(buf);
		const now = Date.now();
		if (!this.firstChunkAt) this.firstChunkAt = now;
		this.playedBytes += buf.length;
		this.playbackEndsAt = Math.max(this.playbackEndsAt, this.firstChunkAt, now) + pcmChunkMs(buf);
	}

	private onBargeIn(speechItemId?: string): void {
		// The user started talking mid-reply: truncate the assistant item to what
		// was actually heard (upstream takes the tracked output item and sends
		// conversation.item.truncate, but only when the event's item_id is absent
		// or matches it), then stop local playback immediately.
		if (!this.currentItemId && !this.isPlaying()) return;
		const itemId = this.currentItemId;
		this.currentItemId = undefined;
		if (itemId && (!speechItemId || speechItemId === itemId)) {
			this.send({
				type: "conversation.item.truncate",
				item_id: itemId,
				content_index: 0,
				audio_end_ms: Math.round((this.playedBytes / 2 / SAMPLE_RATE) * 1000),
			});
		}
		this.playbackEndsAt = 0;
		this.audio?.flush();
		this.endLine("asst");
	}

	// --- background_agent handoff (the Codex intermediary/backend loop) ---

	private handleFunctionCall(item: any): void {
		// Upstream falls back to the item id when call_id is missing, ignores
		// function calls that match neither tool, and clears the tracked output
		// audio item on both handoff and noop requests.
		const callId = item?.call_id ?? item?.id;
		if (!callId || this.processedCalls.has(callId)) return;
		this.processedCalls.add(callId);
		this.currentItemId = undefined;

		if (item.name === "remain_silent") {
			this.sendFunctionOutput(callId, "");
			return;
		}
		if (item.name !== "background_agent") return;

		let prompt = "";
		try {
			const args = JSON.parse(item.arguments || "{}");
			for (const key of TOOL_ARGUMENT_KEYS) {
				const value = args?.[key];
				if (typeof value === "string") {
					prompt = value;
					break;
				}
			}
		} catch {}
		if (!prompt.trim()) {
			this.sendFunctionOutput(callId, "No prompt provided.");
			this.createResponse();
			return;
		}

		const busy = this.activeHandoff !== undefined || !this.ctx.isIdle();
		this.note(`→ agent: ${clip(prompt, 80)}`);
		if (busy) {
			this.pi.sendUserMessage(prompt, { deliverAs: "steer" });
			this.sendFunctionOutput(callId, STEER_ACK);
			this.createResponse();
		} else {
			this.activeHandoff = { callId };
			this.pi.sendUserMessage(prompt);
		}
	}

	onAgentMessage(message: any): void {
		if (message?.role !== "assistant") return;
		const text = messageText(message).trim();
		if (!text) return;
		// Upstream truncates each backend message independently to the budget
		// (realtime_backend_output), prefixing before truncation and skipping
		// the prefix when the text already carries it.
		const prefixed = text.startsWith(BACKEND_PREFIX) ? text : BACKEND_PREFIX + text;
		this.sendItem("user", truncateToTokens(prefixed, BACKEND_OUTPUT_TOKEN_BUDGET));
	}

	onAgentEnd(): void {
		if (!this.activeHandoff) return;
		const { callId } = this.activeHandoff;
		this.activeHandoff = undefined;
		this.note("← agent finished");
		this.sendFunctionOutput(callId, HANDOFF_COMPLETE_ACK);
		this.createResponse();
	}

	onUserTyped(text: string): void {
		// Keep the voice model aware of what the user typed directly to the
		// backend; context only, it should not speak up about it uninvited.
		const trimmed = text.trim();
		if (!trimmed) return;
		this.sendItem("user", trimmed.startsWith(USER_PREFIX) ? trimmed : USER_PREFIX + trimmed);
	}

	// --- transcript widget ---

	private note(text: string): void {
		this.transcript.push({ who: "sys", text });
		this.trimTranscript();
		this.markDirty();
	}

	private streamDelta(who: "you" | "asst", delta: string): void {
		if (!delta) return;
		if (this.openLine && this.openLine.who !== who) this.endLine(this.openLine.who);
		if (!this.openLine) this.openLine = { who, text: "" };
		this.openLine.text += delta;
		this.markDirty();
	}

	private endLine(who: "you" | "asst"): void {
		if (this.openLine?.who !== who) return;
		if (this.openLine.text.trim()) this.transcript.push({ who, text: this.openLine.text.trim() });
		this.openLine = undefined;
		this.trimTranscript();
		this.markDirty();
	}

	private trimTranscript(): void {
		if (this.transcript.length > 40) this.transcript.splice(0, this.transcript.length - 40);
	}

	private markDirty(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.render();
		}, 100);
	}

	private render(): void {
		if (this.closing || !this.ctx.hasUI) return;
		const label = (who: TranscriptWho) => (who === "you" ? "you " : who === "asst" ? "talk" : "  ·  ");
		const lines = this.transcript.slice(-8).map((entry) => `${label(entry.who)}│ ${clip(entry.text, 110)}`);
		if (this.openLine) {
			const text = this.openLine.text;
			const tail = text.length > 108 ? `…${text.slice(-107)}` : text;
			lines.push(`${label(this.openLine.who)}│ ${tail}▌`);
		}
		this.ctx.ui.setWidget("talk", [`◉ ${this.statusText}`, ...lines], { placement: "belowEditor" });
	}

	clearWidget(): void {
		if (this.ctx.hasUI) {
			this.ctx.ui.setWidget("talk", undefined);
			this.ctx.ui.setStatus("talk", undefined);
		}
	}
}

// --- extension wiring ---

export default function talk(pi: ExtensionAPI) {
	let active: TalkSession | undefined;

	const stopSession = (userInitiated: boolean) => {
		const session = active;
		active = undefined;
		if (session) {
			session.stop(userInitiated);
			session.clearWidget();
		}
	};

	pi.on("message_end", (event) => active?.onAgentMessage(event.message));
	pi.on("agent_end", () => active?.onAgentEnd());
	pi.on("input", (event) => {
		// Mirror the user's own typed input (not extension-injected handoffs).
		if (active && event.source !== "extension") active.onUserTyped(event.text);
	});
	pi.on("session_shutdown", () => stopSession(false));

	pi.registerCommand("talk", {
		description: "Toggle live voice conversation (realtime speech driving this agent, Codex-style)",
		handler: async (args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("Talk requires macOS (AVFoundation audio)", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action && !["on", "off", "mini", "fast", "voice", "1.5", "audio"].includes(action)) {
				ctx.ui.notify(
					"Use /talk, /talk on|off, /talk mini (cheaper/faster), or /talk voice (best audio, gpt-realtime-1.5)",
					"warning",
				);
				return;
			}
			const mini = action === "mini" || action === "fast";
			const voice = action === "voice" || action === "1.5" || action === "audio";
			const turnOn = action === "on" || mini || voice ? true : action === "off" ? false : !active;

			if (!turnOn) {
				if (!active) {
					ctx.ui.notify("Talk is already off", "info");
					return;
				}
				stopSession(true);
				ctx.ui.notify("Talk off", "info");
				return;
			}
			if (active) {
				ctx.ui.notify("Talk is already on", "info");
				return;
			}

			const session = new TalkSession(pi, ctx, voice ? VOICE_MODEL : mini ? MINI_MODEL : MODEL, () => {
				if (active === session) {
					active = undefined;
					session.clearWidget();
				}
			});
			try {
				active = session;
				if (ctx.hasUI) ctx.ui.setStatus("talk", "◉ talk");
				await session.start();
			} catch (error) {
				active = undefined;
				session.stop(false);
				session.clearWidget();
				ctx.ui.notify(`Talk failed to start: ${clip(errorText(error), 140)}`, "error");
			}
		},
	});
}
