import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { SidecarApp, Response } from 'sidecar_sdk';
import { MacBackdropCompanion } from './companion.mjs';
import { AgyQuotaFetcher } from './quota_fetcher.mjs';
import {
  ASSET_VERSION,
  BUILTIN_PRESETS,
  BUILTIN_WALLPAPERS,
  BUILTIN_WALLPAPERS_DIR,
  PUBLIC_DIR,
  PrismStorage,
} from './storage.mjs';
import { buildTelemetrySnapshot } from './telemetry.mjs';
import { ONLINE_SOURCES, OnlineWallpaperGallery } from './wallpaper_gallery.mjs';

const storage = new PrismStorage();
const companion = new MacBackdropCompanion(storage);
const quotaFetcher = new AgyQuotaFetcher(storage);
const onlineGallery = new OnlineWallpaperGallery(storage);

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

function readPublicFile(relPath) {
  const fullPath = join(PUBLIC_DIR, relPath);
  const contentType = MIME_BY_EXT[extname(fullPath).toLowerCase()] || 'application/octet-stream';
  return new Response(readFileSync(fullPath), {
    contentType,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function buildStatePayload(settings = storage.loadSettings()) {
  return {
    assetVersion: ASSET_VERSION,
    settings,
    builtinPresets: BUILTIN_PRESETS,
    builtinWallpapers: BUILTIN_WALLPAPERS.filter((w) =>
      existsSync(join(BUILTIN_WALLPAPERS_DIR, w.file)),
    ),
    customWallpapers: storage.listCustomWallpapers(),
    onlineSources: ONLINE_SOURCES,
    companion: companion.getState(),
  };
}

function cleanup() {
  quotaFetcher.stop();
  companion.stop();
}
process.on('exit', cleanup);
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

const app = new SidecarApp();

app.page('/', () => readPublicFile('index.html'));
app.page('/styles.css', () => readPublicFile('styles.css'));
app.page('/app.js', () => readPublicFile('app.js'));
app.page('/logo.svg', () => {
  const logoPath = join(PUBLIC_DIR, '..', '..', '..', 'assets', 'logo.svg');
  return new Response(readFileSync(logoPath), {
    contentType: 'image/svg+xml',
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
});

app.api(
  '/api/wallpaper',
  (data) => {
    const kind = data.kind === 'custom' ? 'custom' : data.kind === 'online' ? 'online' : 'builtin';
    const id = String(data.id || '');
    const filePath = storage.resolveWallpaperPath({ kind, id });
    if (!filePath || !existsSync(filePath)) {
      return new Response('Wallpaper not found', { contentType: 'text/plain', status: 404 });
    }
    const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] || 'image/jpeg';
    return new Response(readFileSync(filePath), {
      contentType: mime,
      headers: {
        'Cache-Control': kind === 'online' ? 'no-store' : 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
  'GET',
);

app.api('/api/state', () => buildStatePayload(), 'GET');

app.api('/api/settings', async (data) => {
  const updated = storage.saveSettings(data?.settings || data || {});
  await companion.syncWithSettings(updated);
  return buildStatePayload(updated);
});

app.api('/api/reset-colors', async () => {
  const updated = storage.resetColors();
  await companion.syncWithSettings(updated);
  return buildStatePayload(updated);
});

app.api('/api/presets/save', (data) => {
  const name = String(data?.name || '').trim().slice(0, 24);
  if (!name) throw new Error('请输入配色方案名称');
  const current = storage.loadSettings();
  const colors = data?.colors || current.colors;
  const preset = {
    id: `custom-${Date.now()}`,
    name,
    mode: data?.mode === 'light' ? 'light' : 'dark',
    colors: { ...current.colors, ...colors },
    isCustom: true,
  };
  const customPresets = [preset, ...(current.customPresets || []).filter((p) => p.name !== name)].slice(0, 12);
  const updated = storage.saveSettings({
    presetId: preset.id,
    colors: preset.colors,
    customPresets,
  });
  return buildStatePayload(updated);
});

app.api('/api/presets/delete', (data) => {
  const id = String(data?.id || '');
  const current = storage.loadSettings();
  const customPresets = (current.customPresets || []).filter((p) => p.id !== id);
  const updated = storage.saveSettings({ customPresets });
  return buildStatePayload(updated);
});

app.api('/api/wallpapers/upload', async (data) => {
  const saved = storage.saveCustomWallpaper(data?.name, data?.dataUrl);
  const updated = storage.saveSettings({
    wallpaper: { kind: 'custom', id: saved.id, onlineMeta: null },
  });
  await companion.syncWithSettings(updated);
  return { uploaded: saved, ...buildStatePayload(updated) };
});

app.api('/api/wallpapers/random-online', async (data) => {
  const sourceId = String(data?.source || 'all');
  const fetched = await onlineGallery.fetchRandom(sourceId);
  const updated = storage.saveSettings({
    wallpaper: {
      kind: 'online',
      id: fetched.id,
      onlineSource: sourceId,
      onlineMeta: fetched.meta,
    },
  });
  await companion.syncWithSettings(updated);
  return { fetched, ...buildStatePayload(updated) };
});

app.api('/api/wallpapers/collect-online', async () => {
  const current = storage.loadSettings();
  if (current.wallpaper?.kind !== 'online' || !current.wallpaper?.id) {
    throw new Error('当前不是在线随机壁纸');
  }
  const collected = storage.collectOnlineWallpaper(
    current.wallpaper.id,
    current.wallpaper.onlineMeta?.name || 'online_wallpaper',
  );
  const updated = storage.saveSettings({
    wallpaper: {
      kind: 'custom',
      id: collected.id,
      onlineMeta: null,
    },
  });
  await companion.syncWithSettings(updated);
  return { collected, ...buildStatePayload(updated) };
});

app.api('/api/wallpapers/delete', async (data) => {
  const id = String(data?.id || '');
  storage.deleteCustomWallpaper(id);
  const current = storage.loadSettings();
  let updated = current;
  if (current.wallpaper?.kind === 'custom' && current.wallpaper?.id === id) {
    updated = storage.saveSettings({
      wallpaper: { kind: 'builtin', id: 'starry-ocean-train' },
    });
    await companion.syncWithSettings(updated);
  }
  return buildStatePayload(updated);
});

app.api('/api/pin', (data) => {
  const id = String(data?.conversationId || '');
  if (!id) throw new Error('缺少会话 ID');
  const current = storage.loadSettings();
  const set = new Set(current.pinnedConversations || []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  const updated = storage.saveSettings({ pinnedConversations: [...set] });
  return buildStatePayload(updated);
});

app.api('/api/companion', async (data) => {
  const action = String(data?.action || '');
  const current = storage.loadSettings();
  if (action === 'start') {
    const updated = storage.saveSettings({ companion: { enabled: true } });
    await companion.start(updated);
    return buildStatePayload(updated);
  }
  if (action === 'stop') {
    const updated = storage.saveSettings({ companion: { enabled: false } });
    companion.stop();
    return buildStatePayload(updated);
  }
  return buildStatePayload(current);
});

app.api('/api/quota/refresh', async () => {
  const officialQuota = await quotaFetcher.refresh();
  return { officialQuota };
});

app.api(
  '/api/telemetry',
  (data) => {
    const settings = storage.loadSettings();
    const followLatest =
      data.followLatest !== undefined
        ? data.followLatest === 'true' || data.followLatest === true
        : settings.telemetry.followLatest;
    const statsScope = ['project', 'session', 'all'].includes(data.statsScope)
      ? data.statsScope
      : settings.telemetry.statsScope || 'project';
    const sourceFilter = ['all', 'gui', 'agy-cli', 'codex-cli'].includes(data.sourceFilter)
      ? data.sourceFilter
      : settings.telemetry.sourceFilter || 'all';
    const range = ['today', '7d', '30d', 'all'].includes(data.range)
      ? data.range
      : settings.telemetry.range || 'today';
    const windowLimit = Number(data.windowLimit || settings.telemetry.windowLimit || 512000);
    const conversationId = String(data.conversationId || '');
    const hostConversationId = String(data.hostConversationId || '');
    const activeWorkspaceUri = String(data.activeWorkspaceUri || '');
    const selectedProjectId = String(data.selectedProjectId || '');
    const contextTarget = String(data.contextTarget || 'main');
    const showRecentAgents =
      data.showRecentAgents !== undefined
        ? data.showRecentAgents === 'true' || data.showRecentAgents === true
        : Boolean(settings.telemetry.showRecentAgents);

    const snap = buildTelemetrySnapshot({
      conversationId,
      hostConversationId,
      activeWorkspaceUri,
      selectedProjectId,
      contextTarget,
      followLatest,
      statsScope,
      sourceFilter,
      range,
      windowLimit,
      showRecentAgents,
      resolveModelContextWindow: (rawModel) => quotaFetcher.getModelContextWindow(rawModel),
    });
    return {
      ...snap,
      officialQuota: quotaFetcher.getSnapshot(),
    };
  },
  'GET',
);

await app.run();
quotaFetcher.startAutoRefresh(3 * 60 * 1000);
const initialSettings = storage.loadSettings();
storage.syncCompanionConfig(initialSettings);
if (initialSettings.companion?.enabled) {
  companion.start(initialSettings).catch((err) => {
    console.error('[prism_studio] Companion auto-start failed:', err.message);
  });
} else if (process.platform === 'darwin') {
  companion.ensureCompiled().catch(() => {});
}
