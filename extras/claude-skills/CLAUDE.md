# Claude Code 全局协作规范

## TAPD Bug 提单

当用户要求提 Bug 时，**必须**通过 `/tapd-bug` skill 执行，禁止使用 TAPD MCP 工具直接创建。

### 模板格式（严格遵循）

```
【账号环境】xxx
【测试步骤】1. xxx<br />2. xxx
【实际结果】xxx
（截图嵌入在实际结果下方）
【预期结果】xxx
```

标题格式：`【模块】具体问题描述`

参考标准 Bug: https://www.tapd.cn/tapd_fe/35572188/bug/detail/1135572188001273108

### 图片规则

- 默认取**最新一条用户消息**的贴图，绝不回退历史图片
- 最新消息无图 → 正常创建无图 Bug，不报错
- `--all-images` 仅在用户明确要求时使用

### 必填字段

- `--title` 格式：`【模块】xxx`
- `--owner` 中文名映射到 owner-aliases.json
- `--priority-label` 和 `--severity` **每次必传**

| 用户描述 | 优先级 | 严重程度 |
|----------|--------|----------|
| 崩溃/闪退/无法使用/数据丢失 | urgent | fatal |
| 核心功能异常/严重受阻 | high | serious |
| 非核心功能异常/体验问题 | medium | normal |
| 纯测试/Demo 用 | low | slight |

### Skill 路径

Skill 通过 `install.sh` 安装到：
- `~/.claude/skills/tapd-bug/`
- `~/.claude/skills/export-chat-image/`

安装命令：
```bash
cd /path/to/claude-code-tapd-bugs && ./install.sh
```
