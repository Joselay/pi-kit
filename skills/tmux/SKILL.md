---
name: tmux
description: "Operate interactive CLIs, debuggers, full-screen TUIs, and long-running commands in tmux; reconnect to live sessions when work may already exist."
---

# tmux

Drive one pane through a **checkpoint loop**:

> observe → predict → send once → wait for fresh evidence → observe

Resolve `<skill-dir>` to this file's directory. Carry the literal socket path, session name, and full `session:window.pane` target across tool calls; shell variables do not persist.

## Select a session

When the requested program may already exist, discover first:

```bash
"<skill-dir>/scripts/find-sessions.sh" --all
tmux -S '<socket>' list-panes -a \
  -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'
tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
```

The discovery output gives the literal socket path and copyable connection arguments. Reconnect only after the pane command and capture identify the requested program.

Otherwise create a one-pane isolated server. Pass the program and each argument separately after `--`:

```bash
"<skill-dir>/scripts/start-session.sh" -c '<working-directory>' -- \
  env PYTHON_BASIC_REPL=1 python3 -q
```

The helper uses a unique private socket, `/dev/null` tmux configuration, and `remain-on-exit` so early failure output survives. Use `--user-config` only when testing the user's tmux configuration.

**Checkpoint:** a successful `capture-pane` on the printed `TARGET` shows the expected program, prompt, or preserved exit output.

## Expose access

Before driving the program, give the user the literal `MONITOR` and `SNAPSHOT` commands printed by the start helper. For a reconnected session, provide equivalents:

```text
Monitor:  tmux -S '<socket>' attach-session -t '<session>'
Snapshot: tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
Detach:   Ctrl+b d
```

**Checkpoint:** `has-session` and `capture-pane` both succeed for the reported identifiers.

## Drive

### Observe and predict

Capture immediately before every input:

```bash
tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
```

Name the state expected after the input: preferably a unique completion marker; otherwise a fresh prompt, output line, screen transition, stop reason, or process exit. Existing pane text is stale evidence.

### Send once and wait

Send literal text and `Enter` separately. Send key names such as `C-c`, `C-d`, `Escape`, and arrows only as deliberate control input.

```bash
tmux -S '<socket>' send-keys -t '<target>' -l -- 'print("PI_DONE_a81f")'
tmux -S '<socket>' send-keys -t '<target>' Enter
"<skill-dir>/scripts/wait-for-text.sh" \
  -S '<socket>' -t '<target>' -F -p 'PI_DONE_a81f' -T 15 -l 4000
tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
```

Choose a marker that cannot already exist in pane history. When the program cannot emit one and output is append-only, count matching lines before input and wait for one additional matching line:

```bash
set -euo pipefail
SOCKET='<socket>'; TARGET='<target>'; PATTERN='^>>>'
PANE="$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -4000)"
SEEN="$(printf '%s\n' "$PANE" | grep -Ec -- "$PATTERN" || true)"
tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- '2 + 2'
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter
"<skill-dir>/scripts/wait-for-text.sh" -S "$SOCKET" -t "$TARGET" \
  -p "$PATTERN" -n "$((SEEN + 1))" -T 15 -l 4000
tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -200
```

This fallback counts matching **lines**, so use it only while the baseline remains in retained history. For full-screen redraws, checkpoint on a visible state transition instead.

A timeout's pane dump is the next observation. Diagnose it before choosing to wait longer, interrupt, or send different input. Retry an input only when fresh evidence proves the program did not receive it. `tmux wait-for` coordinates tmux events, not pane output.

**Checkpoint:** every input has one preceding capture and one fresh resulting state; the final capture proves the requested outcome.

## Close or preserve

Preserve a created session when the user requested continued access or its command is still running at handoff. Report its monitor command and exact observed state. Otherwise remove only the session created in this run:

```bash
tmux -S '<socket>' kill-session -t '=<session>'
! tmux -S '<socket>' has-session -t '=<session>' 2>/dev/null
```

Leave reconnected sessions alive unless the user explicitly requests termination.

**Checkpoint:** each created session is either reported live with a working monitor command or confirmed absent.

## Program checkpoints

- **Python:** `env PYTHON_BASIC_REPL=1 python3 -q`; prompt `^>>>`.
- **LLDB:** `lldb -- <program> [args...]`; prompt `^\(lldb\)`. After `run`, `continue`, `next`, or `step`, wait for a fresh stop reason, exit, or prompt. Inspect with `thread list`, `bt`, `frame variable`, and `register read`. Observe that the inferior is running before sending `C-c` once; then wait for a fresh stop and prompt.
- **Other debuggers:** disable pagination where supported; checkpoint on fresh stops and prompts; confirm destructive actions.
- **Full-screen TUIs:** checkpoint on stable screen text or a deliberate screen transition; capture after each key sequence.
- **Long-running commands:** checkpoint on a task-specific marker and preserve while work continues.

Run any helper with `--help` for authoritative options and defaults.
