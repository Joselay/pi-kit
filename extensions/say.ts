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

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const REALTIME_URL = process.env.PI_SAY_ENDPOINT?.trim() || "wss://api.openai.com/v1/realtime";
const MODEL = process.env.PI_SAY_MODEL?.trim() || "gpt-realtime-2.1-mini";
const VOICE = process.env.PI_SAY_VOICE?.trim() || "marin";

const SAMPLE_RATE = 24000;
const CONNECT_TIMEOUT_MS = 10_000;
const PLAYBACK_TAIL_MS = 300;
/** Longest text to speak in one utterance; realtime instructions cap. */
const MAX_TEXT_CHARS = 6000;

const INSTRUCTIONS =
	"You are a text-to-speech engine. Read the user's message aloud verbatim, " +
	"word for word, in a natural and clear voice. Do not add, omit, translate, " +
	"summarize, or comment on anything. Read code identifiers naturally. Skip " +
	"markdown syntax characters (#, *, backticks) but read their content.";

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

/** Same OAuth-only resolution as /talk and /translate. */
async function resolveOAuth(): Promise<{ token: string; accountId?: string }> {
	const runtime = await ModelRuntime.create();
	const check = await (runtime as any).checkAuth(PROVIDER_ID);
	if (!(runtime as any).isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
		throw new Error("say needs the openai-codex OAuth subscription; run /login first");
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

/** Playback-only ffplay pipe (no mic, so no AEC needed). */
class Player {
	private child?: ChildProcess;
	private stopped = false;

	play(buf: Buffer): void {
		if (this.stopped) return;
		if (!this.child || this.child.stdin?.destroyed) this.spawnPlayer();
		this.child?.stdin?.write(buf);
	}

	private spawnPlayer(): void {
		this.child = spawn(
			findBinary("ffplay"),
			[
				"-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
				"-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-sync", "audio",
				"-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "mono", "-i", "pipe:0",
			],
			{ stdio: ["pipe", "ignore", "ignore"] },
		);
		this.child.stdin?.on("error", () => {});
		this.child.on("close", () => {
			if (!this.stopped) this.child = undefined;
		});
	}

	stop(): void {
		this.stopped = true;
		try {
			this.child?.stdin?.end();
		} catch {}
		this.child?.kill("SIGKILL");
	}
}

class SaySession {
	private ws?: any;
	private player = new Player();
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
		const { token, accountId } = await resolveOAuth();
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			originator: "pi",
			"user-agent": `pi-say (${process.platform}; ${process.arch})`,
		};
		if (accountId) headers["chatgpt-account-id"] = accountId;

		const url = `${REALTIME_URL}?model=${encodeURIComponent(MODEL)}`;
		const ws = new (globalThis as any).WebSocket(url, { headers });
		this.ws = ws;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("realtime connection timed out")), CONNECT_TIMEOUT_MS);
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
		try {
			if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
		} catch {}
	}

	private onServerEvent(event: any): void {
		let msg: any;
		try {
			msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
		} catch {
			return;
		}
		switch (msg.type) {
			case "response.output_audio.delta":
			case "response.audio.delta": {
				if (!msg.delta) break;
				const buf = Buffer.from(msg.delta, "base64");
				this.player.play(buf);
				const chunkMs = (buf.length / 2 / SAMPLE_RATE) * 1000;
				this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + chunkMs;
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

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && typeof part === "object" && (part as any).type === "text"),
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = extractText((entry.message as { content?: unknown }).content);
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
