---
name: commit
description: Create or amend a git commit; read before any commit operation.
---

# Commit

Create one focused commit whose staged diff is the exact **boundary** requested by the user. Use one compound shell call per phase so independent Git reads do not incur separate round trips.

## Inputs

Treat caller arguments as commit guidance:

- Paths or globs define the boundary. Include only matching changes unless the user expands it.
- Freeform text guides the commit type, scope, subject, and body.
- When both appear, apply the text to the path-limited boundary.
- With no explicit paths, infer the boundary from the current task and repository state. Existing unrelated changes remain outside it.

Ask one concise question when the boundary cannot be inferred safely. In particular, clarify unrelated staged changes, suspicious untracked files, or files mixing requested and unrelated edits.

## Procedure

1. **Snapshot.** In one shell call, print labeled sections for `git status --short --untracked-files=all`, `git diff`, and `git diff --cached`. Read intended untracked files separately because Git diffs omit them. Apply pathspecs to diffs only when the caller supplied a boundary; keep status repository-wide so outside work remains visible. Include `git log -n 50 --pretty=format:%s` in the same call only when repository vocabulary would help choose a scope.

   Classify every item, read every in-boundary hunk, and check for generated files, debug output, credentials, or unrelated edits.

   **Done when:** every item is inside or outside the boundary, and one coherent purpose explains every selected change.

2. **Stage and audit.** Stage explicit files or hunks. Preserve outside work; when whole files can be staged safely, combine the staging command and these checks in one shell call:

   ```sh
   git add -- <paths> &&
   git diff --cached --name-status &&
   git diff --cached &&
   git diff --cached --check
   ```

   For partial files, stage interactively first, then run the three audit commands together. Treat the cached diff as the final source of truth. If the existing index contains outside changes, clarify rather than resetting or including them. If the index is empty, report that there is nothing to commit.

   **Done when:** every staged hunk belongs, every intended hunk is present, and the cached diff check passes.

3. **Write a Conventional Commit.** Every commit message must follow Conventional Commits:

   ```text
   <type>[optional scope]: <description>
   ```

   - `type` is required and lowercase: use `feat` for a feature, `fix` for a bug, or `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, or `chore` when they fit better.
   - `scope` is optional and parenthesized: use a short repository-native noun, as in `fix(parser):`.
   - `description` is imperative, specific, lowercase at the start, at most 72 characters including the prefix, and has no trailing period.
   - Add a body only when the rationale or a non-obvious consequence matters. Separate it from the subject with a blank line and keep it concise.
   - For a breaking change, add `!` before `:` and explain it in a `BREAKING CHANGE:` footer. Omit other footers and sign-offs.

   **Done when:** the message is valid Conventional Commits syntax and describes the audited staged diff rather than the surrounding task.

4. **Commit and verify.** Keep hooks enabled and amend only when explicitly requested. Run commit and verification in one shell call:

   ```sh
   git commit -m "<subject>" &&
   git show --stat --oneline --decorate --no-renames HEAD &&
   git status --short
   ```

   Add a second `-m` only when the message needs a body. If a hook fails or modifies files, the chain stops; inspect status and the cached diff together before deciding whether a safe retry is possible.

   **Done when:** the commit succeeds, its displayed contents match the audited boundary, and all residual changes are identified.

## Guardrails

- Commit locally; leave pushing to an explicit separate request.
- Preserve unrelated user work in both the index and worktree.
- Keep repository hooks active; fix or report failures instead of using `--no-verify`.
- Report the commit hash and subject, plus any residual changes or failed checks.
