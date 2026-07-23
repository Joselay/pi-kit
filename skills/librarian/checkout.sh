#!/usr/bin/env bash
set -euo pipefail

readonly CACHE_ROOT="$HOME/.cache/checkouts/github.com"
readonly REFRESH_TTL="${LIBRARIAN_REFRESH_TTL:-0}"
readonly LOCK_TIMEOUT=120

# Fail fast instead of prompting for credentials on private or misspelled repos.
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true GIT_SSH_COMMAND='ssh -oBatchMode=yes'

die() {
  printf 'librarian: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'librarian: %s\n' "$*" >&2
}

[[ $# -eq 1 ]] || die "usage: checkout.sh <github-url>"

raw="${1%%[?#]*}"
while [[ "$raw" == */ ]]; do raw="${raw%/}"; done
case "$raw" in
  git@github.com:*)         path="${raw#git@github.com:}" ;;
  ssh://git@github.com/*)   path="${raw#ssh://git@github.com/}" ;;
  https://github.com/*)     path="${raw#https://github.com/}" ;;
  https://www.github.com/*) path="${raw#https://www.github.com/}" ;;
  http://github.com/*)      path="${raw#http://github.com/}" ;;
  github.com/*)             path="${raw#github.com/}" ;;
  www.github.com/*)         path="${raw#www.github.com/}" ;;
  *) die "expected a github.com URL" ;;
esac

IFS=/ read -r owner repo remainder <<<"$path"
repo="${repo%.git}"
[[ -n "$owner" && -n "$repo" ]] || die "expected owner/repo"

name_pattern='^[A-Za-z0-9][A-Za-z0-9._-]*$'
sha_pattern='^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$'
[[ "$owner" =~ $name_pattern ]] || die "invalid GitHub owner: $owner"
[[ "$repo" =~ $name_pattern ]] || die "invalid GitHub repository: $repo"

owner="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
repo="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
checkout="$CACHE_ROOT/$owner/$repo"
origin="https://github.com/$owner/$repo.git"
stamp_dir="$checkout/.git/librarian"
refs_file="$stamp_dir/refs"

# Deep URLs name a specific revision; serving the default branch instead would
# silently hand the caller the wrong content.
kind=default spec='' subpath=''
if [[ -n "${remainder:-}" ]]; then
  IFS=/ read -r verb rest <<<"$remainder"
  rest="${rest:-}"
  case "$verb" in
    tree|blob|raw)
      [[ -n "$rest" ]] || die "expected a ref after /$verb/"
      kind=ref spec="$rest"
      ;;
    commit)
      kind=commit spec="${rest%%/*}"
      [[ -n "$spec" ]] || die "expected a commit SHA after /commit/"
      ;;
    releases)
      if [[ "$rest" == tag/?* ]]; then
        kind=tag spec="${rest#tag/}"
      else
        note "ignoring URL path '/$remainder'; using the default branch"
      fi
      ;;
    pull)
      kind=pull spec="${rest%%/*}"
      [[ "$spec" =~ ^[0-9]+$ ]] || die "expected a pull request number after /pull/"
      ;;
    *)
      note "ignoring URL path '/$remainder'; using the default branch"
      ;;
  esac
fi

mtime_of() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null
}

fresh_file() {
  local m
  [[ -f "$1" ]] || return 1
  m="$(mtime_of "$1")" && [[ -n "$m" ]] || return 1
  (( $(date +%s) - m < REFRESH_TTL ))
}

mkdir -p "$CACHE_ROOT/$owner"

# Concurrent invocations must not fetch/clean the same checkout at once. Repo
# names cannot start with '.', so the lock dir cannot collide with a checkout.
lock="$CACHE_ROOT/$owner/.$repo.lock"
waited=0
until mkdir "$lock" 2>/dev/null; do
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  if (( waited >= LOCK_TIMEOUT )); then
    die "timed out waiting for $lock (remove it if stale)"
  fi
  waited=$((waited + 1))
  sleep 1
done
printf '%s\n' "$$" >"$lock/pid"
trap 'rm -rf "$lock" "$refs_file.tmp"' EXIT

# Guard against git resolving to some ancestor repository when $checkout is a
# plain directory: force-checkout/clean must only ever run inside the cache.
valid_checkout() {
  local top real
  top="$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null)" || return 1
  real="$(cd "$checkout" 2>/dev/null && pwd -P)" || return 1
  [[ "$top" == "$real" ]]
}

# A shallow clone gets the complete current working tree in one request.
fresh=0
if ! valid_checkout; then
  rm -rf "$checkout"
  git clone --quiet --depth=1 --single-branch "$origin" "$checkout" ||
    die "could not clone $owner/$repo (missing, private, or network down?)"
  fresh=1
fi

git -C "$checkout" remote set-url origin "$origin" 2>/dev/null ||
  git -C "$checkout" remote add origin "$origin"
mkdir -p "$stamp_dir"

ensure_commit() {
  git -C "$checkout" cat-file -e "$1^{commit}" 2>/dev/null && return 0
  git -C "$checkout" fetch --quiet --depth=1 --force --no-tags origin "$1" ||
    die "could not fetch commit $1 from $owner/$repo"
}

fetch_ref() { # remote ref, local ref, expected object sha
  local have
  have="$(git -C "$checkout" rev-parse --verify --quiet "$2" || true)"
  if [[ "$have" != "$3" ]]; then
    git -C "$checkout" fetch --quiet --depth=1 --force --no-tags origin "+$1:$2" ||
      die "could not fetch $1 from $owner/$repo"
  fi
  commit="$(git -C "$checkout" rev-parse --verify --quiet "$2^{commit}")" ||
    die "$1 does not point to a commit"
}

load_refs() {
  if ! fresh_file "$refs_file"; then
    git -C "$checkout" ls-remote --refs origin 'refs/heads/*' 'refs/tags/*' >"$refs_file.tmp" ||
      die "could not list refs for $owner/$repo"
    mv "$refs_file.tmp" "$refs_file"
  fi
}

# Branch and tag names may contain '/', so try the longest ref prefix of the
# URL path first; whatever follows the matched ref is a path inside the tree.
resolve_spec() { # namespaces to search
  local candidate="$spec" ns sha
  while :; do
    for ns in $1; do
      sha="$(awk -v r="$ns/$candidate" '$2 == r { print $1; exit }' "$refs_file")"
      if [[ -n "$sha" ]]; then
        resolved_ref="$ns/$candidate"
        resolved_sha="$sha"
        subpath="${spec:${#candidate}}"
        subpath="${subpath#/}"
        return 0
      fi
    done
    [[ "$candidate" == */* ]] || return 1
    candidate="${candidate%/*}"
  done
}

commit=''
case "$kind" in
  default)
    if (( fresh )) || fresh_file "$stamp_dir/head"; then
      target_ref="$(git -C "$checkout" symbolic-ref -q refs/remotes/origin/HEAD)" ||
        die "$owner/$repo has no default branch (empty repository?)"
      commit="$(git -C "$checkout" rev-parse "$target_ref^{commit}")"
      if (( fresh )); then touch "$stamp_dir/head"; fi
    else
      remote_info="$(git -C "$checkout" ls-remote --symref origin HEAD)" ||
        die "could not query $owner/$repo"
      default_ref="$(awk '$1 == "ref:" && $3 == "HEAD" { print $2; exit }' <<<"$remote_info")"
      head_sha="$(awk '$2 == "HEAD" && $1 != "ref:" { print $1; exit }' <<<"$remote_info")"
      [[ "$default_ref" == refs/heads/* && "$head_sha" =~ $sha_pattern ]] ||
        die "could not resolve the default branch for $owner/$repo"
      branch="${default_ref#refs/heads/}"
      fetch_ref "$default_ref" "refs/remotes/origin/$branch" "$head_sha"
      git -C "$checkout" symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$branch"
      touch "$stamp_dir/head"
    fi
    ;;
  ref|tag)
    load_refs
    namespaces='refs/heads refs/tags'
    if [[ "$kind" == tag ]]; then namespaces='refs/tags'; fi
    if resolve_spec "$namespaces"; then
      case "$resolved_ref" in
        refs/heads/*) fetch_ref "$resolved_ref" "refs/remotes/origin/${resolved_ref#refs/heads/}" "$resolved_sha" ;;
        *)            fetch_ref "$resolved_ref" "$resolved_ref" "$resolved_sha" ;;
      esac
    elif [[ "${spec%%/*}" =~ $sha_pattern ]]; then
      commit="${spec%%/*}"
      subpath="${spec#"$commit"}"
      subpath="${subpath#/}"
      ensure_commit "$commit"
    else
      die "could not find ref '$spec' in $owner/$repo"
    fi
    ;;
  commit)
    if [[ "$spec" =~ $sha_pattern ]]; then
      commit="$spec"
      ensure_commit "$commit"
    elif [[ "$spec" =~ ^[0-9a-fA-F]{4,}$ ]]; then
      # Short SHAs cannot be fetched from a remote; only a cached object works.
      commit="$(git -C "$checkout" rev-parse --verify --quiet "$spec^{commit}")" ||
        die "cannot resolve short SHA '$spec'; use the full commit SHA"
    else
      die "invalid commit SHA: $spec"
    fi
    ;;
  pull)
    pull_sha="$(git -C "$checkout" ls-remote origin "refs/pull/$spec/head" | awk '{ print $1; exit }')"
    [[ "$pull_sha" =~ $sha_pattern ]] || die "could not find pull request #$spec in $owner/$repo"
    fetch_ref "refs/pull/$spec/head" "refs/pull/$spec/head" "$pull_sha"
    ;;
esac

# Cached checkouts are disposable and always represent upstream exactly.
git -C "$checkout" checkout --quiet --detach --force "$commit"
git -C "$checkout" clean -ffdx >/dev/null

printf '%s\n' "$checkout"
if [[ -n "$subpath" ]]; then
  if [[ -e "$checkout/$subpath" ]]; then
    printf 'path: %s\n' "$subpath"
  else
    note "URL path '$subpath' does not exist at this revision"
  fi
fi
