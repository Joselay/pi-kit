---
name: realtime-voice
description: "Hold a live, spoken voice conversation with the model through the OpenAI Realtime API over the pi OAuth subscription. Use when the user wants to talk to and hear the assistant in real time (voice chat, hands-free Q&A, spoken dictation-and-reply). Not for one-way transcription of an existing file (use `transcribe`) or for text-only chat."
---

# Realtime Voice Skill

Live voice conversation via `realtime.mjs`. The helper opens a WebSocket to the
OpenAI Realtime API, streams microphone audio up, and plays the model's spoken
reply back — hands-free, with server-side voice-activity detection deciding when
each turn ends.

## Rules

- OAuth is the only credential. The helper resolves the `openai-codex`
  subscription token through pi's runtime, exactly like `web-search` and
  `imagegen`. If it reports an auth error, ask the user to run `/login`. Never
  fall back to an API key, alternate provider, or one-off SDK runner, and never
  read or expose authentication storage.
- The realtime WebSocket (`wss://api.openai.com/v1/realtime`) accepts the ChatGPT
  OAuth bearer directly; the request shape matches the GA realtime API. Do not
  send the retired `OpenAI-Beta: realtime=v1` header and do not switch to the
  API-key WebRTC flow.
- macOS only: capture uses `ffmpeg` (avfoundation) and playback uses `ffplay`.
- Default is half-duplex — the mic is muted while the assistant speaks to avoid a
  speaker→mic feedback loop. This also means you cannot interrupt the assistant.
- Interruption (barge-in) requires `--full-duplex`, which keeps the mic live while
  the assistant speaks. On speech, the server cancels the reply (server VAD with
  `interrupt_response`) and the helper stops local playback and truncates the item
  — matching Codex's realtime behaviour. Use headphones: with speakers, the mic
  hears the assistant's own voice and it interrupts itself.

## Usage

Interactive voice chat (just talk; Ctrl-C to stop):

```bash
node <skill-directory>/realtime.mjs
```

One spoken reply to a text prompt, then exit (useful for a quick test or a
non-interactive "speak this answer"):

```bash
node <skill-directory>/realtime.mjs --text "What's the capital of France?"
```

Options:

- `--voice <name>` — output voice: `marin` (default), `cedar`, `alloy`, `ash`,
  `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, and others.
- `--model <id>` — realtime model (default `gpt-realtime-2.1`).
- `--instructions <text>` / `--instructions-file <path>` — system persona/rules.
- `--device <index>` — avfoundation audio input index (default `0`; list with
  `ffmpeg -f avfoundation -list_devices true -i ""`).
- `--transcribe-model <id>` — input transcription model (default
  `gpt-4o-mini-transcribe`); powers the `you:` transcript line.
- `--full-duplex` — keep the mic open during playback to allow barge-in
  (headphones only; see rules).
- `--debug` — print every realtime event.

## Output

The transcript streams to stdout as it happens: `you:` lines are your speech
(server-side transcription) and `asst:` lines are the model's reply. Audio plays
through the speakers in real time. Status/errors go to stderr.

## Notes

- Inside the pi TUI, prefer the `/voice` extension (`extensions/voice.ts`): it
  adds echo-cancelled full-duplex audio and delegates spoken requests to the
  running agent session. This skill remains the standalone/scripted variant.

- The session config mirrors upstream Codex: PCM16 @ 24 kHz mono, near-field
  input noise reduction, `gpt-4o-mini-transcribe` input transcription, and server
  VAD with `interrupt_response`/`create_response` and 500 ms silence. Mic audio is
  streamed in steady 40 ms / 960-sample frames like upstream clients.
- Echo/AEC: upstream Codex keeps the mic open and relies on the GUI client's echo
  cancellation. This helper has no AEC, so the default is half-duplex (mic muted
  while the assistant speaks) to stay usable on speakers. For the smoothest,
  closest-to-upstream experience — always-open mic with natural barge-in — use
  headphones and `--full-duplex`.
- First run may trigger a macOS microphone-permission prompt for the terminal.
- Server VAD means no push-to-talk: a ~500 ms pause ends your turn, so long pauses
  mid-thought can split into separate turns (this matches upstream).
