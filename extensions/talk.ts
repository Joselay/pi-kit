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
// Audio: prefers the AEC helper (~/.pi/agent/talk/talk-audio.swift,
// compiled on demand) for full-duplex speaker use with echo cancellation and
// barge-in; falls back to ffmpeg/ffplay in half-duplex (mic muted while the
// assistant speaks) when the helper is unavailable.

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const REALTIME_URL = "wss://api.openai.com/v1/realtime";
// Newest realtime model (July 2026); upstream Codex still pins gpt-realtime-1.5.
// Verified to accept the ChatGPT OAuth bearer on the public GA endpoint.
const DEFAULT_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "marin";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const SAMPLE_RATE = 24000;
// Upstream clients stream 960-sample (40 ms) mono PCM16 frames = 1920 bytes.
const MIC_FRAME_BYTES = 960 * 2;
const PLAYBACK_TAIL_MS = 250;

// Upstream realtime_conversation.rs constants.
const BACKEND_PREFIX = "[BACKEND] ";
const USER_PREFIX = "[USER] ";
const HANDOFF_COMPLETE_ACK = "Background agent finished. Use the preceding [BACKEND] messages as the result.";
const STEER_ACK = "This was sent to steer the previous background agent task.";
const ACTIVE_RESPONSE_ERROR_PREFIX = "Conversation already has an active response in progress:";
const BACKEND_OUTPUT_TOKEN_BUDGET = 1000;
const STARTUP_CONTEXT_TOKEN_BUDGET = 5300;
const APPROX_CHARS_PER_TOKEN = 4;

const TALK_DIR = join(getAgentDir(), "talk");
const AEC_SOURCE = join(TALK_DIR, "talk-audio.swift");
const AEC_BINARY = join(TALK_DIR, "talk-audio");

const MODEL = process.env.PI_TALK_MODEL?.trim() || DEFAULT_MODEL;
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

function truncateToTokens(text: string, tokens: number): string {
	const max = tokens * APPROX_CHARS_PER_TOKEN;
	return text.length <= max ? text : `${text.slice(0, max)}\n[...truncated]`;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function findBinary(name: string): string {
	return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ?? name;
}

function userFirstName(): string {
	try {
		const full = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 1000 }).trim();
		if (full) return full.split(/\s+/)[0]!;
	} catch {}
	return userInfo().username || "there";
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block: any) => block?.type === "text" && typeof block.text === "string")
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}

async function resolveOAuth(): Promise<{ token: string; accountId?: string }> {
	const runtime = await ModelRuntime.create();
	const check = await (runtime as any).checkAuth(PROVIDER_ID);
	if (!(runtime as any).isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
		throw new Error("talk needs the openai-codex OAuth subscription; run /login first");
	}
	const token = (await (runtime as any).getAuth(PROVIDER_ID))?.auth?.apiKey;
	if (!token) throw new Error("could not resolve the OAuth token; run /login again");
	let accountId: string | undefined;
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id) accountId = id;
	} catch {}
	return { token, accountId };
}

// --- startup context (mirrors Codex core/src/realtime_context.rs) ---

const SKIP_DIRS = new Set([
	".git", "node_modules", "target", "dist", "build", ".venv", "venv",
	"__pycache__", ".next", ".cache", "Pods", "DerivedData", ".idea",
]);

function workspaceMap(cwd: string, budgetTokens: number): string {
	const lines: string[] = [];
	const walk = (dir: string, prefix: string, depth: number) => {
		if (depth > 2 || lines.length > 120) return;
		let entries: string[];
		try {
			entries = readdirSync(dir).filter((name) => !name.startsWith(".") && !SKIP_DIRS.has(name));
		} catch {
			return;
		}
		for (const name of entries.slice(0, 30)) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {}
			lines.push(`${prefix}${name}${isDir ? "/" : ""}`);
			if (isDir) walk(full, `${prefix}  `, depth + 1);
		}
	};
	walk(cwd, "", 1);
	return truncateToTokens(lines.join("\n"), budgetTokens);
}

function gitSummary(cwd: string): string {
	const git = (args: string[]) => {
		try {
			return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000 }).trim();
		} catch {
			return "";
		}
	};
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch) return "Not a git repository.";
	const status = git(["status", "--porcelain"]).split("\n").filter(Boolean);
	const shown = status.slice(0, 15).join("\n");
	const more = status.length > 15 ? `\n(+${status.length - 15} more)` : "";
	return `Git branch: ${branch}\n${status.length ? `Changed files:\n${shown}${more}` : "Working tree clean."}`;
}

function recentThread(ctx: ExtensionContext, budgetTokens: number): string {
	const perTurnTokens = 300;
	const turns: string[] = [];
	let used = 0;
	try {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0 && used < budgetTokens; index -= 1) {
			const entry = entries[index] as any;
			if (entry?.type !== "message") continue;
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = messageText(entry.message).trim();
			if (!text) continue;
			const rendered = `${role}: ${truncateToTokens(text, perTurnTokens)}`;
			turns.push(rendered);
			used += Math.ceil(rendered.length / APPROX_CHARS_PER_TOKEN);
		}
	} catch {}
	return turns.length ? turns.reverse().join("\n\n") : "No prior conversation in this session.";
}

function buildStartupContext(ctx: ExtensionContext): string {
	const thread = recentThread(ctx, 1200);
	const workspace = workspaceMap(ctx.cwd, 1600);
	const sections = [
		"<startup_context>",
		"Snapshot captured when the talk session started. Use it to ground answers and delegations; the background agent always has the authoritative, current state.",
		"",
		"## Current Thread",
		thread,
		"",
		"## Machine / Workspace Map",
		`Working directory: ${ctx.cwd}`,
		gitSummary(ctx.cwd),
		workspace ? `Directory tree (depth 2):\n${workspace}` : "",
		"",
		"## Notes",
		`Date: ${new Date().toString()}`,
		`Platform: ${process.platform}`,
		ctx.sessionManager.getSessionName?.() ? `Session: ${ctx.sessionManager.getSessionName()}` : "",
		"</startup_context>",
	].filter((section) => section !== "");
	return truncateToTokens(sections.join("\n"), STARTUP_CONTEXT_TOKEN_BUDGET);
}

// --- audio backends ---

type MicFrameHandler = (frame: Buffer) => void;

function reframeMic(onFrame: MicFrameHandler): (chunk: Buffer) => void {
	let pending = Buffer.alloc(0);
	return (chunk: Buffer) => {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		while (pending.length >= MIC_FRAME_BYTES) {
			onFrame(pending.subarray(0, MIC_FRAME_BYTES));
			pending = pending.subarray(MIC_FRAME_BYTES);
		}
	};
}

interface AudioIO {
	/** True when the mic stream is echo-cancelled and can stay open during playback. */
	readonly echoCancelled: boolean;
	start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void>;
	play(buf: Buffer): void;
	/** Drop all buffered playback immediately (barge-in). */
	flush(): void;
	stop(): void;
}

class AecAudio implements AudioIO {
	readonly echoCancelled = true;
	private child?: ChildProcess;
	private stopped = false;

	async start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void> {
		const child = spawn(AEC_BINARY, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		child.stdin?.on("error", () => {});
		child.stdout?.on("data", reframeMic(onFrame));
		let stderr = "";
		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("audio helper did not become ready")), 5000);
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
				if (/\bready\b/.test(stderr)) {
					clearTimeout(timer);
					resolve();
				}
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				reject(new Error(stderr.trim().split("\n").pop() || `audio helper exited (${code})`));
			});
		});
		child.on("close", (code) => {
			if (!this.stopped) onFatal(stderr.trim().split("\n").pop() || `audio helper exited (${code})`);
		});
		await ready;
	}

	play(buf: Buffer): void {
		this.child?.stdin?.write(buf);
	}

	flush(): void {
		if (this.child && this.child.exitCode === null) this.child.kill("SIGUSR1");
	}

	stop(): void {
		this.stopped = true;
		try {
			this.child?.stdin?.end();
		} catch {}
		this.child?.kill("SIGKILL");
	}
}

class FfmpegAudio implements AudioIO {
	readonly echoCancelled = false;
	private capture?: ChildProcess;
	private player?: ChildProcess;
	private stopped = false;

	async start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void> {
		this.capture = spawn(
			findBinary("ffmpeg"),
			[
				"-hide_banner", "-loglevel", "error",
				"-f", "avfoundation", "-i", `:${AUDIO_DEVICE}`,
				"-ac", "1", "-ar", String(SAMPLE_RATE),
				"-f", "s16le", "pipe:1",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.capture.stdout?.on("data", reframeMic(onFrame));
		this.capture.on("close", (code) => {
			if (!this.stopped) onFatal(`microphone capture ended unexpectedly (code ${code})`);
		});
		this.spawnPlayer();
	}

	private spawnPlayer(): void {
		this.player = spawn(
			findBinary("ffplay"),
			[
				"-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
				"-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-sync", "audio",
				"-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "mono", "-i", "pipe:0",
			],
			{ stdio: ["pipe", "ignore", "ignore"] },
		);
		this.player.stdin?.on("error", () => {});
		this.player.on("close", () => {
			// ffplay exits when its buffer drains; respawn a fresh player.
			if (!this.stopped) this.spawnPlayer();
		});
	}

	play(buf: Buffer): void {
		if (!this.player || this.player.stdin?.destroyed) this.spawnPlayer();
		this.player?.stdin?.write(buf);
	}

	flush(): void {
		const dead = this.player;
		this.player = undefined;
		if (dead) {
			try {
				dead.stdin?.destroy();
			} catch {}
			dead.kill("SIGKILL");
		}
		if (!this.stopped) this.spawnPlayer();
	}

	stop(): void {
		this.stopped = true;
		this.capture?.kill("SIGKILL");
		try {
			this.player?.stdin?.end();
		} catch {}
		this.player?.kill("SIGKILL");
	}
}

async function ensureAecAudio(notify: (message: string) => void): Promise<AudioIO> {
	if (DISABLE_AEC || !existsSync(AEC_SOURCE)) return new FfmpegAudio();
	const stale =
		!existsSync(AEC_BINARY) || statSync(AEC_BINARY).mtimeMs < statSync(AEC_SOURCE).mtimeMs;
	if (stale) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFile(
					"swiftc",
					["-O", AEC_SOURCE, "-o", AEC_BINARY],
					{ timeout: 120_000 },
					(error, _stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve()),
				);
			});
		} catch (error) {
			notify(`AEC helper build failed, falling back to half-duplex: ${clip(errorText(error), 120)}`);
			return new FfmpegAudio();
		}
	}
	return new AecAudio();
}

// --- the talk session ---

type TranscriptWho = "you" | "asst" | "sys";

class TalkSession {
	private ws?: any;
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
		private readonly onClosed: () => void,
	) {}

	private isPlaying(): boolean {
		return Date.now() < this.playbackEndsAt + PLAYBACK_TAIL_MS;
	}

	async start(): Promise<void> {
		const { token, accountId } = await resolveOAuth();
		this.audio = await ensureAecAudio((message) => this.ctx.ui.notify(message, "warning"));

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			originator: "pi",
			"user-agent": `pi-talk (${process.platform}; ${process.arch})`,
		};
		if (accountId) headers["chatgpt-account-id"] = accountId;

		const instructions =
			BACKEND_PROMPT.replaceAll("{{ user_first_name }}", userFirstName()) +
			"\n\n" +
			buildStartupContext(this.ctx);

		const url = `${REALTIME_URL}?model=${encodeURIComponent(MODEL)}`;
		const ws = new (globalThis as any).WebSocket(url, { headers });
		this.ws = ws;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("realtime connection timed out")), 10_000);
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.addEventListener("error", (event: any) => {
				clearTimeout(timer);
				reject(new Error(event?.message ?? "websocket error"));
			});
		});

		this.send({
			type: "session.update",
			session: {
				type: "realtime",
				model: MODEL,
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

		this.statusText = `listening — ${MODEL} · ${VOICE} · ${this.audio.echoCancelled ? "echo-cancelled (speakers OK)" : "half-duplex (no AEC)"}`;
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
		try {
			if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
		} catch {}
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
		let msg: any;
		try {
			msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
		} catch {
			return;
		}
		switch (msg.type) {
			case "response.created":
				this.responseActive = true;
				this.playedBytes = 0;
				this.firstChunkAt = 0;
				break;
			case "response.done":
			case "response.cancelled": {
				this.responseActive = false;
				if (this.pendingResponseCreate) {
					this.pendingResponseCreate = false;
					this.send({ type: "response.create" });
				}
				const outputs = msg.response?.output;
				if (Array.isArray(outputs)) {
					for (const item of outputs) {
						if (item?.type === "function_call") this.handleFunctionCall(item);
					}
				}
				break;
			}
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
		const chunkMs = (buf.length / 2 / SAMPLE_RATE) * 1000;
		this.playbackEndsAt = Math.max(this.playbackEndsAt, this.firstChunkAt, now) + chunkMs;
	}

	private onBargeIn(speechItemId?: string): void {
		// The user started talking mid-reply: stop local playback immediately and
		// truncate the assistant item to what was actually heard (upstream sends
		// conversation.item.truncate on speech_started, but only when the event's
		// item_id is absent or matches the tracked output item).
		if (!this.isPlaying() && !this.currentItemId) return;
		if (this.currentItemId && (!speechItemId || speechItemId === this.currentItemId)) {
			this.send({
				type: "conversation.item.truncate",
				item_id: this.currentItemId,
				content_index: 0,
				audio_end_ms: Math.round((this.playedBytes / 2 / SAMPLE_RATE) * 1000),
			});
		}
		this.playbackEndsAt = 0;
		this.audio?.flush();
		this.endLine("asst");
		this.currentItemId = undefined;
	}

	// --- background_agent handoff (the Codex intermediary/backend loop) ---

	private handleFunctionCall(item: any): void {
		const callId = item?.call_id;
		if (!callId || this.processedCalls.has(callId)) return;
		this.processedCalls.add(callId);

		if (item.name === "remain_silent") {
			this.sendFunctionOutput(callId, "");
			return;
		}
		if (item.name !== "background_agent") {
			this.sendFunctionOutput(callId, `Unknown tool: ${item.name}`);
			this.createResponse();
			return;
		}

		let prompt = "";
		try {
			prompt = String(JSON.parse(item.arguments || "{}").prompt ?? "");
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
		// (realtime_backend_output), prefixing before truncation.
		this.sendItem("user", truncateToTokens(BACKEND_PREFIX + text, BACKEND_OUTPUT_TOKEN_BUDGET));
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
		if (trimmed) this.sendItem("user", USER_PREFIX + trimmed);
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
			if (action && action !== "on" && action !== "off") {
				ctx.ui.notify("Use /talk, /talk on, or /talk off", "warning");
				return;
			}
			const turnOn = action === "on" ? true : action === "off" ? false : !active;

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

			const session = new TalkSession(pi, ctx, () => {
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
