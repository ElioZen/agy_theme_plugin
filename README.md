# Prism Orbit · 棱镜星轨 (`agy_theme_plugin`)

专为 **macOS Antigravity 2.0** 打造的原创 **Apple Liquid Glass（液态玻璃）** 主题美化工坊与实时遥测驾驶舱插件。

- **零侵入 Electron 本体**：完全基于 Antigravity 官方 `sidecar_sdk` UI 插件架构，无需篡改应用签名、无需强行重启、不影响正在运行的其他项目。
- **纯简体中文精校界面**：支持右上角一键切换 `中 / EN`，内置原生英文界面中文对照速查与「全中文回复 Rules」一键复制。

## 核心功能

### 1. 驾驶舱（默认主页，标签页名：`驾驶舱`）
- **极简顶栏**：直接复用 Antigravity 左侧 `Projects`（读取 `~/.gemini/config/projects/`）切换项目 + 一键「跟随」当前会话，右上角提供独立的 **「外观美化」** 页面切换按钮，释放顶部空间。
- **窗体 1 · 项目与会话统计（置顶）**：在同一个窗体内自由切换 `当前项目 / 当前会话 / 全部项目` 与 `今天 / 近7天 / 近30天 / 全部`，精准展示每个模型的整体用量、模型占比条、缓存命中率、未命中与输出 Token（支持勾选是否并入同项目 CLI 消耗）。
- **窗体 2 · 实时上下文窗口（完全独立）**：与累计统计彻底解耦，实时呈现当前会话的星环上下文占用（`200k / 512k / 1M`）、四项构成、当前模型、思考强度与生成速率折线图。
- **窗体 3 · 活动 CLI 与子智能体监控**：默认仅展示正在活动中的 `Codex CLI` / `AGY CLI` / 原生子智能体（不再罗列已完成的历史记录），直出 4 项关键运行状态：**正在思考或执行的动作、当前模型、思考强度、Token 消耗与缓存命中率**。

### 2. 外观美化（独立页面）
- **macOS 整窗氛围伴侣**：原生 Swift `AppKit` 鼠标穿透层，采用 **「星光滤色 (Luminance-Screen)」** 混合引擎——壁纸无缝贯穿左右窗口且保持代码与白色文字锐利不发灰；支持左右无缝贯穿防重影、液态玻璃窗框高光与切应用自动隐藏。
- **极清壁纸画廊**：内置 4 张原创 16:9 高清壁纸（`星海夜行电车`、`极光星轨镜湖`、`雨夜霓虹街巷`、`月下绯樱神社`），支持自定义本地图片上传、随机切换，以及透明度 / 磨砂模糊 / 暗度遮罩 / 圆角柔化实时调节。
- **液态玻璃色调**：5 套内置配色（星海暖灯、星海极光、绯樱雾岚、深海翡翠、霜白晨曦），支持六通道取色器、自定义保存与跟随宿主明暗。

> **关于 Antigravity 原生英文主界面汉化**：Antigravity 2.0 目前未开放宿主 UI 语言包插件接口。本插件自身为纯简体中文界面且零侵入主程序；如需汉化 Antigravity 顶部原生菜单与设置页，可在不运行关键任务时参考社区开源的 Electron ASAR 汉化项目（如 `qqxpee/antigravity2-cn`、`Silas-02/antigravity-desktop-cn`）。

## 安装方式（macOS）

```bash
git clone https://github.com/ElioZen/agy_theme_plugin.git
cd agy_theme_plugin
./scripts/install.sh
```

安装完成后，在 Antigravity 的 **Customizations → Plugins** 中确认 `Prism Orbit · 棱镜星轨` 已启用，即可在右侧辅助栏打开「棱镜星轨」面板。

## 仓库结构

```text
agy_theme_plugin/
├── plugin/
│   ├── plugin.json
│   ├── assets/logo.svg
│   └── sidecars/prism_studio/
│       ├── sidecar.json
│       ├── main.mjs
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
