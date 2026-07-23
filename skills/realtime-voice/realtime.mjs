#!/usr/bin/env node

// Live voice conversation over the OpenAI Realtime API, authenticated with the
// pi `openai-codex` OAuth subscription (no API key). Mirrors the web-search and
// imagegen skills: OAuth is the only credential and it is resolved through pi's
// ModelRuntime. Audio capture and playback go through ffmpeg/ffplay.
//
// The realtime WebSocket endpoint (wss://api.openai.com/v1/realtime) accepts the
// ChatGPT OAuth bearer directly -- the token's audience is api.openai.com/v1 --
// so no WebRTC/SDP negotiation is required.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER_ID = "openai-codex";
const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "marin";
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const SAMPLE_RATE = 24000;
// Upstream Codex clients stream 960-sample (40 ms) mono PCM16 frames = 1920 bytes.
const MIC_FRAME_BYTES = 960 * 2;

function usage() {
  console.log(`Usage:
  realtime.mjs [options]

A live, hands-free voice conversation. Speak into the mic; the model replies with
voice. Server-side voice-activity detection decides when you have finished a turn.
Press Ctrl-C to end.

Options:
  --model <id>            Realtime model (default: ${DEFAULT_MODEL})
  --voice <name>          Output voice, e.g. marin, cedar, alloy (default: ${DEFAULT_VOICE})
  --instructions <text>   System instructions for the assistant
  --instructions-file <p> Read instructions from a file
  --device <index>        avfoundation audio input index (default: 0)
  --transcribe-model <id> Input transcription model (default: ${DEFAULT_TRANSCRIBE_MODEL})
  --full-duplex           Keep the mic open while the assistant speaks (needs
                          headphones; default is half-duplex to avoid feedback)
  --text <text>           Send one text message, speak the reply, then exit
  --debug                 Print every realtime event
  --help                  Show this help`);
}

function fail(message) {
  console.error(`realtime-voice: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    voice: DEFAULT_VOICE,
    instructions: undefined,
    instructionsFile: undefined,
    device: "0",
    transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
    fullDuplex: false,
    text: undefined,
    debug: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--full-duplex") {
      args.fullDuplex = true;
      continue;
    }
    if (arg === "--debug") {
      args.debug = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`missing value for ${arg}`);
    switch (arg) {
      case "--model":
        args.model = value;
        break;
      case "--voice":
        args.voice = value;
        break;
      case "--instructions":
        args.instructions = value;
        break;
      case "--instructions-file":
        args.instructionsFile = value;
        break;
      case "--device":
        args.device = value;
        break;
      case "--transcribe-model":
        args.transcribeModel = value;
        break;
      case "--text":
        args.text = value;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function locatePiIndex() {
  const explicit = process.env.PI_CODING_AGENT_MODULE;
  if (explicit) return explicit;
  let piExecutable;
  try {
    piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    fail("could not locate the pi executable; set PI_CODING_AGENT_MODULE to pi's dist/index.js");
  }
  if (!piExecutable) fail("could not locate the pi executable");
  return join(dirname(realpathSync(piExecutable)), "index.js");
}

// Resolve a fresh OAuth token through pi's runtime (handles refresh), exactly
// like the web-search skill. Falls back to nothing else: OAuth or bust.
async function resolveOAuth() {
  const moduleUrl = pathToFileURL(locatePiIndex()).href;
  const { ModelRuntime } = await import(moduleUrl);
  const runtime = await ModelRuntime.create();

  const authCheck = await runtime.checkAuth(PROVIDER_ID);
  if (!runtime.isUsingOAuth(PROVIDER_ID) || authCheck?.type !== "oauth") {
    fail("realtime voice needs openai-codex OAuth; run /login in pi");
  }
  const result = await runtime.getAuth(PROVIDER_ID);
  const token = result?.auth?.apiKey;
  if (!token) fail("could not resolve OAuth token; run /login again");
  return { token };
}

function accountIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function ffmpegBin() {
  return ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync) ?? "ffmpeg";
}
function ffplayBin() {
  return ["/opt/homebrew/bin/ffplay", "/usr/local/bin/ffplay"].find(existsSync) ?? "ffplay";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") {
    fail("this helper captures audio via avfoundation and currently supports macOS only");
  }
  if (args.instructions && args.instructionsFile) {
    fail("provide at most one of --instructions or --instructions-file");
  }
  const instructions = args.instructionsFile
    ? (await readFile(resolve(args.instructionsFile), "utf8")).trim()
    : args.instructions;

  const { token } = await resolveOAuth();
  const accountId = accountIdFromToken(token);

  const url = `${REALTIME_URL}?model=${encodeURIComponent(args.model)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    originator: "pi",
    "user-agent": `pi-realtime-voice (${process.platform}; ${process.arch})`,
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const ws = new WebSocket(url, { headers });

  let ffCapture; // mic -> PCM16
  let ffPlay; // PCM16 -> speaker
  let closing = false;
  let playedBytes = 0; // total PCM bytes handed to ffplay this response
  let firstChunkAt = 0;
  let playbackEndsAt = 0; // wall-clock time the buffered audio finishes playing

  const PLAYBACK_TAIL_MS = 250; // keep mic muted a beat past playback end
  // True while the assistant's audio is (or is still buffered to be) playing.
  // Based on real audio duration, not delta arrival, so half-duplex keeps the
  // mic muted through the whole spoken reply instead of reopening mid-sentence.
  const isPlaying = () => Date.now() < playbackEndsAt + PLAYBACK_TAIL_MS;

  const log = (...a) => console.error(...a);
  const debug = (...a) => args.debug && console.error("[evt]", ...a);

  function startPlayback() {
    ffPlay = spawn(
      ffplayBin(),
      [
        "-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
        "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-sync", "audio",
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "mono", "-i", "pipe:0",
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    ffPlay.stdin.on("error", () => {});
    ffPlay.on("close", () => {
      if (!closing) startPlayback(); // ffplay exits when its buffer drains; respawn
    });
  }

  function playChunk(buf) {
    if (!ffPlay || ffPlay.stdin.destroyed) startPlayback();
    ffPlay.stdin.write(buf);
    const now = Date.now();
    if (!firstChunkAt) firstChunkAt = now;
    playedBytes += buf.length;
    // Anchor the playback clock to whichever is later: when audio started, or
    // where the buffer currently reaches. Then extend by this chunk's duration.
    const chunkMs = (buf.length / 2 / SAMPLE_RATE) * 1000;
    playbackEndsAt = Math.max(playbackEndsAt, firstChunkAt, now) + chunkMs;
  }

  // Barge-in: drop everything already queued in ffplay so the assistant goes
  // silent the instant the user starts talking. Killing ffplay discards its
  // internal buffer; the close handler respawns a fresh, empty player.
  function flushPlayback() {
    playbackEndsAt = 0;
    if (ffPlay && !ffPlay.killed) {
      const dead = ffPlay;
      ffPlay = undefined;
      try { dead.stdin.destroy(); } catch {}
      dead.kill("SIGKILL");
    }
    startPlayback();
  }

  function startCapture() {
    ffCapture = spawn(
      ffmpegBin(),
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "avfoundation", "-i", `:${args.device}`,
        "-ac", "1", "-ar", String(SAMPLE_RATE),
        "-f", "s16le", "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    ffCapture.stderr.on("data", (d) => args.debug && log("[mic]", String(d).trim()));
    // Reframe the mic stream into steady 40 ms / 960-sample (1920-byte) chunks,
    // matching the chunk size upstream Codex clients send, for smooth server VAD.
    let micBuf = Buffer.alloc(0);
    ffCapture.stdout.on("data", (chunk) => {
      micBuf = micBuf.length ? Buffer.concat([micBuf, chunk]) : chunk;
      while (micBuf.length >= MIC_FRAME_BYTES) {
        const frame = micBuf.subarray(0, MIC_FRAME_BYTES);
        micBuf = micBuf.subarray(MIC_FRAME_BYTES);
        if (ws.readyState !== WebSocket.OPEN) continue;
        // Half-duplex: drop mic frames while the assistant is speaking to avoid a
        // speaker->mic feedback loop (unless the user has headphones). Upstream
        // relies on client-side echo cancellation instead; this is the fallback.
        if (!args.fullDuplex && isPlaying()) continue;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: frame.toString("base64") }));
      }
    });
    ffCapture.on("close", (code) => {
      if (!closing) fail(`microphone capture ended unexpectedly (code ${code})`);
    });
  }

  const sessionConfig = {
    type: "session.update",
    session: {
      type: "realtime",
      model: args.model,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          // Upstream (Codex) enables near-field noise reduction so server VAD
          // isn't tripped by background/speaker noise.
          noise_reduction: { type: "near_field" },
          transcription: { model: args.transcribeModel },
          // Server VAD with interrupt_response lets the model be cut off the
          // moment the user speaks (barge-in), matching Codex's realtime config.
          turn_detection: {
            type: "server_vad",
            interrupt_response: true,
            create_response: true,
            silence_duration_ms: 500,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          voice: args.voice,
        },
      },
      ...(instructions ? { instructions } : {}),
    },
  };

  // Track which speaker's line is mid-stream so deltas print token-by-token and
  // we only emit a prefix/newline at line boundaries.
  let openLine = null; // "you" | "asst" | null
  let currentItemId; // assistant audio item currently being played, for truncation
  // Whether any incremental transcript was already streamed this turn, so the
  // ".done"/".completed" full-transcript fallback doesn't reprint the line when
  // an interleaved transcript (e.g. speaker echo) reset the open line.
  let asstStreamed = false;
  let userStreamed = false;

  function streamDelta(who, prefix, text) {
    if (!text) return;
    if (openLine !== who) {
      if (openLine) process.stdout.write("\n");
      process.stdout.write(prefix);
      openLine = who;
    }
    process.stdout.write(text);
  }
  function endLine(who) {
    if (openLine === who) {
      process.stdout.write("\n");
      openLine = null;
    }
  }

  ws.addEventListener("open", () => {
    log(`\x1b[2m● connected — model ${args.model}, voice ${args.voice}\x1b[0m`);
    ws.send(JSON.stringify(sessionConfig));
    startPlayback();
    if (args.text !== undefined) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: args.text }] },
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    } else {
      startCapture();
      log("\x1b[2m● listening — just start talking. Ctrl-C to stop.\x1b[0m");
    }
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      return;
    }
    debug(msg.type);
    switch (msg.type) {
      case "response.created":
        // New reply: reset per-response playback accounting.
        playedBytes = 0;
        firstChunkAt = 0;
        asstStreamed = false;
        break;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (msg.item_id) currentItemId = msg.item_id;
        if (msg.delta) playChunk(Buffer.from(msg.delta, "base64"));
        break;
      }
      case "input_audio_buffer.speech_started": {
        // The user started talking mid-reply -> barge-in. Stop local playback
        // immediately and tell the server to truncate the assistant item to only
        // what was actually heard, so the model's memory stays consistent.
        if (isPlaying() || currentItemId) {
          const audioEndMs = Math.round((playedBytes / 2 / SAMPLE_RATE) * 1000);
          if (currentItemId) {
            ws.send(JSON.stringify({
              type: "conversation.item.truncate",
              item_id: currentItemId,
              content_index: 0,
              audio_end_ms: audioEndMs,
            }));
          }
          flushPlayback();
          endLine("asst");
          currentItemId = undefined;
        }
        break;
      }
      case "conversation.item.input_audio_transcription.delta":
        if (msg.delta) userStreamed = true;
        streamDelta("you", "\x1b[36myou:\x1b[0m ", msg.delta ?? "");
        break;
      case "conversation.item.input_audio_transcription.completed":
        // Only print the full transcript if nothing was streamed for this turn.
        if (!userStreamed && msg.transcript) streamDelta("you", "\x1b[36myou:\x1b[0m ", msg.transcript.trim());
        endLine("you");
        userStreamed = false;
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (msg.delta) asstStreamed = true;
        streamDelta("asst", "\x1b[32masst:\x1b[0m ", msg.delta ?? "");
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (!asstStreamed && msg.transcript) streamDelta("asst", "\x1b[32masst:\x1b[0m ", msg.transcript.trim());
        endLine("asst");
        asstStreamed = false;
        break;
      case "response.done":
        if (args.text !== undefined) {
          // one-shot: wait for the buffered audio to finish playing, then exit.
          const waitMs = Math.max(300, playbackEndsAt + 500 - Date.now());
          setTimeout(() => shutdown(0), waitMs);
        }
        break;
      case "error":
        log(`\x1b[31merror:\x1b[0m ${msg.error?.message ?? JSON.stringify(msg)}`);
        break;
      default:
        break;
    }
  });

  ws.addEventListener("close", (e) => {
    if (!closing) log(`\x1b[2m● connection closed (${e.code}${e.reason ? ` ${e.reason}` : ""})\x1b[0m`);
    shutdown(closing ? 0 : 1);
  });
  ws.addEventListener("error", (e) => {
    log(`\x1b[31mwebsocket error:\x1b[0m ${e.message ?? e}`);
  });

  function shutdown(code) {
    if (closing) return;
    closing = true;
    try { ffCapture?.kill("SIGKILL"); } catch {}
    try { ffPlay?.stdin.end(); ffPlay?.kill("SIGKILL"); } catch {}
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
    process.exit(code);
  }

  process.on("SIGINT", () => {
    log("\n\x1b[2m● ending\x1b[0m");
    shutdown(0);
  });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
