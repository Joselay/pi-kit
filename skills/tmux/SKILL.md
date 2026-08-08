---
name: tmux
description: "Tmux checkpoint loop for driving interactive REPLs, debuggers, and TTY applications; observing long-running commands; and reconnecting to live sessions."
---

# tmux

Drive one pane through a **checkpoint loop**:

> observe → predict → send once → wait for fresh evidence → observe

Resolve `<skill-dir>` to this file's directory. Keep the literal socket path, session name, and full `session:window.pane` target across tool calls; shell variables do not persist.

## Start or reconnect

Reconnect when the requested program may already exist:

```bash
"<skill-dir>/scripts/find-sessions.sh" --all
tmux -S '<socket>' list-panes -a \
  -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'
tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
```

Otherwise create an isolated one-pane server. Replace the final command with the program itself so its initial screen is observable:

```bash
SOCKET_DIR="${PI_TMUX_SOCKET_DIR:-/tmp/pi-tmux-$UID}"
RUN_ID="${PI_SESSION_ID:-$(date +%s)-$$}"
SOCKET="$SOCKET_DIR/${RUN_ID:0:12}.sock"
SESSION="pi-$(date +%s)-$$"
TARGET="$SESSION:0.0"
umask 077
mkdir -p "$SOCKET_DIR"
tmux -S "$SOCKET" -f /dev/null new-session -d -s "$SESSION" -n main \
  'exec env PYTHON_BASIC_REPL=1 python3 -q' \; \
  set-option -t "$SESSION" remain-on-exit on
printf 'SOCKET=%s\nSESSION=%s\nTARGET=%s\n' "$SOCKET" "$SESSION" "$TARGET"
```

Use `/dev/null` configuration for isolation; use the user's tmux configuration only when the task tests it. `remain-on-exit` preserves output from early failures.

**Checkpoint:** `capture-pane` on one literal target shows the expected program, prompt, or preserved exit output.

## Expose

Give the user literal copy/paste access before driving the program:

```text
Monitor:  tmux -S '<socket>' attach-session -t '<session>'
Snapshot: tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
Detach:   Ctrl+b d
```

**Checkpoint:** both monitor and snapshot commands identify the selected live session.

## Drive

### Observe and predict

Capture before every input:

```bash
tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
```

Name the state expected after the next input: preferably a unique completion marker; otherwise a fresh prompt, output line, screen transition, or process exit. A visible prompt from before the input is stale evidence.

### Send once and wait

For a prompt that may already occur in history, count it before sending and wait for one additional occurrence. Keep baseline, input, wait, and final capture in one fail-fast shell call:

```bash
set -euo pipefail
SOCKET='<socket>'
TARGET='<target>'
WAIT='<skill-dir>/scripts/wait-for-text.sh'
PATTERN='^>>>'
PANE="$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -4000)"
SEEN="$(printf '%s\n' "$PANE" | grep -Ec -- "$PATTERN" || true)"
tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- '2 + 2'
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter
"$WAIT" -S "$SOCKET" -t "$TARGET" -p "$PATTERN" \
  -n "$((SEEN + 1))" -T 15 -l 4000
tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -200
```

Send text with `-l --` and send `Enter` separately. Send key names such as `C-c`, `C-d`, `Escape`, or arrow keys only as deliberate control input.

For a unique marker that cannot predate the input, wait directly:

```bash
"<skill-dir>/scripts/wait-for-text.sh" \
  -S '<socket>' -t '<target>' -p '<marker>' -T 30 -l 4000
tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
```

On timeout, treat the helper's pane dump as the next observed state. Diagnose that state before deciding whether to wait longer, interrupt, or send different input. Never retry the same input blindly.

Repeat until the final capture contains the requested outcome. `tmux wait-for` coordinates tmux events, not pane output; use the helper for text checkpoints.

**Checkpoint:** every input has one preceding observation and one fresh resulting state; the final state proves the task outcome.

## Close or preserve

Preserve a created session while its program remains useful or when the user requested continued access. Report its monitor command and exact current state.

Otherwise remove only sessions created during this run:

```bash
tmux -S '<socket>' kill-session -t '<session>'
if tmux -S '<socket>' has-session -t '<session>' 2>/dev/null; then
  echo 'session still exists' >&2
  exit 1
fi
```

Leave pre-existing sessions alive unless the user explicitly requests termination.

**Checkpoint:** every created session is either reported live with a monitor command or confirmed absent.

## Program reference

- **Python:** start with `PYTHON_BASIC_REPL=1 python3 -q`; checkpoint on `^>>>`.
- **Debuggers:** disable pagination, checkpoint on the debugger prompt, observe before interrupting an inferior, and confirm destructive actions.
- **Full-screen TUIs:** checkpoint on stable screen text or a deliberate state transition; capture after every key sequence.
- **Long-running commands:** checkpoint on a task-specific marker. Preserve the session while work continues.

Run either helper with `--help` for authoritative options and defaults.
