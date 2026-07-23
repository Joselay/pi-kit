#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Speaker-diarized transcription via OpenAI gpt-4o-transcribe-diarize.

The one cloud exception in this otherwise-local skill: MLX Whisper cannot tell
speakers apart. Auth rides the codex OAuth subscription token from
~/.pi/agent/auth.json (verified to work on /v1/audio/transcriptions), so no API
key is needed. The audio is uploaded to OpenAI — only use this when the user
asked for speaker labels.

This is intentionally dependency-free: stdlib HTTP, ffmpeg for transcoding.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

AUTH_PATH = Path("~/.pi/agent/auth.json").expanduser()
API_URL = "https://api.openai.com/v1/audio/transcriptions"
MODEL = "gpt-4o-transcribe-diarize"
STAGE_DIR = Path("/private/tmp/audio-transcription-inputs")
OUTPUT_ROOT = Path("/private/tmp/audio-transcriptions")
# The transcriptions endpoint caps uploads at 25 MB; 16 kHz mono opus keeps
# roughly 2.5 hours under that.
MAX_UPLOAD_BYTES = 24 * 1024 * 1024
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def slugify(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return value or "audio"


def timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def fail(message: str) -> "NoReturn":  # noqa: F821
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_auth() -> tuple[str, str | None]:
    try:
        auth = json.loads(AUTH_PATH.read_text())["openai-codex"]
    except (OSError, KeyError, json.JSONDecodeError) as error:
        fail(f"could not read the openai-codex login from {AUTH_PATH} ({error}); run /login in pi")
    if auth.get("expires", 0) / 1000 < time.time():
        fail("the openai-codex token has expired; open pi (it refreshes on use) and retry")
    token = auth.get("access")
    if not token:
        fail("the openai-codex login has no access token; run /login in pi")
    return token, auth.get("accountId")


def stage_input(source: Path) -> Path:
    """Voice Memo share-sheet paths can vanish at any moment; copy first."""
    if not source.exists():
        fail(f"input not found: {source}")
    STAGE_DIR.mkdir(parents=True, exist_ok=True)
    staged = STAGE_DIR / f"{timestamp()}-{slugify(source.name)}"
    shutil.copy2(source, staged)
    return staged


def transcode(source: Path, out_dir: Path) -> Path:
    """16 kHz mono opus: small enough to upload, more than ASR needs."""
    for bitrate in ("24k", "12k"):
        target = out_dir / f"upload-{bitrate}.ogg"
        result = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(source),
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", bitrate,
             "-y", str(target)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            fail(f"ffmpeg transcode failed: {result.stderr.strip() or result.stdout.strip()}")
        if target.stat().st_size <= MAX_UPLOAD_BYTES:
            return target
    fail("audio exceeds the 25 MB upload cap even at 12 kbps (~5 h); split it with ffmpeg and diarize the parts separately")


def multipart(fields: dict[str, str], file_name: str, file_bytes: bytes) -> tuple[bytes, str]:
    boundary = f"pi-diarize-{uuid.uuid4().hex}"
    body = bytearray()
    for name, value in fields.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n"
             "Content-Type: audio/ogg\r\n\r\n").encode()
    body += file_bytes
    body += f"\r\n--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def request_diarization(audio: Path, language: str | None) -> dict:
    token, account_id = load_auth()
    fields = {"model": MODEL, "response_format": "diarized_json", "chunking_strategy": "auto"}
    if language:
        fields["language"] = language

    file_bytes = audio.read_bytes()
    while True:
        body, content_type = multipart(fields, audio.name, file_bytes)
        headers = {"Authorization": f"Bearer {token}", "Content-Type": content_type, "originator": "pi"}
        if account_id:
            headers["chatgpt-account-id"] = account_id
        req = urllib.request.Request(API_URL, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=600) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            # Tolerate parameter drift: drop optional params the API rejects.
            dropped = next((k for k in ("chunking_strategy", "language") if k in fields and k in detail), None)
            if error.code == 400 and dropped:
                del fields[dropped]
                continue
            if error.code == 401:
                fail(f"authentication rejected ({detail[:200]}); open pi to refresh the token or run /login")
            fail(f"HTTP {error.code}: {detail[:500]}")
        except (urllib.error.URLError, TimeoutError) as error:
            fail(f"upload failed: {error}")


def fmt_clock(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}" if total >= 3600 else f"{total // 60:02d}:{total % 60:02d}"


def fmt_srt(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d},{ms % 1000:03d}"


def write_outputs(result: dict, out_dir: Path) -> tuple[Path, list[str]]:
    (out_dir / "diarized.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")

    segments = [s for s in result.get("segments", []) if str(s.get("text", "")).strip()]
    speakers: list[str] = []
    transcript_lines: list[str] = []
    srt_lines: list[str] = []
    previous_speaker = None
    for index, segment in enumerate(segments, start=1):
        speaker = str(segment.get("speaker") or "?")
        if speaker not in speakers:
            speakers.append(speaker)
        text = str(segment["text"]).strip()
        start = float(segment.get("start") or 0)
        end = float(segment.get("end") or start)
        if speaker != previous_speaker:
            transcript_lines.append(f"\n[{fmt_clock(start)}] Speaker {speaker}:\n{text}")
            previous_speaker = speaker
        else:
            # Same turn: flow the segments together instead of one per line.
            transcript_lines[-1] += f" {text}"
        srt_lines += [str(index), f"{fmt_srt(start)} --> {fmt_srt(end)}", f"[{speaker}] {text}", ""]

    transcript = out_dir / "transcript.txt"
    transcript.write_text("\n".join(transcript_lines).strip() + "\n" if transcript_lines else "")
    (out_dir / "transcript.srt").write_text("\n".join(srt_lines))
    return transcript, speakers


def main() -> None:
    parser = argparse.ArgumentParser(description="Speaker-diarized transcription (cloud, codex subscription)")
    parser.add_argument("input", help="audio or video file")
    parser.add_argument("--language", help="ISO 639-1 language, e.g. en; omit to auto-detect")
    args = parser.parse_args()

    staged = stage_input(Path(args.input).expanduser())
    out_dir = OUTPUT_ROOT / f"{slugify(Path(args.input).stem)}-diarized-{timestamp()}"
    out_dir.mkdir(parents=True, exist_ok=True)

    upload = transcode(staged, out_dir)
    print(f"uploading {upload.stat().st_size / 1024 / 1024:.1f} MB to {MODEL}...", file=sys.stderr)
    result = request_diarization(upload, args.language)
    upload.unlink(missing_ok=True)

    transcript, speakers = write_outputs(result, out_dir)
    duration = result.get("duration")
    print(f"output dir: {out_dir}")
    print(f"speakers detected: {', '.join(speakers) if speakers else 'none (no speech found)'}")
    if duration:
        print(f"audio duration: {fmt_clock(float(duration))}")
    print(f"transcript: {transcript}")


if __name__ == "__main__":
    main()
