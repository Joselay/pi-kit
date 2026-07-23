---
name: youtube
description: "Summarize and answer questions about YouTube videos/podcasts from a URL. Use when the user shares a YouTube link and wants to know what it's about, a summary, or answers about its content."
---

## Workflow

1. Fetch the transcript from YouTube's captions (seconds, no audio download):

   ```bash
   cd /Users/menglay/.pi/agent/skills/youtube
   ./yt-transcript.py "URL"              # English (default)
   ./yt-transcript.py "URL" --lang de    # other caption language
   ```

   Outputs land in `/private/tmp/youtube-transcripts/<video-id>/`:
   `metadata.txt` (title, channel, duration, description), `chapters.txt`
   (if the video has chapters), `transcript.txt` (timestamped every ~30s).

2. **Read the whole transcript**, not just the head. A 2h podcast is roughly
   25-30k words — read it in 2-3 chunks if needed. Read `metadata.txt` and
   `chapters.txt` first for structure and correct spellings of names.

3. Deliver the summary (see format below), then answer follow-up questions
   from the transcript, quoting or citing timestamps.

## Fallback: no usable captions

Exit code 2 means no captions in the requested language. Then:

```bash
./yt-transcript.py "URL" --audio   # downloads audio.m4a into the same dir
```

and hand the file to the **transcribe** skill
(`skills/transcribe/transcribe-audio.py`, `--quality fast` is fine for
podcasts). Expect a 1h podcast to take a few minutes locally.

Known gap: Whisper produces hallucination-loop garbage for Khmer (`km`) —
verified on real audio with both turbo and full models. For Khmer (and other
low-resource languages) local transcription is not viable; tell the user
rather than delivering garbage. A multimodal cloud model (e.g. Gemini) that
accepts audio is the realistic path if they want it.

## Summary format

- 2-3 sentence overview first: who is talking and what the episode is about.
- Then a section per topic/chapter with the key points, notable claims, and
  disagreements — enough that the user genuinely doesn't need to listen.
- Timestamp each section as a clickable link: append `&t=<seconds>s` to the
  video URL so the user can jump to anything that sounds interesting.
- End with 3-5 key takeaways.

## Caveats

- Auto-captions garble names and jargon (e.g. "plot code" for "Claude Code").
  Cross-check against `metadata.txt`/`chapters.txt` and fix silently; mark
  genuinely unclear spans `[unclear]` rather than guessing.
- If the user's URL has `&t=...`, they may care about that moment
  specifically — address it, but still give the full-video context.
- Auto-captions have no speaker labels; `>>` marks speaker changes. Infer
  speakers from context, and don't attribute a quote to a named person unless
  it's clear from the transcript who said it.
