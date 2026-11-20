import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, 'public');
export const BUILTIN_WALLPAPERS_DIR = join(PUBLIC_DIR, 'wallpapers');

export function resolveDataDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-theme', 'prism_studio', 'data');
}

export function resolveAppDataDir() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return appData;
      }
    }
  }
  const fallback = join(homedir(), '.gemini', 'antigravity');
  if (existsSync(join(fallback, 'brain'))) return fallback;
  return fallback;
}

export const BUILTIN_PRESETS = [
  {
    id: 'midnight-train',
    name: '星海暖灯',
    mode: 'dark',
    colors: {
      accent: '#6EA8FF',
      secondary: '#F4B860',
      tertiary: '#38D9A9',
      canvas: '#0E121B',
      surface: '#141B2B',
      card: '#192236',
    },
  },
  {
    id: 'aurora-sapphire',
    name: '星海极光',
    mode: 'dark',
    colors: {
      accent: '#60A5FA',
      secondary: '#A78BFA',
      tertiary: '#34D399',
      canvas: '#0C1222',
      surface: '#141D33',
      card: '#1B2642',
    },
  },
  {
    id: 'sakura-mist',
    name: '绯樱雾岚',
    mode: 'dark',
    colors: {
      accent: '#F472B6',
      secondary: '#C084FC',
      tertiary: '#38BDF8',
      canvas: '#140E1E',
      surface: '#1F1630',
      card: '#291D3D',
    },
  },
  {
    id: 'abyss-emerald',
    name: '深海翡翠',
    mode: 'dark',
    colors: {
      accent: '#2DD4BF',
      secondary: '#38BDF8',
      tertiary: '#A3E635',
      canvas: '#081418',
      surface: '#0F2127',
      card: '#162E36',
    },
  },
  {
    id: 'frost-daylight',
    name: '霜白晨曦',
    mode: 'light',
    colors: {
      accent: '#2563EB',
      secondary: '#7C3AED',
      tertiary: '#059669',
      canvas: '#EEF3FA',
      surface: '#F7FAFE',
      card: '#FFFFFF',
    },
  },
];

export const BUILTIN_WALLPAPERS = [
  {
    id: 'starry-ocean-train',
    name: '星海夜行电车',
    file: 'starry-ocean-train.jpg',
    tag: '推荐',
  },
  {
    id: 'aurora-mirror-lake',
    name: '极光星轨镜湖',
    file: 'aurora-mirror-lake.jpg',
    tag: '液态玻璃',
  },
  {
    id: 'rainy-neon-alley',
    name: '雨夜霓虹街巷',
    file: 'rainy-neon-alley.jpg',
    tag: '赛博微雨',
  },
  {
    id: 'moonlit-sakura-shrine',
    name: '月下绯樱神社',
    file: 'moonlit-sakura-shrine.jpg',
    tag: '和风月夜',
  },
];

const SCHEMA_VERSION = 3;
export const ASSET_VERSION = '3.7.1';

export const DEFAULT_SETTINGS = {
  schemaVersion: SCHEMA_VERSION,
  presetId: 'midnight-train',
  followHostTheme: false,
  adaptiveTheme: false,
  colors: { ...BUILTIN_PRESETS[0].colors },
  customPresets: [],
  wallpaper: {
    kind: 'builtin', // 'builtin' | 'custom' | 'online' | 'none'
    id: 'starry-ocean-train',
    onlineSource: 'all', // 'all' | 'catppuccin' | 'nordic' | 'bing' | 'wikimedia'
    onlineMeta: null,
    opacity: 100,
    blur: 4,
    darkness: 6,
    radius: 12,
    fit: 'cover',
  },
  companion: {
    enabled: false,
    opacity: 62,
    blur: 0,
    vignette: 18,
    onlyWhenFrontmost: false,
    fit: 'cover',
    blendStyle: 'screen', // 'screen' | 'soft'
    glassRim: true,
    seamlessRightPane: true,
  },
  telemetry: {
    followLatest: true,
    windowLimit: 512000,
    statsScope: 'project', // 'project' | 'session' | 'all'
    sourceFilter: 'all', // 'all' | 'gui' | 'agy-cli' | 'codex-cli'
    range: 'today',
    showRecentAgents: false,
  },
  quotaAnchor: {
    // Optional user-synced snapshot from Antigravity's native Usage popup
    gemini5h: null, // { leftPct, resetAtMs, anchoredAtMs }
    gemini7d: null,
    claude5h: null,
    claude7d: null,
  },
  pinnedConversations: [],
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      base &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export class PrismStorage {
  constructor() {
    this.dataDir = resolveDataDir();
    this.customWallpapersDir = join(this.dataDir, 'custom_wallpapers');
    this.onlineWallpapersDir = join(this.dataDir, 'online_wallpapers');
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.companionConfigPath = join(this.dataDir, 'companion_config.json');
    this.binDir = join(this.dataDir, 'bin');
    this.#ensureDirs();
  }

  #ensureDirs() {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.customWallpapersDir, { recursive: true });
    mkdirSync(this.onlineWallpapersDir, { recursive: true });
    mkdirSync(this.binDir, { recursive: true });
  }

  #writeAtomic(filePath, content) {
    this.#ensureDirs();
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, filePath);
  }

  loadSettings() {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
        const merged = deepMerge(DEFAULT_SETTINGS, raw);
        // Smooth schema migrations (v2: ultra-clear glass, v3: native Z-locked backdrop without focus-hide flicker)
        if ((raw.schemaVersion || 1) < SCHEMA_VERSION) {
          const prevVer = raw.schemaVersion || 1;
          merged.schemaVersion = SCHEMA_VERSION;
          if (prevVer < 2) {
            if (merged.wallpaper.blur === 14) merged.wallpaper.blur = 4;
            if (merged.wallpaper.darkness === 38) merged.wallpaper.darkness = 6;
            if (merged.wallpaper.opacity === 92) merged.wallpaper.opacity = 100;
            if (merged.companion.blendStyle === 'crisp') merged.companion.blendStyle = 'screen';
            if (merged.companion.opacity <= 30) merged.companion.opacity = 62;
            if (merged.companion.vignette === 32 || merged.companion.vignette === 28) merged.companion.vignette = 18;
            merged.companion.seamlessRightPane = true;
          }
          if (prevVer < 3) {
            // Normal-level relative Z-ordering naturally stays behind other apps with zero flash
            merged.companion.onlyWhenFrontmost = false;
          }
          this.#writeAtomic(this.settingsPath, JSON.stringify(merged, null, 2));
          this.syncCompanionConfig(merged);
        }
        return merged;
      }
    } catch (err) {
      console.error('[prism_studio] Failed to load settings, using defaults:', err.message);
    }
    return structuredClone(DEFAULT_SETTINGS);
  }

  saveSettings(patch) {
    const current = this.loadSettings();
    const merged = deepMerge(current, patch);
    merged.schemaVersion = SCHEMA_VERSION;
    this.#writeAtomic(this.settingsPath, JSON.stringify(merged, null, 2));
    this.syncCompanionConfig(merged);
    return merged;
  }

  resetColors() {
    const preset = BUILTIN_PRESETS[0];
    return this.saveSettings({
      presetId: preset.id,
      followHostTheme: false,
      colors: { ...preset.colors },
    });
  }

  listCustomWallpapers() {
    this.#ensureDirs();
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const files = readdirSync(this.customWallpapersDir)
      .filter((f) => allowed.has(extname(f).toLowerCase()))
      .sort()
      .reverse();
    return files.map((file) => ({
      id: file,
      name: file.replace(/^\d+-/, '').replace(/\.[^.]+$/, ''),
      file,
      kind: 'custom',
    }));
  }

  saveCustomWallpaper(name, dataUrl) {
    this.#ensureDirs();
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('仅支持 PNG、JPG 或 WEBP 图片格式');
    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const buf = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    if (buf.length > 15 * 1024 * 1024) throw new Error('图片大小不能超过 15MB');
    const safeBase =
      String(name || 'wallpaper')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .slice(0, 36) || 'wallpaper';
    const file = `${Date.now()}-${safeBase}.${ext}`;
    writeFileSync(join(this.customWallpapersDir, file), buf);
    return { id: file, name: safeBase, file, kind: 'custom' };
  }

  deleteCustomWallpaper(id) {
    const safe = basename(String(id || ''));
    if (!safe) return false;
    const fullPath = join(this.customWallpapersDir, safe);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      return true;
    }
    return false;
  }

  saveOnlineWallpaper(buffer, ext = '.jpg', meta = {}) {
    this.#ensureDirs();
    const safeExt = ['.jpg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    const file = `online-${Date.now()}${safeExt}`;
    const targetPath = join(this.onlineWallpapersDir, file);
    writeFileSync(targetPath, buffer);
    // Keep only the latest 3 online preview files to save disk space
    try {
      const oldFiles = readdirSync(this.onlineWallpapersDir)
        .filter((f) => f !== file)
        .sort()
        .reverse();
      for (const old of oldFiles.slice(2)) {
        try {
          unlinkSync(join(this.onlineWallpapersDir, old));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return {
      kind: 'online',
      id: file,
      meta: {
        name: String(meta.name || '在线壁纸'),
        sourceId: String(meta.sourceId || ''),
        sourceLabel: String(meta.sourceLabel || '开源图库'),
        url: String(meta.url || ''),
        fetchedAt: Date.now(),
      },
    };
  }

  collectOnlineWallpaper(id, name = '') {
    this.#ensureDirs();
    const safe = basename(String(id || ''));
    const srcPath = join(this.onlineWallpapersDir, safe);
    if (!safe || !existsSync(srcPath)) {
      throw new Error('当前在线壁纸已失效，请重新随机');
    }
    const ext = extname(safe).toLowerCase() || '.jpg';
    const safeBase =
      String(name || 'online_wallpaper')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .slice(0, 36) || 'online_wallpaper';
    const file = `${Date.now()}-${safeBase}${ext}`;
    copyFileSync(srcPath, join(this.customWallpapersDir, file));
    return { id: file, name: safeBase, file, kind: 'custom' };
  }

  resolveWallpaperPath(wallpaper) {
    if (!wallpaper || wallpaper.kind === 'none') return '';
    if (wallpaper.kind === 'custom') {
      const safe = basename(String(wallpaper.id || ''));
      const fullPath = join(this.customWallpapersDir, safe);
      return existsSync(fullPath) ? fullPath : '';
    }
    if (wallpaper.kind === 'online') {
      const safe = basename(String(wallpaper.id || ''));
      const fullPath = join(this.onlineWallpapersDir, safe);
      return existsSync(fullPath) ? fullPath : '';
    }
    const found = BUILTIN_WALLPAPERS.find((w) => w.id === wallpaper.id);
    if (!found) return '';
    const fullPath = join(BUILTIN_WALLPAPERS_DIR, found.file);
    return existsSync(fullPath) ? fullPath : '';
  }

  syncCompanionConfig(settings) {
    const wpPath = this.resolveWallpaperPath(settings.wallpaper);
    const payload = {
      enabled: Boolean(settings.companion?.enabled),
      imagePath: wpPath,
      opacity: Math.max(0.08, Math.min(0.92, Number(settings.companion?.opacity ?? 62) / 100)),
      blur: Math.max(0, Math.min(24, Number(settings.companion?.blur ?? 0))),
      vignette: Math.max(0, Math.min(0.80, Number(settings.companion?.vignette ?? 18) / 100)),
      cornerRadius: 12,
      onlyWhenFrontmost: Boolean(settings.companion?.onlyWhenFrontmost),
      fit: settings.companion?.fit || settings.wallpaper?.fit || 'cover',
      blendStyle: settings.companion?.blendStyle === 'soft' ? 'soft' : 'screen',
      tintHex: settings.colors?.canvas || '#0E121B',
      accentHex: settings.colors?.accent || '#6EA8FF',
      glassRim: settings.companion?.glassRim !== false,
      updatedAt: Date.now(),
    };
    this.#writeAtomic(this.companionConfigPath, JSON.stringify(payload, null, 2));
    return payload;
  }
}
