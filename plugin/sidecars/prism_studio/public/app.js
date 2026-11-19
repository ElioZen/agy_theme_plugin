(() => {
  const COLOR_CHANNELS = [
    { key: 'accent', label: '主强调色' },
    { key: 'secondary', label: '次折射色' },
    { key: 'tertiary', label: '状态点缀' },
    { key: 'canvas', label: '画布底色' },
    { key: 'surface', label: '顶栏玻璃' },
    { key: 'card', label: '卡片玻璃' },
  ];

  const urlParams = new URLSearchParams(window.location.search);
  let hostConversationId = window.sidecar?.conversationId || urlParams.get('conversationId') || '';
  let activeWorkspaceUri = '';
  let manualConversationId = '';
  let projectFilter = '';
  let includeSubagents = false;
  let subagentScope = 'all';

  let appState = null;
  let telemetry = null;
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
    if (window.sidecar?.fetch) return window.sidecar.fetch(url, options);
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

  function formatCountdown(ms) {
    if (!ms || ms <= 0) return '窗口已清零';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时后释放`;
    if (hours > 0) return `${hours}小时 ${mins}分后释放`;
    return `${Math.max(1, mins)}分钟后释放`;
  }

  function formatRelativeTime(ms) {
    if (!ms) return '—';
    const diff = Math.max(0, Date.now() - ms);
    const sec = Math.floor(diff / 1000);
    if (sec < 45) return '刚刚';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    return `${Math.floor(hr / 24)} 天前`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isLightColor(hex) {
    const clean = String(hex || '').replace('#', '');
    if (clean.length !== 6) return false;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b > 165;
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

  // Listen to host theme & conversation/workspace updates
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'theme-change') {
      const bg = msg.payload?.cssVariables?.['--background'] || '';
      if (bg.startsWith('#')) {
        hostIsLight = isLightColor(bg);
      } else if (/rgb\(\s*(\d+)/.test(bg)) {
        const m = bg.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (m) hostIsLight = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3] > 165;
      }
      if (appState?.settings?.followHostTheme) applyThemeToDOM(appState.settings);
    } else if (msg.payload?.conversationId && typeof msg.payload.conversationId === 'string') {
      if (msg.payload.conversationId !== hostConversationId) {
        hostConversationId = msg.payload.conversationId;
        if (appState?.settings?.telemetry?.followLatest !== false) loadTelemetry();
      }
    }
  });

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      const next = Array.isArray(uris) && uris.length > 0 ? uris[0] : '';
      if (next !== activeWorkspaceUri) {
        activeWorkspaceUri = next;
        if (appState?.settings?.telemetry?.followLatest !== false) {
          loadTelemetry();
        }
      }
    });
  }

  function applyThemeToDOM(settings) {
    const root = document.documentElement;
    const colors = settings.colors || {};
    let lightMode = isLightColor(colors.canvas);
    if (settings.followHostTheme) lightMode = hostIsLight;

    document.body.classList.toggle('theme-light', lightMode);

    if (settings.followHostTheme && lightMode && !isLightColor(colors.canvas)) {
      root.style.setProperty('--prism-canvas', '#EEF3FA');
      root.style.setProperty('--prism-surface', '#F7FAFE');
      root.style.setProperty('--prism-card', '#FFFFFF');
    } else if (settings.followHostTheme && !lightMode && isLightColor(colors.canvas)) {
      root.style.setProperty('--prism-canvas', '#0E121B');
      root.style.setProperty('--prism-surface', '#141B2B');
      root.style.setProperty('--prism-card', '#192236');
    } else {
      root.style.setProperty('--prism-canvas', colors.canvas || '#0E121B');
      root.style.setProperty('--prism-surface', colors.surface || '#141B2B');
      root.style.setProperty('--prism-card', colors.card || '#192236');
    }

    root.style.setProperty('--prism-accent', colors.accent || '#6EA8FF');
    root.style.setProperty('--prism-secondary', colors.secondary || '#F4B860');
    root.style.setProperty('--prism-tertiary', colors.tertiary || '#38D9A9');

    const wp = settings.wallpaper || {};
    root.style.setProperty('--prism-blur', `${Number(wp.blur ?? 4)}px`);
    root.style.setProperty('--prism-radius', `${Number(wp.radius ?? 12)}px`);
    root.style.setProperty('--prism-wp-opacity', String(Number(wp.opacity ?? 100) / 100));
    root.style.setProperty('--prism-scrim', String(Number(wp.darkness ?? 6) / 100));

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
    else saveTimer = setTimeout(run, 150);
  }

  // ==================== RENDER: STUDIO ====================
  function renderStudio() {
    if (!appState) return;
    const { settings, builtinPresets, builtinWallpapers, customWallpapers, companion } = appState;
    applyThemeToDOM(settings);

    $('#btn-follow-host').classList.toggle('active', Boolean(settings.followHostTheme));

    // Presets
    const allPresets = [...builtinPresets, ...(settings.customPresets || [])];
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
          <div>
            <div class="color-cell-label">${ch.label}</div>
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

    $('#range-wp-opacity').value = wp.opacity ?? 100;
    $('#val-wp-opacity').textContent = `${wp.opacity ?? 100}%`;
    $('#range-wp-blur').value = wp.blur ?? 4;
    $('#val-wp-blur').textContent = `${wp.blur ?? 4}px`;
    $('#range-wp-darkness').value = wp.darkness ?? 6;
    $('#val-wp-darkness').textContent = `${wp.darkness ?? 6}%`;
    $('#range-wp-radius').value = wp.radius ?? 12;
    $('#val-wp-radius').textContent = `${wp.radius ?? 12}px`;

    document.querySelectorAll('#wp-fit-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.fit === (wp.fit || 'cover'));
    });

    // Companion
    const comp = settings.companion || {};
    $('#range-comp-opacity').value = comp.opacity ?? 62;
    $('#val-comp-opacity').textContent = `${comp.opacity ?? 62}%`;
    $('#range-comp-vignette').value = comp.vignette ?? 18;
    $('#val-comp-vignette').textContent = `${comp.vignette ?? 18}%`;
    $('#range-comp-blur').value = comp.blur ?? 0;
    $('#val-comp-blur').textContent = `${comp.blur ?? 0}px`;
    $('#chk-comp-seamless').checked = comp.seamlessRightPane !== false;
    $('#chk-comp-rim').checked = comp.glassRim !== false;
    $('#chk-comp-frontmost').checked = comp.onlyWhenFrontmost !== false;

    const blend = comp.blendStyle === 'soft' ? 'soft' : 'screen';
    document.querySelectorAll('#comp-blend-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.blend === blend);
    });

    const badge = $('#companion-status-badge');
    const toggleBtn = $('#btn-toggle-companion');
    const topBtn = $('#btn-top-companion');
    const errEl = $('#companion-error');
    badge.classList.remove('running', 'warn');

    const isCompanionActive = Boolean(companion?.running && comp.enabled);
    topBtn.classList.toggle('active', isCompanionActive);
    document.body.classList.toggle('companion-seamless', isCompanionActive && comp.seamlessRightPane !== false);

    if (!companion?.supported) {
      badge.textContent = '仅支持 macOS';
      toggleBtn.disabled = true;
      toggleBtn.textContent = '当前系统不支持';
    } else if (companion.status === 'compiling') {
      badge.textContent = '编译中...';
      badge.classList.add('warn');
      toggleBtn.textContent = '正在准备...';
    } else if (isCompanionActive) {
      badge.textContent = '● 运行中 · 星光贯穿';
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

    // Quota budget editor inputs
    const qb = settings.quotaBudgets || {};
    $('#inp-g5h').value = Math.round((qb.gemini5h || 60_000_000) / 1_000_000);
    $('#inp-g7d').value = Math.round((qb.gemini7d || 500_000_000) / 1_000_000);
    $('#inp-c5h').value = Math.round((qb.claude5h || 15_000_000) / 1_000_000);
    $('#inp-c7d').value = Math.round((qb.claude7d || 120_000_000) / 1_000_000);
  }

  // ==================== RENDER: COCKPIT ====================
  function renderSparkline(points) {
    const svg = $('#speed-sparkline');
    if (!points || points.length < 2) {
      svg.innerHTML = `<text x="90" y="24" text-anchor="middle" fill="var(--prism-muted)" font-size="10">等待更多生成轮次...</text>`;
      return;
    }
    const vals = points.map((p) => p.rate);
    const min = Math.min(...vals);
    const max = Math.max(...vals, min + 1);
    const w = 180;
    const h = 42;
    const padX = 5;
    const padY = 5;

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
      <path d="${lineD}" fill="none" stroke="var(--prism-tertiary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.8" fill="var(--prism-tertiary)" />
    `;
  }

  function renderCockpit() {
    if (!telemetry || !appState) return;
    const { settings } = appState;
    const telCfg = settings.telemetry || {};
    const activeConv = telemetry.activeConversation;

    $('#btn-follow-latest').classList.toggle('active', Boolean(telCfg.followLatest));

    // Project selector
    const projSel = $('#select-project');
    const projNames = telemetry.projectNames || [];
    projSel.innerHTML =
      `<option value="" ${!projectFilter ? 'selected' : ''}>全部项目 (${projNames.length})</option>` +
      projNames
        .map((name) => `<option value="${escapeHtml(name)}" ${projectFilter === name ? 'selected' : ''}>${escapeHtml(name)}</option>`)
        .join('');

    // Conversation selector
    const convSel = $('#select-conversation');
    const convs = telemetry.conversations || [];
    convSel.innerHTML = convs.length
      ? convs
          .map(
            (c) =>
              `<option value="${escapeHtml(c.id)}" ${c.id === activeConv?.id ? 'selected' : ''}>[${escapeHtml(c.workspace)}] ${escapeHtml(c.title)}</option>`,
          )
          .join('')
      : `<option value="">暂无匹配会话</option>`;

    const statusPill = $('#active-status-pill');
    statusPill.textContent = activeConv?.statusLabel || '就绪';
    statusPill.classList.toggle('running', Boolean(activeConv?.isRunning));

    // 1. Context Ring
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

    // Per-session model ratio (strictly this conversation unless user opts into subagents!)
    const sm = telemetry.sessionModels;
    $('#session-total-badge').textContent = `${formatCompact(sm.totalTokens)} · ≈$${sm.costUsd.toFixed(2)}`;
    $('#chk-include-subagents').checked = Boolean(sm.includeSubagents);
    $('#label-include-sub').textContent = `含子智能体 (${sm.subagentCount || 0})`;
    $('#wrap-include-sub').style.display = sm.subagentCount > 0 ? 'inline-flex' : 'none';

    if (sm.models.length > 0) {
      $('#session-ratio-bar').innerHTML = sm.models
        .map((m) => `<span style="width:${Math.max(2, m.sharePercent)}%;background:${m.color}" title="${escapeHtml(m.displayName)} ${m.sharePercent}%"></span>`)
        .join('');
      $('#session-models-list').innerHTML = sm.models
        .map(
          (m) => `
          <div class="ratio-row tabular">
            <div class="ratio-row-left">
              <span class="ratio-swatch" style="background:${m.color}"></span>
              <span class="ratio-name">${escapeHtml(m.displayName)}</span>
            </div>
            <div class="ratio-row-right">
              <strong>${m.sharePercent.toFixed(1)}%</strong> · ${formatCompact(m.totalTokens)} · 缓存 ${m.cacheHitRate.toFixed(0)}%
            </div>
          </div>
        `,
        )
        .join('');
    } else {
      $('#session-ratio-bar').innerHTML = '';
      $('#session-models-list').innerHTML = `<div class="card-sub">该会话暂无模型 Token 记录</div>`;
    }

    // 2. Quota Rolling Windows (5h & Weekly for Gemini + Claude/GPT)
    const q = telemetry.quotas;
    const renderQuotaCard = (group, accentColor) => {
      const renderWin = (title, win) => {
        const pctLeft = win.remainingPercent;
        const barColor = pctLeft < 15 ? '#f87171' : pctLeft < 35 ? 'var(--prism-secondary)' : accentColor;
        return `
          <div class="quota-row">
            <div class="quota-row-top tabular">
              <span class="muted">${title}</span>
              <span class="quota-val">${formatCompact(win.tokens)} <span class="muted">(${pctLeft.toFixed(0)}% 余)</span></span>
            </div>
            <div class="quota-bar"><span style="width:${Math.min(100, win.usedPercent)}%;background:${barColor}"></span></div>
            <div class="quota-reset tabular">
              <span>${win.calls} 次调用</span>
              <span>${formatCountdown(win.resetInMs)}</span>
            </div>
          </div>
        `;
      };
      return `
        <div class="quota-box">
          <div class="quota-head">
            <span>${group.label}</span>
            <span class="muted tabular" style="font-size:10px">5h / 7d</span>
          </div>
          ${renderWin('5小时窗口', group.h5)}
          ${renderWin('每周窗口', group.d7)}
        </div>
      `;
    };

    $('#quota-grid').innerHTML =
      renderQuotaCard(q.gemini, 'var(--prism-accent)') +
      renderQuotaCard(q.claude, 'var(--prism-tertiary)');

    // Speed & Cache strip
    const spd = telemetry.speed;
    $('#metric-cache-rate').textContent = `${sm.cacheHitRate.toFixed(1)}%`;
    $('#metric-speed').textContent = spd.latest ? spd.latest.toFixed(1) : '—';
    $('#metric-speed-avg').textContent = spd.average ? `均值 ${spd.average.toFixed(1)} tok/s · ${spd.turnCount} 轮` : `${spd.turnCount} 轮`;
    $('#last-model-badge').textContent = spd.lastModelDisplay || '未检测到模型';
    renderSparkline(spd.sparkline);

    // 3. Subagent Live Monitor
    document.querySelectorAll('#subagent-scope-group .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subscope === subagentScope);
    });

    const allSubs = telemetry.subagents || [];
    const targetWs = projectFilter || activeConv?.workspace || '';
    const visibleSubs = subagentScope === 'current' && targetWs
      ? allSubs.filter((s) => s.workspace === targetWs)
      : allSubs;

    const runningSubs = visibleSubs.filter((s) => s.isRunning).length;
    const aliveSubs = visibleSubs.filter((s) => s.status === 'alive').length;
    $('#subagent-count-badge').textContent = runningSubs > 0
      ? `${runningSubs} 运行中 / 共 ${visibleSubs.length}`
      : aliveSubs > 0
      ? `${aliveSubs} 待命 / 共 ${visibleSubs.length}`
      : `共 ${visibleSubs.length} 个`;
    $('#subagent-count-badge').className = `badge-pill ${runningSubs > 0 ? 'running' : aliveSubs > 0 ? 'alive' : ''}`;

    const subsEl = $('#subagents-list');
    if (!visibleSubs.length) {
      subsEl.innerHTML = `<div class="card-sub">当前范围内暂无子智能体记录</div>`;
    } else {
      subsEl.innerHTML = visibleSubs
        .slice(0, 10)
        .map(
          (s) => `
          <div class="sub-item" data-jump-sub="${escapeHtml(s.id)}">
            <div class="sub-top">
              <span class="sub-role">${escapeHtml(s.role)}</span>
              <span class="badge-pill ${s.status === 'running' ? 'running' : s.status === 'alive' ? 'alive' : ''}">${s.statusLabel}</span>
            </div>
            <div class="sub-meta tabular">
              <span class="sub-tags">
                <span class="type-tag">${escapeHtml(s.typeName)}</span>
                <span>${escapeHtml(s.workspace)} · ${escapeHtml(s.parentTitle)}</span>
              </span>
              <span>${s.stepCount} 步 · ${formatCompact(s.totalTokens)} · ${formatRelativeTime(s.lastActiveMs)}</span>
            </div>
          </div>
        `,
        )
        .join('');
    }

    // 4. Project-Level Overall Statistics & Model Breakdown
    const ov = telemetry.overallUsage;
    $('#overall-total-tokens').textContent = formatNumber(ov.totalTokens);
    $('#overall-total-cost').textContent = `≈ $${ov.costUsd.toFixed(2)} 参考`;
    $('#sum-cache').textContent = formatCompact(ov.cacheRead);
    $('#sum-uncached').textContent = formatCompact(ov.uncachedInput);
    $('#sum-output').textContent = formatCompact(ov.output);

    document.querySelectorAll('#usage-range-group .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === ov.range);
    });

    const projs = telemetry.projects || [];
    const projEl = $('#projects-list');
    if (!projs.length) {
      projEl.innerHTML = `<div class="card-sub">当前时间范围内暂无项目 Token 统计</div>`;
    } else {
      projEl.innerHTML = projs
        .map((p) => {
          const isCur = p.isCurrentProject || p.name === projectFilter;
          const ratioSegs = p.models
            .map((m) => `<span style="width:${Math.max(2, m.sharePercent)}%;background:${m.color}" title="${escapeHtml(m.displayName)} ${m.sharePercent}%"></span>`)
            .join('');
          const legend = p.models
            .slice(0, 4)
            .map(
              (m) => `
              <span>
                <i class="ratio-swatch" style="background:${m.color}"></i>
                ${escapeHtml(m.displayName.replace(/^gemini-/, 'g-'))} <strong>${m.sharePercent.toFixed(0)}%</strong>
              </span>
            `,
            )
            .join('');
          return `
            <div class="proj-card ${isCur ? 'is-current' : ''}" data-pick-project="${escapeHtml(p.name)}">
              <div class="proj-head">
                <span class="proj-name">
                  <span>${escapeHtml(p.name)}</span>
                  ${p.runningCount > 0 ? `<span class="badge-pill running">${p.runningCount} 运行中</span>` : ''}
                </span>
                <span class="proj-nums tabular"><strong>${formatCompact(p.totalTokens)}</strong> · ≈$${p.costUsd.toFixed(2)}</span>
              </div>
              <div class="proj-sub tabular">
                <span>${p.sessionCount} 主会话 · ${p.subagentCount} 子智能体</span>
                <span>缓存命中 ${p.cacheHitRate.toFixed(1)}%</span>
              </div>
              <div class="ratio-bar" style="margin-bottom:4px">${ratioSegs}</div>
              <div class="proj-models-inline tabular">${legend}</div>
            </div>
          `;
        })
        .join('');
    }
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
    const follow = tel.followLatest !== false;
    // Always re-read window.sidecar.conversationId in case host updated it
    const liveHostConv = window.sidecar?.conversationId || hostConversationId || '';
    if (liveHostConv) hostConversationId = liveHostConv;

    const params = new URLSearchParams({
      followLatest: String(follow),
      range: tel.range || 'today',
      windowLimit: String(tel.windowLimit || 512000),
      includeSubagents: String(includeSubagents),
    });
    if (hostConversationId) params.set('hostConversationId', hostConversationId);
    if (activeWorkspaceUri) params.set('activeWorkspaceUri', activeWorkspaceUri);
    if (projectFilter) params.set('projectFilter', projectFilter);
    if (!follow && manualConversationId) params.set('conversationId', manualConversationId);

    const res = await apiFetch(`/api/telemetry?${params.toString()}`, { method: 'GET' });
    if (!res.ok) return;
    telemetry = await res.json();
    renderCockpit();
  }

  async function toggleCompanion() {
    const isRunning = Boolean(appState?.companion?.running && appState?.settings?.companion?.enabled);
    const action = isRunning ? 'stop' : 'start';
    showToast(action === 'start' ? '正在开启星光滤色整窗伴侣...' : '正在关闭整窗伴侣...');
    const res = await apiFetch('/api/companion', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      appState = await res.json();
      renderStudio();
      showToast(appState.companion?.running ? '整窗氛围伴侣已开启 ✨' : '整窗氛围伴侣已关闭');
    }
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
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

    $('#btn-top-companion').addEventListener('click', toggleCompanion);
    $('#btn-toggle-companion').addEventListener('click', toggleCompanion);

    $('#btn-refresh').addEventListener('click', async () => {
      await Promise.all([loadState(), loadTelemetry()]);
      showToast('数据已刷新');
    });

    // Follow toggle
    $('#btn-follow-latest').addEventListener('click', async () => {
      const next = !(appState.settings.telemetry?.followLatest !== false);
      if (next) {
        projectFilter = '';
        manualConversationId = '';
      }
      await queueSaveSettings({ telemetry: { followLatest: next } }, true);
      await loadTelemetry();
      showToast(next ? '已开启自动跟随当前会话' : '已切换为手动查看模式');
    });

    // Project switcher
    $('#select-project').addEventListener('change', async (e) => {
      projectFilter = e.target.value;
      if (projectFilter) {
        await queueSaveSettings({ telemetry: { followLatest: false } }, true);
        await loadTelemetry();
        const firstConv = telemetry?.conversations?.[0];
        if (firstConv) {
          manualConversationId = firstConv.id;
          await loadTelemetry();
        }
      } else {
        manualConversationId = '';
        await queueSaveSettings({ telemetry: { followLatest: true } }, true);
        await loadTelemetry();
      }
    });

    // Conversation switcher
    $('#select-conversation').addEventListener('change', async (e) => {
      manualConversationId = e.target.value;
      await queueSaveSettings({ telemetry: { followLatest: false } }, true);
      await loadTelemetry();
    });

    // Jump to selected conversation in Antigravity main window
    $('#btn-jump-conv').addEventListener('click', () => {
      const targetId = $('#select-conversation').value || telemetry?.activeConversation?.id;
      if (targetId && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(targetId);
        showToast('已在主窗口切换至该会话');
      }
    });

    // Include subagents toggle in current session ratio
    $('#chk-include-subagents').addEventListener('change', async (e) => {
      includeSubagents = e.target.checked;
      await loadTelemetry();
    });

    $('#window-limit-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { windowLimit: Number(btn.dataset.limit) } }, true);
      await loadTelemetry();
    });

    // Quota budget editor
    $('#btn-quota-settings').addEventListener('click', () => {
      const box = $('#quota-budget-editor');
      box.hidden = !box.hidden;
    });

    $('#btn-save-budgets').addEventListener('click', async () => {
      const g5h = Math.max(1, Number($('#inp-g5h').value) || 60) * 1_000_000;
      const g7d = Math.max(10, Number($('#inp-g7d').value) || 500) * 1_000_000;
      const c5h = Math.max(1, Number($('#inp-c5h').value) || 15) * 1_000_000;
      const c7d = Math.max(10, Number($('#inp-c7d').value) || 120) * 1_000_000;
      await queueSaveSettings({ quotaBudgets: { gemini5h: g5h, gemini7d: g7d, claude5h: c5h, claude7d: c7d } }, true);
      $('#quota-budget-editor').hidden = true;
      await loadTelemetry();
      showToast('已更新参考额度上限');
    });

    // Subagent scope & click jump
    $('#subagent-scope-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      subagentScope = btn.dataset.subscope;
      renderCockpit();
    });

    $('#subagents-list').addEventListener('click', async (e) => {
      const item = e.target.closest('[data-jump-sub]');
      if (!item) return;
      const subId = item.dataset.jumpSub;
      if (window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(subId);
        showToast('已打开该子智能体对话');
      }
      manualConversationId = subId;
      await queueSaveSettings({ telemetry: { followLatest: false } }, true);
      await loadTelemetry();
    });

    // Project overall stats time range & click filter
    $('#usage-range-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { range: btn.dataset.range } }, true);
      await loadTelemetry();
    });

    $('#projects-list').addEventListener('click', async (e) => {
      const card = e.target.closest('[data-pick-project]');
      if (!card) return;
      const name = card.dataset.pickProject;
      projectFilter = projectFilter === name ? '' : name;
      if (projectFilter) {
        await queueSaveSettings({ telemetry: { followLatest: false } }, true);
        await loadTelemetry();
        const firstConv = telemetry?.conversations?.[0];
        if (firstConv) {
          manualConversationId = firstConv.id;
          await loadTelemetry();
        }
        showToast(`已切换至项目「${projectFilter}」`);
      } else {
        manualConversationId = '';
        await queueSaveSettings({ telemetry: { followLatest: true } }, true);
        await loadTelemetry();
        showToast('已恢复查看全部项目');
      }
    });

    // Studio bindings
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

    $('#btn-save-preset').addEventListener('click', async () => {
      const name = $('#input-preset-name').value.trim();
      if (!name) return showToast('请先输入方案名称');
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

    $('#color-pickers').addEventListener('input', (e) => {
      const input = e.target.closest('input[type="color"]');
      if (!input) return;
      const key = input.dataset.colorKey;
      const hex = input.value.toUpperCase();
      input.closest('.color-cell').querySelector('.color-cell-hex').textContent = hex;
      queueSaveSettings({ presetId: 'custom', colors: { [key]: hex } }, false);
    });

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
    $('#file-wallpaper').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) return showToast('图片不能超过 15MB');
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
    bindSlider('#range-comp-opacity', '#val-comp-opacity', '%', (v) => ({ companion: { opacity: v } }));
    bindSlider('#range-comp-vignette', '#val-comp-vignette', '%', (v) => ({ companion: { vignette: v } }));
    bindSlider('#range-comp-blur', '#val-comp-blur', 'px', (v) => ({ companion: { blur: v } }));

    $('#wp-fit-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      queueSaveSettings({ wallpaper: { fit: btn.dataset.fit }, companion: { fit: btn.dataset.fit } }, true);
    });

    $('#chk-comp-seamless').addEventListener('change', (e) => {
      queueSaveSettings({ companion: { seamlessRightPane: e.target.checked } }, true);
    });
    $('#chk-comp-rim').addEventListener('change', (e) => {
      queueSaveSettings({ companion: { glassRim: e.target.checked } }, true);
    });
    $('#chk-comp-frontmost').addEventListener('change', (e) => {
      queueSaveSettings({ companion: { onlyWhenFrontmost: e.target.checked } }, true);
    });
    $('#comp-blend-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      queueSaveSettings({ companion: { blendStyle: btn.dataset.blend } }, true);
    });
  }

  async function init() {
    bindEvents();
    if (window.sidecar?.getWorkspaceUris) {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        if (Array.isArray(uris) && uris.length > 0) activeWorkspaceUri = uris[0];
      } catch {
        // ignore
      }
    }
    await loadState();
    await loadTelemetry();
    setInterval(loadTelemetry, 3500);
  }

  init().catch((err) => {
    console.error('[prism_studio] init failed:', err);
  });
})();
