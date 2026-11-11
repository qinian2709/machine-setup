#!/usr/bin/env bash
# Print a pass/fail line per expected checkout. Exit 1 if any repo or tool is missing.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LIST="$HERE/repos.list"
fail=0

check_cmd() {
  local name="$1"
  local ver=""
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "FAIL  $name missing"
    fail=1
    return
  fi
  case "$name" in
    go) ver="$(go version 2>/dev/null | head -1)" ;;
    *) ver="$("$name" --version 2>/dev/null | head -1)" ;;
  esac
  echo "ok    $name ${ver}"
}

check_cmd node
check_cmd pnpm
check_cmd go
check_cmd git
if command -v docker >/dev/null 2>&1; then
  echo "ok    docker $(docker --version 2>/dev/null)"
else
  echo "WARN  docker missing"
fi

name="$(git config --global --get user.name || true)"
email="$(git config --global --get user.email || true)"
if [[ "$name" == "qiukailiang" && "$email" == "kailiang.qiu@eeoa.com" ]]; then
  echo "ok    git identity $name <$email>"
else
  echo "FAIL  git identity is '$name' <$email>"
  fail=1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$line" ]] && continue
  IFS='|' read -r path url branch <<<"$line"
  path="$(echo "$path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  branch="$(echo "$branch" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  dest="$ROOT/$path"
  if [[ ! -d "$dest/.git" ]]; then
    echo "FAIL  $path not cloned"
    fail=1
    continue
  fi
  current="$(git -C "$dest" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [[ "$current" == "$branch" ]]; then
    echo "ok    $path @ $current"
  else
    echo "FAIL  $path branch $current, expected $branch"
    fail=1
  fi
done < "$LIST"

for f in "$ROOT/.mcp.json" "$ROOT/.codex/config.toml" "$ROOT/.vscode/settings.json" "$HOME/.cursor/mcp.json"; do
  if [[ -f "$f" ]]; then
    echo "ok    config $f"
  else
    echo "FAIL  config missing $f"
    fail=1
  fi
done

if grep -q 'TAPD_ACCESS_TOKEN = ""' "$ROOT/.codex/config.toml" 2>/dev/null \
  || grep -q '"TAPD_ACCESS_TOKEN": ""' "$ROOT/.mcp.json" 2>/dev/null; then
  echo "WARN  TAPD token is empty"
fi

exit "$fail"
