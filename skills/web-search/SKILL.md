---
name: web-search
description: "Search the live web for facts that must be current or verified: library versions, release notes, API docs, CVEs, news, prices, schedules, weather. Use when the user asks to search or verify something online, or when built-in knowledge may be stale. Not for questions answerable from the local repository or from stable, well-known knowledge."
---

# Web Search Skill

All web searches go through the bundled `search.mjs` helper, which mirrors the upstream codex built-in `web_search` tool: the search runs server-side through the OAuth `/responses` endpoint with a hosted `web_search` tool.

## Rules

- Run searches directly without reconfirmation unless the query is ambiguous.
- OAuth is the only credential: if it is unavailable or the helper reports an auth error, ask the user to run `/login`. Never fall back to an API key, alternate search provider, or one-off SDK runner, and never read or expose authentication storage.
- The helper's model pin and request shape are fixed to match upstream; do not modify `search.mjs` during a search task or expose model selection to callers.
- Treat returned answers as reports from external sources: keep the citations when relaying facts to the user, and note when sources conflict or look stale.

## Usage

```bash
node <skill-directory>/search.mjs --query "<focused question>"
```

Give each call at least a 120-second timeout. The helper prints the searches performed, the cited answer, and a numbered source list.

- `--query <text>` / `--query-file <path>` — exactly one is required; use `--query-file` for long queries.
- `--raw` — single-shot search via the standalone `alpha/search` endpoint (the one upstream codex's `web.run` tool posts to): no answering-model pass, just the raw search output and result links. Faster and cheaper; use it for "find me the link/source" lookups where no synthesis is needed. `--recency <days>` restricts raw results to the last N days.
- `--mode <cached|indexed|live>` — default `cached` (the upstream default) answers from the search index only; `indexed` allows live fetches of indexed URLs; `live` allows unrestricted live fetches. Escalate to `live` when freshness matters (breaking news, just-published releases, live status pages) or when `cached` results look stale.
- `--allowed-domains <a.com,b.org>` — restrict results to specific domains (for example, pin documentation lookups to the official docs site).
- `--search-context-size <low|medium|high>` — how much search context the hosted tool retrieves; leave unset for the server default, like upstream.
- `--country <ISO code>`, `--region <text>`, `--city <text>`, `--timezone <IANA tz>` — approximate user location for localized results (weather, schedules, local businesses).
- `--json` — print `{searches, answer, sources}` as JSON instead of formatted text.

## Query guidance

- Phrase the query as a complete, specific question including names, versions, and constraints; the server-side searcher chooses its own search terms from it.
- Include "as of <today's date>" or "latest" explicitly when recency is the point of the question.
- For comparisons or multi-part research, run separate focused calls and synthesize the results yourself.
- If the answer conflicts with local evidence (lockfiles, vendored docs), say so and prefer verifiable sources.
