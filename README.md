# Pi Kit

Personal [Pi Coding Agent](https://pi.dev/) setup: reusable skills, extensions, a theme, and supporting assets used across projects.

My day-to-day workflow runs mostly on Codex. Much of this kit is inspired by and adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff), built on top of and reshaped to fit my own workflow.

## Skills

Skills live in [`skills`](skills):

- [`agent-browser`](skills/agent-browser) - Browser automation and web-app testing.
- [`google-workspace`](skills/google-workspace) - Read and edit Google Docs and Sheets.
- [`imagegen`](skills/imagegen) - Generate and edit raster images.
- [`librarian`](skills/librarian) - Cache and refresh GitHub repositories.
- [`transcribe`](skills/transcribe) - Transcribe audio and video with cached MLX Whisper models.
- [`uv`](skills/uv) - Prefer `uv` for Python workflows.
- [`web-search`](skills/web-search) - Search the live web for current facts.

## Extensions

Pi extensions live in [`extensions`](extensions):

- [`answer.ts`](extensions/answer.ts) - `/answer` interactive Q&A from the last assistant message.
- [`btw.ts`](extensions/btw.ts) - Side-chat popover for tangential questions.
- [`continue.ts`](extensions/continue.ts) - Shortcut to send `continue` when the agent stops.
- [`cosmetic.ts`](extensions/cosmetic.ts) - All UI chrome: random image header, custom footer (model, context, Codex usage), whimsical working messages, and the completion sound.
- [`dictate.ts`](extensions/dictate.ts) - `/dictate` push-to-talk voice input via local MLX Whisper.
- [`fast.ts`](extensions/fast.ts) - `/fast` for Codex priority mode.
- [`files.ts`](extensions/files.ts) - `/files` browser for Git and session-referenced files.
- [`dupe.ts`](extensions/dupe.ts) - Duplicate the current session into a new Ghostty split.
- [`emoji.ts`](extensions/emoji.ts) - `:shortcode:` autocomplete and `/emoji` picker.
- [`goal.ts`](extensions/goal.ts) - Long-running goals with budgets and progress tracking.
- [`recall.ts`](extensions/recall.ts) - Project-scoped prompt history.
- [`reset.ts`](extensions/reset.ts) - `/reset` for Codex usage-limit resets.
- [`review.ts`](extensions/review.ts) - `/review` workflow for code changes and folders.
- [`todos.ts`](extensions/todos.ts) - File-based todo management and task refinement.
- [`unified-edit.ts`](extensions/unified-edit.ts) - Replaces `edit` with row edit scripts and Codex-style patches.
- [`usage.ts`](extensions/usage.ts) - Session usage and cost breakdown.
- [`talk.ts`](extensions/talk.ts) - `/talk` live voice conversation driving the agent (Codex-style realtime intermediary over OAuth).
- [`uv.ts`](extensions/uv.ts) - Replaces bash with a `uv`-aware version.

## Theme

- [`nightowl.json`](themes/nightowl.json) - Night Owl-inspired theme.

## Support Files

- [`analyze-edits.py`](analyze-edits.py) - `uv run analyze-edits.py` for edit-tool usage and failure stats from session logs.
- [`emoji`](emoji) - Emoji dataset for the emoji extension; regenerate with `uv run emoji/build.py`.
- [`shims`](shims) - Python command shims used by the uv extension.
- [`talk`](talk) - Swift echo-cancellation audio helper for the talk extension (compiled on demand).
- [`cosmetic`](cosmetic) - Working-message list for the cosmetic extension.
- [`images`](images) - Header artwork.
- [`sounds`](sounds) - Completion notification sound.
