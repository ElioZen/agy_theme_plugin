import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findAgyBinary() {
  const candidates = [
    join(homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'agy';
}

const PYTHON_PTY_RUNNER = `
import os, pty, select, subprocess, sys, time

agy_bin, settings_json, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.exists(out_path):
    try:
        os.remove(out_path)
    except OSError:
        pass

master, slave = pty.openpty()
proc = subprocess.Popen(
    [agy_bin, "--project", "default-cli-project", "--settings", settings_json],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

deadline = time.time() + 10.0
captured_at = 0.0
try:
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                os.read(master, 4096)
            except OSError:
                break
        if os.path.exists(out_path) and os.path.getsize(out_path) > 20:
            try:
                with open(out_path, "r", encoding="utf-8") as f:
                    txt = f.read()
                if '"quota"' in txt and '"remaining_fraction"' in txt:
                    if captured_at == 0.0:
                        captured_at = time.time()
                    elif time.time() - captured_at >= 0.4:
                        break
            except OSError:
                pass
finally:
    try:
        os.write(master, b"\\x04\\x04")
        proc.wait(timeout=1.5)
    except Exception:
        try:
            proc.terminate()
            proc.wait(timeout=1.5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    try:
        os.close(master)
    except OSError:
        pass
`;

// ==================== CODEX OFFICIAL RATE-LIMIT READER ====================
const codexRateLimitFileCache = new Map();

function listRecentCodexSessionFiles(limit = 10, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - maxAgeMs;
  const out = [];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoff) {
            out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

function readCodexTailRateLimits(fileInfo) {
  const cacheKey = `${fileInfo.mtimeMs}:${fileInfo.size}`;
  const cached = codexRateLimitFileCache.get(fileInfo.path);
  if (cached && cached.cacheKey === cacheKey) return cached.data;

  const TAIL_BYTES = 128 * 1024;
  let fd;
  let text = '';
  try {
    fd = openSync(fileInfo.path, 'r');
    const start = Math.max(0, fileInfo.size - TAIL_BYTES);
    const len = Math.min(fileInfo.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    text = buf.subarray(0, n).toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  const samples = [];
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"rate_limits"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const rl = obj?.payload?.rate_limits;
    if (!rl || typeof rl !== 'object') continue;
    const ts = Date.parse(obj.timestamp || '') || fileInfo.mtimeMs;
    const windows = [];
    for (const w of [rl.primary, rl.secondary]) {
      if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number') continue;
      const winMin = Number(w.window_minutes || 0);
      const kind = winMin > 0 && winMin <= 600 ? 'h5' : 'weekly';
      const resetAtMs = Number(w.resets_at || 0) * 1000;
      const usedPct = Math.max(0, Math.min(100, Math.round(Number(w.used_percent) * 10) / 10));
      const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);
      windows.push({
        key: `codex-${kind}`,
        kind,
        windowMinutes: winMin,
        remainingPct,
        usedPct,
        resetAtMs,
      });
    }
    if (windows.length) {
      samples.push({ ts, limitId: rl.limit_id || 'codex', windows });
    }
  }

  codexRateLimitFileCache.set(fileInfo.path, { cacheKey, data: samples });
  return samples;
}

function readCodexOfficialQuota(nowMs) {
  const files = listRecentCodexSessionFiles(10, 7 * 24 * 60 * 60 * 1000);
  if (!files.length) return null;

  let latestByKind = { weekly: null, h5: null };
  const historyByKey = { 'codex-weekly': [], 'codex-h5': [] };
  let freshestTs = 0;

  for (const f of files) {
    const samples = readCodexTailRateLimits(f);
    for (const s of samples) {
      if (s.ts > freshestTs) freshestTs = s.ts;
      for (const w of s.windows) {
        const key = w.key;
        historyByKey[key].push({
          ts: s.ts,
          remainingPct: w.remainingPct,
          resetAtMs: w.resetAtMs,
        });
        const cur = latestByKind[w.kind];
        if (!cur || s.ts > cur.ts) {
          latestByKind[w.kind] = { ...w, ts: s.ts };
        }
      }
    }
  }

  if (!latestByKind.weekly && !latestByKind.h5) return null;

  const formatCodexBucket = (raw) => {
    if (!raw) return null;
    const expired = raw.resetAtMs > 0 && nowMs >= raw.resetAtMs;
    const remainingPct = expired ? 100 : raw.remainingPct;
    const usedPct = expired ? 0 : raw.usedPct;
    const windowMs =
      raw.windowMinutes > 0
        ? raw.windowMinutes * 60 * 1000
        : raw.kind === 'h5'
        ? 5 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
    const base = {
      key: raw.key,
      remainingPct,
      usedPct,
      resetAtMs: expired ? 0 : raw.resetAtMs,
      resetInMs: expired ? 0 : Math.max(0, raw.resetAtMs - nowMs),
      windowMs,
    };
    return attachBurnMetrics(base, historyByKey[raw.key] || [], nowMs);
  };

  return {
    available: true,
    label: 'Codex 系列',
    fetchedAtMs: freshestTs,
    weekly: formatCodexBucket(latestByKind.weekly),
    h5: formatCodexBucket(latestByKind.h5),
  };
}

// ==================== BURN RATE & LOW-QUOTA ALERT ====================
function attachBurnMetrics(bucket, rawHistory, nowMs) {
  if (!bucket) return null;
  const alertLevel =
    bucket.remainingPct <= 10 ? 'critical' : bucket.remainingPct < 20 ? 'warn' : 'normal';

  // Look back up to 2.5 hours within the same reset cycle for continuous consumption rate
  const LOOKBACK_MS = 2.5 * 60 * 60 * 1000;
  const MIN_SPAN_MS = 4 * 60 * 1000;
  const valid = (rawHistory || [])
    .filter((s) => {
      if (!s || typeof s.remainingPct !== 'number' || !s.ts) return false;
      if (nowMs - s.ts > LOOKBACK_MS || s.ts > nowMs + 60_000) return false;
      if (bucket.resetAtMs && s.resetAtMs && Math.abs(s.resetAtMs - bucket.resetAtMs) > 15 * 60 * 1000) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.ts - b.ts);

  // Find earliest point in the current uninterrupted descent ending at bucket.remainingPct
  let anchor = null;
  if (valid.length > 0) {
    let nextVal = bucket.remainingPct;
    for (let i = valid.length - 1; i >= 0; i -= 1) {
      const pt = valid[i];
      // If remainingPct jumped UP significantly after this point, a reset happened in between
      if (pt.remainingPct < nextVal - 1.5) break;
      anchor = pt;
      nextVal = Math.max(nextVal, pt.remainingPct);
    }
  }

  let burnPctPerHour = 0;
  let etaMs = 0;
  let willExhaustBeforeReset = false;
  let burnSource = '';

  // Layer 1: Live recent consumption velocity from ring-buffer samples (last 2.5h)
  if (anchor && nowMs - anchor.ts >= MIN_SPAN_MS) {
    const dropped = anchor.remainingPct - bucket.remainingPct;
    if (dropped >= 0.3) {
      const hours = (nowMs - anchor.ts) / (60 * 60 * 1000);
      burnPctPerHour = Math.round((dropped / hours) * 10) / 10;
      burnSource = 'recent';
    }
  }

  // Layer 2: Official cycle-average pace fallback (usedPct / elapsedInCycle)
  // Gives instant, accurate burn & depletion ETA even right after startup or between bursts!
  if (burnPctPerHour < 0.1 && bucket.usedPct >= 0.5 && bucket.windowMs > 0 && bucket.resetInMs > 0) {
    const elapsedMs = bucket.windowMs - bucket.resetInMs;
    if (elapsedMs >= 5 * 60 * 1000 && elapsedMs <= bucket.windowMs) {
      const elapsedHours = elapsedMs / (60 * 60 * 1000);
      const rate = bucket.usedPct / elapsedHours;
      if (rate >= 0.1) {
        burnPctPerHour = Math.round(rate * 10) / 10;
        burnSource = 'cycle';
      }
    }
  }

  if (burnPctPerHour >= 0.1 && bucket.remainingPct > 0) {
    etaMs = Math.round((bucket.remainingPct / burnPctPerHour) * 60 * 60 * 1000);
    willExhaustBeforeReset = Boolean(bucket.resetInMs > 0 && etaMs < bucket.resetInMs);
  }

  return {
    ...bucket,
    alertLevel,
    burnPctPerHour,
    burnSource,
    etaMs,
    willExhaustBeforeReset,
  };
}

export class AgyQuotaFetcher {
  #storage;
  #cachePath;
  #historyPath;
  #captureScriptPath;
  #livePayloadPath;
  #inFlight = null;
  #timer = null;
  #lastError = '';
  #cached = null;
  #history = {};

  constructor(storage) {
    this.#storage = storage;
    this.#cachePath = join(storage.dataDir, 'quota_cache.json');
    this.#historyPath = join(storage.dataDir, 'quota_history.json');
    this.#captureScriptPath = join(storage.dataDir, 'quota_capture.sh');
    this.#livePayloadPath = join(storage.dataDir, 'quota_live.json');
    this.#loadCache();
    this.#loadHistory();
  }

  #loadCache() {
    try {
      if (existsSync(this.#cachePath)) {
        this.#cached = JSON.parse(readFileSync(this.#cachePath, 'utf-8'));
      }
    } catch {
      this.#cached = null;
    }
  }

  #loadHistory() {
    try {
      if (existsSync(this.#historyPath)) {
        this.#history = JSON.parse(readFileSync(this.#historyPath, 'utf-8')) || {};
      }
    } catch {
      this.#history = {};
    }
  }

  #saveCache(snapshot) {
    this.#cached = snapshot;
    const tmp = `${this.#cachePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    renameSync(tmp, this.#cachePath);
  }

  #recordHistory(rawQuota, ts) {
    if (!rawQuota || typeof rawQuota !== 'object') return;
    const maxAgeMs = 6 * 60 * 60 * 1000;
    let changed = false;

    for (const [key, b] of Object.entries(rawQuota)) {
      if (!b || typeof b !== 'object') continue;
      const frac = Number(b.remaining_fraction);
      if (!Number.isFinite(frac)) continue;
      const remainingPct = Math.max(0, Math.min(100, Math.round(frac * 1000) / 10));
      const resetAtMs = b.reset_time
        ? Date.parse(b.reset_time)
        : Number.isFinite(Number(b.reset_in_seconds))
        ? ts + Number(b.reset_in_seconds) * 1000
        : 0;

      const list = Array.isArray(this.#history[key]) ? this.#history[key] : [];
      const pruned = list.filter((pt) => pt && ts - pt.ts <= maxAgeMs);
      const last = pruned[pruned.length - 1];
      if (!last || ts - last.ts >= 45_000 || Math.abs(last.remainingPct - remainingPct) >= 0.1) {
        pruned.push({ ts, remainingPct, resetAtMs });
        changed = true;
      }
      this.#history[key] = pruned.slice(-120);
    }

    if (changed) {
      try {
        const tmp = `${this.#historyPath}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(this.#history), 'utf-8');
        renameSync(tmp, this.#historyPath);
      } catch {
        // ignore
      }
    }
  }

  #ensureCaptureScript() {
    const script = `#!/usr/bin/env bash\ncat > "${this.#livePayloadPath}.tmp" && mv "${this.#livePayloadPath}.tmp" "${this.#livePayloadPath}"\necho "ok"\n`;
    writeFileSync(this.#captureScriptPath, script, 'utf-8');
    chmodSync(this.#captureScriptPath, 0o755);
  }

  startAutoRefresh(intervalMs = 3 * 60 * 1000) {
    this.refresh().catch(() => {});
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, intervalMs);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async refresh() {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#runCapture().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  #runCapture() {
    return new Promise((resolve) => {
      try {
        this.#ensureCaptureScript();
        const agyBin = findAgyBinary();
        const settingsJson = JSON.stringify({
          statusLine: {
            type: 'command',
            command: this.#captureScriptPath,
            enabled: true,
          },
        });

        const child = spawn('python3', ['-c', PYTHON_PTY_RUNNER, agyBin, settingsJson, this.#livePayloadPath], {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            PATH: `${join(homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
          },
        });

        let errBuf = '';
        child.stderr?.on('data', (c) => {
          errBuf += c.toString();
        });

        const hardKill = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 14000);

        child.on('exit', () => {
          clearTimeout(hardKill);
          try {
            if (existsSync(this.#livePayloadPath)) {
              const raw = JSON.parse(readFileSync(this.#livePayloadPath, 'utf-8'));
              if (raw && raw.quota && typeof raw.quota === 'object' && Object.keys(raw.quota).length > 0) {
                const nowMs = Date.now();
                const snap = {
                  fetchedAtMs: nowMs,
                  planTier: raw.plan_tier || null,
                  rawQuota: raw.quota,
                };
                this.#saveCache(snap);
                this.#recordHistory(raw.quota, nowMs);
                this.#lastError = '';
                this.#inFlight = null;
                resolve(this.getSnapshot());
                return;
              }
            }
            this.#lastError = errBuf.trim().slice(0, 140) || '未捕获到官方额度数据';
          } catch (err) {
            this.#lastError = err.message;
          }
          this.#inFlight = null;
          resolve(this.getSnapshot());
        });
      } catch (err) {
        this.#lastError = err.message;
        this.#inFlight = null;
        resolve(this.getSnapshot());
      }
    });
  }

  getSnapshot() {
    const nowMs = Date.now();
    const raw = this.#cached?.rawQuota || null;
    const fetchedAtMs = this.#cached?.fetchedAtMs || 0;

    // Seed initial history point from cache if history file is empty
    if (raw && fetchedAtMs && Object.keys(this.#history).length === 0) {
      this.#recordHistory(raw, fetchedAtMs);
    }

    const parseBucket = (key) => {
      const b = raw?.[key];
      if (!b || typeof b !== 'object') return null;
      const frac = Number(b.remaining_fraction);
      if (!Number.isFinite(frac)) return null;
      const resetAtMs = b.reset_time ? Date.parse(b.reset_time) : 0;
      const fallbackResetAt =
        !resetAtMs && Number.isFinite(Number(b.reset_in_seconds)) && fetchedAtMs
          ? fetchedAtMs + Number(b.reset_in_seconds) * 1000
          : 0;
      const finalResetAtMs = resetAtMs || fallbackResetAt;
      const expired = finalResetAtMs > 0 && nowMs >= finalResetAtMs;
      const remainingPct = expired ? 100 : Math.max(0, Math.min(100, Math.round(frac * 1000) / 10));
      const usedPct = Math.max(0, Math.round((100 - remainingPct) * 10) / 10);
      const windowMs = key.includes('5h')
        ? 5 * 60 * 60 * 1000
        : key.includes('weekly')
        ? 7 * 24 * 60 * 60 * 1000
        : 0;
      return attachBurnMetrics(
        {
          key,
          remainingPct,
          usedPct,
          resetAtMs: expired ? 0 : finalResetAtMs,
          resetInMs: expired ? 0 : Math.max(0, finalResetAtMs - nowMs),
          windowMs,
        },
        this.#history[key] || [],
        nowMs,
      );
    };

    const codexQuota = readCodexOfficialQuota(nowMs);

    const knownKeys = new Set(['gemini-weekly', 'gemini-5h', '3p-weekly', '3p-5h']);
    const extras = [];
    if (raw) {
      for (const k of Object.keys(raw)) {
        if (knownKeys.has(k)) continue;
        const parsed = parseBucket(k);
        if (parsed) extras.push(parsed);
      }
    }

    return {
      available: Boolean(raw || codexQuota?.available),
      syncing: Boolean(this.#inFlight),
      fetchedAtMs,
      error: this.#lastError,
      gemini: {
        label: 'Gemini 系列',
        weekly: parseBucket('gemini-weekly'),
        h5: parseBucket('gemini-5h'),
      },
      claude: {
        label: 'Claude / GPT 系列',
        weekly: parseBucket('3p-weekly'),
        h5: parseBucket('3p-5h'),
      },
      codex: codexQuota,
      extras,
    };
  }
}
