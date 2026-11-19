(() => {
  const FRONTEND_VERSION = '3.5.4';
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
  let overviewExpanded = false;
  let agentsExpanded = false;
  let statsLevel = 'overview'; // 'overview' | 'detail'
  let statsChart = 'donut'; // 'donut' | 'bar'
  let statsMetric = 'tokens'; // 'tokens' | 'calls'
  let drilledModel = '';
  let lastOverviewGroups = [];
  let lastOverviewTotals = { tokens: 0, turns: 0 };
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
    if (num >= 1_000_000_000_000) return `${(num / 1_000_000_000_000).toFixed(2)}T`;
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
    return String(num);
  }

  function formatDurationSec(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }

  function formatClockTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
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

  function formatDurationShort(ms) {
    if (!ms || ms <= 0) return '即将';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m`;
    const hours = ms / 3600000;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  }

  // ==================== WALLPAPER ADAPTIVE PALETTE EXTRACTOR ====================
  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      else if (max === gn) h = ((bn - rn) / d + 2) / 6;
      else h = ((rn - gn) / d + 4) / 6;
    }
    return [h * 360, s, l];
  }

  function hslToHex(h, s, l) {
    const hn = (((h % 360) + 360) % 360) / 360;
    const sn = Math.max(0, Math.min(1, s));
    const ln = Math.max(0, Math.min(1, l));
    const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
    const p = 2 * ln - q;
    const hue2rgb = (t) => {
      let tn = t;
      if (tn < 0) tn += 1;
      if (tn > 1) tn -= 1;
      if (tn < 1 / 6) return p + (q - p) * 6 * tn;
      if (tn < 1 / 2) return q;
      if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
      return p;
    };
    const r = Math.round(hue2rgb(hn + 1 / 3) * 255);
    const g = Math.round(hue2rgb(hn) * 255);
    const b = Math.round(hue2rgb(hn - 1 / 3) * 255);
    return (
      '#' +
      [r, g, b]
        .map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    );
  }

  function hueDistance(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function extractPaletteFromUrl(url, lightMode = false) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const w = 72;
          const h = 40;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, w, h);

          // 18 hue bins (20 deg each) weighted by colorfulness and mid-tone luminance
          const bins = Array.from({ length: 18 }, (_, i) => ({
            idx: i,
            weight: 0,
            sumH: 0,
            sumS: 0,
            sumL: 0,
          }));
          let avgH = 220;
          let maxW = 0;

          for (let i = 0; i < data.length; i += 4) {
            const [hu, sat, lum] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
            if (lum < 0.10 || lum > 0.90 || sat < 0.14) continue;
            const lumWeight = 1 - Math.abs(lum - 0.52) * 1.45;
            const weight = Math.max(0.05, sat * sat * Math.max(0.15, lumWeight));
            const bi = Math.floor((hu % 360) / 20) % 18;
            const bin = bins[bi];
            bin.weight += weight;
            bin.sumH += hu * weight;
            bin.sumS += sat * weight;
            bin.sumL += lum * weight;
            if (bin.weight > maxW) {
              maxW = bin.weight;
              avgH = bin.sumH / bin.weight;
            }
          }

          const ranked = bins
            .filter((b) => b.weight > 0.2)
            .map((b) => ({
              h: b.sumH / b.weight,
              s: b.sumS / b.weight,
              l: b.sumL / b.weight,
              weight: b.weight,
            }))
            .sort((a, b) => b.weight - a.weight);

          const primary = ranked[0] || { h: 216, s: 0.78, l: 0.65 };
          const secondary =
            ranked.find((c) => hueDistance(c.h, primary.h) >= 48) || {
              h: (primary.h + 150) % 360,
              s: 0.72,
              l: 0.68,
            };
          const tertiary =
            ranked.find(
              (c) => hueDistance(c.h, primary.h) >= 48 && hueDistance(c.h, secondary.h) >= 44,
            ) || {
              h: (primary.h + 240) % 360,
              s: 0.68,
              l: 0.62,
            };

          const accentS = Math.max(0.58, Math.min(0.88, primary.s * 1.15));
          const secS = Math.max(0.54, Math.min(0.86, secondary.s * 1.1));
          const terS = Math.max(0.50, Math.min(0.82, tertiary.s * 1.05));

          if (lightMode) {
            resolve({
              accent: hslToHex(primary.h, accentS, 0.48),
              secondary: hslToHex(secondary.h, secS, 0.46),
              tertiary: hslToHex(tertiary.h, terS, 0.40),
              canvas: hslToHex(avgH, 0.24, 0.94),
              surface: hslToHex(avgH, 0.22, 0.97),
              card: '#FFFFFF',
            });
          } else {
            resolve({
              accent: hslToHex(primary.h, accentS, 0.70),
              secondary: hslToHex(secondary.h, secS, 0.69),
              tertiary: hslToHex(tertiary.h, terS, 0.60),
              canvas: hslToHex(avgH, 0.28, 0.08),
              surface: hslToHex(avgH, 0.28, 0.12),
              card: hslToHex(avgH, 0.28, 0.16),
            });
          }
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('壁纸图片加载失败'));
      img.src = url;
    });
  }

  let lastAdaptiveKey = '';

  async function applyAdaptiveColorsFromCurrentWallpaper(force = false) {
    const wp = appState?.settings?.wallpaper;
    if (!wp || wp.kind === 'none' || !wp.id) {
      if (force) showToast('当前未启用壁纸');
      return;
    }
    const key = `${wp.kind}:${wp.id}`;
    if (!force && key === lastAdaptiveKey) return;
    lastAdaptiveKey = key;
    const url = `/api/wallpaper?kind=${encodeURIComponent(wp.kind)}&id=${encodeURIComponent(wp.id)}`;
    const lightMode = appState.settings.followHostTheme
      ? hostIsLight
      : isLightColor(appState.settings.colors?.canvas);
    try {
      const palette = await extractPaletteFromUrl(url, lightMode);
      await queueSaveSettings({ presetId: 'adaptive', colors: palette }, true);
      if (force) showToast('已从当前壁纸提取主题色 ✨');
    } catch (err) {
      if (force) showToast(`取色失败：${err.message}`);
    }
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
    const { settings, builtinPresets, builtinWallpapers, customWallpapers, onlineSources, companion } = appState;
    applyThemeToDOM(settings);

    $('#btn-follow-host').classList.toggle('active', Boolean(settings.followHostTheme));
    $('#btn-adaptive-theme').classList.toggle('active', Boolean(settings.adaptiveTheme));

    const srcSelect = $('#select-online-source');
    const sources = Array.isArray(onlineSources) && onlineSources.length
      ? onlineSources
      : [{ id: 'all', label: '全部图库' }];
    const activeOnlineSource = settings.wallpaper?.onlineSource || 'all';
    srcSelect.innerHTML = sources
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}" ${s.id === activeOnlineSource ? 'selected' : ''}>${escapeHtml(s.label)}</option>`,
      )
      .join('');

    const collectBtn = $('#btn-collect-online');
    collectBtn.hidden = settings.wallpaper?.kind !== 'online';

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
    const activeWpLabel =
      wp.kind === 'none'
        ? '已关闭壁纸'
        : wp.kind === 'online'
        ? `${wp.onlineMeta?.name || '在线壁纸'}${wp.onlineMeta?.sourceLabel ? ` · ${wp.onlineMeta.sourceLabel}` : ''}`
        : currentWp?.name || '自定义壁纸';
    $('#active-wallpaper-name').textContent = activeWpLabel;

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
    $('#chk-comp-frontmost').checked = Boolean(comp.onlyWhenFrontmost);

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
    if (drilledModel && !models.some((m) => m.displayName === drilledModel)) {
      drilledModel = '';
    }

    // Aggregate Level-1 overview by model (merging AGY GUI + AGY CLI for same model)
    const groupedMap = new Map();
    for (const m of models) {
      let g = groupedMap.get(m.displayName);
      if (!g) {
        g = {
          displayName: m.displayName,
          color: m.color,
          totalTokens: 0,
          cacheRead: 0,
          uncachedInput: 0,
          output: 0,
          turns: 0,
          costUsd: 0,
          sources: new Set(),
        };
        groupedMap.set(m.displayName, g);
      }
      g.totalTokens += Number(m.totalTokens || 0);
      g.cacheRead += Number(m.cacheRead || 0);
      g.uncachedInput += Number(m.uncachedInput || 0);
      g.output += Number(m.output || 0);
      g.turns += Number(m.turns || 0);
      g.costUsd += Number(m.costUsd || 0);
      if (m.sourceLabel) g.sources.add(m.sourceLabel);
    }

    const grandTokens = Math.max(1, [...groupedMap.values()].reduce((s, x) => s + x.totalTokens, 0));
    const grandTurns = Math.max(1, [...groupedMap.values()].reduce((s, x) => s + x.turns, 0));
    const overviewGroups = [...groupedMap.values()]
      .map((g) => {
        const tot = Math.max(1, g.totalTokens);
        const cachePct = (g.cacheRead / tot) * 100;
        const uncachedPct = (g.uncachedInput / tot) * 100;
        const outputPct = Math.max(0, 100 - cachePct - uncachedPct);
        const promptTot = g.cacheRead + g.uncachedInput;
        return {
          ...g,
          sourceList: [...g.sources],
          tokenSharePct: (g.totalTokens / grandTokens) * 100,
          callSharePct: (g.turns / grandTurns) * 100,
          cachePct,
          uncachedPct,
          outputPct,
          promptCacheHitRate: promptTot > 0 ? (g.cacheRead / promptTot) * 100 : 0,
        };
      })
      .sort((a, b) => (statsMetric === 'calls' ? b.turns - a.turns : b.totalTokens - a.totalTokens));

    lastOverviewGroups = overviewGroups;
    lastOverviewTotals = {
      tokens: [...groupedMap.values()].reduce((s, x) => s + x.totalTokens, 0),
      turns: [...groupedMap.values()].reduce((s, x) => s + x.turns, 0),
    };

    // Sync Level 1 / Level 2 toolbar controls
    const isDrilled = Boolean(drilledModel && statsLevel === 'detail');
    $('#stats-level-group').hidden = isDrilled;
    $('#btn-drill-back').hidden = !isDrilled;
    if (isDrilled) $('#drill-model-label').textContent = drilledModel;

    document.querySelectorAll('#stats-level-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.level === statsLevel);
    });
    document.querySelectorAll('#stats-metric-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.metric === statsMetric);
    });
    document.querySelectorAll('#stats-chart-group .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.chart === statsChart);
    });
    $('#stats-overview-controls').hidden = statsLevel !== 'overview';
    $('#stats-overview-panel').hidden = statsLevel !== 'overview';
    $('#stats-detail-panel').hidden = statsLevel !== 'detail';

    // Render LEVEL 1: Overview (Donut or Comparative Bar + 3-way composition + click to drill down)
    if (statsLevel === 'overview') {
      const ovPanel = $('#stats-overview-panel');
      if (!overviewGroups.length) {
        ovPanel.innerHTML = `<div class="model-row"><div class="card-sub">当前筛选条件下暂无 Token 记录</div></div>`;
      } else {
        const visibleGroups = overviewExpanded ? overviewGroups : overviewGroups.slice(0, MAX_COLLAPSED_MODELS);
        const hiddenCount = Math.max(0, overviewGroups.length - MAX_COLLAPSED_MODELS);
        const maxMetricVal = Math.max(
          1,
          ...overviewGroups.map((g) => (statsMetric === 'calls' ? g.turns : g.totalTokens)),
        );

        const renderOverviewItem = (g, showCompareBar) => {
          const share = statsMetric === 'calls' ? g.callSharePct : g.tokenSharePct;
          const mainVal = statsMetric === 'calls' ? `${formatNumber(g.turns)} 次` : formatCompact(g.totalTokens);
          const subVal = statsMetric === 'calls' ? formatCompact(g.totalTokens) : `${formatNumber(g.turns)} 次`;
          const relWidth =
            ((statsMetric === 'calls' ? g.turns : g.totalTokens) / maxMetricVal) * 100;
          return `
            <div class="overview-model-item" data-drill-model="${escapeHtml(g.displayName)}" data-hover-model="${escapeHtml(g.displayName)}">
              <div class="overview-item-top">
                <div class="overview-item-name">
                  <span class="ratio-swatch" style="background:${g.color}"></span>
                  <span class="name">${escapeHtml(g.displayName)}</span>
                  ${g.sourceList.length > 1 ? `<span class="src-badge">${g.sourceList.length}来源</span>` : ''}
                  <span class="overview-drill-hint">›</span>
                </div>
                <span class="overview-item-nums tabular"><strong>${share.toFixed(1)}%</strong> · ${mainVal}</span>
              </div>
              ${
                showCompareBar
                  ? `<div class="overview-bar-track"><div class="overview-bar-fill" style="width:${Math.max(2, relWidth)}%;background:${g.color}"></div></div>`
                  : ''
              }
              <div class="overview-comp-bar" title="缓存 ${g.cachePct.toFixed(1)}% · 未命中 ${g.uncachedPct.toFixed(1)}% · 输出 ${g.outputPct.toFixed(1)}%">
                <span style="width:${g.cachePct}%;background:var(--prism-tertiary)"></span>
                <span style="width:${g.uncachedPct}%;background:var(--prism-accent)"></span>
                <span style="width:${g.outputPct}%;background:var(--prism-secondary)"></span>
              </div>
              <div class="overview-comp-meta tabular">
                <span class="overview-comp-pcts">
                  <span class="c-cache">缓 ${g.cachePct.toFixed(1)}%</span>
                  <span class="c-in">新 ${g.uncachedPct.toFixed(1)}%</span>
                  <span class="c-out">出 ${g.outputPct.toFixed(1)}%</span>
                </span>
                <span>${subVal}</span>
              </div>
            </div>
          `;
        };

        const expandBtnHtml =
          hiddenCount > 0
            ? `<button type="button" class="expand-list-btn" data-toggle-expand="overview">${
                overviewExpanded
                  ? '收起模型列表 ▴'
                  : `展开其余 ${hiddenCount} 个模型（共 ${overviewGroups.length} 个）▾`
              }</button>`
            : '';

        if (statsChart === 'donut') {
          const radius = 46;
          const circ = 2 * Math.PI * radius;
          const gap = overviewGroups.length > 1 ? 2.2 : 0;
          let acc = 0;
          const arcsHtml = overviewGroups
            .map((g) => {
              const frac = Math.max(0, (statsMetric === 'calls' ? g.callSharePct : g.tokenSharePct) / 100);
              const rawLen = frac * circ;
              const segLen = Math.max(rawLen > 0 ? 1.8 : 0, rawLen - gap);
              const offset = -acc;
              acc += rawLen;
              return `<circle class="donut-slice" cx="62" cy="62" r="${radius}" stroke="${g.color}" style="color:${g.color}" stroke-dasharray="${segLen.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 62 62)" data-drill-model="${escapeHtml(g.displayName)}" data-hover-model="${escapeHtml(g.displayName)}"><title>${escapeHtml(g.displayName)} · ${(frac * 100).toFixed(1)}% · ${formatCompact(g.totalTokens)}</title></circle>`;
            })
            .join('');

          const centerVal =
            statsMetric === 'calls'
              ? `${formatNumber(lastOverviewTotals.turns)} 次`
              : formatCompact(lastOverviewTotals.tokens);
          const centerSub = `${overviewGroups.length} 个模型`;

          ovPanel.innerHTML = `
            <div class="overview-donut-layout">
              <div class="donut-wrap">
                <svg class="overview-donut-svg" id="overview-donut-svg" viewBox="0 0 124 124">
                  <circle class="donut-track" cx="62" cy="62" r="${radius}" />
                  ${arcsHtml}
                </svg>
                <div class="donut-center tabular">
                  <span id="donut-center-val" class="donut-center-val">${centerVal}</span>
                  <span id="donut-center-sub" class="donut-center-sub">${centerSub}</span>
                </div>
              </div>
              <div class="overview-legend-list">
                ${visibleGroups.map((g) => renderOverviewItem(g, false)).join('')}
              </div>
            </div>
            ${expandBtnHtml}
          `;
        } else {
          ovPanel.innerHTML = `
            <div class="overview-legend-list">
              ${visibleGroups.map((g) => renderOverviewItem(g, true)).join('')}
            </div>
            ${expandBtnHtml}
          `;
        }
      }
    }

    // Render LEVEL 2: Existing Detailed Source-Split Model List (supports drill-down filter)
    const detailModels = isDrilled ? models.filter((m) => m.displayName === drilledModel) : models;
    if (detailModels.length) {
      const detailGrand = Math.max(1, detailModels.reduce((s, x) => s + Number(x.totalTokens || 0), 0));
      $('#stats-ratio-bar').innerHTML = detailModels
        .map((m) => {
          const pct = isDrilled ? (m.totalTokens / detailGrand) * 100 : m.sharePercent;
          return `<span style="width:${Math.max(2, pct)}%;background:${m.color}" title="${escapeHtml(m.displayName)} (${m.sourceLabel}) ${pct.toFixed(1)}%"></span>`;
        })
        .join('');
      const visibleModels = modelsExpanded || isDrilled ? detailModels : detailModels.slice(0, MAX_COLLAPSED_MODELS);
      const hiddenModelsCount = isDrilled ? 0 : Math.max(0, detailModels.length - MAX_COLLAPSED_MODELS);
      $('#stats-models-list').innerHTML =
        visibleModels
          .map((m) => {
            const tot = Math.max(1, m.totalTokens);
            const wCache = (m.cacheRead / tot) * 100;
            const wIn = (m.uncachedInput / tot) * 100;
            const wOut = (m.output / tot) * 100;
            const pctShow = isDrilled ? (m.totalTokens / detailGrand) * 100 : m.sharePercent;
            return `
              <div class="model-row">
                <div class="model-row-top">
                  <div class="model-name-wrap">
                    <span class="ratio-swatch" style="background:${m.color}"></span>
                    <span class="model-row-name">${escapeHtml(m.displayName)}</span>
                    <span class="src-badge ${escapeHtml(m.sourceKind)}">${escapeHtml(m.sourceLabel)}</span>
                  </div>
                  <span class="model-row-nums tabular"><strong>${pctShow.toFixed(1)}%</strong> · ${formatCompact(m.totalTokens)}</span>
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
              modelsExpanded ? '收起模型明细 ▴' : `展开其余 ${hiddenModelsCount} 项模型（共 ${detailModels.length} 项）▾`
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

    // ========== WINDOW 2: AUTOMATIC OFFICIAL QUOTA MONITOR ==========
    const oq = telemetry.officialQuota || {};
    const syncBadge = $('#quota-sync-badge');
    if (oq.syncing) {
      syncBadge.textContent = '同步中...';
      syncBadge.className = 'badge-pill warn';
    } else if (oq.available && oq.fetchedAtMs) {
      syncBadge.textContent = formatRelativeTime(oq.fetchedAtMs);
      syncBadge.className = 'badge-pill running';
    } else {
      syncBadge.textContent = '等待同步';
      syncBadge.className = 'badge-pill';
    }

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

    const renderQuotaItem = (title, bucket) => {
      const hasVal = Boolean(bucket && typeof bucket.remainingPct === 'number');
      const leftPct = hasVal ? bucket.remainingPct : null;
      const usedPct = hasVal ? bucket.usedPct : null;
      const leftText = leftPct !== null ? `${Number.isInteger(leftPct) ? leftPct : leftPct.toFixed(1)}% 剩余` : '—';
      const usedText = usedPct !== null ? `已用 ${Number.isInteger(usedPct) ? usedPct : usedPct.toFixed(1)}%` : '总 100%';
      const resetLine = !hasVal
        ? (oq.syncing ? '同步中...' : '点击刷新')
        : leftPct >= 99.95
        ? '已满额'
        : bucket.resetAtMs
        ? formatCountdown(bucket.resetInMs)
        : '—';
      const burnLine =
        hasVal && bucket.burnPctPerHour >= 0.1
          ? bucket.etaMs > 0
            ? `-${bucket.burnPctPerHour.toFixed(1)}%/h · 预计 ${formatDurationShort(bucket.etaMs)} 耗尽`
            : `-${bucket.burnPctPerHour.toFixed(1)}%/h`
          : '';
      const alertCls =
        hasVal && bucket.alertLevel === 'critical'
          ? 'alert-critical'
          : hasVal && bucket.alertLevel === 'warn'
          ? 'alert-warn'
          : '';
      return `
        <div class="quota-item ${alertCls}">
          <div class="quota-left">
            <span class="quota-name">${title}</span>
            <span class="quota-reset tabular">${resetLine}</span>
            ${burnLine ? `<span class="quota-burn tabular ${bucket.willExhaustBeforeReset ? 'urgent' : ''}">${burnLine}</span>` : ''}
          </div>
          <div class="quota-right">
            <div class="quota-pct-col tabular">
              <span class="quota-pct-main">${leftText}</span>
              <span class="quota-pct-used">${usedText}</span>
            </div>
            ${renderQuotaRing(leftPct)}
          </div>
        </div>
      `;
    };

    const renderQuotaBox = (group, { wide = false } = {}) => {
      if (wide) {
        const itemsHtml = [
          group?.weekly ? renderQuotaItem('每周限额', group.weekly) : '',
          group?.h5 ? renderQuotaItem('5小时限额', group.h5) : '',
        ]
          .filter(Boolean)
          .join('');
        if (!itemsHtml) return '';
        const metaTxt = group?.fetchedAtMs ? formatRelativeTime(group.fetchedAtMs) : '';
        return `
          <div class="quota-box quota-box-wide">
            <div class="quota-head">
              <span>${escapeHtml(group?.label || '')}</span>
              ${metaTxt ? `<span class="quota-head-meta">${metaTxt}</span>` : ''}
            </div>
            <div class="quota-box-wide-items">${itemsHtml}</div>
          </div>
        `;
      }
      return `
        <div class="quota-box">
          <div class="quota-head"><span>${escapeHtml(group?.label || '')}</span></div>
          ${renderQuotaItem('每周限额', group?.weekly)}
          ${renderQuotaItem('5小时限额', group?.h5)}
        </div>
      `;
    };

    const codexBoxHtml = oq.codex?.available ? renderQuotaBox(oq.codex, { wide: true }) : '';
    $('#quota-grid').innerHTML = renderQuotaBox(oq.gemini) + renderQuotaBox(oq.claude) + codexBoxHtml;

    // ========== WINDOW 3: STANDALONE REAL-TIME CONTEXT ==========
    const ctx = telemetry.context;
    const circumference = 2 * Math.PI * 48;
    const offset = circumference * (1 - Math.min(100, ctx.percent) / 100);
    $('#ring-progress').style.strokeDashoffset = String(offset.toFixed(2));
    $('#ring-percent').textContent = `${ctx.percent.toFixed(ctx.percent >= 10 ? 0 : 1)}%`;
    $('#ctx-used').textContent = formatNumber(ctx.used);
    $('#ctx-limit').textContent = formatNumber(ctx.limit);

    const turnCachePill = $('#ctx-turn-cache-pill');
    const ltc = ctx.lastTurnCache;
    if (ltc && typeof ltc.hitRate === 'number') {
      turnCachePill.hidden = false;
      if (ltc.isDrop) {
        turnCachePill.textContent = `⚠ 掉缓存 ${ltc.hitRate.toFixed(0)}% (+${formatCompact(ltc.uncachedInput)})`;
        turnCachePill.className = 'badge-pill danger';
      } else {
        turnCachePill.textContent = `本轮缓存 ${ltc.hitRate.toFixed(1)}%`;
        turnCachePill.className = 'badge-pill running';
      }
    } else {
      turnCachePill.hidden = true;
    }

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
    const usedBase = Math.max(1, ctx.used || items.reduce((s, it) => s + Number(it.value || 0), 0));
    $('#breakdown-list').innerHTML = items
      .map((it) => {
        const shareUsed = ctx.used > 0 ? Math.min(100, (it.value / usedBase) * 100) : 0;
        const shareLimit = ctx.limit > 0 ? Math.min(100, (it.value / ctx.limit) * 100) : 0;
        return `
          <div class="breakdown-item" title="${it.label}：占当前上下文 ${shareUsed.toFixed(1)}% · 占窗口上限 ${shareLimit.toFixed(1)}%">
            <div class="breakdown-top">
              <span>${it.label}</span>
              <strong class="tabular">${formatCompact(it.value)} <span class="muted">${shareUsed.toFixed(1)}%</span></strong>
            </div>
            <div class="breakdown-bar"><span style="width:${Math.max(shareUsed, it.value > 0 ? 4 : 0)}%;background:${it.color}"></span></div>
          </div>
        `;
      })
      .join('');

    const spd = ctx.speed;
    $('#ctx-model-badge').textContent = spd.model || '—';
    $('#ctx-effort-badge').textContent = spd.effort || '—';
    $('#metric-speed').textContent = spd.latest ? spd.latest.toFixed(1) : '—';
    renderSparkline(spd.sparkline);

    const cp = ctx.compaction || { count: 0, lastAtMs: 0, lastDurationMs: null, inProgress: false };
    const cpCountEl = $('#ctx-cp-count');
    const cpLastEl = $('#ctx-cp-last');
    const cpDurEl = $('#ctx-cp-dur');
    cpCountEl.textContent = `${cp.count || 0} 次`;
    if (cp.count > 0 && cp.lastAtMs) {
      const clock = formatClockTime(cp.lastAtMs);
      const rel = formatRelativeTime(cp.lastAtMs);
      cpLastEl.textContent = `${clock} · ${rel}`;
      cpLastEl.title = new Date(cp.lastAtMs).toLocaleString('zh-CN');
    } else {
      cpLastEl.textContent = '尚未压缩';
      cpLastEl.title = '';
    }
    if (cp.inProgress) {
      cpDurEl.textContent = `压缩中 ${formatDurationSec(cp.lastDurationMs)}`;
      cpDurEl.className = 'is-active-cp';
      cpDurEl.title = '';
    } else if (typeof cp.lastDurationMs === 'number') {
      cpDurEl.textContent = formatDurationSec(cp.lastDurationMs);
      cpDurEl.className = '';
      cpDurEl.title =
        cp.preTokens > 0
          ? `压缩前 ${formatCompact(cp.preTokens)} → 压缩后 ${formatCompact(cp.postTokens)}`
          : '';
    } else {
      cpDurEl.textContent = '—';
      cpDurEl.className = '';
      cpDurEl.title = '';
    }

    // Derived Row 2: Runway until next compaction / Freed space ratio / Effective input cost ratio
    const runwayEl = $('#ctx-cp-runway');
    const growthEl = $('#ctx-cp-growth');
    const runwayCell = $('#ctx-cell-runway');
    if (typeof cp.estTurnsToLimit === 'number') {
      runwayEl.textContent = cp.estTurnsToLimit <= 1 ? '即将触发' : `约 ${cp.estTurnsToLimit} 轮`;
      runwayEl.className = cp.estTurnsToLimit <= 5 ? 'is-danger' : cp.estTurnsToLimit <= 15 ? 'is-active-cp' : '';
      growthEl.textContent = cp.avgGrowthPerTurn > 0 ? `+${formatCompact(cp.avgGrowthPerTurn)}/轮` : '';
      runwayCell.title = `按本周期平均每轮净增 ${formatNumber(cp.avgGrowthPerTurn)} Token 估算，距 ${formatCompact(ctx.limit)} 上限大约还可运行 ${cp.estTurnsToLimit} 轮`;
    } else {
      runwayEl.textContent = '待采样';
      runwayEl.className = '';
      growthEl.textContent = '需 ≥2 轮计算';
      runwayCell.title = '至少完成 2 轮对话后自动估算距下次压缩剩余轮数';
    }

    const freedEl = $('#ctx-cp-freed');
    const freedSubEl = $('#ctx-cp-freed-sub');
    const freedCell = $('#ctx-cell-freed');
    if (typeof cp.freedPercent === 'number') {
      freedEl.textContent = `${cp.freedPercent.toFixed(1)}%`;
      freedEl.className = cp.freedPercent >= 85 ? 'is-good' : cp.freedPercent < 70 ? 'is-active-cp' : '';
      freedSubEl.textContent = `${formatCompact(cp.preTokens)} → ${formatCompact(cp.postTokens)}`;
      freedCell.title = `上次压缩释放了 ${cp.freedPercent.toFixed(1)}% 上下文空间（${formatNumber(cp.preTokens)} → ${formatNumber(cp.postTokens)}）；若跌破 75% 说明摘要偏臃肿`;
    } else {
      freedEl.textContent = '—';
      freedEl.className = '';
      freedSubEl.textContent = '首次压缩后显示';
      freedCell.title = '上次压缩释放的上下文比例（越高越清爽）';
    }

    const effEl = $('#ctx-cp-eff');
    const effSubEl = $('#ctx-cp-eff-sub');
    const effCell = $('#ctx-cell-eff');
    if (typeof cp.effectiveInputRatio === 'number') {
      effEl.textContent = `${cp.effectiveInputRatio.toFixed(1)}%`;
      effEl.className = cp.effectiveInputRatio <= 25 ? 'is-good' : cp.effectiveInputRatio >= 45 ? 'is-danger' : 'is-active-cp';
      effSubEl.textContent = `缓存1折·省 ${cp.savedInputPercent?.toFixed(0) ?? 0}%`;
      effCell.title = `等效原价输入占比 = (未命中 + 0.1×缓存读取) / 总输入；越低越省额度，当前缓存约节省 ${cp.savedInputPercent?.toFixed(1) ?? 0}% 输入负担`;
    } else {
      effEl.textContent = '—';
      effEl.className = '';
      effSubEl.textContent = '缓存按1折·越低越省';
      effCell.title = '把命中缓存按 10% 折算成原价输入后的真实负担占比，越低越省额度';
    }

    // ========== WINDOW 4: ACTIVE CLI & SUBAGENT LIVE MONITOR ==========
    const ag = telemetry.activeAgents;
    const badge = $('#active-agents-badge');
    const stalledCount = Number(ag.stalledCount || 0);
    if (stalledCount > 0 && ag.runningCount > 0) {
      badge.textContent = `${ag.runningCount} 运行中 · ${stalledCount} 疑似卡住`;
      badge.className = 'badge-pill warn';
    } else if (stalledCount > 0) {
      badge.textContent = `${stalledCount} 疑似卡住`;
      badge.className = 'badge-pill warn';
    } else if (ag.runningCount > 0) {
      badge.textContent = `${ag.runningCount} 运行中`;
      badge.className = 'badge-pill running';
    } else {
      badge.textContent = `${ag.items.length} 活动中`;
      badge.className = 'badge-pill';
    }

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
            const stateCls = a.isStalled ? 'is-stalled' : a.isRunning ? 'is-running' : '';
            const pillCls = a.isStalled ? 'warn' : a.isRunning ? 'running' : '';
            const statusSuffix = a.isStalled
              ? `疑似卡住 ${a.stalledMinutes}m`
              : a.isRunning
              ? '运行中'
              : formatRelativeTime(a.lastActiveMs);
            return `
              <div class="agent-card ${stateCls} ${a.clickableConvId ? 'clickable' : ''}" ${clickAttr}>
                <div class="agent-top">
                  <div class="agent-id-group">
                    <span class="source-tag ${isCodex ? 'codex' : ''}">${escapeHtml(a.kindLabel)}</span>
                    <span class="agent-action">${escapeHtml(a.activity)}</span>
                  </div>
                  <span class="badge-pill ${pillCls}">${escapeHtml(a.projectName)} · ${statusSuffix}</span>
                </div>
                ${a.taskTitle ? `<div class="agent-task-title" title="${escapeHtml(a.rawTaskTitle || a.taskTitle)}">${escapeHtml(a.taskTitle)}</div>` : ''}
                ${a.actionDetail ? `<div class="agent-cmd-line" title="${escapeHtml(a.actionDetail)}">${escapeHtml(a.actionDetail)}</div>` : ''}
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
      try {
        await Promise.all([loadState(), loadTelemetry()]);
        showToast('已刷新');
      } catch {
        showToast('连接已重置，请关闭并重开驾驶舱标签页');
      }
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

    // Level 1 / Level 2 view switcher, chart type, metric toggle & interactive drill-down
    $('#stats-level-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      statsLevel = btn.dataset.level === 'detail' ? 'detail' : 'overview';
      if (statsLevel === 'overview') drilledModel = '';
      renderCockpit();
    });

    $('#stats-metric-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      statsMetric = btn.dataset.metric === 'calls' ? 'calls' : 'tokens';
      renderCockpit();
    });

    $('#stats-chart-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      statsChart = btn.dataset.chart === 'bar' ? 'bar' : 'donut';
      renderCockpit();
    });

    $('#btn-drill-back').addEventListener('click', () => {
      drilledModel = '';
      statsLevel = 'overview';
      renderCockpit();
    });

    const applyOverviewHover = (modelName) => {
      const panel = $('#stats-overview-panel');
      if (!panel) return;
      const svg = $('#overview-donut-svg');
      if (svg) svg.classList.toggle('has-hover', Boolean(modelName));
      panel.querySelectorAll('[data-hover-model]').forEach((el) => {
        el.classList.toggle('is-hovered', Boolean(modelName) && el.dataset.hoverModel === modelName);
      });
      const valEl = $('#donut-center-val');
      const subEl = $('#donut-center-sub');
      if (!valEl || !subEl) return;
      if (modelName) {
        const g = lastOverviewGroups.find((x) => x.displayName === modelName);
        if (g) {
          const share = statsMetric === 'calls' ? g.callSharePct : g.tokenSharePct;
          valEl.textContent = `${share.toFixed(1)}%`;
          subEl.textContent =
            statsMetric === 'calls' ? `${formatNumber(g.turns)} 次` : formatCompact(g.totalTokens);
          return;
        }
      }
      valEl.textContent =
        statsMetric === 'calls'
          ? `${formatNumber(lastOverviewTotals.turns)} 次`
          : formatCompact(lastOverviewTotals.tokens);
      subEl.textContent = `${lastOverviewGroups.length} 个模型`;
    };

    $('#stats-overview-panel').addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-hover-model]');
      applyOverviewHover(target ? target.dataset.hoverModel : '');
    });

    $('#stats-overview-panel').addEventListener('mouseleave', () => {
      applyOverviewHover('');
    });

    $('#stats-overview-panel').addEventListener('click', (e) => {
      const expBtn = e.target.closest('[data-toggle-expand="overview"]');
      if (expBtn) {
        overviewExpanded = !overviewExpanded;
        renderCockpit();
        return;
      }
      const drill = e.target.closest('[data-drill-model]');
      if (!drill) return;
      drilledModel = drill.dataset.drillModel;
      statsLevel = 'detail';
      renderCockpit();
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

    // Window 2: Automatic Official Quota Refresh
    $('#btn-quota-refresh').addEventListener('click', async () => {
      const btn = $('#btn-quota-refresh');
      btn.disabled = true;
      btn.textContent = '同步中...';
      try {
        const res = await apiFetch('/api/quota/refresh', { method: 'POST', body: '{}' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTelemetry();
        showToast('官方额度已同步');
      } catch (err) {
        showToast(`刷新失败：${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '刷新';
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
    $('#btn-adaptive-theme').addEventListener('click', async () => {
      const next = !Boolean(appState.settings.adaptiveTheme);
      await queueSaveSettings({ adaptiveTheme: next }, true);
      if (next) {
        await applyAdaptiveColorsFromCurrentWallpaper(true);
      } else {
        showToast('已关闭壁纸自动取色');
      }
    });
    $('#btn-extract-colors').addEventListener('click', () => {
      applyAdaptiveColorsFromCurrentWallpaper(true);
    });
    $('#btn-follow-host').addEventListener('click', () => {
      queueSaveSettings({ followHostTheme: !appState.settings.followHostTheme }, true);
    });
    $('#btn-reset-colors').addEventListener('click', async () => {
      const res = await apiFetch('/api/reset-colors', { method: 'POST', body: '{}' });
      if (res.ok) {
        appState = await res.json();
        await queueSaveSettings({ adaptiveTheme: false }, true);
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
      queueSaveSettings({ presetId: found.id, followHostTheme: false, adaptiveTheme: false, colors: { ...found.colors } }, true);
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
      queueSaveSettings({ presetId: 'custom', adaptiveTheme: false, colors: { [key]: hex } }, false);
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
      await queueSaveSettings({ wallpaper: { kind: card.dataset.wpKind, id: card.dataset.wpId, onlineMeta: null } }, true);
      if (appState?.settings?.adaptiveTheme) {
        await applyAdaptiveColorsFromCurrentWallpaper(false);
      }
    });

    $('#select-online-source').addEventListener('change', (e) => {
      queueSaveSettings({ wallpaper: { onlineSource: e.target.value } }, true);
    });

    $('#btn-random-online').addEventListener('click', async () => {
      const btn = $('#btn-random-online');
      const source = $('#select-online-source').value || 'all';
      btn.disabled = true;
      btn.textContent = '拉取中...';
      try {
        const res = await apiFetch('/api/wallpapers/random-online', {
          method: 'POST',
          body: JSON.stringify({ source }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        appState = payload;
        renderStudio();
        if (appState?.settings?.adaptiveTheme) {
          await applyAdaptiveColorsFromCurrentWallpaper(false);
        }
        const meta = payload.fetched?.meta;
        showToast(`已切换「${meta?.name || '在线壁纸'}」(${meta?.sourceLabel || '开源图库'})`);
      } catch (err) {
        showToast(err.message || '开源图库拉取失败');
      } finally {
        btn.disabled = false;
        btn.textContent = '随机图库';
      }
    });

    $('#btn-collect-online').addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/wallpapers/collect-online', { method: 'POST', body: '{}' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || '收藏失败');
        }
        appState = await res.json();
        renderStudio();
        showToast('已收藏到本地画廊 ✨');
      } catch (err) {
        showToast(err.message);
      }
    });

    $('#btn-random-wp').addEventListener('click', async () => {
      const all = [
        ...appState.builtinWallpapers.map((w) => ({ kind: 'builtin', id: w.id, name: w.name })),
        ...(appState.customWallpapers || []).map((w) => ({ kind: 'custom', id: w.id, name: w.name })),
      ];
      if (!all.length) return;
      const cur = appState.settings.wallpaper;
      const pool = all.filter((w) => !(w.kind === cur.kind && w.id === cur.id));
      const pick = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length ? pool.length : all.length))];
      await queueSaveSettings({ wallpaper: { kind: pick.kind, id: pick.id, onlineMeta: null } }, true);
      if (appState?.settings?.adaptiveTheme) {
        await applyAdaptiveColorsFromCurrentWallpaper(false);
      }
      showToast(`已切换壁纸「${pick.name}」`);
    });

    $('#btn-clear-wp').addEventListener('click', () => {
      queueSaveSettings({ wallpaper: { kind: 'none', id: '', onlineMeta: null } }, true);
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
          if (appState?.settings?.adaptiveTheme) {
            await applyAdaptiveColorsFromCurrentWallpaper(false);
          }
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
    // Never block init on getWorkspaceUris() — onWorkspaceChange updates it asynchronously
    // without risking an infinite hang after iframe reload!
    if (window.sidecar?.getWorkspaceUris) {
      window.sidecar
        .getWorkspaceUris()
        .then((uris) => {
          if (Array.isArray(uris) && uris.length > 0 && uris[0] !== activeWorkspaceUri) {
            activeWorkspaceUri = uris[0];
            if (appState?.settings?.telemetry?.followLatest !== false) loadTelemetry();
          }
        })
        .catch(() => {});
    }
    await loadState();
    await loadTelemetry();
    setInterval(loadTelemetry, 3000);
  }

  init().catch((err) => {
    console.error('[prism_studio] init failed:', err);
  });
})();
