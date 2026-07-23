import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
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

const MODEL = process.env.PI_DICTATE_MODEL?.trim() || "mlx-community/whisper-large-v3-turbo";
const STATE_PATH = join(getAgentDir(), "dictate.json");
const MAX_RECORDING_MS = 5 * 60 * 1000;
const HOLD_DELAY_MS = 500;
const PRESPAWN_DELAY_MS = 120;
const MIN_RECORDING_MS = 150;
const CLOSE_GRACE_MS = 400;
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000;
const STDERR_TAIL = 4000;
const IDLE_UNLOAD_MS = (() => {
	const configured = Number.parseInt(process.env.PI_DICTATE_IDLE_MS ?? "", 10);
	return Number.isFinite(configured) ? configured : 10 * 60 * 1000;
})();

const RECORDING_FRAMES = ["▁▁▂▃▂▁▁", "▁▂▃▅▃▂▁", "▂▃▅▇▅▃▂", "▃▅▇█▇▅▃", "▂▃▅▇▅▃▂", "▁▂▃▅▃▂▁"];
const TRANSCRIBING_FRAMES = ["·  ", "·· ", "···"];

type DictationState = "idle" | "recording" | "transcribing";

type Recording = {
	child: ChildProcess;
	dir: string;
	wavPath: string;
	armedAt: number;
	armed: boolean;
	stderr: string;
	closed: Promise<void>;
};

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
const MLX_WHISPER = executable("PI_DICTATE_MLX_WHISPER", "mlx_whisper", [
	join(homedir(), ".local/bin/mlx_whisper"),
]);
const AUDIO_DEVICE = process.env.PI_DICTATE_AUDIO_DEVICE?.trim() || "0";

const PYTHON = (() => {
	const configured = process.env.PI_DICTATE_PYTHON?.trim();
	if (configured) return configured;
	try {
		const head = readFileSync(realpathSync(MLX_WHISPER), "utf8").slice(0, 256);
		const interpreter = /^#!\s*(\S+)/.exec(head.split("\n")[0] ?? "")?.[1];
		if (interpreter && existsSync(interpreter)) return interpreter;
	} catch {
	}
	return "python3";
})();

const WORKER_SOURCE = String.raw`
import json, os, sys

out = os.fdopen(os.dup(1), "w")
os.dup2(2, 1)

def emit(payload):
    out.write(json.dumps(payload) + "\n")
    out.flush()

def transcribe(audio):
    return mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=model,
        language="en",
        task="transcribe",
        temperature=0.0,
        condition_on_previous_text=False,
        verbose=False,
    )

def is_silent(path):
    with wave.open(path) as handle:
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)
    return not samples.size or float(np.abs(samples).max()) / 32768.0 < silence_peak

try:
    import wave

    import numpy as np
    import mlx_whisper

    model = os.environ["PI_DICTATE_MODEL"]
    silence_peak = float(os.environ.get("PI_DICTATE_SILENCE_PEAK", "0.02"))
    transcribe(np.zeros(16000, dtype=np.float32))
except Exception as error:
    emit({"fatal": str(error)})
    sys.exit(1)

emit({"ready": True})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    request_id = request.get("id")
    try:
        path = request["path"]
        text = "" if is_silent(path) else (transcribe(path).get("text") or "").strip()
        emit({"id": request_id, "text": text})
    except Exception as error:
        emit({"id": request_id, "error": str(error)})
`;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function tail(existing: string, chunk: unknown): string {
	return (existing + String(chunk)).slice(-STDERR_TAIL);
}

function onLines(stream: NodeJS.ReadableStream | null | undefined, handler: (line: string) => void): void {
	let buffer = "";
	stream?.on("data", (chunk) => {
		buffer += String(chunk);
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const line = part.trim();
			if (line) handler(line);
		}
	});
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

function readEnabled(): boolean {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8")).enabled === true;
	} catch {
		return false;
	}
}

function writeEnabled(enabled: boolean): void {
	writeFileSync(STATE_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
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

	insertTranscription(text: string): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const needsLeadingSpace = cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "");
		this.insertTextAtCursor(`${needsLeadingSpace ? " " : ""}${text} `);
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
	let enabled = readEnabled();
	let currentEditor: DictationEditor | undefined;
	let ctx: ExtensionContext | undefined;
	let generation = 0;

	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	};

	const stopChild = (child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGINT") => {
		if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
	};


	type Pending = { resolve: (text: string) => void; reject: (error: Error) => void };
	type Worker = {
		child: ChildProcess;
		ready: Promise<void>;
		pending: Map<number, Pending>;
		stderr: string;
	};

	let worker: Worker | undefined;
	let nextRequestId = 1;
	const idleTimer = new Timer();

	function disposeWorker(reason: string): void {
		const current = worker;
		worker = undefined;
		idleTimer.clear();
		if (!current) return;
		for (const pending of current.pending.values()) pending.reject(new Error(reason));
		current.pending.clear();
		stopChild(current.child, "SIGKILL");
	}

	function scheduleIdleUnload(): void {
		idleTimer.clear();
		if (IDLE_UNLOAD_MS > 0) idleTimer.set(IDLE_UNLOAD_MS, () => disposeWorker("idle"), true);
	}

	function spawnWorker(): Worker {
		const child = spawn(PYTHON, ["-u", "-c", WORKER_SOURCE], {
			env: {
				...process.env,
				HF_HUB_OFFLINE: "1",
				PI_DICTATE_MODEL: MODEL,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		ready.catch(() => {});

		const item: Worker = { child, ready, pending: new Map(), stderr: "" };

		const fail = (reason: string) => {
			rejectReady(new Error(reason));
			for (const pending of item.pending.values()) pending.reject(new Error(reason));
			item.pending.clear();
			if (worker === item) worker = undefined;
		};

		onLines(child.stdout, (line) => {
			let message: { ready?: boolean; fatal?: string; id?: number; text?: string; error?: string };
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.ready) return resolveReady();
			if (message.fatal) return rejectReady(new Error(message.fatal));
			if (typeof message.id !== "number") return;
			const pending = item.pending.get(message.id);
			if (!pending) return;
			item.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error));
			else pending.resolve(message.text ?? "");
		});
		child.stderr?.on("data", (chunk) => (item.stderr = tail(item.stderr, chunk)));
		child.stdin?.on("error", () => {});
		child.once("error", (error) => fail(error.message));
		child.once("close", (code, signal) => {
			fail(item.stderr.trim().split("\n").pop() || `transcriber exited ${code ?? signal}`);
		});
		return item;
	}

	function ensureWorker(): Worker {
		if (!worker) worker = spawnWorker();
		scheduleIdleUnload();
		return worker;
	}

	function warmUp(): void {
		ensureWorker().ready.catch(() => {});
		void modifierHeld();
	}

	async function transcribe(wavPath: string): Promise<string> {
		const item = ensureWorker();
		await item.ready;
		return new Promise<string>((resolve, reject) => {
			if (item.child.exitCode !== null || item.child.signalCode !== null) {
				reject(new Error("transcriber is not running"));
				return;
			}
			const id = nextRequestId++;
			const timer = setTimeout(() => {
				item.pending.delete(id);
				if (worker === item) disposeWorker("timeout");
				reject(new Error("transcription timed out"));
			}, TRANSCRIBE_TIMEOUT_MS);
			item.pending.set(id, {
				resolve: (text) => {
					clearTimeout(timer);
					scheduleIdleUnload();
					resolve(text);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			item.child.stdin?.write(`${JSON.stringify({ id, path: wavPath })}\n`);
		});
	}


	let recording: Recording | undefined;
	let starting: Promise<void> | undefined;
	let transcribing = false;
	const maxTimer = new Timer();

	async function settled(): Promise<void> {
		while (starting) await starting;
	}

	function start(editor: DictationEditor): Promise<void> {
		if (starting) return settled();
		if (recording || transcribing) return Promise.resolve();
		const token = generation;

		starting = (async () => {
			let dir: string | undefined;
			try {
				dir = await mkdtemp(join(tmpdir(), "pi-dictate-"));
				if (token !== generation) return;
				const wavPath = join(dir, "speech.wav");
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
						"16000",
						"-y",
						wavPath,
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);

				const item: Recording = {
					child,
					dir,
					wavPath,
					armedAt: Date.now(),
					armed: false,
					stderr: "",
					closed: new Promise((resolve) => child.once("close", () => resolve())),
				};
				child.stderr?.on("data", (chunk) => (item.stderr = tail(item.stderr, chunk)));
				child.once("error", (error) => {
					if (recording !== item) return;
					recording = undefined;
					maxTimer.clear();
					editor.setDictationState("idle");
					notify(`Dictation recorder failed: ${error.message}`, "error");
					void rm(item.dir, { recursive: true, force: true });
				});

				if (token !== generation) {
					stopChild(child, "SIGKILL");
					return;
				}
				recording = item;
				dir = undefined;
			} catch (error) {
				editor.setDictationState("idle");
				if (token === generation) notify(`Could not start dictation: ${errorText(error)}`, "error");
			} finally {
				starting = undefined;
				if (dir) await rm(dir, { recursive: true, force: true });
			}
		})();
		return starting;
	}

	async function arm(editor: DictationEditor): Promise<void> {
		await settled();
		if (!recording) await start(editor);
		const item = recording;
		if (!item) return;
		item.armed = true;
		item.armedAt = Date.now();
		editor.setDictationState("recording");
		maxTimer.set(MAX_RECORDING_MS, () => {
			notify("Dictation stopped at 5-minute limit", "warning");
			void stop(editor);
		});
		warmUp();
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
		await rm(item.dir, { recursive: true, force: true });
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

		if (token !== generation || Date.now() - item.armedAt < MIN_RECORDING_MS) {
			if (token === generation) editor?.setDictationState("idle");
			await rm(item.dir, { recursive: true, force: true });
			return;
		}

		transcribing = true;
		try {
			const info = await stat(item.wavPath);
			if (info.size < 1000) throw new Error(item.stderr.trim() || "microphone produced no audio");
			editor?.setDictationState("transcribing");

			const text = await transcribe(item.wavPath);
			if (token !== generation) return;
			if (!text) {
				notify("No speech detected", "warning");
				return;
			}
			editor?.insertTranscription(text);
		} catch (error) {
			if (token === generation) notify(`Dictation failed: ${errorText(error)}`, "error");
		} finally {
			transcribing = false;
			if (token === generation) editor?.setDictationState("idle");
			await rm(item.dir, { recursive: true, force: true });
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
		if (transcribing) disposeWorker("cancelled");
		transcribing = false;
		currentEditor?.setDictationState("idle");
		if (item) await rm(item.dir, { recursive: true, force: true });
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
		disposeWorker("shutdown");
		currentEditor?.dispose();
		currentEditor = undefined;
		ctx = undefined;
	});

	pi.registerCommand("dictate", {
		description: "Toggle dictation, or explicitly turn it on/off",
		handler: async (args, context) => {
			if (!SUPPORTED) {
				context.ui.notify("Dictation requires macOS", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action && action !== "on" && action !== "off") {
				context.ui.notify("Use /dictate, /dictate on, or /dictate off", "warning");
				return;
			}

			const nextEnabled = action === "on" ? true : action === "off" ? false : !enabled;
			if (nextEnabled === enabled) {
				context.ui.notify(enabled ? "Dictation already on" : "Dictation already off", "info");
				return;
			}
			enabled = nextEnabled;
			try {
				writeEnabled(enabled);
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
			disposeWorker("disabled");
			context.ui.notify("Dictation off", "info");
		},
	});
}
