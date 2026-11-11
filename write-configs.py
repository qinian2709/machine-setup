#!/usr/bin/env python3
"""Write local Cursor/Codex config. Token comes from the environment or secrets/tapd-token."""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEMPLATES = os.path.join(HERE, "templates")
HOME = os.path.expanduser("~")


def read_token():
    path = os.path.join(HERE, "secrets", "tapd-token")
    if os.path.isfile(path):
        token = open(path, encoding="utf-8").read().strip()
        if token:
            return token, "secrets/tapd-token"
    env = os.environ.get("TAPD_ACCESS_TOKEN", "").strip()
    if env:
        return env, "TAPD_ACCESS_TOKEN"
    return "", "missing"


def tapd_server(token):
    return {
        "command": "npx",
        "args": ["-y", "@xihe-lab/tapd-mcp-server@latest"],
        "env": {
            "TAPD_ACCESS_TOKEN": token,
            "TAPD_DEFAULT_WORKSPACE_ID": "35572188",
            "TAPD_API_BASE_URL": "https://api.tapd.cn",
            "TAPD_NICK_NAME": "kailiang.qiu",
        },
    }


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(path, 0o600)


def main():
    token, source = read_token()
    vscode_src = os.path.join(TEMPLATES, "vscode.settings.json")
    vscode_dest = os.path.join(ROOT, ".vscode", "settings.json")
    os.makedirs(os.path.dirname(vscode_dest), exist_ok=True)
    shutil.copyfile(vscode_src, vscode_dest)

    workspace_mcp = {"mcpServers": {"tapd": tapd_server(token)}}
    write_json(os.path.join(ROOT, ".mcp.json"), workspace_mcp)

    cursor_servers = {"tapd": tapd_server(token)}
    binary = os.path.join(HOME, ".local", "bin", "codebase-memory-mcp")
    if os.path.isfile(binary) and os.access(binary, os.X_OK):
        cursor_servers["codebase-memory-mcp"] = {
            "command": binary,
            "args": ["--ui=true", "--port=9749"],
            "env": {"CBM_CACHE_DIR": os.path.join(ROOT, ".codebase-memory-cache")},
        }
        print("codebase-memory-mcp: enabled")
    else:
        print("codebase-memory-mcp: skipped, binary not at ~/.local/bin/codebase-memory-mcp")

    write_json(os.path.join(HOME, ".cursor", "mcp.json"), {"mcpServers": cursor_servers})

    codex_dir = os.path.join(ROOT, ".codex")
    os.makedirs(codex_dir, exist_ok=True)
    codex_path = os.path.join(codex_dir, "config.toml")
    quoted = token.replace("\\", "\\\\").replace('"', '\\"')
    with open(codex_path, "w", encoding="utf-8") as handle:
        handle.write(
            "\n".join(
                [
                    "[mcp_servers.tapd]",
                    'command = "npx"',
                    "args = [",
                    '    "-y",',
                    '    "@xihe-lab/tapd-mcp-server@latest",',
                    "]",
                    "",
                    "[mcp_servers.tapd.env]",
                    f'TAPD_ACCESS_TOKEN = "{quoted}"',
                    'TAPD_DEFAULT_WORKSPACE_ID = "35572188"',
                    'TAPD_API_BASE_URL = "https://api.tapd.cn"',
                    'TAPD_NICK_NAME = "kailiang.qiu"',
                    "",
                ]
            )
        )
    os.chmod(codex_path, 0o600)

    print(f"vscode: {vscode_dest}")
    print(f"workspace mcp: {os.path.join(ROOT, '.mcp.json')}")
    print(f"cursor mcp: {os.path.join(HOME, '.cursor', 'mcp.json')}")
    print(f"codex: {codex_path}")
    print(f"tapd token source: {source}")
    if not token:
        print("TAPD_TOKEN_MISSING")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
