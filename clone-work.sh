#!/usr/bin/env bash
# Clone GitHub test/demo repos from repos.list into the ClassinShop folder.
# Safe to re-run: existing checkouts are left untouched.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LIST="$HERE/repos.list"

if [[ ! -f "$LIST" ]]; then
  echo "missing $LIST" >&2
  exit 1
fi

echo "ClassinShop root: $ROOT"
echo "host: github.com/qinian2709 (ignore GitLab)"

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$line" ]] && continue

  IFS='|' read -r path url branch <<<"$line"
  path="$(echo "$path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  url="$(echo "$url" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  branch="$(echo "$branch" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  dest="$ROOT/$path"
  if [[ -d "$dest/.git" ]]; then
    current="$(git -C "$dest" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    echo "skip  $path (already cloned, branch $current)"
    continue
  fi

  mkdir -p "$(dirname "$dest")"
  echo "clone $path  branch=$branch"
  if ! git clone --branch "$branch" "$url" "$dest"; then
    echo "FAIL  $path  先在本机执行: gh auth login  （GitHub 用户 qinian2709）" >&2
    echo "      不要再用 gl.eeo.im / skills.eeo-inc.com" >&2
    exit 1
  fi
done < "$LIST"

echo "done"
