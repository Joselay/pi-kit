// /say - speak text aloud using gpt-realtime-2.1-mini as an OAuth TTS engine.
//
// The dedicated TTS endpoints (/v1/audio/speech, tts-1-hd, gpt-audio-1.5) reject
// ChatGPT subscription tokens ("Missing scopes: api.model.audio.request"), so
// this drives the realtime WebSocket instead — the same OAuth-accepting endpoint
// /talk uses — with a playback-only session: no mic, no VAD, one response per
// utterance. The realtime model is instructed to read the text verbatim.
//
//   /say <text>   speak the given text
//   /say          speak the last assistant message
//   /say off      stop speaking
//
// Auth is the pi `openai-codex` OAuth subscription resolved through ModelRuntime
// (~/.pi/agent/auth.json). OAuth only — no API-key fallback.

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FfplayPipe, pcmChunkMs, SAMPLE_RATE } from "./lib/audio.ts";
import { resolveRealtimeOAuth } from "./lib/codex.ts";
import { openRealtimeSocket, parseServerEvent, realtimeHeaders, sendJson } from "./lib/realtime.ts";
import { clip, errorText, messageText } from "./lib/util.ts";

const REALTIME_URL = process.env.PI_SAY_ENDPOINT?.trim() || "wss://api.openai.com/v1/realtime";
const MODEL = process.env.PI_SAY_MODEL?.trim() || "gpt-realtime-2.1-mini";
const VOICE = process.env.PI_SAY_VOICE?.trim() || "marin";

const PLAYBACK_TAIL_MS = 300;
/** Longest text to speak in one utterance; realtime instructions cap. */
const MAX_TEXT_CHARS = 6000;

const INSTRUCTIONS =
	"You are a text-to-speech engine. Read the user's message aloud verbatim, " +
	"word for word, in a natural and clear voice. Do not add, omit, translate, " +
	"summarize, or comment on anything. Read code identifiers naturally. Skip " +
	"markdown syntax characters (#, *, backticks) but read their content.";

class SaySession {
	private ws?: WebSocket;
	private player = new FfplayPipe();
	private closing = false;
	private playbackEndsAt = 0;
	private responseDone = false;
	private drainTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly ctx: ExtensionCommandContext,
		private readonly text: string,
		private readonly onClosed: () => void,
	) {}

	async start(): Promise<void> {
		const creds = await resolveRealtimeOAuth("say");
		const url = `${REALTIME_URL}?model=${encodeURIComponent(MODEL)}`;
		const ws = await openRealtimeSocket(url, realtimeHeaders(creds, "say"));
		this.ws = ws;

		this.send({
			type: "session.update",
			session: {
				type: "realtime",
				model: MODEL,
				output_modalities: ["audio"],
				instructions: INSTRUCTIONS,
				audio: {
					// No microphone: disable server VAD so nothing but our explicit
					// response.create produces output.
					input: {
						format: { type: "audio/pcm", rate: SAMPLE_RATE },
						turn_detection: null,
					},
					output: {
						format: { type: "audio/pcm", rate: SAMPLE_RATE },
						voice: VOICE,
					},
				},
			},
		});
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text: this.text }] },
		});
		this.send({ type: "response.create" });

		ws.addEventListener("message", (event: any) => this.onServerEvent(event));
		ws.addEventListener("close", () => {
			if (!this.closing && !this.responseDone) {
				this.ctx.ui.notify("say: connection closed before finishing", "warning");
			}
			this.stop();
		});

		if (this.ctx.hasUI) this.ctx.ui.setStatus("say", `◉ speaking — ${MODEL} · ${VOICE}`);
	}

	stop(): void {
		if (this.closing) return;
		this.closing = true;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.player.stop();
		try {
			this.ws?.close();
		} catch {}
		this.onClosed();
	}

	private send(payload: unknown): void {
		sendJson(this.ws, payload);
	}

	private onServerEvent(event: any): void {
		const msg = parseServerEvent(event);
		if (!msg) return;
		switch (msg.type) {
			case "response.output_audio.delta":
			case "response.audio.delta": {
				if (!msg.delta) break;
				const buf = Buffer.from(msg.delta, "base64");
				this.player.play(buf);
				this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + pcmChunkMs(buf);
				break;
			}
			case "response.done":
			case "response.cancelled":
				this.responseDone = true;
				this.scheduleDrain();
				break;
			case "error":
				this.ctx.ui.notify(`say: ${clip(msg.error?.message ?? JSON.stringify(msg), 140)}`, "error");
				this.stop();
				break;
			default:
				break;
		}
	}

	/** Close once the buffered audio has actually finished playing. */
	private scheduleDrain(): void {
		const remaining = Math.max(0, this.playbackEndsAt - Date.now()) + PLAYBACK_TAIL_MS;
		this.drainTimer = setTimeout(() => this.stop(), remaining);
	}
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = messageText(entry.message).trim();
		if (text) return text;
	}
	return undefined;
}

export default function say(pi: ExtensionAPI) {
	let active: SaySession | undefined;

	const stopSession = () => {
		const session = active;
		active = undefined;
		if (session) session.stop();
	};

	pi.on("session_shutdown", () => stopSession());

	pi.registerCommand("say", {
		description: "Speak text (or the last assistant reply) aloud via realtime TTS",
		handler: async (args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("Say requires macOS (ffplay audio output)", "warning");
				return;
			}
			const arg = args.trim();
			if (arg.toLowerCase() === "off" || (active && !arg)) {
				stopSession();
				if (ctx.hasUI) ctx.ui.setStatus("say", undefined);
				ctx.ui.notify("Say stopped", "info");
				if (arg.toLowerCase() === "off" || !arg) return;
			}
			if (active) stopSession();

			const text = arg || lastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("Nothing to say: no text given and no assistant reply yet", "warning");
				return;
			}

			const session = new SaySession(ctx, clip(text, MAX_TEXT_CHARS), () => {
				if (active === session) {
					active = undefined;
					if (ctx.hasUI) ctx.ui.setStatus("say", undefined);
				}
			});
			try {
				active = session;
				await session.start();
			} catch (error) {
				active = undefined;
				session.stop();
				if (ctx.hasUI) ctx.ui.setStatus("say", undefined);
				ctx.ui.notify(`Say failed: ${clip(errorText(error), 140)}`, "error");
			}
		},
	});
}
