import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
    id: 'midnight-train',
    name: '星海暖灯',
    mode: 'dark',
    colors: {
      accent: '#6EA8FF',
      secondary: '#F4B860',
      tertiary: '#38D9A9',
      canvas: '#0B101D',
      surface: '#131A2D',
      card: '#1A233A',
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

export const DEFAULT_SETTINGS = {
  language: 'zh-CN',
  presetId: 'midnight-train',
  followHostTheme: false,
  colors: { ...BUILTIN_PRESETS[1].colors },
  customPresets: [],
  wallpaper: {
    kind: 'builtin', // 'builtin' | 'custom' | 'none'
    id: 'starry-ocean-train',
    opacity: 92,
    blur: 14,
    darkness: 38,
    radius: 16,
    fit: 'cover', // 'cover' | 'contain'
  },
  companion: {
    enabled: false,
    opacity: 22,
    blur: 0,
    vignette: 32,
    onlyWhenFrontmost: true,
    fit: 'cover',
    blendStyle: 'crisp', // 'crisp' | 'soft'
  },
  telemetry: {
    followLatest: true,
    windowLimit: 512000,
    scope: 'all',
    range: 'today',
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
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.companionConfigPath = join(this.dataDir, 'companion_config.json');
    this.binDir = join(this.dataDir, 'bin');
    this.#ensureDirs();
  }

  #ensureDirs() {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.customWallpapersDir, { recursive: true });
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
        return deepMerge(DEFAULT_SETTINGS, raw);
      }
    } catch (err) {
      console.error('[prism_studio] Failed to load settings, using defaults:', err.message);
    }
    return structuredClone(DEFAULT_SETTINGS);
  }

  saveSettings(patch) {
    const current = this.loadSettings();
    const merged = deepMerge(current, patch);
    this.#writeAtomic(this.settingsPath, JSON.stringify(merged, null, 2));
    this.syncCompanionConfig(merged);
    return merged;
  }

  resetColors() {
    const preset = BUILTIN_PRESETS[1];
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
    if (!match) {
      throw new Error('仅支持 PNG、JPG 或 WEBP 图片格式');
    }
    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const buf = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    if (buf.length > 15 * 1024 * 1024) {
      throw new Error('图片大小不能超过 15MB');
    }
    const safeBase = String(name || 'wallpaper')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\p{L}\p{N}_-]+/gu, '_')
      .slice(0, 36) || 'wallpaper';
    const file = `${Date.now()}-${safeBase}.${ext}`;
    const fullPath = join(this.customWallpapersDir, file);
    writeFileSync(fullPath, buf);
    return {
      id: file,
      name: safeBase,
      file,
      kind: 'custom',
    };
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

  resolveWallpaperPath(wallpaper) {
    if (!wallpaper || wallpaper.kind === 'none') return '';
    if (wallpaper.kind === 'custom') {
      const safe = basename(String(wallpaper.id || ''));
      const fullPath = join(this.customWallpapersDir, safe);
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
      opacity: Math.max(0.05, Math.min(0.65, Number(settings.companion?.opacity ?? 22) / 100)),
      blur: Math.max(0, Math.min(24, Number(settings.companion?.blur ?? 0))),
      vignette: Math.max(0, Math.min(0.85, Number(settings.companion?.vignette ?? 32) / 100)),
      cornerRadius: 12,
      onlyWhenFrontmost: settings.companion?.onlyWhenFrontmost !== false,
      fit: settings.companion?.fit || settings.wallpaper?.fit || 'cover',
      blendStyle: settings.companion?.blendStyle || 'crisp',
      tintHex: settings.colors?.canvas || '#0B101D',
      updatedAt: Date.now(),
    };
    this.#writeAtomic(this.companionConfigPath, JSON.stringify(payload, null, 2));
    return payload;
  }
}
