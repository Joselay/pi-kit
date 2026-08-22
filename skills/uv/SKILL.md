---
name: uv
description: "Python environment and dependency work with uv: run Python commands or scripts, manage project dependencies and lockfiles, create standalone scripts, or configure uv_build packages."
---

## Workflow

1. Inspect `pyproject.toml`, `uv.lock`, and any inline script metadata. Preserve the repository's Python constraints, dependency groups, indexes, sources, and build backend.
2. Choose the matching mode:
   - **Project:** declare dependencies with `uv add` / `uv remove`; execute in the managed environment with `uv run`.
   - **Standalone script:** declare dependencies as inline metadata. Read [scripts.md](scripts.md).
   - **One-off tool:** use `uvx <tool>` so the tool stays isolated from the project.
   - **Package build:** retain the configured backend. For a new pure-Python package using `uv_build`, read [build.md](build.md).
3. Run the narrowest relevant check through `uv run`. Work is complete when dependency declarations and lockfiles agree and the check passes.

## Project commands

```bash
uv add requests                 # Published/runtime dependency
uv add --dev pytest             # Development dependency
uv remove requests
uv run pytest
uv run python -m ast foo.py >/dev/null  # Syntax check without __pycache__
uv sync                         # Explicitly synchronize the environment
uv lock --check                 # Verify that uv.lock matches project metadata
```

`uv run` locks and synchronizes a project automatically. Use `uv run --locked ...` in CI when a stale lockfile must fail rather than update.

Treat `pyproject.toml` and `uv.lock` as the source of truth. Use `uv pip` only for pip-compatible workflows that intentionally do not manage project metadata.
