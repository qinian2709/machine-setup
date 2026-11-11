---
name: export-chat-image
description: Export an image pasted into the current Claude Code conversation as its original file, raw Base64, or a Data URL without exposing its payload in chat output.
allowed-tools:
  - Bash
---

# Export Chat Image

Use this skill when the user asks to save, export, download, or convert an image they pasted directly into the current Claude Code conversation. The image is retrieved from the active Claude Code session transcript; the user does not need to save it separately first.

Run only the fixed exporter. Do not use `Read`, `rg`, shell pipes, command substitution, or `base64` against Claude transcripts. Those can place the image payload into tool output and conversation context.

```bash
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs"
```

Supported commands:

```bash
# Latest pasted image as an image file in ./bugsImage/.
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs"

# A specific pasted image, using one-based transcript order, also in ./bugsImage/.
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs" --index 1

# Every pasted image in ./bugsImage/ (default).
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs" --all

# Original image at an explicit path (bypasses bugsImage).
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs" --output ./screenshot.png

# Raw Base64 or a complete data URL. The payload remains in the output file.
# These always require an explicit path and are not placed under bugsImage.
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs" --base64-file ./screenshot.base64.txt
node "$HOME/.claude/skills/export-chat-image/scripts/export-chat-image.mjs" --data-url ./screenshot.data-url.txt
```

The script prints only JSON metadata: output path, media type, byte count, SHA-256, and status. Report that metadata to the user. Never print or read the generated Base64/Data URL file contents into the conversation.

If an output path already contains different content, report the conflict instead of overwriting it. If the image cannot be found in the current session, report the script's bounded error and explain that the user must paste the image in this conversation first.
