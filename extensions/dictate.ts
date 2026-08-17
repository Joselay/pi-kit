import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CustomEditor,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function notify(ctx, message, level = "info") {
  if (ctx.hasUI)
    ctx.ui.notify(message, level);
}

var SAMPLE_RATE = 24000;

var PROVIDER_ID = "openai-codex";
function authClaim(access) {
  try {
    const payloadPart = access.split(".")[1];
    if (!payloadPart)
      return;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!isRecord(payload))
      return;
    const claim = payload["https://api.openai.com/auth"];
    return isRecord(claim) ? claim : undefined;
  } catch {
    return;
  }
}
function authClaimString(access, field) {
  const value = authClaim(access)?.[field];
  return typeof value === "string" && value ? value : undefined;
}
function accountIdFromAccessToken(access) {
  return authClaimString(access, "chatgpt_account_id");
}
var runtimePromise;
function modelRuntime() {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}
async function realtimeCredentials(feature) {
  let runtime;
  try {
    runtime = await modelRuntime();
  } catch (error) {
    runtimePromise = undefined;
    throw new Error(`could not load pi's model runtime (${errorText(error)}); run /login`);
  }
  let check;
  let token;
  try {
    check = await runtime.checkAuth(PROVIDER_ID);
    token = (await runtime.getAuth(PROVIDER_ID))?.auth?.apiKey;
  } catch (error) {
    throw new Error(`pi's openai-codex OAuth check failed (${errorText(error)}); run /login`);
  }
  if (!runtime.isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
    throw new Error(`${feature} needs the openai-codex OAuth subscription; run /login first`);
  }
  if (!token)
    throw new Error("could not resolve the OAuth token; run /login again");
  return { token, accountId: accountIdFromAccessToken(token) };
}

var CONNECT_TIMEOUT_MS = 1e4;
var CLOSE_GRACE_MS = 1500;
var AUTH_HINT = "run /login if this persists";
function headersFor(credentials, feature, extra) {
  const headers = {
    Authorization: `Bearer ${credentials.token}`,
    originator: "pi",
    "user-agent": `pi-${feature} (${process.platform}; ${process.arch})`,
    ...extra
  };
  if (credentials.accountId)
    headers["chatgpt-account-id"] = credentials.accountId;
  return headers;
}
var defaultConnect = (url, headers) => new WebSocket(url, { headers });
async function openRealtimeSession(config) {
  const connect = config.connect ?? defaultConnect;
  const readyEvent = config.readyEvent ?? "session.updated";
  const socket = connect(config.url, headersFor(config.credentials, config.feature, config.extraHeaders));
  const queue = [];
  let ready = config.sessionUpdate === undefined;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  if (ready)
    resolveReady();
  let closed = false;
  let closing = false;
  let notified = false;
  const finish = (info) => {
    if (notified)
      return;
    notified = true;
    closed = true;
    config.onClosed?.(info);
  };
  const hangUp = () => {
    try {
      socket.close();
    } catch {}
  };
  try {
    await new Promise((resolve, reject) => {
      if (config.signal?.aborted) {
        reject(new Error(`${config.feature} connection cancelled`));
        return;
      }
      let timer;
      const cleanup = () => {
        if (timer)
          clearTimeout(timer);
        config.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`${config.feature} connection cancelled`));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${config.feature} connection timed out`));
      }, config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      config.signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", () => {
        cleanup();
        resolve();
      });
      socket.addEventListener("error", (event) => {
        cleanup();
        reject(new Error(`${event?.message ?? `could not reach the ${config.feature} API`}; ${AUTH_HINT}`));
      });
    });
  } catch (error) {
    hangUp();
    throw error;
  }
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message === undefined || message === null)
      return;
    if (!ready && message.type === readyEvent) {
      ready = true;
      resolveReady();
      for (const payload of queue.splice(0)) {
        try {
          socket.send(payload);
        } catch {}
      }
    }
    if (!ready && message.type === "error")
      rejectReady(new Error(message.error?.message ?? message.message ?? `${config.feature} session update failed`));
    config.onEvent?.(message);
  });
  socket.addEventListener("close", (event) => {
    if (!ready)
      rejectReady(new Error(`${config.feature} connection closed before session was ready`));
    finish({ code: event?.code, reason: event?.reason, expected: closing });
  });
  if (config.sessionUpdate !== undefined) {
    try {
      socket.send(JSON.stringify(config.sessionUpdate));
    } catch {}
  }
  if (!ready) {
    try {
      await Promise.race([
        readyPromise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`${config.feature} session update timed out`)),
          config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
        ))
      ]);
    } catch (error) {
      hangUp();
      throw error;
    }
  }
  return {
    get ready() {
      return ready;
    },
    get closed() {
      return closed;
    },
    send(payload) {
      let serialised;
      try {
        serialised = JSON.stringify(payload);
      } catch {
        return;
      }
      if (!ready) {
        queue.push(serialised);
        return;
      }
      try {
        if (socket.readyState === 1)
          socket.send(serialised);
      } catch {}
    },
    close(options) {
      if (closing)
        return;
      closing = true;
      if (options?.farewell !== undefined && socket.readyState === 1 && !closed) {
        try {
          socket.send(JSON.stringify(options.farewell));
        } catch {}
        setTimeout(hangUp, options.graceMs ?? CLOSE_GRACE_MS);
      } else {
        hangUp();
      }
      finish({ expected: true });
    }
  };
}

var FILE_MODE = 0o600;
function statePath(name) {
  const dir = join(homedir(), ".cache", "pi", "dictate");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}
function readState(name, parse) {
  let raw;
  try {
    raw = readFileSync(statePath(name), "utf8");
  } catch {
    return;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  try {
    return parse(value);
  } catch {
    return;
  }
}
function writeState(name, value) {
  const target = statePath(name);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { mode: FILE_MODE });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

import {
  CURSOR_MARKER,
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  truncateToWidth
} from "@earendil-works/pi-tui";
var STATE_FILE = "dictate.json";
var MAX_RECORDING_MS = 5 * 60 * 1000;
var MIN_RECORDING_MS = 150;
var CLOSE_GRACE_MS2 = 400;
var FINALIZE_TIMEOUT_MS = 15 * 1000;
var STDERR_TAIL = 4000;
// Keep tap-to-type usable without making dictation feel like it starts late.
var HOLD_TRIGGER_MS = 200;
var AUTH_HINT2 = "run /login if this persists";
var REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
var TRANSCRIPTION_MODELS = [
  "gpt-live-transcribe",
  "gpt-transcribe"
];
var TRANSCRIPTION_MODEL_DESCRIPTIONS = {
  "gpt-live-transcribe": "Live deltas, low latency, coding context",
  "gpt-transcribe": "Accuracy-focused, committed turns and files"
};
var DEFAULT_TRANSCRIPTION_MODEL = TRANSCRIPTION_MODELS[0];
var TRANSCRIPTION_PROMPT = [
  "The speaker always dictates in English about software development, coding, and programming.",
  "Preserve programming terms, code identifiers, command names, and technical product names.",
  "Spell this coding agent's proper name as Pi.",
  "Transcribe in English only, using unaccented English letters A-Z for words.",
  "Do not output any other language."
].join(" ");
async function selectCurrent(ui, title, options, current, descriptions = {}) {
  const labels = options.map((option) => {
    const description = descriptions[option];
    return `${option === current ? "\u2713 " : "  "}${option}${description ? ` \u2014 ${description}` : ""}`;
  });
  const selected = await ui.select(title, labels);
  if (!selected)
    return;
  return options[labels.indexOf(selected)];
}
var RECORDING_FRAMES = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
var RAINBOW_COLORS = [
  [255, 80, 80],
  [255, 165, 60],
  [255, 225, 70],
  [80, 220, 120],
  [70, 200, 255],
  [100, 120, 255],
  [200, 100, 255]
];

function rainbowColor(text, frame) {
  const [red, green, blue] = RAINBOW_COLORS[frame % RAINBOW_COLORS.length];
  return `\x1B[38;2;${red};${green};${blue}m${text}\x1B[0m`;
}

function recordingLevel(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0)
    return 0;
  let sumSquares = 0;
  for (let offset = 0;offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples);
  const decibels = 20 * Math.log10(Math.max(rms, 1e-7));
  const voice = Math.max(0, Math.min(1, (decibels + 42) / 30));
  return Math.round(voice * (RECORDING_FRAMES.length - 1));
}

export const DICTATE_EDITOR_BRIDGE = Symbol.for("pi.dictate.editorBridge");
export interface DictateEditorBridge {
  decorate<T extends EditorForDictation>(editor: T, tui: any): T;
}
export interface EditorForDictation {
  insertTextAtCursor?(text: string): void;
  [key: string]: any;
}

class Timer {
  handle;
  set(ms, callback, unref = false) {
    this.clear();
    this.handle = setTimeout(() => {
      this.handle = undefined;
      callback();
    }, ms);
    if (unref)
      this.handle.unref?.();
  }
  clear() {
    if (this.handle)
      clearTimeout(this.handle);
    this.handle = undefined;
  }
}
function executable(fallback, candidates) {
  return candidates.find(existsSync) ?? fallback;
}
var FFMPEG = process.env.PI_DICTATE_FFMPEG?.trim() || executable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
var AUDIO_DEVICE = process.env.PI_DICTATE_AUDIO_DEVICE?.trim() || "0";
async function audioDeviceDescription() {
  if (!/^\d+$/.test(AUDIO_DEVICE))
    return AUDIO_DEVICE;
  return await new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      "-hide_banner",
      "-f",
      "avfoundation",
      "-list_devices",
      "true",
      "-i",
      ""
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      const plain = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      const audioSection = plain.split(/AVFoundation audio devices:\s*/i)[1] ?? "";
      const match = [...audioSection.matchAll(/\[(\d+)\]\s+([^\r\n]+)/g)]
        .find((entry) => entry[1] === AUDIO_DEVICE);
      resolve(match?.[2]?.trim() || `device ${AUDIO_DEVICE}`);
    };
    child.stderr?.on("data", (chunk) => output = tail(output, chunk));
    child.once("error", finish);
    child.once("close", finish);
    const timeout = setTimeout(() => {
      stopChild(child, "SIGKILL");
      finish();
    }, 2000);
  });
}
function tail(existing, chunk) {
  return (existing + String(chunk)).slice(-STDERR_TAIL);
}
function stopChild(child, signal = "SIGINT") {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill(signal);
}
function isEnglishLanguageCode(value) {
  const primary = String(value).trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  return primary === "en" || primary === "eng";
}
function hasNonAsciiLettersOrMarks(text) {
  return [...text.normalize("NFD")].some(
    (character) => /[\p{L}\p{M}]/u.test(character) && !/[A-Za-z]/.test(character)
  );
}
async function openTranscription(signal, model, onTranscriptDelta) {
  const transcription = {
    model,
    language: "en",
    prompt: TRANSCRIPTION_PROMPT
  };
  const finalizeTimeoutMs = FINALIZE_TIMEOUT_MS;
  let done = false;
  let failure;
  let finalText = "";
  let partialText = "";
  let detectedLanguages = [];
  let settle;
  const finishTimer = new Timer;
  const fail = (error) => {
    failure ??= error;
    settle?.();
  };
  const session = await openRealtimeSession({
    url: REALTIME_URL,
    feature: "dictate",
    credentials: await realtimeCredentials("dictate"),
    signal,
    sessionUpdate: {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: SAMPLE_RATE },
            transcription,
            noise_reduction: { type: "far_field" },
            turn_detection: null
          }
        }
      }
    },
    onEvent: (message) => {
      switch (message.type) {
        case "conversation.input_transcript.delta":
        case "conversation.item.input_audio_transcription.delta":
          partialText += String(message.delta ?? "");
          onTranscriptDelta?.(partialText);
          break;
        case "conversation.input_transcript.turn_marked":
        case "conversation.item.input_audio_transcription.completed":
          finalText = String(message.transcript ?? "");
          onTranscriptDelta?.(finalText);
          detectedLanguages = Array.isArray(message.languages)
            ? message.languages.map((entry) => typeof entry === "string" ? entry : entry?.code).filter(Boolean)
            : [];
          settle?.();
          break;
        case "conversation.item.input_audio_transcription.failed":
        case "error":
          fail(new Error(message.message ?? message.error?.message ?? (message.error ? JSON.stringify(message.error) : "realtime transcription failed")));
          break;
      }
    },
    onClosed: ({ reason, expected }) => {
      if (!expected && !done) {
        const detail = reason?.trim();
        fail(new Error(`realtime connection closed${detail ? ` (${detail})` : ""}; ${AUTH_HINT2}`));
      }
      done = true;
      settle?.();
    }
  });
  const close = () => {
    finishTimer.clear();
    session.close();
  };
  return {
    push(pcm) {
      if (done || failure)
        return;
      session.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    },
    cancel() {
      done = true;
      close();
      settle?.();
    },
    async finish() {
      if (!done && !failure) {
        session.send({ type: "input_audio_buffer.commit" });
        await new Promise((resolve) => {
          settle = resolve;
          finishTimer.set(finalizeTimeoutMs, () => fail(new Error("realtime transcription timed out")));
          if (failure || done)
            resolve();
        });
        settle = undefined;
      }
      close();
      if (failure)
        throw failure;
      const text = finalText.trim();
      const hasNonEnglishLanguage = detectedLanguages.some((code) => !isEnglishLanguageCode(code));
      if (hasNonEnglishLanguage || hasNonAsciiLettersOrMarks(text))
        throw new Error("transcription was not English; please try again");
      return text;
    }
  };
}
var DEFAULT_STATE = { enabled: false, model: DEFAULT_TRANSCRIPTION_MODEL };
function readDictateState() {
  const persisted = readState(STATE_FILE, (value) => {
    if (!isRecord(value))
      return;
    const model = typeof value.model === "string" && TRANSCRIPTION_MODELS.includes(value.model)
      ? value.model
      : DEFAULT_TRANSCRIPTION_MODEL;
    return { enabled: value.enabled === true, model };
  });
  return persisted ?? DEFAULT_STATE;
}
function writeDictateState(state) {
  writeState(STATE_FILE, state);
}
function supportsDictation(editor) {
  return typeof editor.insertTextAtCursor === "function";
}
function decorateDictationEditor(editor, tui, isEnabled, setDictationActive, holdMs = HOLD_TRIGGER_MS) {
  let dictationState = "idle";
  let liveTranscript = "";
  let animationFrame = 0;
  let rainbowFrame = 0;
  let animationTimer;
  let holdTimer;
  let triggerHeld = false;
  let holdActivated = false;
  const stopAnimation = () => {
    if (animationTimer)
      clearInterval(animationTimer);
    animationTimer = undefined;
  };
  const cancelHold = () => {
    if (holdTimer)
      clearTimeout(holdTimer);
    holdTimer = undefined;
    triggerHeld = false;
    holdActivated = false;
  };
  const insertTranscription = (text, atStart = true) => {
    if (!text)
      return;
    if (!atStart) {
      editor.insertTextAtCursor(text);
      return;
    }
    const body = text.replace(/^\s+/, "");
    if (!body)
      return;
    const cursor = editor.getCursor?.();
    const line = cursor ? editor.getLines?.()[cursor.line] ?? "" : "";
    const needsLeadingSpace = !!cursor && cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "");
    editor.insertTextAtCursor(`${needsLeadingSpace ? " " : ""}${body}`);
  };
  const endTranscription = () => {
    const cursor = editor.getCursor?.();
    const line = cursor ? editor.getLines?.()[cursor.line] ?? "" : "";
    if (!cursor || cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "")) {
      editor.insertTextAtCursor(" ");
    }
  };
  const setDictationState = (state) => {
    dictationState = state;
    if (state === "idle" || state === "recording")
      liveTranscript = "";
    animationFrame = 0;
    rainbowFrame = 0;
    stopAnimation();
    if (state === "recording") {
      animationTimer = setInterval(() => {
        rainbowFrame++;
        tui.requestRender();
      }, 120);
    }
    tui.requestRender();
  };
  const setDictationLevel = (level) => {
    if (dictationState !== "recording")
      return;
    const nextFrame = Math.max(0, Math.min(RECORDING_FRAMES.length - 1, Math.round(level)));
    if (animationFrame === nextFrame)
      return;
    animationFrame = nextFrame;
    tui.requestRender();
  };
  const setDictationTranscript = (text) => {
    const nextTranscript = String(text ?? "").replace(/\s+/g, " ").trim();
    if (liveTranscript === nextTranscript)
      return;
    liveTranscript = nextTranscript;
    tui.requestRender();
  };
  const originalHandleInput = editor.handleInput;
  const handleInput = originalHandleInput.bind(editor);
  const originalWantsKeyRelease = editor.wantsKeyRelease;
  const baseWantsKeyRelease = originalWantsKeyRelease === true;
  editor.wantsKeyRelease = true;
  editor.handleInput = (data) => {
    const trigger = matchesKey(data, Key.backtick);
    if (isKeyRelease(data)) {
      if (!trigger) {
        if (baseWantsKeyRelease)
          handleInput(data);
        return;
      }
      if (!triggerHeld) {
        if (!isEnabled() && baseWantsKeyRelease)
          handleInput(data);
        return;
      }
      const wasActivated = holdActivated;
      cancelHold();
      if (wasActivated)
        setDictationActive(false);
      else
        handleInput("`");
      return;
    }
    if (triggerHeld && !holdActivated && !trigger) {
      cancelHold();
      handleInput("`");
    }
    if (isEnabled() && trigger) {
      if (isKeyRepeat(data) || triggerHeld)
        return;
      triggerHeld = true;
      holdTimer = setTimeout(() => {
        holdTimer = undefined;
        if (!triggerHeld || !isEnabled())
          return;
        holdActivated = true;
        setDictationActive(true);
      }, holdMs);
      return;
    }
    handleInput(data);
  };
  const originalRender = editor.render;
  const render = originalRender.bind(editor);
  editor.render = (width) => {
    const lines = render(width);
    if (dictationState !== "recording" || lines.length === 0)
      return lines;
    const frame = RECORDING_FRAMES[animationFrame % RECORDING_FRAMES.length];
    const transcriptLimit = Math.max(12, width - 20);
    const visibleTranscript = liveTranscript.length > transcriptLimit
      ? `\u2026${liveTranscript.slice(-(transcriptLimit - 1))}`
      : liveTranscript;
    const transcript = visibleTranscript ? ` ${visibleTranscript}\u258C` : "";
    const borderColor = (text) => editor.borderColor?.(text) ?? text;
    const coloredFrame = rainbowColor(frame, rainbowFrame);
    const label = `${borderColor(" ")}${coloredFrame}${borderColor(`${transcript} `)}`;
    for (let index = 1;index < lines.length - 1; index++) {
      const line = lines[index];
      const marker = line.indexOf(CURSOR_MARKER);
      if (marker === -1)
        continue;
      const cursorStart = line.indexOf("\x1B[7m", marker + CURSOR_MARKER.length);
      const cursorEnd = line.indexOf("\x1B[0m", cursorStart);
      if (cursorStart === -1 || cursorEnd === -1)
        continue;
      const afterCursor = cursorEnd + "\x1B[0m".length;
      lines[index] = truncateToWidth(line.slice(0, cursorStart) + label + line.slice(afterCursor), width, "");
      break;
    }
    return lines;
  };
  return Object.assign(editor, {
    insertTranscription,
    endTranscription,
    setDictationState,
    setDictationLevel,
    setDictationTranscript,
    disposeDictation: () => {
      cancelHold();
      stopAnimation();
      editor.handleInput = originalHandleInput;
      editor.render = originalRender;
      editor.wantsKeyRelease = originalWantsKeyRelease;
    }
  });
}
var SUPPORTED = process.platform === "darwin";
function dictate(pi: ExtensionAPI) {
  let { enabled, model } = readDictateState();
  let currentEditor;
  const decoratedEditors = new Set<any>();
  let ctx: ExtensionContext | undefined;
  let generation = 0;
  const notifyUser = (message, level = "info") => {
    if (ctx)
      notify(ctx, message, level);
  };
  function warmUp() {
    realtimeCredentials("dictate").catch(() => {});
  }
  let recording;
  let starting;
  let startController;
  let transcribing = false;
  let finishingSession;
  let dictating = false;
  const maxTimer = new Timer;
  async function settled() {
    while (starting) {
      const pending = starting;
      await pending;
      if (starting === pending)
        starting = undefined;
    }
  }
  function start(editor) {
    if (starting)
      return settled();
    if (recording || transcribing)
      return Promise.resolve();
    const token = generation;
    const controller = new AbortController();
    startController = controller;
    const pending = (async () => {
      try {
        const child = spawn(FFMPEG, [
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
          "-"
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const item = {
          child,
          startedAt: Date.now(),
          stderr: "",
          bytes: 0,
          level: 0,
          buffered: [],
          closed: new Promise((resolve) => child.once("close", () => resolve()))
        };
        child.stdout?.on("data", (chunk) => {
          item.bytes += chunk.length;
          const level = recordingLevel(chunk);
          item.level = level > item.level
            ? level
            : Math.max(level, item.level - 1);
          if (recording === item)
            editor.setDictationLevel(item.level);
          if (item.session)
            item.session.push(chunk);
          else
            item.buffered.push(chunk);
        });
        child.stderr?.on("data", (chunk) => item.stderr = tail(item.stderr, chunk));
        child.once("error", (error) => {
          if (recording !== item)
            return;
          recording = undefined;
          maxTimer.clear();
          item.session?.cancel();
          editor.setDictationState("idle");
          notifyUser(`Dictation recorder failed: ${error.message}`, "error");
        });
        if (token !== generation) {
          stopChild(child, "SIGKILL");
          return;
        }
        recording = item;
        editor.setDictationState("recording");
        const session = await openTranscription(
          controller.signal,
          model,
          (text) => {
            if (token === generation)
              editor.setDictationTranscript(text);
          }
        );
        if (token !== generation || recording !== item) {
          session.cancel();
          return;
        }
        item.session = session;
        for (const chunk of item.buffered.splice(0))
          session.push(chunk);
        maxTimer.set(MAX_RECORDING_MS, () => {
          notifyUser("Dictation stopped at 5-minute limit", "warning");
          dictating = false;
          stop(editor);
        });
      } catch (error) {
        const item = recording;
        recording = undefined;
        maxTimer.clear();
        if (item) {
          stopChild(item.child, "SIGKILL");
          item.session?.cancel();
        }
        if (token !== generation)
          return;
        editor.setDictationState("idle");
        notifyUser(`Dictation failed: ${errorText(error)}`, "error");
      }
    })();
    starting = pending;
    pending.finally(() => {
      if (starting === pending)
        starting = undefined;
      if (startController === controller)
        startController = undefined;
    });
    return pending;
  }
  async function take() {
    // Stop capture immediately on key release. Previously this waited for auth
    // and WebSocket setup to settle, recording unwanted trailing audio and
    // making short dictations noticeably slow to finish.
    const active = recording;
    if (active)
      stopChild(active.child);
    await settled();
    const item = recording;
    if (!item)
      return;
    recording = undefined;
    maxTimer.clear();
    return item;
  }
  async function stop(editor) {
    const item = await take();
    if (!item)
      return;
    const token = generation;
    stopChild(item.child);
    const grace = new Timer;
    await Promise.race([
      item.closed,
      new Promise((resolve) => {
        grace.set(CLOSE_GRACE_MS2, () => {
          stopChild(item.child, "SIGKILL");
          resolve();
        });
      })
    ]);
    grace.clear();
    const session = item.session;
    if (!session || token !== generation || Date.now() - item.startedAt < MIN_RECORDING_MS) {
      session?.cancel();
      if (token === generation)
        editor.setDictationState("idle");
      return;
    }
    transcribing = true;
    finishingSession = session;
    try {
      if (item.bytes < 1000)
        throw new Error(item.stderr.trim() || "microphone produced no audio");
      editor.setDictationState("transcribing");
      const trailing = await session.finish();
      if (token !== generation)
        return;
      editor.insertTranscription(trailing);
      if (!trailing) {
        notifyUser("No speech detected", "warning");
        return;
      }
      editor.endTranscription();
    } catch (error) {
      if (token === generation)
        notifyUser(`Dictation failed: ${errorText(error)}`, "error");
    } finally {
      if (finishingSession === session)
        finishingSession = undefined;
      transcribing = false;
      if (token === generation)
        editor.setDictationState("idle");
    }
  }
  function setDictationActive(editor, active) {
    if (transcribing)
      return;
    if (!active) {
      if (!dictating)
        return;
      dictating = false;
      stop(editor);
      return;
    }
    if (dictating)
      return;
    dictating = true;
    start(editor).finally(() => {
      if (!recording)
        dictating = false;
    });
  }
  async function teardown() {
    generation++;
    dictating = false;
    maxTimer.clear();
    startController?.abort();
    finishingSession?.cancel();
    finishingSession = undefined;
    const item = await take();
    stopChild(item?.child, "SIGKILL");
    item?.session?.cancel();
    transcribing = false;
    for (const editor of decoratedEditors)
      editor.setDictationState("idle");
  }
  const bridge: DictateEditorBridge = {
    decorate(base, tui) {
      if (!supportsDictation(base))
        return base;
      let editor: any;
      editor = decorateDictationEditor(base, tui, () => enabled, (active) => setDictationActive(editor, active));
      const dispose = editor.disposeDictation.bind(editor);
      editor.disposeDictation = () => {
        decoratedEditors.delete(editor);
        dispose();
      };
      decoratedEditors.add(editor);
      return editor as typeof base;
    }
  };
  (globalThis as any)[DICTATE_EDITOR_BRIDGE] = bridge;
  pi.on("session_start", (_event, context) => {
    ctx = context;
    if (context.mode !== "tui")
      return;
    if (!SUPPORTED) {
      if (enabled)
        notifyUser("Dictation requires macOS (FFmpeg avfoundation); staying off", "warning");
      return;
    }
    const previousEditor = context.ui.getEditorComponent();
    context.ui.setEditorComponent((tui, theme, keybindings) => {
      const base = previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      if (!supportsDictation(base)) {
        notifyUser("Dictation requires an editor that supports cursor insertion", "warning");
        return base;
      }
      const editor = bridge.decorate(base, tui);
      currentEditor = editor;
      return editor;
    });
    if (enabled)
      warmUp();
  });
  pi.on("session_shutdown", async () => {
    await teardown();
    currentEditor?.disposeDictation();
    currentEditor = undefined;
    decoratedEditors.clear();
    if ((globalThis as any)[DICTATE_EDITOR_BRIDGE] === bridge)
      delete (globalThis as any)[DICTATE_EDITOR_BRIDGE];
    ctx = undefined;
  });
  pi.registerCommand("dictate", {
    description: "Show dictation status; use on|off or config",
    getArgumentCompletions: (prefix) => {
      const actions = [
        { value: "on", label: "on", description: "Enable hold-backtick dictation" },
        { value: "off", label: "off", description: "Disable dictation" },
        { value: "config", label: "config", description: "Choose transcription model" }
      ].filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
      return actions.length ? actions : null;
    },
    handler: async (args, context) => {
      if (!SUPPORTED) {
        notify(context, "Dictation requires macOS", "warning");
        return;
      }
      const action = args.trim().toLowerCase();
      if (action && action !== "on" && action !== "off" && action !== "config") {
        notify(context, "Use /dictate, /dictate on|off, or /dictate config", "warning");
        return;
      }
      if (!action) {
        const audioDevice = await audioDeviceDescription();
        notify(context, `Dictation ${enabled ? "on" : "off"} (${model}, ${audioDevice})`, "info");
        return;
      }
      if (action === "config") {
        if (!context.hasUI) {
          notify(context, "Dictation configuration requires interactive mode", "warning");
          return;
        }
        const selected = await selectCurrent(
          context.ui,
          `Choose dictation model (${enabled ? "on" : "off"}):`,
          TRANSCRIPTION_MODELS,
          model,
          TRANSCRIPTION_MODEL_DESCRIPTIONS
        );
        if (!selected)
          return;
        model = selected;
        try {
          writeDictateState({ enabled, model });
        } catch (error) {
          notify(context, `Dictation model changed but state was not saved: ${errorText(error)}`, "warning");
        }
        notify(context, `Dictation model: ${model} (${enabled ? "on" : "off"})`, "info");
        return;
      }
      const nextEnabled = action === "on";
      if (nextEnabled === enabled) {
        notify(context, enabled ? "Dictation already on" : "Dictation already off", "info");
        return;
      }
      enabled = nextEnabled;
      try {
        writeDictateState({ enabled, model });
      } catch (error) {
        notify(context, `Dictation changed but state was not saved: ${errorText(error)}`, "warning");
      }
      if (enabled) {
        currentEditor?.setDictationState("idle");
        warmUp();
        notify(context, `Dictation on (${model}) - hold \` to record`, "info");
        return;
      }
      await teardown();
      notify(context, "Dictation off", "info");
    }
  });
}
export {
  dictate as default,
  decorateDictationEditor
};
