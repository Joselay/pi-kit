# /// script
# requires-python = ">=3.11"
# ///
"""Regenerate emoji.json from github/gemoji and emojilib keywords.

gemoji is the upstream source of GitHub's shortcode API and stores
fully-qualified glyphs (including U+FE0F variation selectors), so
:heart: renders as the red emoji rather than the raw text-style glyph.

Usage: uv run emoji/build.py
"""

import json
import urllib.request
from pathlib import Path

GEMOJI = "https://raw.githubusercontent.com/github/gemoji/master/db/emoji.json"
EMOJILIB = "https://cdn.jsdelivr.net/npm/emojilib@4/dist/emoji-en-US.json"
MAX_KEYWORDS = 8
VS16 = "️"


def fetch_json(url: str) -> list | dict:
    request = urllib.request.Request(url, headers={"User-Agent": "pi-emoji-build"})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def main() -> None:
    gemoji = fetch_json(GEMOJI)
    keywords_by_glyph = fetch_json(EMOJILIB)

    entries = []
    for item in gemoji:
        glyph = item.get("emoji")
        if not glyph:
            continue  # non-unicode GitHub emoji like octocat or shipit

        codes = item["aliases"]
        # emojilib keys vary in VS16 usage; try both forms
        extra = (
            keywords_by_glyph.get(glyph)
            or keywords_by_glyph.get(glyph.replace(VS16, ""))
            or keywords_by_glyph.get(glyph + VS16)
            or []
        )
        seen = set(codes)
        keywords = []
        for word in [item["description"].replace(" ", "_"), *item.get("tags", []), *extra]:
            if word not in seen:
                seen.add(word)
                keywords.append(word)
        entries.append({"emoji": glyph, "codes": codes, "keywords": keywords[:MAX_KEYWORDS]})

    out = Path(__file__).parent / "emoji.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {len(entries)} emoji to {out}")


if __name__ == "__main__":
    main()
