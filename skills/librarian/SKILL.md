---
name: librarian
description: "Repository research: use when a task cites a remote Git repository to inspect, compare, or use as an implementation reference."
---

# Librarian

## 1. Catalog the repository

Run [`checkout.sh`](checkout.sh) with the cited repository reference:

```bash
bash ~/.pi/agent/skills/librarian/checkout.sh '<repo-reference>' --path-only
```

Quote the reference as one argument. The script accepts `owner/repo`, host paths, HTTPS or SSH URLs, and repository deep links; `owner/repo` defaults to GitHub.

Add `--force-update` when the task requires the latest remote state; otherwise use its throttled refresh. Consult `--help` for overrides.

Complete only when the command returns a checkout path containing a Git repository.

## 2. Research from the catalog

Search and read the returned path until every repository-dependent claim needed by the result is verified against the checkout.

For a later task, run `checkout.sh` again: it reuses the stable catalog path and refreshes stale checkouts.

## 3. Isolate modifications

When the task requires edits, create a worktree or copy outside the catalog and modify that workspace. Complete only when every task change lives there and `git status --porcelain` in the cached checkout contains no task-specific change.
