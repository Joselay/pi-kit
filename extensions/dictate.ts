import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { SAMPLE_RATE } from "./lib/audio.ts";
import { resolveRealtimeOAuth } from "./lib/codex.ts";
import { realtimeHeaders } from "./lib/realtime.ts";
import { errorText } from "./lib/util.ts";
import {
	CURSOR_MARKER,
	isKeyRelease,
	Key,
	matchesKey,
	parseKey,
	truncateToWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const STATE_PATH = join(getAgentDir(), "dictate.json");
const MAX_RECORDING_MS = 5 * 60 * 1000;
const HOLD_DELAY_MS = 500;
const PRESPAWN_DELAY_MS = 120;
const MIN_RECORDING_MS = 150;
const CLOSE_GRACE_MS = 400;
const CONNECT_TIMEOUT_MS = 10 * 1000;
const FINALIZE_TIMEOUT_MS = 15 * 1000;
const TAIL_SILENCE_MS = 600;
const STDERR_TAIL = 4000;

const AUTH_HINT = "run /login if this persists";
const REALTIME_URL =
	process.env.PI_DICTATE_ENDPOINT?.trim() || "wss://api.openai.com/v1/realtime?intent=transcription";
// gpt-realtime-whisper emits transcript deltas as you speak; the gpt-4o-*-transcribe
// models only produce text once the turn is committed. Streaming mode uses the
// former; batch mode uses the mini transcriber (codex's choice) and best mode the
// full gpt-4o-transcribe for maximum accuracy.
const MODEL_OVERRIDE = process.env.PI_DICTATE_MODEL?.trim();
const STREAMING_MODEL = "gpt-realtime-whisper";
const BATCH_MODEL = "gpt-4o-mini-transcribe";
const BEST_MODEL = "gpt-4o-transcribe";
const LANGUAGE = process.env.PI_DICTATE_LANGUAGE?.trim() || "en";
const DELAY = process.env.PI_DICTATE_DELAY?.trim() || "low";
// Non-streaming modes transcribe the whole utterance on commit, so their
// finalize wait scales far past the streaming tail.
const BATCH_FINALIZE_TIMEOUT_MS = 60 * 1000;

type DictateMode = "streaming" | "batch" | "best";

const RECORDING_FRAMES = ["▁▁▂▃▂▁▁", "▁▂▃▅▃▂▁", "▂▃▅▇▅▃▂", "▃▅▇█▇▅▃", "▂▃▅▇▅▃▂", "▁▂▃▅▃▂▁"];
const TRANSCRIBING_FRAMES = ["·  ", "·· ", "···"];

type DictationState = "idle" | "recording" | "transcribing";

type Recording = {
	child: ChildProcess;
	armedAt: number;
	armed: boolean;
	stderr: string;
	bytes: number;
	transcribed: boolean;
	/** Audio captured before the hold was confirmed, replayed once the session opens. */
	buffered: Buffer[];
	session?: LiveSession;
	/** Resolves once the (async) transcription session has been opened or has failed. */
	sessionPending?: Promise<void>;
	closed: Promise<void>;
};

/** Cancels the transcription session, waiting for an in-flight open first. */
async function closeSession(item: Recording): Promise<void> {
	if (item.sessionPending) {
		try {
			await item.sessionPending;
		} catch {
		}
	}
	item.session?.cancel();
}
class Timer {
	private handle?: ReturnType<typeof setTimeout>;

	set(ms: number, callback: () => void, unref = false): void {
		this.clear();
		this.handle = setTimeout(() => {
			this.handle = undefined;
			callback();
		}, ms);
		if (unref) this.handle.unref?.();
	}

	clear(): void {
		if (this.handle) clearTimeout(this.handle);
		this.handle = undefined;
	}
}

function executable(envName: string, fallback: string, candidates: string[]): string {
	const configured = process.env[envName]?.trim();
	if (configured) return configured;
	return candidates.find(existsSync) ?? fallback;
}

const FFMPEG = executable("PI_DICTATE_FFMPEG", "ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
const AUDIO_DEVICE = process.env.PI_DICTATE_AUDIO_DEVICE?.trim() || "0";

function tail(existing: string, chunk: unknown): string {
	return (existing + String(chunk)).slice(-STDERR_TAIL);
}

const MODIFIER_MASK = 0x20000 | 0x40000 | 0x80000 | 0x100000;

function modifierHeld(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(
			"osascript",
			["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSEvent.modifierFlags'],
			{ timeout: 500 },
			(error, stdout) => {
				const flags = Number.parseInt(stdout.trim(), 10);
				resolve(!error && Number.isFinite(flags) && (flags & MODIFIER_MASK) !== 0);
			},
		);
	});
}

function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGINT"): void {
	if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

const SILENCE_TAIL = Buffer.alloc(Math.floor((SAMPLE_RATE * 2 * TAIL_SILENCE_MS) / 1000)).toString("base64");

type LiveSession = {
	/** Raw s16le mono 24 kHz straight off the recorder. */
	push(pcm: Buffer): void;
	/** Flushes the tail, waits for the final transcript, returns text not already streamed. */
	finish(): Promise<string>;
	cancel(): void;
};

/**
 * A transcription-only Realtime session over WebSocket. Deltas arrive while the user
 * is still speaking, which is the whole point: the batch `/v1/audio/transcriptions`
 * endpoint cannot start until the recording has finished uploading.
 *
 * `gpt-realtime-whisper` streams natively and does not support VAD, so end-of-turn is
 * driven by an explicit commit on key release.
 */
async function openLiveTranscription(mode: DictateMode, onDelta: (delta: string) => void): Promise<LiveSession> {
	const model =
		MODEL_OVERRIDE || (mode === "batch" ? BATCH_MODEL : mode === "best" ? BEST_MODEL : STREAMING_MODEL);
	// `delay` only exists on the streaming whisper models; the batch models reject it.
	const transcription: Record<string, string> = { model, language: LANGUAGE };
	if (model.includes("whisper")) transcription.delay = DELAY;
	const finalizeTimeoutMs = mode === "streaming" ? FINALIZE_TIMEOUT_MS : BATCH_FINALIZE_TIMEOUT_MS;
	const creds = await resolveRealtimeOAuth("dictate");
	const ws = new WebSocket(REALTIME_URL, { headers: realtimeHeaders(creds, "dictate") });
	const queue: string[] = [];
	let ready = false;
	let done = false;
	let failure: Error | undefined;
	let streamed = 0;
	let finalText = "";
	let settle: (() => void) | undefined;

	const connectTimer = new Timer();
	const finishTimer = new Timer();

	const send = (message: unknown): void => {
		const payload = JSON.stringify(message);
		if (ready) ws.send(payload);
		else queue.push(payload);
	};

	const fail = (error: Error): void => {
		failure ??= error;
		settle?.();
	};

	const close = (): void => {
		connectTimer.clear();
		finishTimer.clear();
		try {
			ws.close();
		} catch {
		}
	};

	connectTimer.set(CONNECT_TIMEOUT_MS, () => fail(new Error("realtime connection timed out")));

	ws.addEventListener("open", () => {
		connectTimer.clear();
		ws.send(
			JSON.stringify({
				type: "session.update",
				session: {
					type: "transcription",
					audio: {
						input: {
							format: { type: "audio/pcm", rate: SAMPLE_RATE },
							transcription,
							noise_reduction: { type: "near_field" },
							turn_detection: null,
						},
					},
				},
			}),
		);
	});

	ws.addEventListener("error", () => fail(new Error(`could not reach the realtime API (${AUTH_HINT})`)));

	ws.addEventListener("close", (event: { code?: number; reason?: string }) => {
		// A close after `session.updated` is a normal end of stream; before it, the
		// server rejected the session (bad token, model, ...) and would otherwise
		// surface as a bogus "no speech detected".
		if (!ready && !done) {
			const reason = event.reason?.trim();
			fail(new Error(`realtime connection closed${reason ? ` (${reason})` : ""}; ${AUTH_HINT}`));
		}
		done = true;
		settle?.();
	});

	ws.addEventListener("message", (event: { data: string }) => {
		let message: {
			type?: string;
			delta?: string;
			transcript?: string;
			message?: string;
			error?: { message?: string };
		};
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		switch (message.type) {
			case "session.updated":
				ready = true;
				for (const payload of queue.splice(0)) ws.send(payload);
				break;
			case "conversation.item.input_audio_transcription.delta":
				if (message.delta) {
					streamed++;
					onDelta(message.delta);
				}
				break;
			case "conversation.item.input_audio_transcription.completed":
				finalText = String(message.transcript ?? "");
				settle?.();
				break;
			case "conversation.item.input_audio_transcription.failed":
			case "error":
				// Same fallback chain as codex's parse_error_event: error.message, then
				// the top-level message field.
				fail(new Error(message.error?.message ?? message.message ?? "realtime transcription failed"));
				break;
		}
	});

	return {
		push(pcm: Buffer): void {
			if (done || failure) return;
			send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
		},

		cancel(): void {
			done = true;
			close();
		},

		async finish(): Promise<string> {
			if (!done && !failure) {
				send({ type: "input_audio_buffer.append", audio: SILENCE_TAIL });
				send({ type: "input_audio_buffer.commit" });
				await new Promise<void>((resolve) => {
					settle = resolve;
					finishTimer.set(finalizeTimeoutMs, resolve);
					if (failure || done) resolve();
				});
				settle = undefined;
			}
			close();
			if (failure) throw failure;
			// Deltas are already in the editor; only report text that never streamed.
			return streamed > 0 ? "" : finalText.trim();
		},
	};
}

type PersistedState = { enabled: boolean; mode: DictateMode };

function readState(): PersistedState {
	try {
		const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
		return {
			enabled: raw.enabled === true,
			mode: raw.mode === "batch" || raw.mode === "best" ? raw.mode : "streaming",
		};
	} catch {
		return { enabled: false, mode: "streaming" };
	}
}

function writeState(state: PersistedState): void {
	writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

class DictationEditor extends CustomEditor {
	wantsKeyRelease = true;
	private spaceHeld = false;
	private dictationState: DictationState = "idle";
	private animationFrame = 0;
	private animationTimer?: ReturnType<typeof setInterval>;

	removePendingSpaces(count: number, expected: { line: number; col: number }): void {
		const cursor = this.getCursor();
		if (count < 1 || cursor.line !== expected.line || cursor.col !== expected.col || cursor.col < count) return;
		const line = this.getLines()[cursor.line] ?? "";
		if (line.slice(cursor.col - count, cursor.col) !== " ".repeat(count)) return;
		for (let index = 0; index < count; index++) super.handleInput("\x7f");
	}

	/**
	 * Transcript fragments arrive one at a time and already carry their own spacing,
	 * so only the first fragment of an utterance is spaced against existing text —
	 * doing it per fragment splits words ("dict" + "ation" -> "dict ation").
	 */
	insertTranscription(text: string, atStart = true): void {
		if (!text) return;
		if (!atStart) {
			this.insertTextAtCursor(text);
			return;
		}
		const body = text.replace(/^\s+/, "");
		if (!body) return;
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const needsLeadingSpace = cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "");
		this.insertTextAtCursor(`${needsLeadingSpace ? " " : ""}${body}`);
	}

	endTranscription(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		if (cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "")) this.insertTextAtCursor(" ");
	}

	setDictationState(state: DictationState): void {
		this.dictationState = state;
		this.animationFrame = 0;
		this.stopAnimation();
		if (state !== "idle") {
			this.animationTimer = setInterval(() => {
				this.animationFrame++;
				this.tui.requestRender();
			}, 120);
		}
		this.tui.requestRender();
	}

	private stopAnimation(): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	dispose(): void {
		this.stopAnimation();
	}

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly isEnabled: () => boolean,
		private readonly startDictation: () => void,
		private readonly repeatDictationKey: () => void,
		private readonly stopDictation: () => void,
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) {
			if (this.spaceHeld && parseKey(data)?.split("+").pop() === "space") {
				this.spaceHeld = false;
				this.stopDictation();
			}
			return;
		}

		if (matchesKey(data, Key.space)) {
			if (!this.isEnabled()) {
				super.handleInput(data);
				return;
			}
			if (this.spaceHeld) {
				this.repeatDictationKey();
				return;
			}
			this.spaceHeld = true;
			this.startDictation();
			return;
		}

		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.dictationState === "idle" || lines.length === 0) return lines;

		const frames = this.dictationState === "recording" ? RECORDING_FRAMES : TRANSCRIBING_FRAMES;
		const frame = frames[this.animationFrame % frames.length];
		const label = ` ${frame} `;
		for (let index = 1; index < lines.length - 1; index++) {
			const line = lines[index]!;
			const marker = line.indexOf(CURSOR_MARKER);
			if (marker === -1) continue;

			const cursorStart = line.indexOf("\x1b[7m", marker + CURSOR_MARKER.length);
			const cursorEnd = line.indexOf("\x1b[0m", cursorStart);
			if (cursorStart === -1 || cursorEnd === -1) continue;

			const afterCursor = cursorEnd + "\x1b[0m".length;
			lines[index] = truncateToWidth(
				line.slice(0, cursorStart) + this.borderColor(label) + line.slice(afterCursor),
				width,
				"",
			);
			break;
		}
		return lines;
	}
}

const SUPPORTED = process.platform === "darwin";

export default function dictate(pi: ExtensionAPI) {
	let { enabled, mode } = readState();
	let currentEditor: DictationEditor | undefined;
	let ctx: ExtensionContext | undefined;
	let generation = 0;

	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	};

	function warmUp(): void {
		// Surfaces a stale login, and builds the ModelRuntime, before the user has
		// spoken into a dead session.
		void resolveRealtimeOAuth("dictate").catch(() => {});
		void modifierHeld();
	}

	let recording: Recording | undefined;
	let starting: Promise<void> | undefined;
	let transcribing = false;
	const maxTimer = new Timer();

	async function settled(): Promise<void> {
		while (starting) {
			const pending = starting;
			await pending;
			// Never wait on the same settled promise twice; that would spin forever.
			if (starting === pending) starting = undefined;
		}
	}

	function start(editor: DictationEditor): Promise<void> {
		if (starting) return settled();
		if (recording || transcribing) return Promise.resolve();
		const token = generation;

		const pending = (async () => {
			try {
				const child = spawn(
					FFMPEG,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-f",
						"avfoundation",
						"-i",
						`:${AUDIO_DEVICE}`,
						"-ac",
						"1",
						"-ar",
						String(SAMPLE_RATE),
						"-f",
						"s16le",
						"-",
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);

				const item: Recording = {
					child,
					armedAt: Date.now(),
					armed: false,
					stderr: "",
					bytes: 0,
					transcribed: false,
					buffered: [],
					closed: new Promise((resolve) => child.once("close", () => resolve())),
				};

				child.stdout?.on("data", (chunk: Buffer) => {
					item.bytes += chunk.length;
					// The mic may be rolling for a hold that turns out to be a
					// passthrough space, so nothing goes to the API before the hold is
					// confirmed even when the session is already open.
					if (item.armed && item.session) item.session.push(chunk);
					else item.buffered.push(chunk);
				});
				child.stderr?.on("data", (chunk) => (item.stderr = tail(item.stderr, chunk)));
				child.once("error", (error) => {
					if (recording !== item) return;
					recording = undefined;
					maxTimer.clear();
					void closeSession(item);
					editor.setDictationState("idle");
					notify(`Dictation recorder failed: ${error.message}`, "error");
				});

				if (token !== generation) {
					stopChild(child, "SIGKILL");
					return;
				}
				recording = item;

				// Connect the transcription session during the hold delay instead of
				// after it, so the OAuth resolve + TLS + session.updated round trip
				// (several hundred ms) overlaps the hold instead of delaying the
				// first deltas. Audio stays buffered until the hold is confirmed.
				let atStart = true;
				const sessionPending = (async () => {
					// No `recording` check in the delta handler: transcription runs
					// ~1.4s behind speech, so for a short hold every delta lands after
					// release has already cleared `recording`.
					const session = await openLiveTranscription(mode, (delta) => {
						if (token !== generation || !item.armed) return;
						editor.insertTranscription(delta, atStart);
						atStart = false;
						item.transcribed = true;
					});
					if (token !== generation) {
						session.cancel();
						return;
					}
					item.session = session;
					if (item.armed) for (const chunk of item.buffered.splice(0)) session.push(chunk);
				})();
				item.sessionPending = sessionPending;
				// Failures surface when arm()/stop() await the session, not here.
				sessionPending.catch(() => {});
			} catch (error) {
				editor.setDictationState("idle");
				if (token === generation) notify(`Could not start dictation: ${errorText(error)}`, "error");
			}
		})();
		// Cleared from out here: the body can finish synchronously, and clearing it
		// inside would run before this assignment and leave `starting` set forever.
		starting = pending;
		void pending.finally(() => {
			if (starting === pending) starting = undefined;
		});
		return pending;
	}

	async function arm(editor: DictationEditor): Promise<void> {
		await settled();
		if (!recording) await start(editor);
		const item = recording;
		if (!item) return;
		item.armed = true;
		item.armedAt = Date.now();
		editor.setDictationState("recording");

		const token = generation;
		try {
			// Usually already resolved: the session started connecting at prespawn.
			await item.sessionPending;
		} catch (error) {
			notify(`Dictation failed: ${errorText(error)}`, "error");
			void discard();
			return;
		}
		if (token !== generation) return;
		// Release the audio that was held back while the hold was unconfirmed. If
		// the session opened after arming, its own open path already flushed.
		if (item.session) for (const chunk of item.buffered.splice(0)) item.session.push(chunk);

		maxTimer.set(MAX_RECORDING_MS, () => {
			notify("Dictation stopped at 5-minute limit", "warning");
			void stop(editor);
		});
	}

	async function take(): Promise<Recording | undefined> {
		await settled();
		const item = recording;
		if (!item) return undefined;
		recording = undefined;
		maxTimer.clear();
		return item;
	}

	async function discard(): Promise<void> {
		const item = await take();
		if (!item) return;
		stopChild(item.child, "SIGKILL");
		await closeSession(item);
	}

	async function stop(editor?: DictationEditor): Promise<void> {
		await settled();
		if (recording && !recording.armed) return discard();
		const item = await take();
		if (!item) return;

		const token = generation;
		stopChild(item.child);
		const grace = new Timer();
		await Promise.race([
			item.closed,
			new Promise<void>((resolve) => {
				grace.set(CLOSE_GRACE_MS, () => {
					stopChild(item.child, "SIGKILL");
					resolve();
				});
			}),
		]);
		grace.clear();

		// The session may still be opening if the hold was short.
		if (item.sessionPending) {
			try {
				await item.sessionPending;
			} catch {
			}
		}

		const session = item.session;
		if (!session || token !== generation || Date.now() - item.armedAt < MIN_RECORDING_MS) {
			session?.cancel();
			if (token === generation) editor?.setDictationState("idle");
			return;
		}

		transcribing = true;
		try {
			if (item.bytes < 1000) throw new Error(item.stderr.trim() || "microphone produced no audio");
			editor?.setDictationState("transcribing");

			const trailing = await session.finish();
			if (token !== generation) return;
			editor?.insertTranscription(trailing, !item.transcribed);
			if (!item.transcribed && !trailing) {
				notify("No speech detected", "warning");
				return;
			}
			editor?.endTranscription();
		} catch (error) {
			if (token === generation) notify(`Dictation failed: ${errorText(error)}`, "error");
		} finally {
			transcribing = false;
			if (token === generation) editor?.setDictationState("idle");
		}
	}

	type Hold = {
		phase: "pending" | "checking" | "passthrough" | "dictating";
		cursor?: { line: number; col: number };
		spaces: number;
	};

	let hold: Hold | undefined;
	const holdTimer = new Timer();
	const captureTimer = new Timer();

	function beginHold(editor: DictationEditor): void {
		if (hold) return;
		editor.insertTextAtCursor(" ");
		if (recording || transcribing || starting) return;

		const current: Hold = { phase: "pending", cursor: editor.getCursor(), spaces: 1 };
		hold = current;

		captureTimer.set(PRESPAWN_DELAY_MS, () => {
			if (hold === current) void start(editor);
		});
		holdTimer.set(HOLD_DELAY_MS, () => {
			if (hold !== current) return;
			current.phase = "checking";
			void modifierHeld().then((held) => {
				if (hold !== current) return;
				captureTimer.clear();
				if (held) {
					current.phase = "passthrough";
					current.spaces = 0;
					current.cursor = undefined;
					void discard();
					return;
				}
				current.phase = "dictating";
				if (current.cursor) editor.removePendingSpaces(current.spaces, current.cursor);
				current.spaces = 0;
				current.cursor = undefined;
				void arm(editor);
			});
		});
	}

	function repeatHold(editor: DictationEditor): void {
		if (!hold || hold.phase === "dictating") return;
		editor.insertTextAtCursor(" ");
		if (hold.phase === "passthrough") return;
		hold.spaces++;
		hold.cursor = editor.getCursor();
	}

	function endHold(editor: DictationEditor): void {
		const current = hold;
		resetHold();
		if (!current || current.phase === "passthrough") return;
		if (current.phase === "dictating") void stop(editor);
		else void discard();
	}

	function resetHold(): void {
		hold = undefined;
		holdTimer.clear();
		captureTimer.clear();
	}

	async function teardown(): Promise<void> {
		generation++;
		resetHold();
		maxTimer.clear();
		const item = await take();
		stopChild(item?.child, "SIGKILL");
		if (item) await closeSession(item);
		transcribing = false;
		currentEditor?.setDictationState("idle");
	}

	pi.on("session_start", (_event, context) => {
		ctx = context;
		if (context.mode !== "tui") return;
		if (!SUPPORTED) {
			if (enabled) notify("Dictation requires macOS (avfoundation/osascript); staying off", "warning");
			return;
		}
		context.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor: DictationEditor = new DictationEditor(
				tui,
				theme,
				keybindings,
				() => enabled,
				() => beginHold(editor),
				() => repeatHold(editor),
				() => endHold(editor),
			);
			currentEditor = editor;
			return editor;
		});
		if (enabled) warmUp();
	});

	pi.on("session_shutdown", async () => {
		await teardown();
		currentEditor?.dispose();
		currentEditor = undefined;
		ctx = undefined;
	});

	pi.registerCommand("dictate", {
		description: "Toggle dictation on/off, or pick streaming/batch/best transcription",
		handler: async (args, context) => {
			if (!SUPPORTED) {
				context.ui.notify("Dictation requires macOS", "warning");
				return;
			}
			const action = args.trim().toLowerCase();

			const nextMode: DictateMode | undefined =
				action === "streaming" || action === "stream"
					? "streaming"
					: action === "batch" || action === "non-streaming" || action === "nonstreaming"
						? "batch"
						: action === "best" || action === "quality" || action === "4o"
							? "best"
							: undefined;
			if (nextMode) {
				if (nextMode === mode) {
					context.ui.notify(`Dictation already in ${mode} mode`, "info");
					return;
				}
				mode = nextMode;
				try {
					writeState({ enabled, mode });
				} catch (error) {
					context.ui.notify(`Dictation mode changed but was not saved: ${errorText(error)}`, "warning");
				}
				context.ui.notify(
					mode === "streaming"
						? "Dictation mode: streaming (text appears as you speak)"
						: mode === "batch"
							? "Dictation mode: batch (mini model, text after release)"
							: "Dictation mode: best (gpt-4o-transcribe, text after release)",
					"info",
				);
				return;
			}

			if (action && action !== "on" && action !== "off") {
				context.ui.notify("Use /dictate, /dictate on|off, or /dictate streaming|batch|best", "warning");
				return;
			}

			const nextEnabled = action === "on" ? true : action === "off" ? false : !enabled;
			if (nextEnabled === enabled) {
				context.ui.notify(enabled ? "Dictation already on" : "Dictation already off", "info");
				return;
			}
			enabled = nextEnabled;
			try {
				writeState({ enabled, mode });
			} catch (error) {
				context.ui.notify(`Dictation changed but state was not saved: ${errorText(error)}`, "warning");
			}

			if (enabled) {
				currentEditor?.setDictationState("idle");
				warmUp();
				context.ui.notify("Dictation on", "info");
				return;
			}

			await teardown();
			context.ui.notify("Dictation off", "info");
		},
	});
}
