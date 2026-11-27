import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { IS_WIN, IS_WSL } from './platform.mjs';

// Windows .NET GDI+ (PrismBackdrop.exe) natively decodes JPG/PNG but not WebP
const IMAGE_EXTS = new Set(IS_WIN || IS_WSL ? ['.jpg', '.jpeg', '.png'] : ['.jpg', '.jpeg', '.png', '.webp']);
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

export const ONLINE_SOURCES = [
  { id: 'all', label: '全部图库' },
  { id: 'catppuccin', label: 'Catppuccin 暗夜' },
  { id: 'nordic', label: 'Nordic 北欧' },
  { id: 'bing', label: 'Bing 每日超清' },
  { id: 'wikimedia', label: 'Wikimedia 星空风景' },
];

function cleanDisplayName(filename) {
  return String(filename || '在线壁纸')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

async function fetchJson(url, timeoutMs = 9000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PrismOrbit-WallpaperGallery/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadGitHubRepoIndex(owner, repo, branch, path, sourceId, sourceLabel) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents${path ? `/${path}` : ''}`;
  const list = await fetchJson(apiUrl);
  if (!Array.isArray(list)) return [];
  const items = [];
  for (const item of list) {
    if (item?.type !== 'file' || !item?.name) continue;
    const ext = extname(item.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    if (Number(item.size || 0) > 14 * 1024 * 1024) continue;
    const rawUrl =
      item.download_url ||
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURIComponent(item.path).replace(/%2F/g, '/')}`;
    items.push({
      id: `${sourceId}:${item.name}`,
      name: cleanDisplayName(item.name),
      url: rawUrl,
      ext: ext === '.jpeg' ? '.jpg' : ext,
      sourceId,
      sourceLabel,
    });
  }
  return items;
}

async function loadBingIndex() {
  const items = [];
  const seen = new Set();
  const batches = [
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN',
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=7&n=8&mkt=zh-CN',
  ];
  for (const url of batches) {
    try {
      const data = await fetchJson(url, 8000);
      for (const img of data?.images || []) {
        if (!img?.urlbase) continue;
        const fullUrl = `https://www.bing.com${img.urlbase}_1920x1080.jpg`;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);
        const title = String(img.title || img.copyright || 'Bing 每日壁纸')
          .split('(')[0]
          .trim()
          .slice(0, 32);
        items.push({
          id: `bing:${img.startdate || items.length}`,
          name: title || 'Bing 每日壁纸',
          url: fullUrl,
          ext: '.jpg',
          sourceId: 'bing',
          sourceLabel: 'Bing 每日超清',
        });
      }
    } catch {
      // continue with available batch
    }
  }
  return items;
}

async function loadWikimediaIndex() {
  const categories = [
    'Category:Featured_pictures_of_astronomy',
    'Category:Featured_pictures_of_landscapes',
  ];
  const items = [];
  const seen = new Set();
  for (const cat of categories) {
    try {
      const url =
        `https://commons.wikimedia.org/w/api.php?action=query` +
        `&generator=categorymembers&gcmtitle=${encodeURIComponent(cat)}` +
        `&gcmtype=file&gcmlimit=24&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1920&format=json`;
      const data = await fetchJson(url, 9000);
      const pages = Object.values(data?.query?.pages || {});
      for (const page of pages) {
        const info = page?.imageinfo?.[0];
        if (!info) continue;
        const mime = String(info.mime || '');
        const allowWebp = !(IS_WIN || IS_WSL);
        if (!mime.includes('jpeg') && !mime.includes('png') && !(allowWebp && mime.includes('webp'))) continue;
        // Prefer wide landscape aspect ratios for desktop wallpapers
        const w = Number(info.width || 0);
        const h = Number(info.height || 0);
        if (w > 0 && h > 0 && w / h < 1.25) continue;
        const imgUrl = info.thumburl || info.url;
        if (!imgUrl || seen.has(imgUrl)) continue;
        seen.add(imgUrl);
        const rawTitle = String(page.title || '').replace(/^File:/i, '');
        items.push({
          id: `wikimedia:${page.pageid || items.length}`,
          name: cleanDisplayName(rawTitle),
          url: imgUrl,
          ext: mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg',
          sourceId: 'wikimedia',
          sourceLabel: 'Wikimedia 精选',
        });
      }
    } catch {
      // ignore single category error
    }
  }
  return items;
}

export class OnlineWallpaperGallery {
  #storage;
  #cachePath;
  #cache = {};
  #recentIds = [];

  constructor(storage) {
    this.#storage = storage;
    this.#cachePath = join(storage.dataDir, 'online_wp_index_cache.json');
    this.#loadCache();
  }

  #loadCache() {
    try {
      if (existsSync(this.#cachePath)) {
        this.#cache = JSON.parse(readFileSync(this.#cachePath, 'utf-8')) || {};
      }
    } catch {
      this.#cache = {};
    }
  }

  #saveCache() {
    try {
      const tmp = `${this.#cachePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(this.#cache), 'utf-8');
      renameSync(tmp, this.#cachePath);
    } catch {
      // ignore cache write failure
    }
  }

  async #getSourceItems(sourceId) {
    const cached = this.#cache[sourceId];
    if (cached && Array.isArray(cached.items) && cached.items.length > 0 && Date.now() - cached.fetchedAt < INDEX_TTL_MS) {
      return cached.items;
    }

    let items = [];
    if (sourceId === 'catppuccin') {
      items = await loadGitHubRepoIndex(
        'orangci',
        'walls-catppuccin-mocha',
        'master',
        '',
        'catppuccin',
        'Catppuccin 暗夜',
      );
    } else if (sourceId === 'nordic') {
      items = await loadGitHubRepoIndex(
        'linuxdotexe',
        'nordic-wallpapers',
        'master',
        'wallpapers',
        'nordic',
        'Nordic 北欧',
      );
    } else if (sourceId === 'bing') {
      items = await loadBingIndex();
    } else if (sourceId === 'wikimedia') {
      items = await loadWikimediaIndex();
    }

    if (items.length > 0) {
      this.#cache[sourceId] = { fetchedAt: Date.now(), items };
      this.#saveCache();
      return items;
    }
    return cached?.items || [];
  }

  async fetchRandom(sourceId = 'all') {
    const targetSources =
      sourceId && sourceId !== 'all'
        ? [sourceId]
        : ['catppuccin', 'nordic', 'bing', 'wikimedia'];

    // Shuffle target source order so 'all' balances across collections
    const orderedSources = [...targetSources].sort(() => Math.random() - 0.5);

    let lastErr = null;
    for (const sid of orderedSources) {
      let pool = [];
      try {
        pool = await this.#getSourceItems(sid);
      } catch (err) {
        lastErr = err;
        continue;
      }
      if (!pool.length) continue;

      const gdiSafe = IS_WIN || IS_WSL ? pool.filter((item) => item.ext !== '.webp') : pool;
      const basePool = gdiSafe.length ? gdiSafe : pool;
      const fresh = basePool.filter((item) => !this.#recentIds.includes(item.id));
      const candidates = fresh.length ? fresh : basePool;

      // Try up to 3 random candidates in this source in case one image URL fails
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        try {
          const res = await fetch(pick.url, {
            headers: { 'User-Agent': 'PrismOrbit-WallpaperGallery/1.0' },
            signal: AbortSignal.timeout(12000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const contentType = String(res.headers.get('content-type') || '').toLowerCase();
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 8192 || buf.length > 15 * 1024 * 1024) {
            throw new Error('图片体积超出范围');
          }
          let ext = pick.ext || '.jpg';
          if (contentType.includes('png')) ext = '.png';
          else if (contentType.includes('webp')) ext = '.webp';
          else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';

          const saved = this.#storage.saveOnlineWallpaper(buf, ext, {
            name: pick.name,
            sourceId: pick.sourceId,
            sourceLabel: pick.sourceLabel,
            url: pick.url,
          });
          this.#recentIds = [pick.id, ...this.#recentIds.filter((x) => x !== pick.id)].slice(0, 20);
          return saved;
        } catch (err) {
          lastErr = err;
        }
      }
    }

    throw new Error(lastErr ? `开源图库拉取失败：${lastErr.message}` : '开源图库暂无可用壁纸');
  }
}
