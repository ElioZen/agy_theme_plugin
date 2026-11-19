# Prism Orbit · 棱镜星轨 (`agy_theme_plugin`)

专为 **macOS Antigravity 2.0** 打造的原创 **Apple Liquid Glass（液态玻璃）** 主题美化工坊与实时遥测驾驶舱插件。

- **零侵入 Electron 本体**：完全基于 Antigravity 官方 `sidecar_sdk` UI 插件架构，无需篡改应用签名、无需强行重启、不影响正在运行的其他项目。
- **纯简体中文精校界面**：支持右上角一键切换 `中 / EN`，内置原生英文界面中文对照速查与「全中文回复 Rules」一键复制。

## 核心功能

### 1. 驾驶舱（实时遥测）
- **星环上下文仪表**：发光渐变圆环实时展示当前会话上下文占用（支持 `200k` / `512k` / `1M` 窗口切换）及系统基准 / 思考增量 / 用户与对话 / 工具与输出占比。
- **速率与缓存遥测**：只读解析本地 `transcript.jsonl`，实时计算缓存命中率、最近轮次生成速率 (`tok/s`) 与近期速率趋势折线图（Sparkline），展示最近上游模型 ID。
- **模型 Token 与参考成本账本**：支持 `全部 / 当前` 与 `今天 / 近7天 / 近30天` 筛选，按模型拆分缓存命中、未命中与输出 Token。
- **多项目会话监视**：只读读取本地 `conversation_summaries.db`，区分运行中/空闲会话，支持置顶常用会话与一键切换。

### 2. 棱镜工坊（Liquid Glass 主题与壁纸）
- **5 套内置液态玻璃配色**：星海暖灯（默认）、星海极光、绯樱雾岚、深海翡翠、霜白晨曦（浅色），支持六通道自定义调色盘与保存个人方案。
- **4 张原创 16:9 高清内置壁纸**：
  - `星海夜行电车`（默认）
  - `极光星轨镜湖`
  - `雨夜霓虹街巷`
  - `月下绯樱神社`
  - 支持上传本地自定义壁纸（PNG / JPG / WEBP，最大 15MB）、随机切换、透明度 / 玻璃模糊度 / 护眼暗度遮罩 / 卡片圆角实时调节。
- **macOS 整窗氛围伴侣（可选）**：
  - 基于原生 Swift `AppKit` 编写的轻量级鼠标穿透窗口（`PrismBackdrop.swift`）。
  - 自动追踪 Antigravity 窗口坐标并贴合圆角，切到其他应用时自动隐藏，零修改 Electron 本体。

### 3. 效率台（多项目监视与快捷指令）
- **多项目会话监视**：置顶常用会话、一眼分辨运行中/空闲项目并一键跳转。
- **快捷发起新对话**：指定模型直接新开任务，不打断当前页面。
- **常用指令模板**：自定义常用 Prompt，点击一键发送到当前对话。

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
