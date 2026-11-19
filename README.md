# Prism Orbit · 棱镜星轨 (`agy_theme_plugin`)

专为 **macOS Antigravity 2.0** 打造的原创 **Apple Liquid Glass（液态玻璃）** 主题美化工坊与实时遥测驾驶舱插件。

- **零侵入 Electron 本体**：完全基于 Antigravity 官方 `sidecar_sdk` UI 插件架构，无需篡改应用签名、无需强行重启、不影响正在运行的其他项目。
- **纯简体中文精校界面**：支持右上角一键切换 `中 / EN`，内置原生英文界面中文对照速查与「全中文回复 Rules」一键复制。

## 核心功能

### 1. 驾驶舱（实时遥测与跨项目监控）
- **项目 + 会话双切换与自动跟随**：支持一键跟随 Antigravity 当前打开的会话与工作区，或按项目筛选/跳转任意会话。
- **星环上下文仪表 + 本会话模型占比**：发光渐变圆环实时展示上下文占用（`200k` / `512k` / `1M`），下方独立展示当前会话各模型的用量比例（默认仅统计主会话本身，可勾选合并其子智能体）。
- **额度滚动窗口与刷新监控**：本地精确追踪 **Gemini 系列** 与 **Claude / GPT 系列** 的 **5 小时 / 每周（7 天）** 滑动窗口消耗、剩余参考比例与最早释放倒计时，附带实时生成速率（`tok/s`）Sparkline 与缓存命中率。
- **子智能体实时监控**：自动聚合追踪各项目主会话派生的子智能体（状态、角色、步数、Token 消耗与活跃时间），支持按全部项目 / 当前项目筛选并一键跳转。
- **项目整体统计与模型占比**：按工作区项目自动归并主会话与子智能体用量，支持 `今天 / 近7天 / 近30天 / 全部` 切换，直观呈现每个项目的总消耗、缓存命中率与模型占比条。

### 2. 外观美化（通透液态玻璃 + macOS 星光滤色整窗伴侣）
- **macOS 整窗氛围伴侣**：原生 Swift `AppKit` 鼠标穿透层，独创 **「星光滤色 (Luminance-Screen)」** 混合模式——让银河与夜行电车清晰贯穿左右窗口的同时，保证代码与白色文字锐利不发灰；支持左右窗口壁纸无缝贯穿防重影、液态玻璃窗框高光与切应用自动隐藏。
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
