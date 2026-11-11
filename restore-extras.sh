#!/usr/bin/env bash
# Restore CC Switch config and the local Claude skills snapshot.
# Does not print file contents.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HERE/extras/claude-skills"
SWITCH="$HERE/extras/cc-switch"

for f in \
  "$SKILLS/tapd-bug/SKILL.md" \
  "$SKILLS/export-chat-image/SKILL.md" \
  "$SKILLS/export-chat-image/scripts/export-chat-image.mjs" \
  "$SWITCH/cc-switch.db" \
  "$SWITCH/settings.json" \
  "$SWITCH/claude.settings.json" \
  "$SWITCH/zshrc.snippet"
do
  if [[ ! -f "$f" ]]; then
    echo "FAIL  missing $f" >&2
    exit 1
  fi
done

mkdir -p "$HOME/.claude/skills"
rm -rf "$HOME/.claude/skills/tapd-bug" "$HOME/.claude/skills/export-chat-image"
cp -R "$SKILLS/tapd-bug" "$HOME/.claude/skills/tapd-bug"
cp -R "$SKILLS/export-chat-image" "$HOME/.claude/skills/export-chat-image"
cp "$SKILLS/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
echo "ok    skills -> ~/.claude/skills/{tapd-bug,export-chat-image}"

mkdir -p "$HOME/.cc-switch"
cp "$SWITCH/settings.json" "$HOME/.cc-switch/settings.json"
cp "$SWITCH/cc-switch.db" "$HOME/.cc-switch/cc-switch.db"
cp "$SWITCH/claude.settings.json" "$HOME/.claude/settings.json"
chmod 600 "$HOME/.cc-switch/settings.json" "$HOME/.cc-switch/cc-switch.db" "$HOME/.claude/settings.json"
echo "ok    cc-switch config -> ~/.cc-switch and ~/.claude/settings.json"

touch "$HOME/.zshrc"
if ! grep -q 'OPENAI_BASE_URL="http://127.0.0.1:15721/v1"' "$HOME/.zshrc"; then
  printf '\n# cc-switch local proxy\n' >> "$HOME/.zshrc"
  cat "$SWITCH/zshrc.snippet" >> "$HOME/.zshrc"
  echo "ok    appended cc-switch proxy lines to ~/.zshrc"
else
  echo "ok    ~/.zshrc already has the cc-switch proxy"
fi

if [[ -d "/Applications/CC Switch.app" ]]; then
  ver="$(defaults read "/Applications/CC Switch.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)"
  echo "ok    CC Switch.app $ver"
else
  echo "WARN  /Applications/CC Switch.app missing. Copy version 3.16.5 from the old Mac, then open it once."
fi
