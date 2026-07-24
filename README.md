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
- [`youtube`](skills/youtube) - Summarize and answer questions about YouTube videos from their captions.

## Extensions

Pi extensions live in [`extensions`](extensions):

- [`lib/`](extensions/lib) - Shared helpers imported by the extensions below (not auto-loaded): `util.ts` (small utilities), `codex.ts` (Codex OAuth + ChatGPT `/wham` backend API), `audio.ts` (24 kHz PCM16 capture/playback with AEC helper + ffmpeg fallback), `realtime.ts` (realtime WebSocket plumbing).
- [`account.ts`](extensions/account.ts) - `/account` Codex plan, real rate-limit windows, credits, and profile stats.
- [`answer.ts`](extensions/answer.ts) - `/answer` interactive Q&A from the last assistant message.
- [`btw.ts`](extensions/btw.ts) - Side-chat popover for tangential questions.
- [`continue.ts`](extensions/continue.ts) - Shortcut to send `continue` when the agent stops.
- [`cosmetic.ts`](extensions/cosmetic.ts) - All UI chrome: random image header, custom footer (model, context, Codex plan and usage), whimsical working messages, and the completion sound.
- [`dictate.ts`](extensions/dictate.ts) - `/dictate` push-to-talk voice input; `/dictate streaming|batch|best` picks the transcription mode (`gpt-realtime-whisper` live deltas / `gpt-4o-mini-transcribe` / `gpt-4o-transcribe`).
- [`fast.ts`](extensions/fast.ts) - `/fast` for Codex priority mode.
- [`dupe.ts`](extensions/dupe.ts) - Duplicate the current session into a new Ghostty split.
- [`emoji.ts`](extensions/emoji.ts) - `:shortcode:` autocomplete and `/emoji` picker.
- [`files.ts`](extensions/files.ts) - `/files` browser for Git and session-referenced files.
- [`goal.ts`](extensions/goal.ts) - Long-running goals with budgets and progress tracking.
- [`recall.ts`](extensions/recall.ts) - Project-scoped prompt history.
- [`reset.ts`](extensions/reset.ts) - `/reset` for Codex usage-limit resets.
- [`review.ts`](extensions/review.ts) - `/review` workflow for code changes and folders.
- [`say.ts`](extensions/say.ts) - `/say` speak text or the last reply aloud (`gpt-realtime-2.1-mini` as TTS over OAuth).
- [`talk.ts`](extensions/talk.ts) - `/talk` live voice conversation driving the agent (Codex-style realtime intermediary over OAuth); `/talk mini|voice` picks the cheaper or best-audio model tier.
- [`todos.ts`](extensions/todos.ts) - File-based todo management and task refinement.
- [`translate.ts`](extensions/translate.ts) - `/translate` live speech-to-speech translation via `gpt-realtime-translate`.
- [`unified-edit.ts`](extensions/unified-edit.ts) - Replaces `edit` with row edit scripts and Codex-style patches.
- [`usage.ts`](extensions/usage.ts) - Session usage and cost breakdown.
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
