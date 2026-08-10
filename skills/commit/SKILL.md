---
name: commit
description: Create or amend a git commit; read before any commit operation.
---

# Commit

Create one focused commit whose staged diff is the exact **boundary** requested by the user.

## Inputs

Treat caller arguments as commit guidance:

- Paths or globs define the boundary. Include only matching changes unless the user expands it.
- Freeform text guides the commit type, scope, subject, and body.
- When both appear, apply the text to the path-limited boundary.
- With no explicit paths, infer the boundary from the current task and repository state. Existing unrelated changes remain outside it.

Ask one concise question when the boundary cannot be inferred safely. In particular, clarify unrelated staged changes, suspicious untracked files, or files mixing requested and unrelated edits.

## Procedure

1. **Inventory.** Run `git status --short --untracked-files=all`, then inspect both `git diff` and `git diff --cached`. Inspect intended untracked files separately because they do not appear in either diff. Limit pathspecs only when the caller supplied a path boundary.

   **Done when:** every staged, unstaged, and untracked item is classified as inside or outside the boundary.

2. **Understand.** Read the complete diff inside the boundary. Identify the user-visible purpose and check for accidental generated files, debug output, credentials, or unrelated edits. Use recent subjects such as `git log -n 50 --pretty=format:%s` only when repository vocabulary would help choose a scope.

   **Done when:** one coherent purpose explains every change selected for the commit.

3. **Stage.** Stage explicit files or hunks inside the boundary. Preserve changes outside it. Avoid broad staging commands when the worktree contains anything outside the boundary. If the existing index includes outside changes, clarify rather than resetting or silently including them.

   **Done when:** `git diff --cached --name-status` names only intended files.

4. **Audit the index.** Read `git diff --cached` as the final source of truth and run `git diff --cached --check`. Resolve boundary mistakes before continuing. If nothing is staged, report that there is nothing to commit.

   **Done when:** every staged hunk belongs, no intended hunk is missing, and the cached diff check passes.

5. **Write the message.** Use this subject form:

   ```text
   <type>(<scope>): <summary>
   ```

   - `type` is required: prefer `feat` for a feature and `fix` for a bug; use `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, or `chore` when they fit better.
   - `scope` is optional: use a short repository-native noun.
   - `summary` is imperative, specific, at most 72 characters, and has no trailing period.
   - Add a body only when the rationale or a non-obvious consequence matters. Separate it from the subject with a blank line and keep it concise.
   - Omit breaking-change markers, footers, and sign-offs.

   **Done when:** the message describes the audited staged diff rather than the surrounding task.

6. **Commit.** Run `git commit -m "<subject>"`, adding a second `-m` argument only for a body. Keep hooks enabled. Amend only when the user explicitly requested an amend. If a hook fails or modifies files, inspect the new status and cached diff before deciding whether a safe retry is possible.

   **Done when:** `git commit` succeeds without bypassing repository checks.

7. **Verify.** Inspect the new commit with `git show --stat --oneline --decorate --no-renames HEAD` and check `git status --short` for residual work.

   **Done when:** the new commit contains the audited boundary and all remaining changes are identified as uncommitted.

## Guardrails

- Commit locally; leave pushing to an explicit separate request.
- Preserve unrelated user work in both the index and worktree.
- Keep repository hooks active; fix or report failures instead of using `--no-verify`.
- Report the commit hash and subject, plus any residual changes or failed checks.
