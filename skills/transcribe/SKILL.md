---
name: transcribe
description: "Transcribe audio/video locally with cached MLX Whisper models. Use when the user wants a recording or Voice Memo transcribed, or mentions bad/low-quality audio."
---

## Core rules

1. **Stage inputs first.** Voice Memo share-sheet paths under `~/Library/Containers/com.apple.VoiceMemos/Data/tmp/…` can vanish at any moment. The script stages a copy in `/private/tmp/audio-transcription-inputs/` before anything else; if you must probe the file before running it, copy it there yourself first.
2. **Transcribe locally.** MLX Whisper via `uvx --from mlx-whisper mlx_whisper`, models cached in `~/.cache/huggingface/hub/` — never a cloud API.
3. **Force the language when known.** Get it from the user or the conversation; a filename is not evidence of language.
4. **Deliver a cleaned transcript.** Remove hallucination loops, lightly punctuate and paragraph, and mark uncertain spans `[unclear]` rather than inventing words.

## Fast path

```bash
cd /Users/menglay/.pi/agent/skills/transcribe
./transcribe-audio.py "/path/to/audio.m4a" --language en --quality balanced
```

The script stages the input, downloads the model only if missing, writes `txt`/`srt`/`vtt`/`tsv`/`json` to `/private/tmp/audio-transcriptions/<name>-<timestamp>/`, and in `balanced` mode reruns with the full model when it detects hallucination loops.

Variants:

```bash
# Quick draft with the fastest cached model
./transcribe-audio.py audio.m4a --language en --quality fast

# Bad or important audio: full model, plus a prompt seeding names, places, jargon
./transcribe-audio.py audio.m4a --language en --quality best \
  --prompt "Speaker name, project names, technical terms, place names likely in the recording."

# Language genuinely unknown
./transcribe-audio.py audio.m4a --language auto --quality balanced
```

If the script is unsuitable, read `run_whisper()` in `transcribe-audio.py` for the exact `mlx_whisper` invocation; every run also records the command it used in `command.txt` next to the outputs.

## Models

- fast/balanced: `mlx-community/whisper-large-v3-turbo`
- best, and the balanced-mode fallback: `mlx-community/whisper-large-v3-mlx`

`./precache-models.py` downloads or refreshes both. A cached model makes `mlx_whisper` print `Fetching 4 files: 100%` almost instantly; a slow fetch means it is downloading.

## Quality checks

Read the generated `.txt` end to end, then check the `.srt`/`.json` around anything suspicious. Rerun or clean up when you see:

- hallucination loops — the same phrase repeated for many lines
- many zero-duration segments
- `NaN` `avg_logprob` or very high `compression_ratio` values in the JSON
- text contradicting the context words you supplied in `--prompt`
