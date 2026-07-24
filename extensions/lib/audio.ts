// Shared realtime audio stack for the voice extensions (/talk, /translate,
// /say, /dictate): 24 kHz mono PCM16 in and out, with either the Swift AEC
// helper (~/.pi/agent/assets/talk/talk-audio, compiled from talk-audio.swift on
// demand) for full-duplex speaker use, or an ffmpeg/ffplay half-duplex
// fallback.

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { clip, errorText } from "./util.ts";

/** The realtime API only accepts 24 kHz PCM16. */
export const SAMPLE_RATE = 24000;
/** Upstream clients stream 960-sample (40 ms) mono PCM16 frames = 1920 bytes. */
export const MIC_FRAME_BYTES = 960 * 2;
// Longest gap in the mic stream treated as normal. Capture is continuous — even
// silence arrives as frames — so this only has to clear the ~300 ms the helper
// takes to rebuild its engine when the audio route changes.
const MIC_STALL_MS = 4000;

const TALK_DIR = join(getAgentDir(), "assets", "talk");
const AEC_SOURCE = join(TALK_DIR, "talk-audio.swift");
const AEC_BINARY = join(TALK_DIR, "talk-audio");

export function findBinary(name: string): string {
	return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ?? name;
}

/**
 * avfoundation addresses capture devices by enumeration index, which is not the
 * system default input and shifts as devices come and go — a Continuity iPhone,
 * a USB interface or a virtual device can take index 0, and capturing the wrong
 * microphone succeeds silently. Accept a name (or part of one) as well and look
 * its index up, so a device can be named rather than guessed at.
 */
export function resolveAudioDevice(device: string): string {
	if (/^\d+$/.test(device)) return device;
	const wanted = device.toLowerCase();
	// ffmpeg prints the listing to stderr and exits non-zero by design.
	let listing = "";
	try {
		const args = ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""];
		listing = execFileSync(findBinary("ffmpeg"), args, {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (error) {
		listing = String((error as { stderr?: unknown })?.stderr ?? "");
	}
	let inAudio = false;
	for (const line of listing.split("\n")) {
		if (/AVFoundation (audio|video) devices:/.test(line)) {
			inAudio = line.includes("audio");
			continue;
		}
		const match = inAudio ? /\[(\d+)\]\s+(.+?)\s*$/.exec(line) : undefined;
		if (match && match[2]!.toLowerCase().includes(wanted)) return match[1]!;
	}
	return device;
}

/** Playback duration of a PCM16 mono chunk at SAMPLE_RATE, in milliseconds. */
export function pcmChunkMs(buf: Buffer): number {
	return (buf.length / 2 / SAMPLE_RATE) * 1000;
}

export type MicFrameHandler = (frame: Buffer) => void;

/** Rechunks an arbitrary PCM stream into MIC_FRAME_BYTES frames. */
export function reframeMic(onFrame: MicFrameHandler): (chunk: Buffer) => void {
	let pending: Buffer = Buffer.alloc(0);
	return (chunk: Buffer) => {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		while (pending.length >= MIC_FRAME_BYTES) {
			onFrame(pending.subarray(0, MIC_FRAME_BYTES));
			pending = pending.subarray(MIC_FRAME_BYTES);
		}
	};
}

const FFPLAY_ARGS = [
	"-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
	"-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-sync", "audio",
	"-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "mono", "-i", "pipe:0",
];

/**
 * PCM16 playback through an ffplay pipe. ffplay exits when its buffer drains;
 * `eager` respawns a fresh player immediately on close (live sessions), the
 * default respawns lazily on the next play() (one-shot playback).
 */
export class FfplayPipe {
	private child?: ChildProcess;
	private stopped = false;

	constructor(private readonly eager = false) {}

	/** Spawn the player ahead of the first chunk. */
	prime(): void {
		if (!this.stopped && (!this.child || this.child.stdin?.destroyed)) this.spawnPlayer();
	}

	play(buf: Buffer): void {
		if (this.stopped) return;
		this.prime();
		this.child?.stdin?.write(buf);
	}

	/** Drop all buffered playback immediately (barge-in). */
	flush(): void {
		const dead = this.child;
		this.child = undefined;
		if (dead) {
			try {
				dead.stdin?.destroy();
			} catch {}
			dead.kill("SIGKILL");
		}
		if (this.eager && !this.stopped) this.spawnPlayer();
	}

	stop(): void {
		this.stopped = true;
		try {
			this.child?.stdin?.end();
		} catch {}
		this.child?.kill("SIGKILL");
	}

	private spawnPlayer(): void {
		this.child = spawn(findBinary("ffplay"), FFPLAY_ARGS, { stdio: ["pipe", "ignore", "ignore"] });
		this.child.stdin?.on("error", () => {});
		// findBinary falls back to a bare name, so a machine without ffplay emits
		// ENOENT here; unhandled, that takes the whole agent down.
		this.child.on("error", () => {});
		this.child.on("close", () => {
			if (this.stopped) return;
			this.child = undefined;
			if (this.eager) this.spawnPlayer();
		});
	}
}

export interface AudioIO {
	/**
	 * True when the mic stream is echo-cancelled and can stay open during
	 * playback. Only known once start() has resolved: the AEC helper reports
	 * whether the voice-processing unit actually came up.
	 */
	readonly echoCancelled: boolean;
	start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void>;
	play(buf: Buffer): void;
	/** Drop all buffered playback immediately (barge-in). */
	flush(): void;
	stop(): void;
}

/** Full-duplex capture+playback through the Swift AEC helper. */
export class AecAudio implements AudioIO {
	/** Not known until the helper's ready line says whether VP came up. */
	echoCancelled = false;
	private child?: ChildProcess;
	private stopped = false;
	private lastFrameAt = 0;
	private watchdog?: ReturnType<typeof setInterval>;

	async start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void> {
		const child = spawn(AEC_BINARY, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		child.stdin?.on("error", () => {});
		const reframe = reframeMic(onFrame);
		child.stdout?.on("data", (chunk: Buffer) => {
			this.lastFrameAt = Date.now();
			reframe(chunk);
		});
		// Keep only the tail: this accumulates for the life of the session, and
		// all anyone reads off it is the last line.
		let stderr = "";
		const note = (chunk: unknown) => {
			stderr = (stderr + String(chunk)).slice(-4096);
		};
		const lastLine = (code: number | null) =>
			stderr.trim().split("\n").pop() || `audio helper exited (${code})`;
		// Whichever of ready / failure lands first settles start(); afterwards
		// only onFatal is left, so a startup failure is reported exactly once.
		let settled = false;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error("audio helper did not become ready"));
			}, 5000);
			child.stderr?.on("data", (chunk) => {
				note(chunk);
				// Match only a complete line: a chunk boundary between "ready"
				// and its " aec=0" would otherwise read as cancellation working.
				const ready = /\bready(?: aec=([01]))? *\n/.exec(stderr);
				if (!ready || settled) return;
				settled = true;
				// aec=0 means voice processing failed to initialise: the mic is
				// live but not cancelled, so the caller has to gate it while the
				// assistant speaks or the speakers feed straight back in.
				this.echoCancelled = ready[1] !== "0";
				this.lastFrameAt = Date.now();
				clearTimeout(timer);
				resolve();
			});
			// spawn itself can fail (helper deleted between build and run).
			child.on("error", (error) => {
				note(error.message);
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new Error(`audio helper failed to start: ${error.message}`));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (!settled) {
					settled = true;
					reject(new Error(lastLine(code)));
					return;
				}
				if (!this.stopped) onFatal(lastLine(code));
			});
		});

		// The helper can also stay alive and go deaf — a wedged voice-processing
		// unit, or a device swap it failed to recover from. Silence is still
		// frames, so a gap in the stream at all means capture has stopped.
		this.watchdog = setInterval(() => {
			if (this.stopped || !this.lastFrameAt) return;
			if (Date.now() - this.lastFrameAt < MIC_STALL_MS) return;
			this.lastFrameAt = 0;
			onFatal("microphone stopped delivering audio");
		}, 1000);
		this.watchdog.unref?.();
	}

	play(buf: Buffer): void {
		this.child?.stdin?.write(buf);
	}

	flush(): void {
		if (this.child && this.child.exitCode === null) this.child.kill("SIGUSR1");
	}

	stop(): void {
		this.stopped = true;
		if (this.watchdog) clearInterval(this.watchdog);
		try {
			this.child?.stdin?.end();
		} catch {}
		this.child?.kill("SIGKILL");
	}
}

/** Half-duplex fallback: ffmpeg avfoundation capture + ffplay playback. */
export class FfmpegAudio implements AudioIO {
	readonly echoCancelled = false;
	private capture?: ChildProcess;
	private readonly player = new FfplayPipe(true);
	private stopped = false;

	constructor(private readonly device: string) {}

	async start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void> {
		this.capture = spawn(
			findBinary("ffmpeg"),
			[
				"-hide_banner", "-loglevel", "error",
				"-f", "avfoundation", "-i", `:${resolveAudioDevice(this.device)}`,
				"-ac", "1", "-ar", String(SAMPLE_RATE),
				"-f", "s16le", "pipe:1",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.capture.stdout?.on("data", reframeMic(onFrame));
		// Without ffmpeg on PATH this is an unhandled ENOENT, which is fatal to
		// the agent rather than to the audio session.
		this.capture.on("error", (error) => {
			if (!this.stopped) onFatal(`microphone capture failed: ${error.message}`);
		});
		this.capture.on("close", (code) => {
			if (!this.stopped) onFatal(`microphone capture ended unexpectedly (code ${code})`);
		});
		this.player.prime();
	}

	play(buf: Buffer): void {
		this.player.play(buf);
	}

	flush(): void {
		this.player.flush();
	}

	stop(): void {
		this.stopped = true;
		this.capture?.kill("SIGKILL");
		this.player.stop();
	}
}

/**
 * Preferred audio backend: the AEC helper (compiling it first when the source
 * is newer than the binary), falling back to ffmpeg/ffplay half-duplex when
 * disabled, missing, or failing to build.
 */
export async function ensureAecAudio(
	notify: (message: string) => void,
	options: { disable?: boolean; device?: string } = {},
): Promise<AudioIO> {
	const device = options.device ?? "0";
	if (options.disable || !existsSync(AEC_SOURCE)) return new FfmpegAudio(device);
	const stale = !existsSync(AEC_BINARY) || statSync(AEC_BINARY).mtimeMs < statSync(AEC_SOURCE).mtimeMs;
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
			return new FfmpegAudio(device);
		}
	}
	return new AecAudio();
}
