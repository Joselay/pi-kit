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
//
// The pieces live next door: prompts.ts (tool + prompt templates), context.ts
// (startup context and token budgeting), globe.ts (the animated visualizer),
// panel.ts (globe + transcript block above the editor).

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { ensureAecAudio, pcmChunkMs, SAMPLE_RATE, type AudioIO } from "../lib/audio.ts";
import { resolveRealtimeOAuth } from "../lib/codex.ts";
import { openRealtimeSocket, parseServerEvent, realtimeHeaders, sendJson } from "../lib/realtime.ts";
import { clip, errorText, messageText } from "../lib/util.ts";
import { buildStartupContext, truncateToTokens, userFirstName } from "./context.ts";
import type { TalkVisualState } from "./globe.ts";
import { TalkPanel, type TranscriptEntry, type TranscriptWho } from "./panel.ts";
import { BACKEND_PROMPT, REALTIME_END, REALTIME_START, REALTIME_TOOLS } from "./prompts.ts";

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
// Longest a response.create is allowed to stay outstanding before the gate that
// serializes them is forced back open. Generous: it only has to beat a response
// that will never arrive.
const RESPONSE_TIMEOUT_MS = 60_000;

// Upstream realtime_conversation.rs constants.
const BACKEND_PREFIX = "[BACKEND] ";
const USER_PREFIX = "[USER] ";
const HANDOFF_COMPLETE_ACK = "Background agent finished. Use the preceding [BACKEND] messages as the result.";
const STEER_ACK = "This was sent to steer the previous background agent task.";
const ACTIVE_RESPONSE_ERROR_PREFIX = "Conversation already has an active response in progress:";
const BACKEND_OUTPUT_TOKEN_BUDGET = 1000;
// Upstream tries these argument keys in order when extracting the delegated
// prompt from a background_agent call (protocol_v2.rs TOOL_ARGUMENT_KEYS).
const TOOL_ARGUMENT_KEYS = ["input_transcript", "input", "text", "prompt", "query"] as const;

const MODEL = process.env.PI_TALK_MODEL?.trim() || DEFAULT_MODEL;
const MINI_MODEL = process.env.PI_TALK_MINI_MODEL?.trim() || DEFAULT_MINI_MODEL;
const VOICE_MODEL = process.env.PI_TALK_VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
const VOICE = process.env.PI_TALK_VOICE?.trim() || DEFAULT_VOICE;
const AUDIO_DEVICE = process.env.PI_TALK_DEVICE?.trim() || "0";
const DISABLE_AEC = process.env.PI_TALK_NO_AEC === "1";
// Optional ISO-639-1 hint for the transcriber. Left unset it auto-detects,
// which on a breath or a bit of speaker echo can come back as a stray word in
// some other language; pinning it keeps those in the language you speak.
const LANGUAGE = process.env.PI_TALK_LANGUAGE?.trim();
// How loud speech has to be before the server opens a turn. Above the API's
// 0.5 default: at 0.5 room noise and residual echo open turns of their own,
// which the transcriber then has to write down as something. Upstream Codex
// sends no threshold at all, which `PI_TALK_VAD_THRESHOLD=off` restores.
const VAD_THRESHOLD_ENV = process.env.PI_TALK_VAD_THRESHOLD?.trim();
const VAD_THRESHOLD = VAD_THRESHOLD_ENV === "off" ? undefined : Number(VAD_THRESHOLD_ENV) || 0.6;

const MAX_TRANSCRIPT_ENTRIES = 40;
const MAX_OUT_LEVELS = 600;
// Ids of calls already handled and items already settled. Only the recent past
// can still be referred to, and a long session should not accumulate every id
// it ever saw.
const MAX_TRACKED_IDS = 256;

/** Records an id, evicting the oldest once the set is full (Sets keep order). */
function remember(ids: Set<string>, id: string): void {
	ids.add(id);
	if (ids.size > MAX_TRACKED_IDS) {
		const oldest = ids.values().next();
		if (!oldest.done) ids.delete(oldest.value);
	}
}

/** RMS loudness of a PCM16LE mono buffer, subsampled for cheapness; 0..1. */
function pcmRms(buf: Buffer): number {
	const samples = buf.length >> 1;
	if (!samples) return 0;
	const step = Math.max(1, Math.floor(samples / 128));
	let sum = 0;
	let count = 0;
	for (let i = 0; i < samples; i += step) {
		const v = buf.readInt16LE(i << 1) / 32768;
		sum += v * v;
		count++;
	}
	return Math.sqrt(sum / count);
}

/**
 * The prompt a background_agent call delegates. Upstream extract_input_transcript:
 * the first non-empty string under the known keys, otherwise the raw arguments.
 */
function handoffPrompt(item: any): string {
	try {
		const args = JSON.parse(item.arguments || "{}");
		for (const key of TOOL_ARGUMENT_KEYS) {
			const value = args?.[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	} catch {}
	return typeof item.arguments === "string" ? item.arguments : "";
}

// --- the talk session ---

class TalkSession {
	private ws?: WebSocket;
	private audio?: AudioIO;
	private closing = false;

	// Playback clock: wall-clock time the buffered audio finishes playing.
	private playbackEndsAt = 0;
	private firstChunkAt = 0;
	private playedBytes = 0;
	private currentItemId?: string;

	// Live loudness feeding the orb animation.
	private micLevel = 0;
	private outLevels: { start: number; end: number; rms: number }[] = [];

	// response.create serialization (upstream RealtimeResponseCreateQueue).
	private responseActive = false;
	private pendingResponseCreate = false;
	private responseTimer?: ReturnType<typeof setTimeout>;

	private activeHandoff?: { callId: string };
	private processedCalls = new Set<string>();
	// Items whose transcript is already in the transcript list. A `.done` event
	// carries the whole transcript, so anything that settles a line early — a
	// barge-in, or a server emitting both the GA and the legacy event name —
	// would otherwise have that line re-added in full underneath it.
	private settledItems = new Set<string>();

	private transcript: TranscriptEntry[] = [];
	private openLine?: { who: "you" | "asst"; text: string };
	private visualState: TalkVisualState = "connecting";
	private renderTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionCommandContext,
		private readonly model: string,
		private readonly onClosed: () => void,
	) {}

	mountUI(): void {
		// Only the TUI can take a live component; RPC falls back to the plain
		// transcript lines pushed by renderFallback().
		if (this.ctx.mode !== "tui") return;
		this.ctx.ui.setWidget(
			"talk-panel",
			(tui, theme) =>
				new TalkPanel(
					tui,
					theme,
					() => (this.isPlaying() ? "speaking" : this.visualState),
					() => this.audioLevel(),
					() => ({ entries: this.transcript, open: this.openTranscriptEntry() }),
				),
			{ placement: "aboveEditor" },
		);
	}

	private openTranscriptEntry(): TranscriptEntry | undefined {
		const open = this.openLine;
		const text = open?.text.trim();
		return open && text ? { who: open.who, text } : undefined;
	}

	private isPlaying(): boolean {
		return Date.now() < this.playbackEndsAt + PLAYBACK_TAIL_MS;
	}

	/** 0..1 level for the orb: the speaker chunk playing right now, else the mic. */
	private audioLevel(): number {
		const now = Date.now();
		while (this.outLevels.length && this.outLevels[0]!.end <= now) this.outLevels.shift();
		const chunk = this.outLevels[0];
		const rms = this.isPlaying() ? (chunk && chunk.start <= now + 40 ? chunk.rms : 0) : this.micLevel;
		return Math.min(1, Math.sqrt(Math.max(0, rms - 0.006)) * 2.6);
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
						transcription: { model: TRANSCRIBE_MODEL, ...(LANGUAGE ? { language: LANGUAGE } : {}) },
						turn_detection: {
							type: "server_vad",
							interrupt_response: true,
							create_response: true,
							silence_duration_ms: 500,
							...(VAD_THRESHOLD === undefined ? {} : { threshold: VAD_THRESHOLD }),
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
				this.micLevel = pcmRms(frame);
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

		// Session facts live in the status bar rather than under the globe: they
		// are fixed for the session, and the widget line is for what changes.
		// Echo cancellation is the normal case, so only call out its absence.
		if (this.ctx.hasUI) {
			const tag = `${this.model.replace(/^gpt-realtime-/, "")} · ${VOICE}`;
			this.ctx.ui.setStatus("talk", `◉ talk · ${tag}${this.audio.echoCancelled ? "" : " · half-duplex"}`);
		}
		this.visualState = "listening";
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
		if (this.responseTimer) clearTimeout(this.responseTimer);
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

	private sendUserItem(text: string): void {
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
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
		this.sendResponseCreate();
	}

	/**
	 * Actually put a response.create on the wire. Upstream's send_create_now marks
	 * the response active as soon as it is sent rather than waiting for
	 * response.created: two creates issued back to back — an agent finishing while
	 * a steer lands, say — are separated by a round trip, and without the optimistic
	 * flag the second one races through the open gate and the server rejects it.
	 */
	private sendResponseCreate(): void {
		this.responseActive = true;
		this.armResponseTimeout();
		this.send({ type: "response.create" });
	}

	/**
	 * Failsafe for the response gate. Everything that opens it is closed by a
	 * `response.done`, but a response that never lands — or an active-response
	 * error arriving after the response it referred to already finished — would
	 * otherwise leave the gate shut and the voice mute for the rest of the
	 * session. Reopening it late is a stray reply at worst.
	 */
	private armResponseTimeout(): void {
		if (this.responseTimer) clearTimeout(this.responseTimer);
		this.responseTimer = setTimeout(() => {
			this.responseTimer = undefined;
			if (!this.responseActive || this.closing) return;
			this.responseActive = false;
			if (this.pendingResponseCreate) {
				this.pendingResponseCreate = false;
				this.sendResponseCreate();
			}
		}, RESPONSE_TIMEOUT_MS);
		this.responseTimer.unref?.();
	}

	// --- events from the realtime server ---

	private onServerEvent(event: any): void {
		const msg = parseServerEvent(event);
		if (!msg) return;
		switch (msg.type) {
			case "response.created":
				this.responseActive = true;
				this.visualState = "thinking";
				this.playedBytes = 0;
				this.firstChunkAt = 0;
				break;
			case "response.done":
			case "response.cancelled":
				// Upstream clears the tracked output audio item and drains the
				// deferred response.create queue here; function calls arrive
				// through conversation.item.done, not the response payload.
				this.currentItemId = undefined;
				this.playedBytes = 0;
				this.responseActive = false;
				if (this.responseTimer) {
					clearTimeout(this.responseTimer);
					this.responseTimer = undefined;
				}
				this.visualState = this.activeHandoff ? "working" : "listening";
				if (this.pendingResponseCreate) {
					this.pendingResponseCreate = false;
					this.sendResponseCreate();
				}
				break;
			case "response.output_audio.delta":
			case "response.audio.delta": {
				// Per-item accounting (upstream update_output_audio_state): the
				// same item accumulates, a new item id replaces the state, so a
				// barge-in truncates at the played offset within that item only.
				if (msg.item_id && msg.item_id !== this.currentItemId) {
					this.currentItemId = msg.item_id;
					this.playedBytes = 0;
				}
				if (msg.delta) this.playChunk(Buffer.from(msg.delta, "base64"));
				break;
			}
			case "input_audio_buffer.speech_started":
				this.visualState = "hearing";
				this.onBargeIn();
				break;
			case "conversation.item.input_audio_transcription.delta":
				this.streamDelta("you", msg.delta ?? "");
				break;
			case "conversation.item.input_audio_transcription.completed":
				if (this.alreadySettled(msg.item_id)) break;
				if (!this.openLine && msg.transcript) this.streamDelta("you", msg.transcript.trim());
				this.endLine("you");
				break;
			// Upstream v2 (protocol_v2.rs) reads the text and audio-transcript
			// names for the same line; the un-prefixed pair is v1-era, kept
			// because a server emitting both no longer doubles anything.
			case "response.output_audio_transcript.delta":
			case "response.output_text.delta":
			case "response.audio_transcript.delta":
				this.streamDelta("asst", msg.delta ?? "");
				break;
			case "response.output_text.done":
				if (this.alreadySettled(msg.item_id)) break;
				if (!this.openLine && msg.text) this.streamDelta("asst", msg.text.trim());
				this.endLine("asst");
				break;
			case "response.output_audio_transcript.done":
			case "response.audio_transcript.done":
				if (this.alreadySettled(msg.item_id)) break;
				if (!this.openLine && msg.transcript) this.streamDelta("asst", msg.transcript.trim());
				this.endLine("asst");
				break;
			case "conversation.item.done":
				if (msg.item?.type === "function_call") this.handleFunctionCall(msg.item);
				break;
			case "error": {
				// parse_error_event order: top-level message, then error.message.
				const message = msg.message ?? msg.error?.message ?? JSON.stringify(msg.error ?? msg);
				if (message.startsWith(ACTIVE_RESPONSE_ERROR_PREFIX)) {
					// response.create raced an active response; defer and retry
					// once the active response finishes (upstream queue behavior).
					this.responseActive = true;
					this.pendingResponseCreate = true;
					this.armResponseTimeout();
				} else {
					// Upstream tears the conversation down on any error event. A
					// rejected session.update is the one that matters — the session
					// stays up but with default instructions, no tools and no
					// transcription — and a note under the globe was too quiet to
					// notice, so surface it properly as well.
					this.note(`error: ${clip(message, 110)}`);
					if (this.ctx.hasUI) this.ctx.ui.notify(`talk: ${clip(message, 160)}`, "error");
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
		const start = Math.max(this.playbackEndsAt, this.firstChunkAt, now);
		this.playbackEndsAt = start + pcmChunkMs(buf);
		// Chunks arrive faster than realtime; remember each one's loudness over
		// its wall-clock playback window so the orb animates in sync with the
		// audio the speaker is actually emitting.
		this.outLevels.push({ start, end: this.playbackEndsAt, rms: pcmRms(buf) });
		if (this.outLevels.length > MAX_OUT_LEVELS) this.outLevels.splice(0, this.outLevels.length - MAX_OUT_LEVELS);
	}

	/**
	 * How much of the current assistant item the user actually heard, in ms.
	 * Chunks arrive faster than realtime, so the bytes received are ahead of the
	 * speaker; whatever is still queued behind the playback clock was cut off by
	 * the barge-in and was never heard.
	 */
	private playedMs(): number {
		const receivedMs = (this.playedBytes / 2 / SAMPLE_RATE) * 1000;
		const queuedMs = Math.max(0, this.playbackEndsAt - Date.now());
		return Math.max(0, Math.round(receivedMs - queuedMs));
	}

	private onBargeIn(): void {
		// The user started talking mid-reply: truncate the assistant item to what
		// was actually heard, then stop local playback immediately.
		//
		// Upstream also requires the event's item_id to match the tracked output
		// item, but on the GA endpoint speech_started carries the id of the *user*
		// item the server will create when speech stops — never the assistant's
		// audio item — so that guard would make this dead code and the server
		// would keep believing it said the whole reply.
		if (!this.currentItemId && !this.isPlaying()) return;
		const itemId = this.currentItemId;
		this.currentItemId = undefined;
		if (itemId) {
			this.send({
				type: "conversation.item.truncate",
				item_id: itemId,
				content_index: 0,
				audio_end_ms: this.playedMs(),
			});
		}
		this.playedBytes = 0;
		this.playbackEndsAt = 0;
		this.outLevels.length = 0;
		this.audio?.flush();
		// What was actually spoken before the interruption is the honest record of
		// this item, so keep it and ignore the full transcript the server sends
		// afterwards — that arrives late and would read as the reply twice.
		if (this.endLine("asst") && itemId) remember(this.settledItems, itemId);
	}

	// --- background_agent handoff (the Codex intermediary/backend loop) ---

	private handleFunctionCall(item: any): void {
		// Upstream falls back to the item id when call_id is missing, ignores
		// function calls that match neither tool, and clears the tracked output
		// audio item on both handoff and noop requests.
		const callId = item?.call_id ?? item?.id;
		if (!callId || this.processedCalls.has(callId)) return;
		remember(this.processedCalls, callId);
		this.currentItemId = undefined;
		this.playedBytes = 0;

		if (item.name === "remain_silent") {
			this.sendFunctionOutput(callId, "");
			return;
		}
		if (item.name !== "background_agent") return;

		const prompt = handoffPrompt(item);
		const trimmed = prompt.trim();
		if (!trimmed || trimmed === "{}") {
			this.sendFunctionOutput(callId, "No prompt provided.");
			this.createResponse();
			return;
		}

		// The prompt itself lands in the scrollback as a user message a moment
		// later, and it is what you just said out loud — echoing it here only
		// spent a row of the panel repeating you.
		//
		// Upstream keys this on whether a handoff is already outstanding, not on
		// whether the agent happens to be busy. A turn the user started by typing
		// is busy but has no handoff behind it, and acknowledging that as mere
		// steering left this call with nobody to complete it — the agent would
		// finish and the voice would never say so.
		if (this.activeHandoff) {
			this.note("→ steering the agent");
			this.visualState = "thinking";
			this.deliverPrompt(prompt, true);
			this.sendFunctionOutput(callId, STEER_ACK);
			this.createResponse();
			return;
		}
		const streaming = !this.ctx.isIdle();
		this.note(streaming ? "→ steering the agent" : "→ handed to the agent");
		this.activeHandoff = { callId };
		this.visualState = "working";
		if (!this.deliverPrompt(prompt, streaming)) {
			// Nothing will ever complete this call now, and a function call left
			// unanswered stops the model producing any further response at all.
			this.activeHandoff = undefined;
			this.visualState = "listening";
			this.sendFunctionOutput(callId, "Could not reach the agent.");
			this.createResponse();
		}
	}

	/**
	 * Hands a prompt to the coding agent; false when it could not be delivered.
	 * `sendUserMessage` throws if the agent turns out to be streaming and no
	 * delivery mode was given, and `isIdle()` can go stale between the check and
	 * the send, so an unqualified send gets one retry as a steer.
	 */
	private deliverPrompt(prompt: string, steer: boolean): boolean {
		try {
			this.pi.sendUserMessage(prompt, steer ? { deliverAs: "steer" } : undefined);
			return true;
		} catch (error) {
			if (!steer) {
				try {
					this.pi.sendUserMessage(prompt, { deliverAs: "steer" });
					return true;
				} catch {}
			}
			this.note(`agent handoff failed: ${clip(errorText(error), 80)}`);
			return false;
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
		this.sendUserItem(truncateToTokens(prefixed, BACKEND_OUTPUT_TOKEN_BUDGET));
		// With a handoff outstanding, its tool result is what will prompt the
		// model to speak. Without one — the user typed straight to the agent —
		// nothing else would, so ask for a response here (upstream's standalone
		// handoff does the same) and let `remain_silent` decline it. That tool
		// was otherwise unreachable, having no response to opt out of.
		if (!this.activeHandoff) this.createResponse();
	}

	onAgentEnd(): void {
		if (!this.activeHandoff) return;
		const { callId } = this.activeHandoff;
		this.activeHandoff = undefined;
		this.note("← agent finished");
		this.visualState = "thinking";
		this.sendFunctionOutput(callId, HANDOFF_COMPLETE_ACK);
		this.createResponse();
	}

	onUserTyped(text: string): void {
		// Keep the voice model aware of what the user typed directly to the
		// backend; context only, it should not speak up about it uninvited.
		const trimmed = text.trim();
		if (!trimmed) return;
		this.sendUserItem(trimmed.startsWith(USER_PREFIX) ? trimmed : USER_PREFIX + trimmed);
	}

	// --- transcript widget ---

	private note(text: string): void {
		this.push({ who: "sys", text });
	}

	/** True when this item's transcript is already settled; records it if not. */
	private alreadySettled(itemId: unknown): boolean {
		if (typeof itemId !== "string" || !itemId) return false;
		if (this.settledItems.has(itemId)) return true;
		remember(this.settledItems, itemId);
		return false;
	}

	private streamDelta(who: "you" | "asst", delta: string): void {
		if (!delta) return;
		if (this.openLine && this.openLine.who !== who) this.endLine(this.openLine.who);
		if (!this.openLine) this.openLine = { who, text: "" };
		this.openLine.text += delta;
		this.markDirty();
	}

	/** Settles the open line; true when it carried text worth keeping. */
	private endLine(who: "you" | "asst"): boolean {
		if (this.openLine?.who !== who) return false;
		const text = this.openLine.text.trim();
		this.openLine = undefined;
		if (!text) {
			this.markDirty();
			return false;
		}
		this.push({ who, text });
		return true;
	}

	/** Append an utterance, keeping the transcript bounded, and redraw. */
	private push(entry: TranscriptEntry): void {
		this.transcript.push(entry);
		if (this.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
			this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT_ENTRIES);
		}
		this.markDirty();
	}

	// In the TUI the panel reads the transcript straight off this session on
	// every animation frame, so there is nothing to schedule; only the plain-lines
	// fallback has to be pushed, and that is worth coalescing.
	private markDirty(): void {
		if (this.ctx.mode === "tui" || this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.renderFallback();
		}, 100);
	}

	/** Non-TUI (RPC): a plain list under the editor, with no live component. */
	private renderFallback(): void {
		if (this.closing || !this.ctx.hasUI) return;
		const label = (who: TranscriptWho) => (who === "you" ? "you " : who === "asst" ? "talk" : "  ·  ");
		const lines = this.transcript.slice(-4).map((entry) => `${label(entry.who)}│ ${clip(entry.text, 110)}`);
		if (this.openLine) {
			const text = this.openLine.text;
			const tail = text.length > 108 ? `…${text.slice(-107)}` : text;
			lines.push(`${label(this.openLine.who)}│ ${tail}▌`);
		}
		this.ctx.ui.setWidget("talk-transcript", lines.length ? lines : undefined, { placement: "belowEditor" });
	}

	clearWidget(): void {
		if (this.ctx.hasUI) {
			this.ctx.ui.setWidget("talk-panel", undefined);
			this.ctx.ui.setWidget("talk-transcript", undefined);
			this.ctx.ui.setStatus("talk", undefined);
		}
	}
}

// --- extension wiring ---

// `/talk <arg>`: the model tier each argument selects. Anything else is either
// on/off or a typo.
const MODEL_ARGS: Record<string, string | undefined> = {
	mini: MINI_MODEL,
	fast: MINI_MODEL,
	voice: VOICE_MODEL,
	"1.5": VOICE_MODEL,
	audio: VOICE_MODEL,
};

export default function talk(pi: ExtensionAPI) {
	let active: TalkSession | undefined;

	pi.on("message_end", (event) => active?.onAgentMessage(event.message));
	// `agent_end` closes one low-level run, after which pi may still auto-retry,
	// auto-compact, or pick up a queued follow-up — and the steer path queues one
	// by design. Completing the handoff there had the voice announcing the result
	// while the agent was still working. `agent_settled` is the point nothing
	// further runs on its own.
	pi.on("agent_settled", () => active?.onAgentEnd());
	pi.on("input", (event) => {
		// Mirror the user's own typed input (not extension-injected handoffs).
		if (active && event.source !== "extension") active.onUserTyped(event.text);
	});
	pi.on("session_shutdown", () => active?.stop(false));

	pi.registerCommand("talk", {
		description: "Toggle live voice conversation (realtime speech driving this agent, Codex-style)",
		handler: async (args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("Talk requires macOS (AVFoundation audio)", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			const argModel = MODEL_ARGS[action];
			if (action && !argModel && action !== "on" && action !== "off") {
				ctx.ui.notify(
					"Use /talk, /talk on|off, /talk mini (cheaper/faster), or /talk voice (best audio, gpt-realtime-1.5)",
					"warning",
				);
				return;
			}
			const turnOn = action === "on" || argModel ? true : action === "off" ? false : !active;

			if (!turnOn) {
				if (!active) {
					ctx.ui.notify("Talk is already off", "info");
					return;
				}
				active.stop(true);
				ctx.ui.notify("Talk off", "info");
				return;
			}
			if (active) {
				ctx.ui.notify("Talk is already on", "info");
				return;
			}

			// stop() runs this on every path — user toggle, socket close, audio
			// failure, shutdown — so teardown lives in one place.
			const session = new TalkSession(pi, ctx, argModel ?? MODEL, () => {
				if (active === session) active = undefined;
				session.clearWidget();
			});
			try {
				active = session;
				if (ctx.hasUI) ctx.ui.setStatus("talk", "◉ talk");
				session.mountUI();
				await session.start();
			} catch (error) {
				session.stop(false);
				ctx.ui.notify(`Talk failed to start: ${clip(errorText(error), 140)}`, "error");
			}
		},
	});
}
