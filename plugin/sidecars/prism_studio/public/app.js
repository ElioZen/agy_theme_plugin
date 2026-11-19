(() => {
  const COLOR_CHANNELS = [
    { key: 'accent', label: '主强调色' },
    { key: 'secondary', label: '次折射色' },
    { key: 'tertiary', label: '状态点缀' },
    { key: 'canvas', label: '画布底色' },
    { key: 'surface', label: '顶栏玻璃' },
    { key: 'card', label: '卡片玻璃' },
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
          renderWorkbench();
        }
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
    };
    if (immediate) run();
    else saveTimer = setTimeout(run, 160);
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
          <div class="color-cell-info">
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

    // Wallpaper sliders
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
    $('#range-comp-opacity').value = comp.opacity ?? 26;
    $('#val-comp-opacity').textContent = `${comp.opacity ?? 26}%`;
    $('#range-comp-vignette').value = comp.vignette ?? 28;
    $('#val-comp-vignette').textContent = `${comp.vignette ?? 28}%`;
    $('#range-comp-blur').value = comp.blur ?? 0;
    $('#val-comp-blur').textContent = `${comp.blur ?? 0}px`;
    $('#chk-comp-rim').checked = comp.glassRim !== false;
    $('#chk-comp-frontmost').checked = comp.onlyWhenFrontmost !== false;

    const badge = $('#companion-status-badge');
    const toggleBtn = $('#btn-toggle-companion');
    const topBtn = $('#btn-top-companion');
    const errEl = $('#companion-error');
    badge.classList.remove('running', 'warn');

    const isCompanionActive = Boolean(companion?.running && comp.enabled);
    topBtn.classList.toggle('active', isCompanionActive);

    if (!companion?.supported) {
      badge.textContent = '仅支持 macOS';
      toggleBtn.disabled = true;
      toggleBtn.textContent = '当前系统不支持';
    } else if (companion.status === 'compiling') {
      badge.textContent = '编译中...';
      badge.classList.add('warn');
      toggleBtn.textContent = '正在准备...';
    } else if (isCompanionActive) {
      badge.textContent = '● 运行中 · 已覆盖整窗';
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
  }

  // ==================== RENDER: WORKBENCH ====================
  function renderWorkbench() {
    if (!appState) return;
    const settings = appState.settings;
    const convs = telemetry?.conversations || [];
    const activeConv = telemetry?.activeConversation;
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
      .slice(0, 12);

    $('#sessions-list').innerHTML = sortedConvs.length
      ? sortedConvs
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
          .join('')
      : `<div class="card-sub">暂无本地会话</div>`;

    const prompts = settings.quickPrompts || [];
    $('#prompts-list').innerHTML = prompts.length
      ? prompts
          .map(
            (p) => `
          <div class="prompt-item">
            <div class="prompt-info">
              <div class="prompt-title">${escapeHtml(p.title)}</div>
              <div class="prompt-body">${escapeHtml(p.body)}</div>
            </div>
            <div class="prompt-actions">
              <button type="button" class="ghost-btn" data-send-prompt="${escapeHtml(p.id)}">发送</button>
              <button type="button" class="icon-pill" data-del-prompt="${escapeHtml(p.id)}" title="删除">×</button>
            </div>
          </div>
        `,
          )
          .join('')
      : `<div class="card-sub">暂无常用指令，可在下方添加</div>`;
  }

  // ==================== DATA FETCHING ====================
  async function loadState() {
    const res = await apiFetch('/api/state', { method: 'GET' });
    if (!res.ok) throw new Error('Failed to load state');
    appState = await res.json();
    renderStudio();
    renderWorkbench();
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
    if (selectedConversationId) params.set('conversationId', selectedConversationId);
    const res = await apiFetch(`/api/telemetry?${params.toString()}`, { method: 'GET' });
    if (!res.ok) return;
    telemetry = await res.json();
    if (tel.followLatest !== false && telemetry.activeConversation?.id) {
      selectedConversationId = telemetry.activeConversation.id;
    }
    renderCockpit();
    renderWorkbench();
  }

  async function toggleCompanion() {
    const isRunning = Boolean(appState?.companion?.running && appState?.settings?.companion?.enabled);
    const action = isRunning ? 'stop' : 'start';
    showToast(action === 'start' ? '正在开启整窗氛围伴侣...' : '正在关闭整窗氛围伴侣...');
    const res = await apiFetch('/api/companion', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      appState = await res.json();
      renderStudio();
      showToast(appState.companion?.running ? '整窗氛围伴侣已覆盖整个窗口 ✨' : '整窗氛围伴侣已关闭');
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

    // Studio: Palettes & Colors
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

    // Studio: Wallpapers
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

    $('#chk-comp-rim').addEventListener('change', (e) => {
      queueSaveSettings({ companion: { glassRim: e.target.checked } }, true);
    });

    $('#chk-comp-frontmost').addEventListener('change', (e) => {
      queueSaveSettings({ companion: { onlyWhenFrontmost: e.target.checked } }, true);
    });

    // Workbench: Sessions
    $('#sessions-list').addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('[data-pin-conv]');
      if (pinBtn) {
        e.stopPropagation();
        const res = await apiFetch('/api/pin', {
          method: 'POST',
          body: JSON.stringify({ conversationId: pinBtn.dataset.pinConv }),
        });
        if (res.ok) {
          appState = await res.json();
          renderWorkbench();
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

    // Workbench: Start new conversation
    $('#btn-start-conv').addEventListener('click', async () => {
      const msg = $('#input-new-conv').value.trim();
      if (!msg) return showToast('请输入新对话的任务内容');
      const model = $('#select-new-model').value;
      try {
        await apiFetch('/_sidecar/new-conversation', {
          method: 'POST',
          body: JSON.stringify({ message: msg, model }),
        });
        $('#input-new-conv').value = '';
        showToast('已发起新对话');
        setTimeout(loadTelemetry, 1200);
      } catch (err) {
        showToast(`发起失败：${err.message}`);
      }
    });

    // Workbench: Quick Prompts
    $('#prompts-list').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-prompt]');
      if (del) {
        const res = await apiFetch('/api/prompts/delete', {
          method: 'POST',
          body: JSON.stringify({ id: del.dataset.delPrompt }),
        });
        if (res.ok) {
          appState = await res.json();
          renderWorkbench();
          showToast('已删除快捷指令');
        }
        return;
      }
      const send = e.target.closest('[data-send-prompt]');
      if (send) {
        const found = (appState.settings.quickPrompts || []).find((p) => p.id === send.dataset.sendPrompt);
        if (!found) return;
        const targetConvId = selectedConversationId || window.sidecar?.conversationId;
        if (!targetConvId || !window.sidecar?.agent?.sendMessage) {
          return showToast('当前未关联可发送的会话');
        }
        try {
          await window.sidecar.agent.sendMessage(found.body, targetConvId);
          showToast(`已发送「${found.title}」`);
        } catch (err) {
          showToast(`发送失败：${err.message}`);
        }
      }
    });

    $('#btn-save-prompt').addEventListener('click', async () => {
      const title = $('#input-prompt-title').value.trim();
      const body = $('#input-prompt-body').value.trim();
      if (!title || !body) return showToast('请填写指令标题和内容');
      const res = await apiFetch('/api/prompts/save', {
        method: 'POST',
        body: JSON.stringify({ title, body }),
      });
      if (res.ok) {
        appState = await res.json();
        $('#input-prompt-title').value = '';
        $('#input-prompt-body').value = '';
        renderWorkbench();
        showToast(`已添加「${title}」`);
      }
    });
  }

  async function init() {
    bindEvents();
    await loadState();
    await loadTelemetry();
    setInterval(loadTelemetry, 3500);
  }

  init().catch((err) => {
    console.error('[prism_studio] init failed:', err);
  });
})();
