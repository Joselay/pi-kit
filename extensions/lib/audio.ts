// Shared realtime audio stack for the voice extensions (/talk, /translate,
// /say, /dictate): 24 kHz mono PCM16 in and out, with either the Swift AEC
// helper (~/.pi/agent/assets/talk/talk-audio, compiled from talk-audio.swift on
// demand) for full-duplex speaker use, or an ffmpeg/ffplay half-duplex
// fallback.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { clip, errorText } from "./util.ts";

/** The realtime API only accepts 24 kHz PCM16. */
export const SAMPLE_RATE = 24000;
/** Upstream clients stream 960-sample (40 ms) mono PCM16 frames = 1920 bytes. */
export const MIC_FRAME_BYTES = 960 * 2;

const TALK_DIR = join(getAgentDir(), "assets", "talk");
const AEC_SOURCE = join(TALK_DIR, "talk-audio.swift");
const AEC_BINARY = join(TALK_DIR, "talk-audio");

export function findBinary(name: string): string {
	return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ?? name;
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
		this.child.on("close", () => {
			if (this.stopped) return;
			this.child = undefined;
			if (this.eager) this.spawnPlayer();
		});
	}
}

export interface AudioIO {
	/** True when the mic stream is echo-cancelled and can stay open during playback. */
	readonly echoCancelled: boolean;
	start(onFrame: MicFrameHandler, onFatal: (message: string) => void): Promise<void>;
	play(buf: Buffer): void;
	/** Drop all buffered playback immediately (barge-in). */
	flush(): void;
	stop(): void;
}

/** Full-duplex capture+playback through the Swift AEC helper. */
export class AecAudio implements AudioIO {
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
				"-f", "avfoundation", "-i", `:${this.device}`,
				"-ac", "1", "-ar", String(SAMPLE_RATE),
				"-f", "s16le", "pipe:1",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.capture.stdout?.on("data", reframeMic(onFrame));
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
