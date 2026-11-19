(() => {
  const I18N = {
    'zh-CN': {
      'tab.cockpit': '驾驶舱',
      'tab.studio': '棱镜工坊',
      'tab.guide': '中文速查',
      'cockpit.followLatest': '跟随最新',
      'cockpit.contextTitle': '上下文窗口占用',
      'cockpit.contextShort': '已占用',
      'cockpit.telemetryTitle': '速率与缓存遥测',
      'cockpit.cacheHit': '缓存命中率',
      'cockpit.speed': '生成速率',
      'cockpit.usageTitle': '模型 Token 用量',
      'cockpit.scopeAll': '全部',
      'cockpit.scopeCurrent': '当前',
      'cockpit.today': '今天',
      'cockpit.7d': '近7天',
      'cockpit.30d': '近30天',
      'cockpit.cacheRead': '缓存命中',
      'cockpit.uncached': '未命中',
      'cockpit.output': '输出',
      'cockpit.costNote': '* 费用为按公开 API 单价估算的参考值，本地只读统计，不产生额外请求。',
      'cockpit.sessionsTitle': '多项目会话监视',
      'studio.paletteTitle': '液态玻璃色调',
      'studio.paletteSub': '六通道实时配色定制与明暗自适应',
      'studio.followHost': '跟随宿主明暗',
      'studio.reset': '还原默认',
      'studio.savePreset': '保存方案',
      'studio.previewTitle': '液态玻璃效果预览',
      'studio.wallpaperTitle': '壁纸画廊',
      'studio.randomWp': '随机壁纸',
      'studio.uploadWp': '自定义图片',
      'studio.clearWp': '清除',
      'studio.opacity': '壁纸透明度',
      'studio.blur': '玻璃磨砂模糊',
      'studio.darkness': '暗度护眼遮罩',
      'studio.radius': '卡片圆角柔化',
      'studio.fitMode': '壁纸适配',
      'studio.fitCover': '铺满裁剪',
      'studio.fitContain': '完整居中',
      'studio.companionTitle': 'macOS 整窗氛围伴侣',
      'studio.companionSub': '原生鼠标穿透层 · 自动贴合 Antigravity 窗口 · 零侵入不重启',
      'studio.compOpacity': '整窗壁纸浓度',
      'studio.compVignette': '边缘护眼暗角',
      'studio.compBlur': '整窗柔焦',
      'studio.compFrontmost': '切到其他应用时自动隐藏',
    },
    en: {
      'tab.cockpit': 'Cockpit',
      'tab.studio': 'Glass Studio',
      'tab.guide': 'ZH Guide',
      'cockpit.followLatest': 'Follow Latest',
      'cockpit.contextTitle': 'Context Window',
      'cockpit.contextShort': 'Used',
      'cockpit.telemetryTitle': 'Model Telemetry',
      'cockpit.cacheHit': 'Cache Hit',
      'cockpit.speed': 'Speed',
      'cockpit.usageTitle': 'Model Token Usage',
      'cockpit.scopeAll': 'All',
      'cockpit.scopeCurrent': 'Current',
      'cockpit.today': 'Today',
      'cockpit.7d': '7d',
      'cockpit.30d': '30d',
      'cockpit.cacheRead': 'Cache Hit',
      'cockpit.uncached': 'Uncached',
      'cockpit.output': 'Output',
      'cockpit.costNote': '* Reference cost estimate based on public API rates; strictly local read-only telemetry.',
      'cockpit.sessionsTitle': 'Parallel Sessions',
      'studio.paletteTitle': 'Liquid Glass Palette',
      'studio.paletteSub': '6-channel live theming with light/dark adaptation',
      'studio.followHost': 'Follow Host',
      'studio.reset': 'Reset',
      'studio.savePreset': 'Save Preset',
      'studio.previewTitle': 'Live Glass Preview',
      'studio.wallpaperTitle': 'Wallpaper Gallery',
      'studio.randomWp': 'Random',
      'studio.uploadWp': 'Upload Image',
      'studio.clearWp': 'Clear',
      'studio.opacity': 'Wallpaper Opacity',
      'studio.blur': 'Glass Blur',
      'studio.darkness': 'Readability Scrim',
      'studio.radius': 'Card Radius',
      'studio.fitMode': 'Fit Mode',
      'studio.fitCover': 'Cover',
      'studio.fitContain': 'Contain',
      'studio.companionTitle': 'macOS Backdrop Companion',
      'studio.companionSub': 'Native click-through overlay synced to Antigravity window bounds',
      'studio.compOpacity': 'Window Opacity',
      'studio.compVignette': 'Edge Vignette',
      'studio.compBlur': 'Overlay Blur',
      'studio.compFrontmost': 'Auto-hide when switching apps',
    },
  };

  const COLOR_CHANNELS = [
    { key: 'accent', zh: '主强调色', en: 'Primary Accent' },
    { key: 'secondary', zh: '次折射色', en: 'Secondary Glow' },
    { key: 'tertiary', zh: '状态点缀', en: 'Status Mint' },
    { key: 'canvas', zh: '画布底色', en: 'Canvas Base' },
    { key: 'surface', zh: '顶栏玻璃', en: 'Surface Glass' },
    { key: 'card', zh: '卡片玻璃', en: 'Card Glass' },
  ];

  const GLOSSARY = [
    { en: 'Customizations', zh: '自定义配置', desc: '统一管理 Plugins（插件）、Skills（技能）、Rules（规则）与 MCP 服务。' },
    { en: 'Rules / AGENTS.md', zh: '全局与项目规则', desc: '自动注入上下文的常驻指令（例如要求 AI 始终使用简体中文回复）。' },
    { en: 'Skills', zh: '按需技能包', desc: '仅在任务相关时按需加载的专业工作流说明，节省上下文窗口。' },
    { en: 'Tool Execution Policy', zh: '工具执行策略', desc: '控制终端命令是否需要人工确认（always-proceed / request-review / strict / sandbox）。' },
    { en: 'Terminal Sandbox', zh: '终端沙盒模式', desc: '将 Agent 执行的命令隔离在受限安全沙盒内运行。' },
    { en: 'Non-Workspace File Access', zh: '工作区外文件权限', desc: '控制 Agent 是否允许读写当前项目目录之外的本机文件。' },
    { en: '/plan', zh: '深度规划模式', desc: '复杂任务前先输出清晰的分步方案，确认后再动手。' },
    { en: '/goal', zh: '长任务目标模式', desc: '适合耗时较长的端到端任务，持续推进直到目标彻底完成。' },
    { en: '/compact', zh: '压缩上下文', desc: '当上下文窗口占比偏高时，智能总结历史对话以释放空间。' },
    { en: '/grill-me', zh: '交互式需求访谈', desc: '通过逐条提问帮你理清模糊需求与关键架构决策。' },
    { en: '/teamwork', zh: '多智能体协作', desc: '将大型任务拆解给多个并行 Agent 协同推进。' },
    { en: '/boost', zh: '深度强化模式', desc: '启用多视角深度思考与更严格的交叉验证。' },
    { en: '/schedule', zh: '定时与周期任务', desc: '创建一次性倒计时提醒或 Cron 周期自动任务。' },
    { en: 'Auxiliary Pane (⌘B)', zh: '辅助侧边栏', desc: '右侧面板区域，用来展示插件界面、产物、变更文件与终端。' },
  ];

  let appState = null;
  let telemetry = null;
  let selectedConversationId = window.sidecar?.conversationId || '';
  let hostIsLight = false;
  let saveTimer = null;

  const $ = (sel) => document.querySelector(sel);

  function showToast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function apiFetch(url, options = {}) {
    if (window.sidecar?.fetch) {
      return window.sidecar.fetch(url, options);
    }
    return fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function formatCompact(n) {
    const num = Number(n || 0);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
    return String(num);
  }

  function formatRelativeTime(ms) {
    if (!ms) return '';
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    return `${day} 天前`;
  }

  function isLightColor(hex) {
    const clean = String(hex || '').replace('#', '');
    if (clean.length !== 6) return false;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return luma > 165;
  }

  // Detect host theme changes pushed by sidecar preload
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') {
      const bg = event.data.payload?.cssVariables?.['--background'] || '';
      if (bg.startsWith('#')) {
        hostIsLight = isLightColor(bg);
      } else if (/rgb\(\s*(\d+)/.test(bg)) {
        const m = bg.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (m) hostIsLight = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3] > 165;
      }
      if (appState?.settings?.followHostTheme) {
        applyThemeToDOM(appState.settings);
      }
    }
  });

  function applyI18n(lang) {
    const dict = I18N[lang] || I18N['zh-CN'];
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
    $('#btn-lang').textContent = lang === 'en' ? 'EN' : '中';
  }

  function applyThemeToDOM(settings) {
    const root = document.documentElement;
    const colors = settings.colors || {};
    let lightMode = isLightColor(colors.canvas);
    if (settings.followHostTheme) {
      lightMode = hostIsLight;
    }

    document.body.classList.toggle('theme-light', lightMode);

    if (settings.followHostTheme && lightMode && !isLightColor(colors.canvas)) {
      root.style.setProperty('--prism-canvas', '#EEF3FA');
      root.style.setProperty('--prism-surface', '#F7FAFE');
      root.style.setProperty('--prism-card', '#FFFFFF');
    } else if (settings.followHostTheme && !lightMode && isLightColor(colors.canvas)) {
      root.style.setProperty('--prism-canvas', '#0B101D');
      root.style.setProperty('--prism-surface', '#131A2D');
      root.style.setProperty('--prism-card', '#1A233A');
    } else {
      root.style.setProperty('--prism-canvas', colors.canvas || '#0B101D');
      root.style.setProperty('--prism-surface', colors.surface || '#131A2D');
      root.style.setProperty('--prism-card', colors.card || '#1A233A');
    }

    root.style.setProperty('--prism-accent', colors.accent || '#6EA8FF');
    root.style.setProperty('--prism-secondary', colors.secondary || '#F4B860');
    root.style.setProperty('--prism-tertiary', colors.tertiary || '#38D9A9');

    const wp = settings.wallpaper || {};
    root.style.setProperty('--prism-blur', `${Number(wp.blur ?? 14)}px`);
    root.style.setProperty('--prism-radius', `${Number(wp.radius ?? 16)}px`);
    root.style.setProperty('--prism-wp-opacity', String(Number(wp.opacity ?? 92) / 100));
    root.style.setProperty('--prism-scrim', String(Number(wp.darkness ?? 38) / 100));

    const wpEl = $('#wallpaper-layer');
    if (wp.kind === 'none' || !wp.id) {
      wpEl.style.backgroundImage = 'none';
    } else {
      const url = `/api/wallpaper?kind=${encodeURIComponent(wp.kind)}&id=${encodeURIComponent(wp.id)}`;
      wpEl.style.backgroundImage = `url("${url}")`;
      wpEl.style.backgroundSize = wp.fit === 'contain' ? 'contain' : 'cover';
    }
  }

  function queueSaveSettings(patch, immediate = false) {
    if (!appState) return;
    // Optimistic local merge
    appState.settings = deepMergeLocal(appState.settings, patch);
    applyThemeToDOM(appState.settings);

    clearTimeout(saveTimer);
    const run = async () => {
      try {
        const res = await apiFetch('/api/settings', {
          method: 'POST',
          body: JSON.stringify({ settings: patch }),
        });
        if (res.ok) {
          appState = await res.json();
          renderStudio();
        }
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
    };
    if (immediate) run();
    else saveTimer = setTimeout(run, 180);
  }

  function deepMergeLocal(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMergeLocal(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // ==================== RENDER: STUDIO ====================
  function renderStudio() {
    if (!appState) return;
    const { settings, builtinPresets, builtinWallpapers, customWallpapers, companion } = appState;
    const lang = settings.language || 'zh-CN';
    applyI18n(lang);
    applyThemeToDOM(settings);

    $('#btn-follow-host').classList.toggle('active', Boolean(settings.followHostTheme));

    // Presets
    const allPresets = [...builtinPresets, ...(settings.customPresets || [])];
    const activePreset = allPresets.find((p) => p.id === settings.presetId);
    $('#preview-preset-name').textContent = activePreset ? activePreset.name : '自定义配色';

    $('#preset-pills').innerHTML = allPresets
      .map((p) => {
        const active = settings.presetId === p.id;
        return `
          <button type="button" class="preset-pill ${active ? 'active' : ''}" data-preset-id="${p.id}">
            <span class="swatch-trio">
              <i style="background:${p.colors.accent}"></i>
              <i style="background:${p.colors.secondary}"></i>
              <i style="background:${p.colors.tertiary}"></i>
            </span>
            <span>${escapeHtml(p.name)}</span>
            ${p.isCustom ? `<span class="preset-del" data-del-preset="${p.id}" title="删除">×</span>` : ''}
          </button>
        `;
      })
      .join('');

    // Color pickers
    $('#color-pickers').innerHTML = COLOR_CHANNELS.map((ch) => {
      const hex = (settings.colors?.[ch.key] || '#6EA8FF').toUpperCase();
      return `
        <div class="color-cell">
          <div class="color-cell-info">
            <div class="color-cell-label">${lang === 'en' ? ch.en : ch.zh}</div>
            <div class="color-cell-hex">${hex}</div>
          </div>
          <input type="color" data-color-key="${ch.key}" value="${hex}" />
        </div>
      `;
    }).join('');

    // Wallpapers
    const wp = settings.wallpaper || {};
    const allWallpapers = [
      ...builtinWallpapers.map((w) => ({ ...w, kind: 'builtin' })),
      ...(customWallpapers || []).map((w) => ({ ...w, kind: 'custom', tag: '本地' })),
    ];
    const currentWp = allWallpapers.find((w) => w.kind === wp.kind && w.id === wp.id);
    $('#active-wallpaper-name').textContent = wp.kind === 'none' ? '已关闭壁纸' : currentWp?.name || '自定义壁纸';

    $('#wallpaper-grid').innerHTML = allWallpapers
      .map((w) => {
        const active = wp.kind === w.kind && wp.id === w.id;
        const src = `/api/wallpaper?kind=${encodeURIComponent(w.kind)}&id=${encodeURIComponent(w.id)}`;
        return `
          <div class="wp-card ${active ? 'active' : ''}" data-wp-kind="${w.kind}" data-wp-id="${escapeHtml(w.id)}">
            <img src="${src}" alt="${escapeHtml(w.name)}" loading="lazy" />
            ${w.kind === 'custom' ? `<button type="button" class="wp-del-btn" data-del-wp="${escapeHtml(w.id)}" title="删除">×</button>` : ''}
            <div class="wp-caption">
              <span>${escapeHtml(w.name)}</span>
              ${w.tag ? `<span class="wp-tag">${escapeHtml(w.tag)}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // Sliders
    $('#range-wp-opacity').value = wp.opacity ?? 92;
    $('#val-wp-opacity').textContent = `${wp.opacity ?? 92}%`;
    $('#range-wp-blur').value = wp.blur ?? 14;
    $('#val-wp-blur').textContent = `${wp.blur ?? 14}px`;
    $('#range-wp-darkness').value = wp.darkness ?? 38;
    $('#val-wp-darkness').textContent = `${wp.darkness ?? 38}%`;
    $('#range-wp-radius').value = wp.radius ?? 16;
    $('#val-wp-radius').textContent = `${wp.radius ?? 16}px`;

    document.querySelectorAll('#wp-fit-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.fit === (wp.fit || 'cover'));
    });

    // Companion
    const comp = settings.companion || {};
    $('#range-comp-opacity').value = comp.opacity ?? 22;
    $('#val-comp-opacity').textContent = `${comp.opacity ?? 22}%`;
    $('#range-comp-vignette').value = comp.vignette ?? 32;
    $('#val-comp-vignette').textContent = `${comp.vignette ?? 32}%`;
    $('#range-comp-blur').value = comp.blur ?? 0;
    $('#val-comp-blur').textContent = `${comp.blur ?? 0}px`;
    $('#chk-comp-frontmost').checked = comp.onlyWhenFrontmost !== false;

    const badge = $('#companion-status-badge');
    const toggleBtn = $('#btn-toggle-companion');
    const errEl = $('#companion-error');
    badge.classList.remove('running', 'warn');

    if (!companion?.supported) {
      badge.textContent = '仅支持 macOS';
      toggleBtn.disabled = true;
      toggleBtn.textContent = '当前系统不支持';
    } else if (companion.status === 'compiling') {
      badge.textContent = '首次编译中...';
      badge.classList.add('warn');
      toggleBtn.textContent = '正在准备...';
    } else if (companion.running && comp.enabled) {
      badge.textContent = '● 运行中 · 追踪窗口';
      badge.classList.add('running');
      toggleBtn.textContent = '关闭整窗伴侣';
      toggleBtn.classList.add('is-active-danger');
    } else {
      badge.textContent = companion.binaryReady ? '准备就绪' : '待启动';
      toggleBtn.textContent = '开启整窗伴侣';
      toggleBtn.classList.remove('is-active-danger');
    }

    if (companion?.error) {
      errEl.hidden = false;
      errEl.textContent = `伴侣提示：${companion.error}`;
    } else {
      errEl.hidden = true;
    }
  }

  // ==================== RENDER: COCKPIT ====================
  function renderSparkline(points) {
    const svg = $('#speed-sparkline');
    if (!points || points.length < 2) {
      svg.innerHTML = `<text x="90" y="27" text-anchor="middle" fill="var(--prism-muted)" font-size="10">等待更多生成轮次...</text>`;
      return;
    }
    const vals = points.map((p) => p.rate);
    const min = Math.min(...vals);
    const max = Math.max(...vals, min + 1);
    const w = 180;
    const h = 46;
    const padX = 6;
    const padY = 6;

    const coords = vals.map((v, i) => {
      const x = padX + (i / (vals.length - 1)) * (w - padX * 2);
      const y = h - padY - ((v - min) / (max - min)) * (h - padY * 2);
      return [x, y];
    });

    const lineD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${coords[coords.length - 1][0].toFixed(1)},${h} L${coords[0][0].toFixed(1)},${h} Z`;
    const last = coords[coords.length - 1];

    svg.innerHTML = `
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--prism-tertiary)" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="var(--prism-tertiary)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#sparkFill)" />
      <path d="${lineD}" fill="none" stroke="var(--prism-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="var(--prism-tertiary)" />
    `;
  }

  function renderCockpit() {
    if (!telemetry || !appState) return;
    const { settings } = appState;
    const telCfg = settings.telemetry || {};

    $('#btn-follow-latest').classList.toggle('active', Boolean(telCfg.followLatest));

    // Conversation select
    const select = $('#select-conversation');
    const convs = telemetry.conversations || [];
    select.innerHTML = convs.length
      ? convs
          .map(
            (c) =>
              `<option value="${escapeHtml(c.id)}" ${c.id === telemetry.activeConversation?.id ? 'selected' : ''}>[${escapeHtml(c.workspace)}] ${escapeHtml(c.title)}</option>`,
          )
          .join('')
      : `<option value="">暂无本地会话</option>`;

    const activeConv = telemetry.activeConversation;
    const statusPill = $('#active-status-pill');
    statusPill.textContent = activeConv?.statusLabel || '就绪';
    statusPill.classList.toggle('running', Boolean(activeConv?.isRunning));

    // Context Ring
    const ctx = telemetry.context;
    const circumference = 2 * Math.PI * 48;
    const offset = circumference * (1 - Math.min(100, ctx.percent) / 100);
    $('#ring-progress').style.strokeDashoffset = String(offset.toFixed(2));
    $('#ring-percent').textContent = `${ctx.percent.toFixed(ctx.percent >= 10 ? 0 : 1)}%`;
    $('#ctx-used').textContent = formatNumber(ctx.used);
    $('#ctx-limit').textContent = formatNumber(ctx.limit);
    $('#context-subtitle').textContent = `${activeConv?.workspace || '工作区'} · ${activeConv?.title || '当前会话'}`;

    document.querySelectorAll('#window-limit-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.limit) === Number(ctx.limit));
    });

    const b = ctx.breakdown;
    const items = [
      { label: '系统基准', value: b.system, color: 'var(--prism-accent)' },
      { label: '思考增量', value: b.thinking, color: 'var(--prism-secondary)' },
      { label: '用户与对话', value: b.dialog, color: 'var(--prism-tertiary)' },
      { label: '工具与输出', value: b.tools, color: '#C084FC' },
    ];
    $('#breakdown-list').innerHTML = items
      .map((it) => {
        const pct = ctx.limit > 0 ? Math.min(100, (it.value / ctx.limit) * 100) : 0;
        return `
          <div class="breakdown-item">
            <div class="breakdown-top">
              <span>${it.label}</span>
              <strong class="tabular">${formatCompact(it.value)}</strong>
            </div>
            <div class="breakdown-bar"><span style="width:${Math.max(pct, it.value > 0 ? 4 : 0)}%;background:${it.color}"></span></div>
          </div>
        `;
      })
      .join('');

    // Speed & Cache Telemetry
    const spd = telemetry.speed;
    const usage = telemetry.usage;
    $('#last-model-badge').textContent = spd.lastModelDisplay || '未检测到模型';
    $('#metric-cache-rate').textContent = `${usage.cacheHitRate.toFixed(1)}%`;
    $('#metric-cache-bar').style.width = `${Math.min(100, usage.cacheHitRate)}%`;
    $('#metric-speed').textContent = spd.latest ? spd.latest.toFixed(1) : '—';
    $('#metric-speed-avg').textContent = spd.average ? `均值 ${spd.average.toFixed(1)} tok/s · ${spd.turnCount} 轮` : `${spd.turnCount} 轮对话`;
    renderSparkline(spd.sparkline);

    // Usage Ledger
    $('#usage-total-tokens').textContent = formatNumber(usage.totalTokens);
    $('#usage-total-cost').textContent = `≈ $${usage.costUsd.toFixed(2)} 参考`;
    $('#sum-cache').textContent = formatCompact(usage.cacheRead);
    $('#sum-uncached').textContent = formatCompact(usage.uncachedInput);
    $('#sum-output').textContent = formatCompact(usage.output);

    document.querySelectorAll('#usage-scope-group .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === usage.scope);
    });
    document.querySelectorAll('#usage-range-group .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === usage.range);
    });

    const modelsEl = $('#models-list');
    if (!usage.models.length) {
      modelsEl.innerHTML = `<div class="model-row"><div class="card-sub">当前时间范围内暂无 Token 记录</div></div>`;
    } else {
      modelsEl.innerHTML = usage.models
        .map((m) => {
          const tot = Math.max(1, m.totalTokens);
          const wCache = (m.cacheRead / tot) * 100;
          const wIn = (m.uncachedInput / tot) * 100;
          const wOut = (m.output / tot) * 100;
          return `
            <div class="model-row">
              <div class="model-row-top">
                <span class="model-row-name">${escapeHtml(m.displayName)}</span>
                <span class="model-row-nums tabular"><strong>${formatCompact(m.totalTokens)}</strong> · ≈$${m.costUsd.toFixed(2)}</span>
              </div>
              <div class="stacked-bar">
                <span style="width:${wCache}%;background:var(--prism-tertiary)"></span>
                <span style="width:${wIn}%;background:var(--prism-accent)"></span>
                <span style="width:${wOut}%;background:var(--prism-secondary)"></span>
              </div>
              <div class="model-row-sub tabular">
                <span>缓存命中 ${m.cacheHitRate.toFixed(1)}% · ${m.turns} 轮</span>
                <span>输出 ${formatCompact(m.output)}</span>
              </div>
            </div>
          `;
        })
        .join('');
    }

    // Sessions list (pinned first, then running, then recent)
    const pinnedSet = new Set(settings.pinnedConversations || []);
    const runningCount = convs.filter((c) => c.isRunning).length;
    $('#running-count-badge').textContent = `${runningCount} 运行中`;

    const sortedConvs = [...convs]
      .sort((a, b) => {
        const pa = pinnedSet.has(a.id) ? 1 : 0;
        const pb = pinnedSet.has(b.id) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
        return b.lastModifiedMs - a.lastModifiedMs;
      })
      .slice(0, 10);

    $('#sessions-list').innerHTML = sortedConvs
      .map((c) => {
        const pinned = pinnedSet.has(c.id);
        const isCurrent = c.id === activeConv?.id;
        return `
          <div class="session-item ${isCurrent ? 'is-current' : ''}" data-open-conv="${escapeHtml(c.id)}">
            <div class="session-meta">
              <div class="session-title">${escapeHtml(c.title)}</div>
              <div class="session-sub">${escapeHtml(c.workspace)} · ${c.stepCount} 步 · ${formatRelativeTime(c.lastModifiedMs)}</div>
            </div>
            <div class="session-actions">
              <span class="badge-pill ${c.isRunning ? 'running' : ''}">${c.statusLabel}</span>
              <button type="button" class="star-btn ${pinned ? 'pinned' : ''}" data-pin-conv="${escapeHtml(c.id)}" title="置顶会话">${pinned ? '★' : '☆'}</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ==================== RENDER: GLOSSARY ====================
  function renderGlossary(query = '') {
    const q = query.trim().toLowerCase();
    const list = q
      ? GLOSSARY.filter(
          (g) =>
            g.en.toLowerCase().includes(q) ||
            g.zh.toLowerCase().includes(q) ||
            g.desc.toLowerCase().includes(q),
        )
      : GLOSSARY;

    $('#glossary-list').innerHTML = list.length
      ? list
          .map(
            (g) => `
          <div class="glossary-item">
            <div class="glossary-top">
              <span class="glossary-en">${escapeHtml(g.en)}</span>
              <span class="glossary-zh">${escapeHtml(g.zh)}</span>
            </div>
            <div class="glossary-desc">${escapeHtml(g.desc)}</div>
          </div>
        `,
          )
          .join('')
      : `<div class="glossary-item"><div class="glossary-desc">未找到匹配词条</div></div>`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== DATA FETCHING ====================
  async function loadState() {
    const res = await apiFetch('/api/state', { method: 'GET' });
    if (!res.ok) throw new Error('Failed to load state');
    appState = await res.json();
    renderStudio();
  }

  async function loadTelemetry() {
    if (!appState) return;
    const tel = appState.settings.telemetry || {};
    const params = new URLSearchParams({
      followLatest: String(tel.followLatest !== false),
      scope: tel.scope || 'all',
      range: tel.range || 'today',
      windowLimit: String(tel.windowLimit || 512000),
    });
    if (selectedConversationId) {
      params.set('conversationId', selectedConversationId);
    }
    const res = await apiFetch(`/api/telemetry?${params.toString()}`, { method: 'GET' });
    if (!res.ok) return;
    telemetry = await res.json();
    if (tel.followLatest !== false && telemetry.activeConversation?.id) {
      selectedConversationId = telemetry.activeConversation.id;
    }
    renderCockpit();
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    // Top tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        document.querySelectorAll('.nav-tab').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        document.querySelectorAll('.tab-panel').forEach((p) => {
          p.classList.toggle('active', p.id === `tab-${target}`);
        });
      });
    });

    // Language switch
    $('#btn-lang').addEventListener('click', () => {
      const next = appState.settings.language === 'en' ? 'zh-CN' : 'en';
      queueSaveSettings({ language: next }, true);
      showToast(next === 'en' ? 'Switched to English' : '已切换为简体中文');
    });

    // Manual refresh
    $('#btn-refresh').addEventListener('click', async () => {
      await Promise.all([loadState(), loadTelemetry()]);
      showToast('数据已刷新');
    });

    // Cockpit controls
    $('#btn-follow-latest').addEventListener('click', async () => {
      const next = !(appState.settings.telemetry?.followLatest !== false);
      await queueSaveSettings({ telemetry: { followLatest: next } }, true);
      await loadTelemetry();
    });

    $('#select-conversation').addEventListener('change', async (e) => {
      selectedConversationId = e.target.value;
      await queueSaveSettings({ telemetry: { followLatest: false } }, true);
      await loadTelemetry();
    });

    $('#window-limit-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { windowLimit: Number(btn.dataset.limit) } }, true);
      await loadTelemetry();
    });

    $('#usage-scope-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { scope: btn.dataset.scope } }, true);
      await loadTelemetry();
    });

    $('#usage-range-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { range: btn.dataset.range } }, true);
      await loadTelemetry();
    });

    // Session open & pin
    $('#sessions-list').addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('[data-pin-conv]');
      if (pinBtn) {
        e.stopPropagation();
        const convId = pinBtn.dataset.pinConv;
        const res = await apiFetch('/api/pin', {
          method: 'POST',
          body: JSON.stringify({ conversationId: convId }),
        });
        if (res.ok) {
          appState = await res.json();
          renderCockpit();
        }
        return;
      }
      const item = e.target.closest('[data-open-conv]');
      if (item) {
        const convId = item.dataset.openConv;
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(convId);
        }
        selectedConversationId = convId;
        await queueSaveSettings({ telemetry: { followLatest: false } }, true);
        await loadTelemetry();
      }
    });

    // Studio: Follow host / Reset
    $('#btn-follow-host').addEventListener('click', () => {
      queueSaveSettings({ followHostTheme: !appState.settings.followHostTheme }, true);
    });

    $('#btn-reset-colors').addEventListener('click', async () => {
      const res = await apiFetch('/api/reset-colors', { method: 'POST', body: '{}' });
      if (res.ok) {
        appState = await res.json();
        renderStudio();
        showToast('已还原星海暖灯默认配色');
      }
    });

    // Preset click / delete
    $('#preset-pills').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-preset]');
      if (del) {
        e.stopPropagation();
        const res = await apiFetch('/api/presets/delete', {
          method: 'POST',
          body: JSON.stringify({ id: del.dataset.delPreset }),
        });
        if (res.ok) {
          appState = await res.json();
          renderStudio();
          showToast('已删除自定义方案');
        }
        return;
      }
      const pill = e.target.closest('[data-preset-id]');
      if (!pill) return;
      const all = [...appState.builtinPresets, ...(appState.settings.customPresets || [])];
      const found = all.find((p) => p.id === pill.dataset.presetId);
      if (!found) return;
      queueSaveSettings({ presetId: found.id, followHostTheme: false, colors: { ...found.colors } }, true);
      showToast(`已切换「${found.name}」`);
    });

    // Save custom preset
    $('#btn-save-preset').addEventListener('click', async () => {
      const name = $('#input-preset-name').value.trim();
      if (!name) {
        showToast('请先输入方案名称');
        return;
      }
      const res = await apiFetch('/api/presets/save', {
        method: 'POST',
        body: JSON.stringify({
          name,
          colors: appState.settings.colors,
          mode: isLightColor(appState.settings.colors.canvas) ? 'light' : 'dark',
        }),
      });
      if (res.ok) {
        appState = await res.json();
        $('#input-preset-name').value = '';
        renderStudio();
        showToast(`已保存方案「${name}」`);
      }
    });

    // Color picker live change
    $('#color-pickers').addEventListener('input', (e) => {
      const input = e.target.closest('input[type="color"]');
      if (!input) return;
      const key = input.dataset.colorKey;
      const hex = input.value.toUpperCase();
      input.closest('.color-cell').querySelector('.color-cell-hex').textContent = hex;
      queueSaveSettings({ presetId: 'custom', colors: { [key]: hex } }, false);
    });

    // Wallpaper click / delete
    $('#wallpaper-grid').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-wp]');
      if (del) {
        e.stopPropagation();
        const res = await apiFetch('/api/wallpapers/delete', {
          method: 'POST',
          body: JSON.stringify({ id: del.dataset.delWp }),
        });
        if (res.ok) {
          appState = await res.json();
          renderStudio();
          showToast('已删除自定义壁纸');
        }
        return;
      }
      const card = e.target.closest('.wp-card');
      if (!card) return;
      queueSaveSettings({ wallpaper: { kind: card.dataset.wpKind, id: card.dataset.wpId } }, true);
    });

    // Random / Upload / Clear wallpaper
    $('#btn-random-wp').addEventListener('click', () => {
      const all = [
        ...appState.builtinWallpapers.map((w) => ({ kind: 'builtin', id: w.id, name: w.name })),
        ...(appState.customWallpapers || []).map((w) => ({ kind: 'custom', id: w.id, name: w.name })),
      ];
      if (!all.length) return;
      const cur = appState.settings.wallpaper;
      const pool = all.filter((w) => !(w.kind === cur.kind && w.id === cur.id));
      const pick = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length ? pool.length : all.length))];
      queueSaveSettings({ wallpaper: { kind: pick.kind, id: pick.id } }, true);
      showToast(`已切换壁纸「${pick.name}」`);
    });

    $('#btn-clear-wp').addEventListener('click', () => {
      queueSaveSettings({ wallpaper: { kind: 'none', id: '' } }, true);
      showToast('已清除壁纸');
    });

    $('#btn-upload-wp').addEventListener('click', () => $('#file-wallpaper').click());
    $('#file-wallpaper').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) {
        showToast('图片不能超过 15MB');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await apiFetch('/api/wallpapers/upload', {
            method: 'POST',
            body: JSON.stringify({ name: file.name, dataUrl: reader.result }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '上传失败');
          }
          appState = await res.json();
          renderStudio();
          showToast('自定义壁纸已应用');
        } catch (err) {
          showToast(err.message);
        } finally {
          e.target.value = '';
        }
      };
      reader.readAsDataURL(file);
    });

    // Wallpaper sliders
    const bindSlider = (id, readoutId, unit, pathBuilder) => {
      const input = $(id);
      input.addEventListener('input', () => {
        const val = Number(input.value);
        $(readoutId).textContent = `${val}${unit}`;
        queueSaveSettings(pathBuilder(val), false);
      });
    };

    bindSlider('#range-wp-opacity', '#val-wp-opacity', '%', (v) => ({ wallpaper: { opacity: v } }));
    bindSlider('#range-wp-blur', '#val-wp-blur', 'px', (v) => ({ wallpaper: { blur: v } }));
    bindSlider('#range-wp-darkness', '#val-wp-darkness', '%', (v) => ({ wallpaper: { darkness: v } }));
    bindSlider('#range-wp-radius', '#val-wp-radius', 'px', (v) => ({ wallpaper: { radius: v } }));

    $('#wp-fit-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      queueSaveSettings({ wallpaper: { fit: btn.dataset.fit }, companion: { fit: btn.dataset.fit } }, true);
    });

    // Companion sliders & toggle
    bindSlider('#range-comp-opacity', '#val-comp-opacity', '%', (v) => ({ companion: { opacity: v } }));
    bindSlider('#range-comp-vignette', '#val-comp-vignette', '%', (v) => ({ companion: { vignette: v } }));
    bindSlider('#range-comp-blur', '#val-comp-blur', 'px', (v) => ({ companion: { blur: v } }));

    $('#chk-comp-frontmost').addEventListener('change', (e) => {
      queueSaveSettings({ companion: { onlyWhenFrontmost: e.target.checked } }, true);
    });

    $('#btn-toggle-companion').addEventListener('click', async () => {
      const isRunning = Boolean(appState?.companion?.running && appState?.settings?.companion?.enabled);
      const action = isRunning ? 'stop' : 'start';
      showToast(action === 'start' ? '正在启动 macOS 整窗氛围伴侣...' : '正在关闭整窗氛围伴侣...');
      const res = await apiFetch('/api/companion', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        appState = await res.json();
        renderStudio();
        showToast(appState.companion?.running ? '整窗氛围伴侣已开启 ✨' : '整窗氛围伴侣已关闭');
      }
    });

    // Guide tab
    $('#input-glossary-search').addEventListener('input', (e) => renderGlossary(e.target.value));
    $('#btn-copy-rule').addEventListener('click', async () => {
      const text = $('#zh-rule-snippet').textContent;
      try {
        await navigator.clipboard.writeText(text);
        showToast('已复制中文回复规则，可粘贴到 Rules');
      } catch {
        showToast('请手动选中上方规则复制');
      }
    });
  }

  // ==================== BOOTSTRAP ====================
  async function init() {
    bindEvents();
    renderGlossary('');
    await loadState();
    await loadTelemetry();
    setInterval(loadTelemetry, 3500);
  }

  init().catch((err) => {
    console.error('[prism_studio] init failed:', err);
  });
})();
