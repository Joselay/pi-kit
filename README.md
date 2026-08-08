# Pi Kit

Jose's personal [Pi Coding Agent](https://pi.dev/) toolkit: reusable extensions, skills, prompt commands, themes, and supporting utilities used across projects.

The repository follows Pi's conventional agent-directory layout:

- [`extensions`](extensions) contains Pi extensions
- [`skills`](skills) contains agent skills
- [`themes`](themes) contains Pi themes
- [`prompts`](prompts) contains prompt commands

Most items are tuned for my workflow and environment, so expect to adjust paths, credentials, account details, or defaults before reusing them elsewhere.

## Prompt Commands

Prompt commands live in [`prompts`](prompts):

- [`/discuss`](prompts/discuss.md) - Planning interviewer mode. It inspects the project first, asks focused questions in short rounds, and stops once the plan is clear enough to implement.

## Skills

Skills live in [`skills`](skills). Each skill has a `SKILL.md` plus any helper scripts or reference material it needs.

- [`/agent-browser`](skills/agent-browser) - Operate rendered browser sessions for interaction, exploratory QA, Electron apps, Slack, and remote browser environments.
- [`/audio-transcription`](skills/audio-transcription) - Transcribe local audio, video, and Apple Voice Memos with cached MLX Whisper models.
- [`/commit`](skills/commit) - Create concise Conventional Commits-style Git commits after reviewing the intended changes.
- [`/frontend-design`](skills/frontend-design) - Design and implement distinctive, production-ready frontend pages, components, and applications.
- [`/google-workspace`](skills/google-workspace) - Work with Google Docs, Sheets, Drive, and Gmail through `gws`.
- [`/imagegen`](skills/imagegen) - Generate and edit raster images through an OAuth-backed image-generation workflow.
- [`/librarian`](skills/librarian) - Cache and inspect cited remote Git repositories for implementation research and comparison.
- [`/summarize`](skills/summarize) - Convert URLs and local documents into Markdown with MarkItDown, optionally summarizing them.
- [`/tmux`](skills/tmux) - Drive interactive and long-running terminal applications through a tmux checkpoint loop.
- [`/uv`](skills/uv) - Standardize Python execution, dependencies, scripts, and environments on `uv`.
- [`/writing-for-agents`](skills/writing-for-agents) - Write reliable skills and agent instruction files such as `AGENTS.md` and `CLAUDE.md`.

## Extensions

Pi extensions live in [`extensions`](extensions):

- [`account.ts`](extensions/account.ts) - Switch between stored OpenAI Codex OAuth accounts while displaying plan and rate-limit details.
- [`answer.ts`](extensions/answer.ts) - Extract unresolved questions from the latest assistant response and collect answers through an interactive Q&A.
- [`btw.ts`](extensions/btw.ts) - Open a persistent side-chat popover without interrupting the primary thread.
- [`context.ts`](extensions/context.ts) - Visualize context-window usage across prompts, files, skills, tools, messages, and free capacity.
- [`continue.ts`](extensions/continue.ts) - Send `continue` with `shift+option+enter` when the agent is idle.
- [`control.ts`](extensions/control.ts) - Expose optional Unix-socket controls for messaging, querying, clearing, and coordinating live Pi sessions.
- [`dictate.ts`](extensions/dictate.ts) - Provide hold-backtick macOS dictation using FFmpeg and OpenAI realtime transcription.
- [`edit.ts`](extensions/edit.ts) - Add a grammar-constrained `apply_patch` editing tool with validation and atomic file operations.
- [`fast.ts`](extensions/fast.ts) - Toggle persistent OpenAI Codex priority processing for supported models with `/fast`.
- [`files.ts`](extensions/files.ts) - Browse Git and session-referenced files, with actions for opening, editing, diffing, revealing, and Quick Look.
- [`goal.ts`](extensions/goal.ts) - Manage session-backed long-running goals with automatic continuation and optional token budgets.
- [`handoff.ts`](extensions/handoff.ts) - Generate a redacted conversation handoff and start a linked session to continue the work.
- [`no-sleep.ts`](extensions/no-sleep.ts) - Keep macOS awake with `caffeinate` while a Pi session is running.
- [`notify.ts`](extensions/notify.ts) - Play a notification sound when an interactive agent run settles.
- [`recall.ts`](extensions/recall.ts) - Populate editor history with recent prompts from the current and previous sessions.
- [`reset.ts`](extensions/reset.ts) - Display and redeem available OpenAI Codex usage-limit reset credits.
- [`review.ts`](extensions/review.ts) - Run structured reviews of pull requests, branches, commits, uncommitted changes, or folders.
- [`session-name.ts`](extensions/session-name.ts) - Display the current session name as an accent badge on the editor border.
- [`mentions.ts`](extensions/mentions.ts) - Highlight skill and file mentions, autocomplete skills, and expand `/skill-name` invocations into skill instructions.
- [`split-fork.ts`](extensions/split-fork.ts) - Fork the current session into a right-hand Ghostty split on macOS.
- [`statusline.ts`](extensions/statusline.ts) - Replace the footer with project, branch, model, thinking, context, fast-mode, and Codex usage information.
- [`subagent.ts`](extensions/subagent.ts) - Run serialized delegated tasks in observable tmux-backed Pi child sessions.
- [`todos.ts`](extensions/todos.ts) - Manage claimable file-based project todos through an agent tool and interactive `/todos` interface.
- [`trust-github-repos.ts`](extensions/trust-github-repos.ts) - Automatically trust GitHub checkouts owned by configured accounts.
- [`usage.ts`](extensions/usage.ts) - Show OpenAI Codex account, plan, rate-limit, spend, credit, and reset information.
- [`uv.ts`](extensions/uv.ts) - Replace the Bash tool with a guarded version that redirects Python workflows to `uv`.
- [`web-search.ts`](extensions/web-search.ts) - Add web, image, page, finance, weather, sports, PDF, and time lookup operations.
- [`whimsical.ts`](extensions/whimsical.ts) - Rotate playful working messages while the agent is processing a turn.

## Themes

Custom themes live in [`themes`](themes):

- [`dayowl.json`](themes/dayowl.json) - Light Day Owl-inspired theme.
- [`nightowl.json`](themes/nightowl.json) - Dark Night Owl-inspired theme.

## Support Files and Utilities

- [`intercepted-commands`](intercepted-commands) - Shell shims for `pip`, `pip3`, `poetry`, `python`, and `python3`, used by [`extensions/uv.ts`](extensions/uv.ts) to steer agents toward `uv`.
- [`settings.json`](settings.json) - Pi model, theme, thinking-level, and TUI defaults.

## Setup

Clone the repository as your Pi agent directory, or copy only the resources you want into an existing configuration:

```sh
git clone https://github.com/Joselay/pi-kit.git ~/.pi/agent
```

Some extensions and skills require local tools, credentials, macOS features, or account-specific configuration. Review their source and `SKILL.md` files before enabling them.
