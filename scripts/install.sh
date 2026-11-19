#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/agy-theme"

mkdir -p "$(dirname "$TARGET_DIR")"

if [ -L "$TARGET_DIR" ]; then
  rm "$TARGET_DIR"
elif [ -e "$TARGET_DIR" ]; then
  echo "目标路径已存在且非软链接：$TARGET_DIR"
  echo "如需覆盖，请先手动备份或移走该目录。"
  exit 1
fi

ln -s "$REPO_DIR/plugin" "$TARGET_DIR"
echo "已安装 Prism Orbit · 棱镜星轨 插件：$TARGET_DIR -> $REPO_DIR/plugin"
echo "Antigravity 会自动发现该插件，无需重启，不会影响其他运行中的项目。"
