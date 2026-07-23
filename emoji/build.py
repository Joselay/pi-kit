# /// script
# requires-python = ">=3.11"
# ///
"""Regenerate emoji.json from GitHub's shortcode list and emojilib keywords.

Usage: uv run emoji/build.py
"""

import json
import re
import urllib.request
from pathlib import Path

GITHUB_EMOJIS = "https://api.github.com/emojis"
EMOJILIB = "https://cdn.jsdelivr.net/npm/emojilib@4/dist/emoji-en-US.json"
MAX_KEYWORDS = 8


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "pi-emoji-build"})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def glyph_from_url(url: str) -> str | None:
    match = re.search(r"/unicode/([0-9a-f-]+)\.png", url)
    if not match:
        return None  # non-unicode GitHub emoji like octocat or shipit
    return "".join(chr(int(part, 16)) for part in match.group(1).split("-"))


def main() -> None:
    shortcodes = fetch_json(GITHUB_EMOJIS)
    keywords_by_glyph = fetch_json(EMOJILIB)

    by_glyph: dict[str, list[str]] = {}
    for code, url in sorted(shortcodes.items()):
        glyph = glyph_from_url(url)
        if glyph:
            by_glyph.setdefault(glyph, []).append(code)

    entries = []
    for glyph, codes in by_glyph.items():
        # emojilib keys plain glyphs; GitHub URLs sometimes omit VS16 (fe0f)
        keywords = keywords_by_glyph.get(glyph) or keywords_by_glyph.get(glyph + "️") or []
        keywords = [word for word in keywords if word not in codes][:MAX_KEYWORDS]
        entries.append({"emoji": glyph, "codes": codes, "keywords": keywords})

    out = Path(__file__).parent / "emoji.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {len(entries)} emoji to {out}")


if __name__ == "__main__":
    main()
