#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: start-session.sh [-c directory] [--user-config] -- command [args...]

Start a command in a new isolated tmux server and print reusable identifiers.

Options:
  -c, --cwd          working directory for the command (default: current directory)
  --user-config      load the user's tmux configuration instead of /dev/null
  -h, --help         show this help
USAGE
}

cwd="$PWD"
config=/dev/null

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--cwd)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      cwd="$2"; shift 2 ;;
    --user-config) config=""; shift ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    *) break ;;
  esac
done

[[ $# -gt 0 ]] || { echo "command is required" >&2; usage; exit 1; }
[[ -d "$cwd" ]] || { echo "working directory does not exist: $cwd" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "tmux not found in PATH" >&2; exit 1; }

socket_root="${PI_TMUX_SOCKET_DIR:-/tmp/pi-tmux-$UID}"
umask 077
mkdir -p "$socket_root"
chmod 700 "$socket_root"
run_dir="$(mktemp -d "$socket_root/run-XXXXXXXX")"
socket="$run_dir/tmux.sock"
session="pi-$(basename "$run_dir")"
target="$session:0.0"

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

command_text="exec"
for arg in "$@"; do
  command_text+=" $(shell_quote "$arg")"
done

tmux_args=(-S "$socket")
[[ -n "$config" ]] && tmux_args+=(-f "$config")

if ! tmux "${tmux_args[@]}" new-session -d -s "$session" -n main -c "$cwd" \
  "$command_text" \; set-option -t "$session" remain-on-exit on; then
  rm -rf "$run_dir"
  exit 1
fi

printf 'SOCKET=%s\nSESSION=%s\nTARGET=%s\n' "$socket" "$session" "$target"
printf 'MONITOR='
printf '%q ' tmux -S "$socket" attach-session -t "$session"
printf '\nSNAPSHOT='
printf '%q ' tmux -S "$socket" capture-pane -p -J -t "$target" -S -200
printf '\n'
