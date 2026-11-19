# Prism Orbit · 棱镜星轨 (`agy_theme_plugin`)

专为 **macOS Antigravity 2.0** 打造的原创 **Apple Liquid Glass（液态玻璃）** 主题美化工坊与实时遥测驾驶舱插件。

- **零侵入 Electron 本体**：完全基于 Antigravity 官方 `sidecar_sdk` UI 插件架构，无需篡改应用签名、无需强行重启、不影响正在运行的其他项目。
- **纯简体中文无冗余界面**：专注核心观测指标与 Apple Liquid Glass 视觉体验，零多余说明文案。

## 核心功能

### 1. 驾驶舱（默认主页，标签页名：`驾驶舱`）
- **极简顶栏**：直接复用 Antigravity 左侧 `Projects`（读取 `~/.gemini/config/projects/`）切换项目 + 一键「跟随」当前会话，右上角提供独立的 **「外观美化」** 页面切换按钮，释放顶部空间。
- **窗体 1 · 项目与会话统计（置顶）**：在同一个窗体内自由切换 `当前项目 / 当前会话 / 全部项目`、`全部 / GUI / AGY CLI / Codex` 与 `今天 / 近7天 / 近30天 / 全部`，精准展示每个模型的整体用量、模型占比条、缓存命中率（含 `CHECKPOINT` 压缩调用与 Codex 按时间戳增量切片）、未命中与输出 Token（支持展开/折叠与底部项目快捷切换）。
- **窗体 2 · 额度监控（全自动官方同步）**：
  - 自动实时同步 **Gemini 系列** 与 **Claude / GPT 系列**（通过官方 `agy` CLI `statusLine` JSON 接口，零 Token 消耗、每 3 分钟静默刷新）以及 **Codex 系列**（零成本直读本地会话官方 `rate_limits`）的每周限额与 5 小时限额。
  - 支持基于本地历史采样的 **燃烧速率（`-%/h`）与预计耗尽时间预测**，以及 `< 20%` 琥珀/红色呼吸告警。
- **窗体 3 · 实时上下文窗口（完全独立）**：与累计统计彻底解耦，实时呈现当前会话的星环上下文占用（`200k / 512k / 1M`）、**单轮缓存命中与异常掉缓存即时预警**、四项构成、当前模型、思考强度与生成速率折线图。
- **窗体 4 · 活动 CLI 与子智能体监控**：默认仅展示正在活动中的 `Codex CLI` / `AGY CLI` / 原生子智能体（支持展开/折叠），直出实时动作、**当前命令/工具参数单行摘要**、**超过 20 分钟无推进自动标记「疑似卡住」**、当前模型、思考强度与 Token 消耗。

### 2. 外观美化（独立页面）
- **macOS 整窗氛围伴侣**：原生 Swift `AppKit` 鼠标穿透层，采用 **「星光滤色 (Luminance-Screen)」** 混合引擎——壁纸无缝贯穿左右窗口且保持代码与白色文字锐利不发灰；支持左右无缝贯穿防重影、液态玻璃窗框高光与切应用自动隐藏。
- **极清壁纸画廊 & 开源图库随机**：内置 4 张原创 16:9 高清壁纸（`星海夜行电车`、`极光星轨镜湖`、`雨夜霓虹街巷`、`月下绯樱神社`），支持本地上传，并接入 **Catppuccin 暗夜 / Nordic 北欧 / Bing 每日超清 / Wikimedia 星空风景** 等开源免费图库一键随机与收藏到本地画廊。
- **液态玻璃色调 & 壁纸自适应取色**：5 套内置配色 + 六通道取色器 + 自定义方案保存 + 跟随宿主明暗；支持开启 **「壁纸自动取色」** 或 **「立即取色」**，切壁纸时自动提取主色调联动玻璃高光与星环配色。

> **关于 Antigravity 原生英文主界面汉化**：Antigravity 2.0 目前未开放宿主 UI 语言包插件接口。本插件自身为纯简体中文界面且零侵入主程序；如需汉化 Antigravity 顶部原生菜单与设置页，可在不运行关键任务时参考社区开源的 Electron ASAR 汉化项目（如 `qqxpee/antigravity2-cn`、`Silas-02/antigravity-desktop-cn`）。

## 安装方式（macOS）

```bash
git clone https://github.com/ElioZen/agy_theme_plugin.git
cd agy_theme_plugin
./scripts/install.sh
```

安装完成后，在 Antigravity 的 **Customizations → Plugins** 中确认 `Prism Orbit · 棱镜星轨` 已启用，即可在右侧辅助栏打开「驾驶舱」面板。

## 仓库结构

```text
agy_theme_plugin/
├── plugin/
│   ├── plugin.json
│   ├── assets/logo.svg
│   └── sidecars/prism_studio/
│       ├── sidecar.json
│       ├── main.mjs
│       ├── quota_fetcher.mjs
│       ├── wallpaper_gallery.mjs
│       ├── telemetry.mjs
│       ├── storage.mjs
│       ├── companion.mjs
│       ├── mac/PrismBackdrop.swift
│       └── public/
│           ├── index.html
│           ├── styles.css
│           ├── app.js
│           └── wallpapers/
└── scripts/
    └── install.sh
```
