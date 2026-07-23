---
name: librarian
description: Cache and refresh GitHub repositories for local reference. Use when a user provides a GitHub URL or refers to a GitHub-hosted repo whose source you need.
---

# Librarian

Run `bash <skill-directory>/checkout.sh <github-url>` for every GitHub URL, even when cached. Treat the cache as read-only.

Output on stdout:

- Line 1: the checkout directory. Read and search there.
- Optional `path: <subpath>` line when the URL pointed at a file or directory inside the repo. Start there.

The script checks out the exact revision the URL names: plain repo URLs use the default branch, and `/tree/<ref>`, `/blob/<ref>/<file>`, `/commit/<sha>`, `/releases/tag/<tag>`, and `/pull/<n>` URLs use that ref. `git@github.com:owner/repo` and scheme-less `github.com/...` forms also work. Non-content URLs (issues, actions, wiki, ...) fall back to the default branch with a note on stderr.

Every run checks the remote so results are always the latest upstream state. Set `LIBRARIAN_REFRESH_TTL=<seconds>` to reuse remote lookups for that long instead (faster when reading many files from one repo).
