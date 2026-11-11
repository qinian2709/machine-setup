---
name: tapd-bug
description: Create or update TAPD bugs with screenshots pasted into the current Claude Code conversation using the verified Data URI to TAPD /tfl/ conversion workflow.
allowed-tools:
  - Bash
  - AskUserQuestion
---

# TAPD Bug

Use this skill whenever the user asks to create, file, submit, or update a TAPD Bug, especially when a screenshot was pasted into the conversation.

## Bug Template (strict — match Bug 1135572188001273108 exactly)

Every Bug description MUST follow this exact template. The description is built from these fields in this order:

```
【账号环境】xxx
【测试步骤】1. xxx<br />2. xxx
【实际结果】xxx
（截图嵌入在实际结果下方）
【预期结果】xxx
```

The Bug title format is: `【模块名】具体问题描述`

Claude MUST extract from the user's message and screenshot:

- **标题**: `【模块】xxx` — extract module from screenshot context, prefix with `【模块】`.
- **account environment (`--env`)**: Account, device, OS, version — leave empty if not mentioned.
- **steps to reproduce (`--steps`)**: Numbered steps, each separated by `<br />` — leave empty if not mentioned.
- **actual result (`--actual`)**: What the screenshot shows or the user describes. Screenshot is embedded right below.
- **expected result (`--expected`)**: What should happen instead — leave empty if not mentioned.

### Mandatory fields

Every create MUST pass ALL of:

- `--title` with `【模块】xxx` format
- `--owner` (resolved via owner-aliases.json)
- `--priority-label` and `--severity` — inferred from context:
  - 崩溃/闪退/无法使用/数据丢失 → `urgent` / `fatal`
  - 核心功能异常 → `high` / `serious`
  - 非核心异常/体验 → `medium` / `normal`
  - 纯测试/Demo → `low` / `slight`
- `--env`, `--steps`, `--actual`, `--expected` — fill what's known, leave empty if not mentioned
- Screenshot: if the latest user message has an image, it is included automatically

## Fixed screenshot workflow

Do not rediscover attachment APIs. Do not call TAPD's attachment upload endpoint. The verified workflow is:

1. Read the pasted image from the active Claude transcript through the existing `export-chat-image` implementation.
2. Embed it as `data:image/...;base64,...` in an HTML `<img>` inside the Bug description.
3. POST the form to `https://api.tapd.cn/bugs` using the Bearer token from the nearest `.mcp.json` or `TAPD_ACCESS_TOKEN`.
4. Require TAPD's response to contain `<img>` and `/tfl/`, with no remaining Data URI.

The fixed Node script performs all four steps without printing the token, Base64, description, or raw response:

```bash
node "$HOME/.claude/skills/tapd-bug/scripts/tapd-bug.mjs" create \
  --title "问题标题" \
  --problem "问题描述" \
  --steps $'1. 第一步\n2. 第二步' \
  --actual "实际结果" \
  --expected "预期结果" \
  --impact "影响范围" \
  --owner "邱开亮"
```

Before any create or update, the script resolves `--owner` through `config/owner-aliases.json`. Chinese names must exist in that verified local mapping. TAPD nickname inputs such as `kailiang.qiu` pass through unchanged. If a Chinese name is missing, the script stops before the TAPD mutation; never remove `--owner` or submit an unassigned Bug as a fallback.

Update a Bug and append the latest pasted screenshot:

```bash
node "$HOME/.claude/skills/tapd-bug/scripts/tapd-bug.mjs" update \
  --id "1135572188001272856" \
  --problem "补充说明"
```

Options:

- Latest pasted image is included by default.
- `--image-index N` selects one image by conversation order.
- `--all-images` must be explicitly requested by the user.
- `--no-image` creates or updates a text-only Bug.
- Update appends to the existing description by default.
- `--replace-description` requires explicit user intent because it replaces existing content.
- Common fields: `--workspace-id`, `--owner`, `--owner-aliases`, `--reporter`, `--priority`, `--priority-label`, `--severity`, `--iteration-id`, `--bugtype`, `--source`, `--testphase`, `--version-report`, and supported custom fields.

Defaults for this workspace:

- Workspace: `35572188`
- Owner/reporter: `kailiang.qiu`

All other fields such as iteration, priority, severity, bug type, and source must be explicitly specified or left blank. Do not silently apply default text or hard-coded values.

**Priority and severity are MANDATORY for every create.**

## Priority and Severity Assessment

**MANDATORY for every create.** Every Bug MUST pass both `--priority-label` and `--severity`. Infer from the issue context:

| 用户描述 | 优先级 | 严重程度 |
|----------|--------|----------|
| 崩溃/闪退/无法使用/数据丢失 | urgent | fatal |
| 核心功能异常/严重受阻 | high | serious |
| 非核心功能异常/体验问题 | medium | normal |
| 纯测试/Demo 用 | low | slight |

## Authorization

An explicit request to create a Bug authorizes one create operation. An explicit request to update a named Bug authorizes one append operation. Do not ask a redundant confirmation. Ask only when the title, target Bug ID, owner, or intended screenshot is ambiguous. Never replace an existing description without explicit wording or confirmation.

## Reporting

Report the Bug ID, title, owner, priority/severity when known, and whether all submitted images were converted to `/tfl/`. Never display or read generated Base64, the access token, or the complete HTML description into the conversation.
