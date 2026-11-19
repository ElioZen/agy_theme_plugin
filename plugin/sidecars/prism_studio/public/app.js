(() => {
  const FRONTEND_VERSION = '3.3.0';
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
  let selectedProjectId = '';
  let manualConversationId = '';
  let currentPage = 'cockpit';
  let modelsExpanded = false;
  let agentsExpanded = false;
  const MAX_COLLAPSED_MODELS = 4;
  const MAX_COLLAPSED_AGENTS = 4;

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
    if (!ms || ms <= 0) return '已重置';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时后重置`;
    if (hours > 0) return `${hours}小时 ${mins}分后重置`;
    return `${Math.max(1, mins)}分钟后重置`;
  }

  function formatRelativeTime(ms) {
    if (!ms) return '—';
    const diff = Math.max(0, Date.now() - ms);
    const sec = Math.floor(diff / 1000);
    if (sec < 30) return '刚刚';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    return `${Math.floor(min / 60)} 小时前`;
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

  function setPage(page) {
    currentPage = page === 'studio' ? 'studio' : 'cockpit';
    $('#page-cockpit').classList.toggle('active', currentPage === 'cockpit');
    $('#page-studio').classList.toggle('active', currentPage === 'studio');
    const btn = $('#btn-page-toggle');
    btn.textContent = currentPage === 'studio' ? '← 返回驾驶舱' : '外观美化';
    btn.classList.toggle('is-in-studio', currentPage === 'studio');
  }

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
        if (appState?.settings?.telemetry?.followLatest !== false) loadTelemetry();
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

  // Always returns a Promise when immediate=true to avoid any state race!
  function queueSaveSettings(patch, immediate = false) {
    if (!appState) return Promise.resolve();
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
    if (immediate) return run();
    saveTimer = setTimeout(run, 150);
    return Promise.resolve();
  }

  // ==================== RENDER: STUDIO ====================
  function renderStudio() {
    if (!appState) return;
    const { settings, builtinPresets, builtinWallpapers, customWallpapers, companion } = appState;
    applyThemeToDOM(settings);

    $('#btn-follow-host').classList.toggle('active', Boolean(settings.followHostTheme));

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
    const errEl = $('#companion-error');
    badge.classList.remove('running', 'warn');

    const isCompanionActive = Boolean(companion?.running && comp.enabled);
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
      toggleBtn.textContent = '关闭整窗氛围';
      toggleBtn.classList.add('is-active-danger');
    } else {
      badge.textContent = companion.binaryReady ? '准备就绪' : '待启动';
      toggleBtn.textContent = '开启整窗氛围';
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
      svg.innerHTML = `<text x="60" y="18" text-anchor="middle" fill="var(--prism-muted)" font-size="9">待采样</text>`;
      return;
    }
    const vals = points.map((p) => p.rate);
    const min = Math.min(...vals);
    const max = Math.max(...vals, min + 1);
    const w = 120;
    const h = 30;
    const padX = 4;
    const padY = 4;

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
      <path d="${lineD}" fill="none" stroke="var(--prism-tertiary)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4" fill="var(--prism-tertiary)" />
    `;
  }

  function renderCockpit() {
    if (!telemetry || !appState) return;
    const telCfg = appState.settings.telemetry || {};
    const activeConv = telemetry.activeConversation;

    $('#btn-follow-latest').classList.toggle('active', Boolean(telCfg.followLatest));

    const projSel = $('#select-project');
    const projects = telemetry.projects || [];
    projSel.innerHTML = projects.length
      ? projects
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}" ${p.id === telemetry.activeProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`,
          )
          .join('')
      : `<option value="">暂无项目</option>`;

    const convSel = $('#select-conversation');
    const convs = telemetry.conversations || [];
    convSel.innerHTML = convs.length
      ? convs
          .map(
            (c) =>
              `<option value="${escapeHtml(c.id)}" ${c.id === activeConv?.id ? 'selected' : ''}>${escapeHtml(c.title)}</option>`,
          )
          .join('')
      : `<option value="">该项目暂无会话</option>`;

    const statusPill = $('#active-status-pill');
    statusPill.textContent = activeConv?.statusLabel || '就绪';
    statusPill.classList.toggle('running', Boolean(activeConv?.isRunning));

    // ========== WINDOW 1: UNIFIED PROJECT & SESSION STATS ==========
    const st = telemetry.stats;
    const scope = st.scope || 'project';
    const srcFilter = st.sourceFilter || 'all';
    const dataBlock = scope === 'session' ? st.session : scope === 'all' ? st.all : st.project;

    document.querySelectorAll('#stats-scope-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.scope === scope);
    });
    document.querySelectorAll('#stats-range-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.range === st.range);
    });
    document.querySelectorAll('#stats-source-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.source === srcFilter);
    });

    const isSessionScope = scope === 'session';
    $('#stats-source-row').style.display = isSessionScope ? 'none' : 'flex';

    if (!isSessionScope) {
      const split = dataBlock.allBySource || dataBlock.bySource || { gui: 0, agyCli: 0, codexCli: 0 };
      $('#src-gui').textContent = formatCompact(split.gui);
      $('#src-agycli').textContent = formatCompact(split.agyCli);
      $('#src-codex').textContent = formatCompact(split.codexCli);
    }

    $('#stats-total-tokens').textContent = formatNumber(dataBlock.totalTokens);
    $('#stats-total-cost').textContent = `≈ $${dataBlock.costUsd.toFixed(2)}`;
    $('#stats-cache-rate').textContent = `缓存 ${dataBlock.cacheHitRate.toFixed(1)}%`;
    $('#sum-cache').textContent = formatCompact(dataBlock.cacheRead);
    $('#sum-uncached').textContent = formatCompact(dataBlock.uncachedInput);
    $('#sum-output').textContent = formatCompact(dataBlock.output);

    const models = dataBlock.models || [];
    if (models.length) {
      $('#stats-ratio-bar').innerHTML = models
        .map(
          (m) =>
            `<span style="width:${Math.max(2, m.sharePercent)}%;background:${m.color}" title="${escapeHtml(m.displayName)} (${m.sourceLabel}) ${m.sharePercent}%"></span>`,
        )
        .join('');
      const visibleModels = modelsExpanded ? models : models.slice(0, MAX_COLLAPSED_MODELS);
      const hiddenModelsCount = Math.max(0, models.length - MAX_COLLAPSED_MODELS);
      $('#stats-models-list').innerHTML =
        visibleModels
          .map((m) => {
            const tot = Math.max(1, m.totalTokens);
            const wCache = (m.cacheRead / tot) * 100;
            const wIn = (m.uncachedInput / tot) * 100;
            const wOut = (m.output / tot) * 100;
            return `
              <div class="model-row">
                <div class="model-row-top">
                  <div class="model-name-wrap">
                    <span class="ratio-swatch" style="background:${m.color}"></span>
                    <span class="model-row-name">${escapeHtml(m.displayName)}</span>
                    <span class="src-badge ${escapeHtml(m.sourceKind)}">${escapeHtml(m.sourceLabel)}</span>
                  </div>
                  <span class="model-row-nums tabular"><strong>${m.sharePercent.toFixed(1)}%</strong> · ${formatCompact(m.totalTokens)}</span>
                </div>
                <div class="stacked-bar">
                  <span style="width:${wCache}%;background:var(--prism-tertiary)"></span>
                  <span style="width:${wIn}%;background:var(--prism-accent)"></span>
                  <span style="width:${wOut}%;background:var(--prism-secondary)"></span>
                </div>
                <div class="model-row-sub tabular">
                  <span>缓存命中 ${m.cacheHitRate.toFixed(1)}% · ${m.turns} 轮</span>
                  <span>输出 ${formatCompact(m.output)} · ≈$${m.costUsd.toFixed(2)}</span>
                </div>
              </div>
            `;
          })
          .join('') +
        (hiddenModelsCount > 0
          ? `<button type="button" class="expand-list-btn" data-toggle-expand="models">${
              modelsExpanded ? '收起模型明细 ▴' : `展开其余 ${hiddenModelsCount} 项模型（共 ${models.length} 项）▾`
            }</button>`
          : '');
    } else {
      $('#stats-ratio-bar').innerHTML = '';
      $('#stats-models-list').innerHTML = `<div class="model-row"><div class="card-sub">当前筛选条件下暂无 Token 记录</div></div>`;
    }

    // ALWAYS-VISIBLE Quick Project Switcher Strip inside Window 1
    const switchStrip = $('#projects-switch-strip');
    if (projects.length > 0) {
      switchStrip.hidden = false;
      switchStrip.innerHTML = projects
        .map((p) => {
          const isSelected = p.id === telemetry.activeProjectId && scope !== 'all';
          return `
            <div class="proj-mini-chip ${isSelected ? 'active' : ''}" data-pick-project-id="${escapeHtml(p.id)}">
              <div class="proj-mini-name">
                <span>${escapeHtml(p.name)}</span>
                ${isSelected ? `<span class="badge-pill running" style="padding:1px 5px;font-size:9.5px">当前</span>` : ''}
              </div>
              <div class="proj-mini-val tabular">${formatCompact(p.totalTokens)} · 缓存 ${p.cacheHitRate.toFixed(0)}%</div>
            </div>
          `;
        })
        .join('');
    } else {
      switchStrip.hidden = true;
    }

    // ========== WINDOW 2: QUOTA MONITOR (Official Usage style: remaining %, used %, reset timer, ring) ==========
    const q = telemetry.quotas;
    const renderQuotaRing = (leftPct) => {
      const r = 8.5;
      const circ = 2 * Math.PI * r;
      const hasVal = typeof leftPct === 'number';
      const pct = hasVal ? Math.max(0, Math.min(100, leftPct)) : 0;
      const dashOffset = circ * (1 - pct / 100);
      const stroke = !hasVal
        ? 'rgba(255,255,255,0.22)'
        : pct <= 15
        ? '#f87171'
        : pct <= 35
        ? 'var(--prism-secondary)'
        : 'var(--prism-tertiary)';
      return `
        <svg class="quota-mini-ring" viewBox="0 0 22 22">
          <circle class="track" cx="11" cy="11" r="${r}" />
          <circle class="fill" cx="11" cy="11" r="${r}" stroke="${stroke}" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" />
        </svg>
      `;
    };

    const renderQuotaBox = (group) => {
      const renderItem = (title, win) => {
        const a = win.anchor;
        const leftPct = a ? Math.round(a.leftPct) : null;
        const usedPct = a ? Math.max(0, 100 - leftPct) : null;
        const resetLine = a
          ? a.resetAtMs
            ? formatCountdown(a.resetInMs)
            : leftPct === 100
            ? '已满额'
            : '未填刷新时间'
          : '点右上角校准';
        return `
          <div class="quota-item">
            <div class="quota-left">
              <span class="quota-name">${title}</span>
              <span class="quota-reset tabular">${resetLine}</span>
            </div>
            <div class="quota-right">
              <div class="quota-pct-col tabular">
                <span class="quota-pct-main">${leftPct !== null ? `${leftPct}% 剩余` : '—% 剩余'}</span>
                <span class="quota-pct-used">${usedPct !== null ? `已用 ${usedPct}%` : `总 100%`}</span>
              </div>
              ${renderQuotaRing(leftPct)}
            </div>
          </div>
        `;
      };
      return `
        <div class="quota-box">
          <div class="quota-head">${group.label}</div>
          ${renderItem('每周限额', group.d7)}
          ${renderItem('5小时限额', group.h5)}
        </div>
      `;
    };
    $('#quota-grid').innerHTML = renderQuotaBox(q.gemini) + renderQuotaBox(q.claude);

    // ========== WINDOW 3: STANDALONE REAL-TIME CONTEXT ==========
    const ctx = telemetry.context;
    const circumference = 2 * Math.PI * 48;
    const offset = circumference * (1 - Math.min(100, ctx.percent) / 100);
    $('#ring-progress').style.strokeDashoffset = String(offset.toFixed(2));
    $('#ring-percent').textContent = `${ctx.percent.toFixed(ctx.percent >= 10 ? 0 : 1)}%`;
    $('#ctx-used').textContent = formatNumber(ctx.used);
    $('#ctx-limit').textContent = formatNumber(ctx.limit);

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

    const spd = ctx.speed;
    $('#ctx-model-badge').textContent = spd.model || '—';
    $('#ctx-effort-badge').textContent = spd.effort || '—';
    $('#metric-speed').textContent = spd.latest ? spd.latest.toFixed(1) : '—';
    renderSparkline(spd.sparkline);

    // ========== WINDOW 4: ACTIVE CLI & SUBAGENT LIVE MONITOR ==========
    const ag = telemetry.activeAgents;
    const badge = $('#active-agents-badge');
    badge.textContent = ag.runningCount > 0 ? `${ag.runningCount} 运行中` : `${ag.items.length} 活动中`;
    badge.className = `badge-pill ${ag.runningCount > 0 ? 'running' : ''}`;

    const recentBtn = $('#btn-toggle-recent-agents');
    recentBtn.textContent = ag.showRecent ? '仅看活动中' : `近期 1h (${ag.recentHiddenCount})`;

    const listEl = $('#agents-list');
    if (!ag.items.length) {
      listEl.innerHTML = `
        <div class="empty-agents">
          当前暂无运行中的 CLI 或子智能体${ag.recentHiddenCount > 0 ? `（可点右上角查看近期 1h 的 ${ag.recentHiddenCount} 个记录）` : ''}
        </div>
      `;
    } else {
      const visibleAgents = agentsExpanded ? ag.items : ag.items.slice(0, MAX_COLLAPSED_AGENTS);
      const hiddenAgentsCount = Math.max(0, ag.items.length - MAX_COLLAPSED_AGENTS);
      listEl.innerHTML =
        visibleAgents
          .map((a) => {
            const isCodex = a.kind === 'codex-cli';
            const clickAttr = a.clickableConvId ? `data-jump-agent="${escapeHtml(a.clickableConvId)}"` : '';
            return `
              <div class="agent-card ${a.isRunning ? 'is-running' : ''} ${a.clickableConvId ? 'clickable' : ''}" ${clickAttr}>
                <div class="agent-top">
                  <div class="agent-id-group">
                    <span class="source-tag ${isCodex ? 'codex' : ''}">${escapeHtml(a.kindLabel)}</span>
                    <span class="agent-action">${escapeHtml(a.activity)}</span>
                  </div>
                  <span class="badge-pill ${a.isRunning ? 'running' : ''}">${escapeHtml(a.projectName)} · ${a.isRunning ? '运行中' : formatRelativeTime(a.lastActiveMs)}</span>
                </div>
                <div class="agent-metrics-grid tabular">
                  <div class="agent-kv">
                    <span>当前模型</span>
                    <strong>${escapeHtml(a.model)}</strong>
                  </div>
                  <div class="agent-kv">
                    <span>思考强度</span>
                    <strong>${escapeHtml(a.effort)}</strong>
                  </div>
                  <div class="agent-kv">
                    <span>Token 消耗</span>
                    <strong>${formatCompact(a.totalTokens)} (${a.cacheHitRate}% 缓)</strong>
                  </div>
                </div>
              </div>
            `;
          })
          .join('') +
        (hiddenAgentsCount > 0
          ? `<button type="button" class="expand-list-btn" data-toggle-expand="agents">${
              agentsExpanded ? '收起列表 ▴' : `展开其余 ${hiddenAgentsCount} 项（共 ${ag.items.length} 项）▾`
            }</button>`
          : '');
    }
  }

  // ==================== DATA FETCHING ====================
  async function loadState() {
    const res = await apiFetch('/api/state', { method: 'GET' });
    if (!res.ok) throw new Error('Failed to load state');
    const next = await res.json();
    // Auto-reload stale open iframes when plugin frontend version upgrades
    if (next.assetVersion && next.assetVersion !== FRONTEND_VERSION) {
      window.location.reload();
      return;
    }
    appState = next;
    renderStudio();
  }

  async function loadTelemetry() {
    if (!appState) return;
    const tel = appState.settings.telemetry || {};
    const follow = tel.followLatest !== false;
    const liveHostConv = window.sidecar?.conversationId || hostConversationId || '';
    if (liveHostConv) hostConversationId = liveHostConv;

    const params = new URLSearchParams({
      followLatest: String(follow),
      statsScope: tel.statsScope || 'project',
      sourceFilter: tel.sourceFilter || 'all',
      range: tel.range || 'today',
      windowLimit: String(tel.windowLimit || 512000),
      showRecentAgents: String(Boolean(tel.showRecentAgents)),
    });
    if (hostConversationId) params.set('hostConversationId', hostConversationId);
    if (activeWorkspaceUri) params.set('activeWorkspaceUri', activeWorkspaceUri);
    if (!follow && selectedProjectId) params.set('selectedProjectId', selectedProjectId);
    if (!follow && manualConversationId) params.set('conversationId', manualConversationId);

    const res = await apiFetch(`/api/telemetry?${params.toString()}`, { method: 'GET' });
    if (!res.ok) return;
    telemetry = await res.json();
    if (follow) selectedProjectId = telemetry.activeProjectId || '';
    renderCockpit();
  }

  async function toggleCompanion() {
    const isRunning = Boolean(appState?.companion?.running && appState?.settings?.companion?.enabled);
    const action = isRunning ? 'stop' : 'start';
    showToast(action === 'start' ? '正在开启星光滤色整窗氛围...' : '正在关闭整窗氛围...');
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
    $('#btn-page-toggle').addEventListener('click', () => {
      setPage(currentPage === 'cockpit' ? 'studio' : 'cockpit');
    });

    $('#btn-refresh').addEventListener('click', async () => {
      await Promise.all([loadState(), loadTelemetry()]);
      showToast('已刷新');
    });

    $('#btn-follow-latest').addEventListener('click', async () => {
      const next = !(appState.settings.telemetry?.followLatest !== false);
      if (next) {
        selectedProjectId = '';
        manualConversationId = '';
      }
      await queueSaveSettings({ telemetry: { followLatest: next } }, true);
      await loadTelemetry();
      showToast(next ? '已跟随当前会话与项目' : '已切为手动选择');
    });

    $('#select-project').addEventListener('change', async (e) => {
      selectedProjectId = e.target.value;
      manualConversationId = '';
      await queueSaveSettings({ telemetry: { followLatest: false, statsScope: 'project' } }, true);
      await loadTelemetry();
    });

    $('#select-conversation').addEventListener('change', async (e) => {
      manualConversationId = e.target.value;
      await queueSaveSettings({ telemetry: { followLatest: false } }, true);
      await loadTelemetry();
    });

    $('#btn-jump-conv').addEventListener('click', () => {
      const targetId = $('#select-conversation').value || telemetry?.activeConversation?.id;
      if (targetId && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(targetId);
        showToast('已在主窗口切换至该会话');
      }
    });

    // Window 1 controls
    $('#stats-scope-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { statsScope: btn.dataset.scope } }, true);
      await loadTelemetry();
    });

    $('#stats-range-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { range: btn.dataset.range } }, true);
      await loadTelemetry();
    });

    $('#stats-source-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { sourceFilter: btn.dataset.source } }, true);
      await loadTelemetry();
    });

    // Quick Project Switcher Strip (fixed promise sequencing — switches active highlight immediately!)
    $('#projects-switch-strip').addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-pick-project-id]');
      if (!chip) return;
      selectedProjectId = chip.dataset.pickProjectId;
      manualConversationId = '';
      await queueSaveSettings({ telemetry: { followLatest: false, statsScope: 'project' } }, true);
      await loadTelemetry();
    });

    // Window 2: Quota Anchor controls
    $('#btn-quota-anchor').addEventListener('click', () => {
      const box = $('#quota-anchor-editor');
      box.hidden = !box.hidden;
      if (!box.hidden && appState?.settings?.quotaAnchor) {
        const qa = appState.settings.quotaAnchor;
        const setVal = (id, v) => { if (v !== null && v !== undefined) $(id).value = v; };
        setVal('#inp-g7d-pct', qa.gemini7d?.leftPct);
        setVal('#inp-g5h-pct', qa.gemini5h?.leftPct);
        setVal('#inp-c7d-pct', qa.claude7d?.leftPct);
        setVal('#inp-c5h-pct', qa.claude5h?.leftPct);
      }
    });

    $('#btn-save-anchor').addEventListener('click', async () => {
      const payload = {
        g7dPct: $('#inp-g7d-pct').value,
        g7dReset: $('#inp-g7d-reset').value,
        g5hPct: $('#inp-g5h-pct').value,
        g5hReset: $('#inp-g5h-reset').value,
        c7dPct: $('#inp-c7d-pct').value,
        c7dReset: $('#inp-c7d-reset').value,
        c5hPct: $('#inp-c5h-pct').value,
        c5hReset: $('#inp-c5h-reset').value,
      };
      const res = await apiFetch('/api/quota-anchor', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        appState = await res.json();
        $('#quota-anchor-editor').hidden = true;
        await loadTelemetry();
        showToast('已同步官方剩余额度并开启实时倒计时');
      }
    });

    $('#btn-clear-anchor').addEventListener('click', async () => {
      const res = await apiFetch('/api/quota-anchor', {
        method: 'POST',
        body: JSON.stringify({ clear: true }),
      });
      if (res.ok) {
        appState = await res.json();
        $('#quota-anchor-editor').hidden = true;
        await loadTelemetry();
        showToast('已清除同步快照，恢复纯本地统计');
      }
    });

    // Window 3: Context controls
    $('#window-limit-group').addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      await queueSaveSettings({ telemetry: { windowLimit: Number(btn.dataset.limit) } }, true);
      await loadTelemetry();
    });

    // Window 4: Active CLI & Subagent controls
    $('#btn-toggle-recent-agents').addEventListener('click', async () => {
      const next = !Boolean(appState.settings.telemetry?.showRecentAgents);
      await queueSaveSettings({ telemetry: { showRecentAgents: next } }, true);
      await loadTelemetry();
    });

    // Expand / collapse handlers for models & active agents lists
    $('#stats-models-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle-expand="models"]');
      if (!btn) return;
      modelsExpanded = !modelsExpanded;
      renderCockpit();
    });

    $('#agents-list').addEventListener('click', async (e) => {
      const expBtn = e.target.closest('[data-toggle-expand="agents"]');
      if (expBtn) {
        agentsExpanded = !agentsExpanded;
        renderCockpit();
        return;
      }
      const card = e.target.closest('[data-jump-agent]');
      if (!card) return;
      const cid = card.dataset.jumpAgent;
      if (cid && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(cid);
        showToast('已打开该子智能体');
      }
    });

    // Studio bindings
    $('#btn-toggle-companion').addEventListener('click', toggleCompanion);
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
    setPage('cockpit');
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
    setInterval(loadTelemetry, 3000);
  }

  init().catch((err) => {
    console.error('[prism_studio] init failed:', err);
  });
})();
