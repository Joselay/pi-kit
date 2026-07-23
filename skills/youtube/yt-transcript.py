#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["yt-dlp"]
# ///
"""Fetch a YouTube video's transcript from its captions, no audio download.

Writes metadata.txt, chapters.txt (if any), and transcript.txt (timestamped)
to /private/tmp/youtube-transcripts/<video-id>/ and prints the output dir.

Usage:
  ./yt-transcript.py URL [--lang en] [--audio]

--audio skips captions entirely and downloads bestaudio as m4a instead,
for handing off to the transcribe skill when no usable captions exist.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from yt_dlp import YoutubeDL

OUT_ROOT = Path("/private/tmp/youtube-transcripts")


def hms(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def pick_captions(info: dict, lang: str) -> tuple[dict | None, str, str]:
    """Return (format_entry, language_code, kind) preferring manual subs over auto."""
    for kind, table in (("manual", info.get("subtitles") or {}),
                        ("auto", info.get("automatic_captions") or {})):
        # Exact language first, then language-prefixed variants (en-US, en-orig),
        # then whatever the original-language track is.
        codes = [c for c in table if c == lang]
        codes += [c for c in table if c.startswith(f"{lang}-") and c not in codes]
        codes += [c for c in table if c.endswith("-orig") and c not in codes]
        for code in codes:
            fmt = next((f for f in table[code] if f.get("ext") == "json3"), None)
            if fmt:
                return fmt, code, kind
    return None, "", ""


def events_to_transcript(events: list[dict], interval: float = 30.0) -> str:
    """Flatten caption events into paragraphs with a timestamp every ~interval seconds."""
    out: list[str] = []
    line: list[str] = []
    last_stamp = -interval
    for ev in events:
        segs = ev.get("segs")
        if not segs:
            continue
        start = ev.get("tStartMs", 0) / 1000
        text = "".join(s.get("utf8", "") for s in segs)
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue
        if start - last_stamp >= interval:
            if line:
                out.append(" ".join(line))
                line = []
            out.append(f"\n[{hms(start)}]")
            last_stamp = start
        line.append(text)
    if line:
        out.append(" ".join(line))
    return "\n".join(out).strip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--lang", default="en", help="preferred caption language (default en)")
    ap.add_argument("--audio", action="store_true",
                    help="download bestaudio m4a instead of captions")
    args = ap.parse_args()

    with YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(args.url, download=False)

    vid = info["id"]
    out_dir = OUT_ROOT / vid
    out_dir.mkdir(parents=True, exist_ok=True)

    meta = [
        f"Title: {info.get('title')}",
        f"Channel: {info.get('channel') or info.get('uploader')}",
        f"Duration: {hms(info.get('duration') or 0)}",
        f"Upload date: {info.get('upload_date')}",
        f"URL: https://www.youtube.com/watch?v={vid}",
        "",
        (info.get("description") or "").strip(),
    ]
    (out_dir / "metadata.txt").write_text("\n".join(meta) + "\n")

    if info.get("chapters"):
        chapters = "\n".join(
            f"[{hms(c['start_time'])}] {c['title']}" for c in info["chapters"]
        )
        (out_dir / "chapters.txt").write_text(chapters + "\n")

    if args.audio:
        opts = {
            "quiet": True,
            "format": "bestaudio[ext=m4a]/bestaudio",
            "outtmpl": str(out_dir / "audio.%(ext)s"),
        }
        with YoutubeDL(opts) as ydl:
            ydl.download([args.url])
        audio = next(out_dir.glob("audio.*"))
        print(f"Audio: {audio}")
        print(f"Output dir: {out_dir}")
        return 0

    fmt, code, kind = pick_captions(info, args.lang)
    if not fmt:
        avail = sorted(set(info.get("subtitles") or {}) | set(info.get("automatic_captions") or {}))
        print(f"No '{args.lang}' captions. Available: {', '.join(avail) or 'none'}",
              file=sys.stderr)
        print("Fall back to: yt-transcript.py URL --audio, then the transcribe skill.",
              file=sys.stderr)
        return 2

    with YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
        data = json.loads(ydl.urlopen(fmt["url"]).read().decode())

    transcript = events_to_transcript(data.get("events") or [])
    (out_dir / "transcript.txt").write_text(transcript)

    words = len(transcript.split())
    print(f"Captions: {code} ({kind})")
    print(f"Transcript: {out_dir / 'transcript.txt'} (~{words} words)")
    if (out_dir / "chapters.txt").exists():
        print(f"Chapters: {out_dir / 'chapters.txt'}")
    print(f"Metadata: {out_dir / 'metadata.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
