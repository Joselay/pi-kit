#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: find-sessions.sh [-L socket-name|-S socket-path|-A] [-q text]

List tmux sessions on a socket (default tmux socket if none provided).

Options:
  -L, --socket       tmux socket name (passed to tmux -L)
  -S, --socket-path  tmux socket path (passed to tmux -S)
  -A, --all          scan default, current, and PI_TMUX_SOCKET_DIR sockets
  -q, --query        case-insensitive substring to filter session names
  -h, --help         show this help
USAGE
}

socket_name=""
socket_path=""
query=""
scan_all=false
socket_dir="${PI_TMUX_SOCKET_DIR:-/tmp/pi-tmux-$UID}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -L|--socket)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      socket_name="$2"; shift 2 ;;
    -S|--socket-path)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      socket_path="$2"; shift 2 ;;
    -A|--all)         scan_all=true; shift ;;
    -q|--query)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage; exit 1; }
      query="$2"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$scan_all" == true && ( -n "$socket_name" || -n "$socket_path" ) ]]; then
  echo "Cannot combine --all with -L or -S" >&2
  exit 1
fi

if [[ -n "$socket_name" && -n "$socket_path" ]]; then
  echo "Use either -L or -S, not both" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

list_sessions() {
  local label="$1"; shift
  local tmux_cmd=(tmux "$@")

  if ! sessions="$("${tmux_cmd[@]}" list-sessions -F $'#{session_name}\t#{session_attached}\t#{t:session_created}' 2>/dev/null)"; then
    echo "No tmux server found on $label" >&2
    return 1
  fi

  if [[ -n "$query" ]]; then
    sessions="$(printf '%s\n' "$sessions" | grep -iF -- "$query" || true)"
  fi

  if [[ -z "$sessions" ]]; then
    echo "No sessions found on $label"
    return 0
  fi

  echo "Sessions on $label:"
  printf '%s\n' "$sessions" | while IFS=$'\t' read -r name attached created; do
    if (( attached > 0 )); then
      attached_label="attached"
    else
      attached_label="detached"
    fi
    printf '  - %s (%s, started %s)\n' "$name" "$attached_label" "$created"
  done
}

if [[ "$scan_all" == true ]]; then
  successful_servers=0
  if list_sessions "default socket" -L default; then
    ((successful_servers += 1))
  fi

  sockets=()
  if [[ -n "${TMUX:-}" ]]; then
    current_socket="${TMUX%%,*}"
    [[ -S "$current_socket" ]] && sockets+=("$current_socket")
  fi

  if [[ -d "$socket_dir" ]]; then
    shopt -s nullglob
    sockets+=("$socket_dir"/*)
    shopt -u nullglob
  fi

  seen_sockets=()
  for sock in "${sockets[@]}"; do
    [[ -S "$sock" ]] || continue
    already_seen=false
    for seen_socket in "${seen_sockets[@]}"; do
      if [[ "$seen_socket" == "$sock" ]]; then
        already_seen=true
        break
      fi
    done
    [[ "$already_seen" == true ]] && continue
    seen_sockets+=("$sock")
    if list_sessions "socket path '$sock'" -S "$sock"; then
      ((successful_servers += 1))
    fi
  done

  if (( successful_servers == 0 )); then
    echo "No live tmux servers found" >&2
    exit 1
  fi
  exit 0
fi

tmux_cmd=(tmux)
socket_label="default socket"

if [[ -n "$socket_name" ]]; then
  tmux_cmd+=(-L "$socket_name")
  socket_label="socket name '$socket_name'"
elif [[ -n "$socket_path" ]]; then
  tmux_cmd+=(-S "$socket_path")
  socket_label="socket path '$socket_path'"
fi

list_sessions "$socket_label" "${tmux_cmd[@]:1}"
