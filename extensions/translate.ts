// /translate - live speech-to-speech translation through gpt-realtime-translate.
//
// Unlike /talk (a conversational realtime session that drives the agent), the
// translations endpoint is a pure continuous stream: no turns, no VAD, no tools,
// no response.create, no voice selection. You speak in any language (auto-
// detected), it streams back translated speech in the target language plus dual
// transcripts. Protocol per the OpenAI realtime-translation guide:
//   wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
//   -> session.update { audio: { input: { transcription, noise_reduction },
//                                output: { language } } }
//   -> session.input_audio_buffer.append (base64 24 kHz PCM16, incl. silence)
//   <- session.output_audio.delta / session.output_transcript.delta /
//      session.input_transcript.delta
//   -> session.close ... <- session.closed
//
// Auth is the pi `openai-codex` OAuth subscription resolved through ModelRuntime
// (~/.pi/agent/auth.json), the same pattern as /talk and /dictate. OAuth only —
// no API-key fallback.
//
// Audio reuses the /talk stack: the AEC helper (~/.pi/agent/talk/talk-audio,
// compiled from talk-audio.swift on demand) for full-duplex speaker use, or
// ffmpeg/ffplay half-duplex (mic muted while translated audio plays — use
// headphones for continuous translation) when the helper is unavailable.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const TRANSLATIONS_URL =
	process.env.PI_TRANSLATE_ENDPOINT?.trim() || "wss://api.openai.com/v1/realtime/translations";
const MODEL = process.env.PI_TRANSLATE_MODEL?.trim() || "gpt-realtime-translate";
// The translations input transcriber; gpt-realtime-whisper is the streaming STT.
const TRANSCRIBE_MODEL = process.env.PI_TRANSLATE_TRANSCRIBE_MODEL?.trim() || "gpt-realtime-whisper";
const DEFAULT_LANGUAGE = process.env.PI_TRANSLATE_LANGUAGE?.trim() || "en";

const SAMPLE_RATE = 24000;
const MIC_FRAME_BYTES = 960 * 2;
const PLAYBACK_TAIL_MS = 250;
const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 1500;
/** Commit a transcript line to history after this much silence on its stream. */
const LINE_SETTLE_MS = 2000;

// The 13 output languages the model supports (input is auto-detected, 70+).
const OUTPUT_LANGUAGES: Record<string, string> = {
	en: "English",
	es: "Spanish",
	pt: "Portuguese",
	fr: "French",
	ja: "Japanese",
	ru: "Russian",
	zh: "Chinese",
	de: "German",
	ko: "Korean",
	hi: "Hindi",
	id: "Indonesian",
	vi: "Vietnamese",
	it: "Italian",
};

// Accept full names and common mistaken codes alongside the ISO codes.
const LANGUAGE_ALIASES: Record<string, string> = {
	jp: "ja",
	cn: "zh",
	kr: "ko",
	br: "pt",
	mandarin: "zh",
	...Object.fromEntries(Object.entries(OUTPUT_LANGUAGES).map(([code, name]) => [name.toLowerCase(), code])),
};

function resolveLanguage(input: string): string | undefined {
	const key = input.trim().toLowerCase();
	const code = OUTPUT_LANGUAGES[key] ? key : LANGUAGE_ALIASES[key];
	return code && OUTPUT_LANGUAGES[code] ? code : undefined;
}

const TALK_DIR = join(getAgentDir(), "talk");
const AEC_SOURCE = join(TALK_DIR, "talk-audio.swift");
const AEC_BINARY = join(TALK_DIR, "talk-audio");
const DISABLE_AEC = process.env.PI_TRANSLATE_NO_AEC === "1";
const AUDIO_DEVICE = process.env.PI_TRANSLATE_DEVICE?.trim() || "0";

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

/**
 * Resolves the `openai-codex` OAuth subscription through pi's ModelRuntime
 * (~/.pi/agent/auth.json). OAuth only: unlike /dictate there is deliberately no
 * OPENAI_API_KEY fallback.
 */
async function resolveOAuth(): Promise<{ token: string; accountId?: string }> {
	const runtime = await ModelRuntime.create();
	const check = await (runtime as any).checkAuth(PROVIDER_ID);
	if (!(runtime as any).isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
		throw new Error("translate needs the openai-codex OAuth subscription; run /login first");
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

// --- audio backends (same stack as /talk) ---

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

// --- the translate session ---

type StreamWho = "you" | "xlat";

class TranslateSession {
	private ws?: any;
	private audio?: AudioIO;
	private closing = false;
	private closed = false;

	// Playback clock: wall-clock time the buffered audio finishes playing.
	private playbackEndsAt = 0;
	private firstChunkAt = 0;

	private transcript: { who: StreamWho | "sys"; text: string }[] = [];
	// Source and translated transcripts stream simultaneously, so each keeps
	// its own open line; a settle timer commits it to history after a pause.
	private open: Record<StreamWho, { text: string; timer?: ReturnType<typeof setTimeout> }> = {
		you: { text: "" },
		xlat: { text: "" },
	};
	private statusText = "connecting…";
	private renderTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly ctx: ExtensionCommandContext,
		private readonly language: string,
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
			"user-agent": `pi-translate (${process.platform}; ${process.arch})`,
		};
		if (accountId) {
			headers["chatgpt-account-id"] = accountId;
			// The translations endpoint documents a safety identifier; the opaque
			// ChatGPT account id serves as the stable hashed user id.
			headers["OpenAI-Safety-Identifier"] = accountId;
		}

		const url = `${TRANSLATIONS_URL}?model=${encodeURIComponent(MODEL)}`;
		const ws = new (globalThis as any).WebSocket(url, { headers });
		this.ws = ws;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("translation connection timed out")), CONNECT_TIMEOUT_MS);
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
				audio: {
					input: {
						transcription: { model: TRANSCRIBE_MODEL },
						noise_reduction: { type: "near_field" },
					},
					output: { language: this.language },
				},
			},
		});

		ws.addEventListener("message", (event: any) => this.onServerEvent(event));
		ws.addEventListener("close", (event: any) => {
			this.closed = true;
			if (!this.closing) {
				this.note(`connection closed (${event?.code ?? "?"})`);
				this.stop();
			}
		});

		await this.audio.start(
			(frame) => {
				if (ws.readyState !== 1) return;
				// Half-duplex fallback: without AEC the mic would hear the translated
				// speech and translate it again, so drop frames while playing.
				if (!this.audio!.echoCancelled && this.isPlaying()) return;
				this.send({ type: "session.input_audio_buffer.append", audio: frame.toString("base64") });
			},
			(message) => {
				this.ctx.ui.notify(`translate audio failed: ${message}`, "error");
				this.stop();
			},
		);

		const name = OUTPUT_LANGUAGES[this.language] ?? this.language;
		this.statusText = `translating → ${name} — ${MODEL} · ${this.audio.echoCancelled ? "echo-cancelled (speakers OK)" : "half-duplex (use headphones)"}`;
		this.markDirty();
	}

	stop(): void {
		if (this.closing) return;
		this.closing = true;
		try {
			this.audio?.stop();
		} catch {}
		// Graceful shutdown per the guide: session.close, then wait briefly for
		// session.closed before dropping the socket.
		try {
			if (this.ws?.readyState === 1 && !this.closed) {
				this.ws.send(JSON.stringify({ type: "session.close" }));
				const ws = this.ws;
				setTimeout(() => {
					try {
						ws.close();
					} catch {}
				}, CLOSE_GRACE_MS);
			} else {
				this.ws?.close();
			}
		} catch {}
		if (this.renderTimer) clearTimeout(this.renderTimer);
		for (const who of ["you", "xlat"] as const) {
			if (this.open[who].timer) clearTimeout(this.open[who].timer);
		}
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
			case "session.output_audio.delta":
				if (msg.delta) this.playChunk(Buffer.from(msg.delta, "base64"));
				break;
			case "session.input_transcript.delta":
				this.streamDelta("you", msg.delta ?? "");
				break;
			case "session.output_transcript.delta":
				this.streamDelta("xlat", msg.delta ?? "");
				break;
			case "session.closed":
				this.closed = true;
				try {
					this.ws?.close();
				} catch {}
				break;
			case "error":
				this.note(`error: ${clip(msg.error?.message ?? JSON.stringify(msg), 110)}`);
				break;
			default:
				break;
		}
	}

	private playChunk(buf: Buffer): void {
		this.audio?.play(buf);
		const now = Date.now();
		if (!this.firstChunkAt) this.firstChunkAt = now;
		const chunkMs = (buf.length / 2 / SAMPLE_RATE) * 1000;
		this.playbackEndsAt = Math.max(this.playbackEndsAt, this.firstChunkAt, now) + chunkMs;
	}

	// --- transcript widget ---

	private note(text: string): void {
		this.transcript.push({ who: "sys", text });
		this.trimTranscript();
		this.markDirty();
	}

	private streamDelta(who: StreamWho, delta: string): void {
		if (!delta) return;
		const line = this.open[who];
		line.text += delta;
		if (line.timer) clearTimeout(line.timer);
		line.timer = setTimeout(() => this.settleLine(who), LINE_SETTLE_MS);
		this.markDirty();
	}

	private settleLine(who: StreamWho): void {
		const line = this.open[who];
		if (line.timer) clearTimeout(line.timer);
		line.timer = undefined;
		if (line.text.trim()) this.transcript.push({ who, text: line.text.trim() });
		line.text = "";
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
		const label = (who: StreamWho | "sys") => (who === "you" ? "you " : who === "xlat" ? `→${this.language} ` : "  ·  ");
		const lines = this.transcript.slice(-6).map((entry) => `${label(entry.who)}│ ${clip(entry.text, 110)}`);
		for (const who of ["you", "xlat"] as const) {
			const text = this.open[who].text;
			if (!text) continue;
			const tail = text.length > 108 ? `…${text.slice(-107)}` : text;
			lines.push(`${label(who)}│ ${tail}▌`);
		}
		this.ctx.ui.setWidget("translate", [`◉ ${this.statusText}`, ...lines], { placement: "belowEditor" });
	}

	clearWidget(): void {
		if (this.ctx.hasUI) {
			this.ctx.ui.setWidget("translate", undefined);
			this.ctx.ui.setStatus("translate", undefined);
		}
	}
}

// --- extension wiring ---

export default function translate(pi: ExtensionAPI) {
	let active: TranslateSession | undefined;

	const stopSession = () => {
		const session = active;
		active = undefined;
		if (session) {
			session.stop();
			session.clearWidget();
		}
	};

	pi.on("session_shutdown", () => stopSession());

	pi.registerCommand("translate", {
		description: "Toggle live speech translation (speak any language, hear the target language)",
		handler: async (args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("Translate requires macOS (AVFoundation audio)", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action === "off") {
				if (!active) {
					ctx.ui.notify("Translate is already off", "info");
					return;
				}
				stopSession();
				ctx.ui.notify("Translate off", "info");
				return;
			}
			const requested = action && action !== "on" ? action : DEFAULT_LANGUAGE;
			const language = resolveLanguage(requested);
			if (!language) {
				const supported = Object.entries(OUTPUT_LANGUAGES)
					.map(([code, name]) => `${code} (${name})`)
					.join(", ");
				ctx.ui.notify(`Unsupported target language "${requested}". Use one of: ${supported}`, "warning");
				return;
			}
			if (active) {
				if (!action) {
					// Bare /translate toggles off when already running.
					stopSession();
					ctx.ui.notify("Translate off", "info");
					return;
				}
				// Switching target language restarts the session.
				stopSession();
			}

			const session = new TranslateSession(ctx, language, () => {
				if (active === session) {
					active = undefined;
					session.clearWidget();
				}
			});
			try {
				active = session;
				if (ctx.hasUI) ctx.ui.setStatus("translate", `◉ →${language}`);
				await session.start();
			} catch (error) {
				active = undefined;
				session.stop();
				session.clearWidget();
				ctx.ui.notify(`Translate failed to start: ${clip(errorText(error), 140)}`, "error");
			}
		},
	});
}
