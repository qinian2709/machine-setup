#!/usr/bin/env bash
# Install JS/Python dependencies for GitHub test/demo repos. Continues after a single repo fails.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
fail=0

install_pnpm() {
  local rel="$1"
  local dir="$ROOT/$rel"
  if [[ ! -f "$dir/pnpm-lock.yaml" ]]; then
    echo "skip  $rel (no pnpm-lock.yaml)"
    return 0
  fi
  echo "install $rel"
  if (cd "$dir" && pnpm install --frozen-lockfile); then
    echo "ok    $rel"
  else
    echo "FAIL  $rel"
    fail=1
  fi
}

install_npm() {
  local rel="$1"
  local dir="$ROOT/$rel"
  if [[ ! -f "$dir/package-lock.json" ]]; then
    echo "skip  $rel (no package-lock.json)"
    return 0
  fi
  echo "install $rel"
  if (cd "$dir" && npm ci); then
    echo "ok    $rel"
  else
    echo "FAIL  $rel"
    fail=1
  fi
}

install_pip() {
  local rel="$1"
  local dir="$ROOT/$rel"
  if [[ ! -f "$dir/requirements.txt" ]]; then
    echo "skip  $rel (no requirements.txt)"
    return 0
  fi
  echo "install $rel"
  if (cd "$dir" && python3 -m pip install -r requirements.txt); then
    echo "ok    $rel"
  else
    echo "FAIL  $rel"
    fail=1
  fi
}

install_pnpm "classinshop/classinshop-test-suite"
install_pnpm "TI/teacherin-test-suite"
install_pnpm "gorw/classin-teacher-buddy-test-suite"
install_pnpm "web-test-agent"
install_npm "agent-demo"
install_pip "agent-test"
install_pip "agent-mutation-test"

for rel in \
  classinshop/classinshop-test-suite \
  TI/teacherin-test-suite \
  gorw/classin-teacher-buddy-test-suite
do
  dir="$ROOT/$rel"
  if [[ -f "$dir/package.json" ]]; then
    echo "browsers $rel"
    if (cd "$dir" && pnpm install:browsers); then
      echo "ok    browsers $rel"
    else
      echo "FAIL  browsers $rel"
      fail=1
    fi
  fi
done

exit "$fail"
