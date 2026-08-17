---
name: audio-transcription
description: Transcribe local audio, video, Voice Memos, dictation, lectures, and meetings with cached MLX Whisper, including rough recordings.
disable-model-invocation: true
---

## Workflow

1. **Stage first.** For a Voice Memo share-sheet path, run the helper before inspecting or probing the file. Paths under `~/Library/Containers/com.apple.VoiceMemos/Data/tmp/.com.apple.uikit.itemprovider...` can disappear; the helper's first operation copies the input to `/private/tmp/audio-transcription-inputs/`.
2. **Choose the language.** Pass the user-stated or otherwise known language with `--language`. Use `auto` only when it is genuinely unknown; a filename is not evidence of the spoken language.
3. **Transcribe.** Run the helper from this skill directory:

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language en --quality balanced
```

   Use `fast` for a draft, `balanced` by default, and `best` for rough or important audio. `balanced` automatically retries suspicious output with the full model. Add `--prompt` only with confirmed names, places, or jargon:

```bash
./transcribe-audio.py audio.m4a --language en --quality best \
  --prompt "Meeting about Project Atlas with Nguyen and Kowalski."
```

   The helper uses local MLX Whisper, downloading a missing model into the Hugging Face cache. It writes `txt`, `srt`, `vtt`, `tsv`, and `json` under `/private/tmp/audio-transcriptions/<name>-<timestamp>/<model>/`.

4. **Review.** Read `transcript.txt`. Inspect the `.srt` or `.json` around uncertain passages and whenever the helper prints a quality warning. If `balanced` created both `turbo/` and `best/`, compare their suspicious passages. Remove obvious hallucination loops; preserve uncertain speech as `[unclear]`. Lightly repair punctuation and paragraphing while preserving meaning.
5. **Deliver.** Return the cleaned transcript and the output directory. Completion means all text is accounted for, obvious loops are removed, and every unresolved span is marked `[unclear]`.

## Offline preparation

To cache both default models before working offline, run:

```bash
./precache-models.py
```

The defaults are `mlx-community/whisper-large-v3-turbo` and `mlx-community/whisper-large-v3-mlx`.
