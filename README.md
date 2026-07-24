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

- [`lib/`](extensions/lib) - Shared helpers imported by the extensions below (not auto-loaded): `util.ts` (small utilities), `state.ts` (state-file paths under `state/`), `codex.ts` (Codex OAuth + ChatGPT `/wham` backend API), `audio.ts` (24 kHz PCM16 capture/playback with AEC helper + ffmpeg fallback), `realtime.ts` (realtime WebSocket plumbing).
- [`account/`](extensions/account) - `/account` Codex plan, real rate-limit windows, credits, and profile stats.
- [`answer/`](extensions/answer) - `/answer` interactive Q&A from the last assistant message.
- [`btw/`](extensions/btw) - Side-chat popover for tangential questions.
- [`continue/`](extensions/continue) - Shortcut to send `continue` when the agent stops.
- [`cosmetic/`](extensions/cosmetic) - All UI chrome: random image header, custom footer (model, context, Codex plan and usage), whimsical working messages, and the completion sound.
- [`dictate/`](extensions/dictate) - `/dictate` push-to-talk voice input; `/dictate streaming|batch|best` picks the transcription mode (`gpt-realtime-whisper` live deltas / `gpt-4o-mini-transcribe` / `gpt-4o-transcribe`).
- [`fast/`](extensions/fast) - `/fast` for Codex priority mode.
- [`dupe/`](extensions/dupe) - Duplicate the current session into a new Ghostty split.
- [`emoji/`](extensions/emoji) - `:shortcode:` autocomplete and `/emoji` picker.
- [`files/`](extensions/files) - `/files` browser for Git and session-referenced files.
- [`goal/`](extensions/goal) - Long-running goals with budgets and progress tracking.
- [`recall/`](extensions/recall) - Project-scoped prompt history.
- [`reset/`](extensions/reset) - `/reset` for Codex usage-limit resets.
- [`review/`](extensions/review) - `/review` workflow for code changes and folders.
- [`say/`](extensions/say) - `/say` speak text or the last reply aloud (`gpt-realtime-2.1-mini` as TTS over OAuth).
- [`talk/`](extensions/talk) - `/talk` live voice conversation driving the agent (Codex-style realtime intermediary over OAuth); `/talk mini|voice` picks the cheaper or best-audio model tier.
- [`todos/`](extensions/todos) - File-based todo management and task refinement.
- [`translate/`](extensions/translate) - `/translate` live speech-to-speech translation via `gpt-realtime-translate`.
- [`unified-edit/`](extensions/unified-edit) - Replaces `edit` with row edit scripts and Codex-style patches.
- [`usage/`](extensions/usage) - Session usage and cost breakdown.
- [`uv/`](extensions/uv) - Replaces bash with a `uv`-aware version.

## Theme

- [`nightowl.json`](themes/nightowl.json) - Night Owl-inspired theme.

## Support Files

- [`scripts/analyze-edits.py`](scripts/analyze-edits.py) - `uv run scripts/analyze-edits.py` for edit-tool usage and failure stats from session logs.
- [`assets/emoji`](assets/emoji) - Emoji dataset for the emoji extension; regenerate with `uv run assets/emoji/build.py`.
- [`assets/shims`](assets/shims) - Python command shims used by the uv extension.
- [`assets/talk`](assets/talk) - Swift echo-cancellation audio helper for the talk extension (compiled on demand).
- [`assets/working-messages.json`](assets/working-messages.json) - Working-message list for the cosmetic extension.
- [`assets/images`](assets/images) - Header artwork.
- [`assets/sounds`](assets/sounds) - Completion notification sound.
- `state/` - Gitignored extension state (`fast.json`, `dictate.json`, `recall.json`, ...), managed via [`extensions/lib/state.ts`](extensions/lib/state.ts).
