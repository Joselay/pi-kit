#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh [-L socket-name|-S socket-path] -t target -p pattern [options]

Poll a tmux pane until a pattern reaches the required matching-line count.

Options:
  -L, --socket       tmux socket name (passed to tmux -L)
  -S, --socket-path  tmux socket path (passed to tmux -S)
  -t, --target    tmux target (session:window.pane), required
  -p, --pattern   regex pattern to look for, required
  -F, --fixed     treat pattern as a fixed string (grep -F)
  -n, --count     required occurrence count (positive integer, default: 1)
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -l, --lines     number of history lines to inspect (integer, default: 1000)
  -h, --help      show this help
USAGE
}

target=""
pattern=""
socket_name=""
socket_path=""
grep_flag="-E"
required_count=1
timeout=15
interval=0.5
lines=1000

while [[ $# -gt 0 ]]; do
  case "$1" in
    -L|--socket)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      socket_name="$2"; shift 2 ;;
    -S|--socket-path)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      socket_path="$2"; shift 2 ;;
    -t|--target)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      target="$2"; shift 2 ;;
    -p|--pattern)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      pattern="$2"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -n|--count)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      required_count="$2"; shift 2 ;;
    -T|--timeout)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      timeout="$2"; shift 2 ;;
    -i|--interval)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      interval="$2"; shift 2 ;;
    -l|--lines)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      lines="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -n "$socket_name" && -n "$socket_path" ]]; then
  echo "Use either -L or -S, not both" >&2
  exit 1
fi

if [[ -z "$target" || -z "$pattern" ]]; then
  echo "target and pattern are required" >&2
  usage
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! [[ "$required_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "count must be a positive integer" >&2
  exit 1
fi

if ! [[ "$lines" =~ ^[1-9][0-9]*$ ]]; then
  echo "lines must be a positive integer" >&2
  exit 1
fi

if ! [[ "$interval" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] ||
   [[ "$interval" =~ ^0*([.]0*)?$ ]]; then
  echo "interval must be a positive number" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

tmux_cmd=(tmux)
if [[ -n "$socket_name" ]]; then
  tmux_cmd+=(-L "$socket_name")
elif [[ -n "$socket_path" ]]; then
  tmux_cmd+=(-S "$socket_path")
fi

deadline=$((SECONDS + timeout))

while true; do
  if ! pane_text="$("${tmux_cmd[@]}" capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null)"; then
    echo "Unable to capture tmux target: $target" >&2
    exit 2
  fi

  if match_count="$(printf '%s\n' "$pane_text" | grep "$grep_flag" -c -- "$pattern")"; then
    :
  else
    grep_status=$?
    if (( grep_status == 1 )); then
      match_count=0
    else
      echo "Invalid grep pattern: $pattern" >&2
      exit 2
    fi
  fi
  if (( match_count >= required_count )); then
    exit 0
  fi

  if (( SECONDS >= deadline )); then
    echo "Timed out after ${timeout}s waiting for $required_count matching line(s) of: $pattern" >&2
    echo "Last ${lines} lines from $target:" >&2
    printf '%s\n' "$pane_text" >&2
    exit 1
  fi

  sleep "$interval"
done
