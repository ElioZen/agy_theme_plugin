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
  unlinkSync,
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

function findCodexBinary() {
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.npm-global', 'bin', 'codex'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'codex';
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

const PYTHON_MODEL_PROBE_RUNNER = `
import json, os, pty, select, subprocess, sys, time

agy_bin, model_id, settings_json, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
if os.path.exists(out_path):
    try:
        os.remove(out_path)
    except OSError:
        pass

master, slave = pty.openpty()
proc = subprocess.Popen(
    [agy_bin, "--project", "default-cli-project", "--model", model_id, "--settings", settings_json],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

deadline = time.time() + 7.5
try:
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.15)
        if r:
            try:
                os.read(master, 4096)
            except OSError:
                break
        if os.path.exists(out_path) and os.path.getsize(out_path) > 20:
            try:
                with open(out_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("context_window", {}).get("context_window_size"):
                    break
            except Exception:
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

function extractModelFamilyKey(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[\s_()]+/g, '-');
  if (!s) return '';
  if (s.includes('claude')) {
    const tier = s.includes('opus') ? 'opus' : s.includes('sonnet') ? 'sonnet' : s.includes('haiku') ? 'haiku' : 'other';
    const vm = s.match(/(\d+)[.-](\d+)/);
    return `claude-${tier}${vm ? `-${vm[1]}.${vm[2]}` : ''}`;
  }
  if (s.includes('orchestrator')) {
    if (s.includes('neon')) return 'gemini-orchestrator-neon';
    if (s.includes('argon')) return 'gemini-orchestrator-argon';
    return 'gemini-orchestrator-carbon';
  }
  if (s.includes('gemini')) {
    if (s.includes('neon')) return 'gemini-neon';
    if (s.includes('carbon')) return 'gemini-carbon';
    if (s.includes('argon')) return 'gemini-argon';
    if (s.includes('hydrogen')) return 'gemini-hydrogen';
    if (s.includes('flash')) return 'gemini-flash';
    return 'gemini';
  }
  if (s.includes('gpt-oss')) return 'gpt-oss';
  if (s.includes('gpt-')) return 'gpt';
  return '';
}

function normalizeProbeModelArg(rawModel) {
  const clean = String(rawModel || '').trim();
  if (!clean) return '';
  // e.g. gemini-4-hydrogen-tiered-high -> gemini-4-hydrogen-high
  return clean.replace(/-tiered(?=-|$)/i, '');
}

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

function parseCodexRateLimitsObject(rl, ts) {
  if (!rl || typeof rl !== 'object') return [];
  const windows = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w !== 'object') continue;
    const usedRaw = typeof w.usedPercent === 'number' ? w.usedPercent : w.used_percent;
    if (typeof usedRaw !== 'number') continue;
    const winMin = Number(w.windowDurationMins ?? w.window_minutes ?? 0);
    const kind = winMin > 0 && winMin <= 600 ? 'h5' : 'weekly';
    const resetSec = Number(w.resetsAt ?? w.resets_at ?? 0);
    const resetAtMs = resetSec > 1e12 ? resetSec : resetSec * 1000;
    const usedPct = Math.max(0, Math.min(100, Math.round(Number(usedRaw) * 10) / 10));
    const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);
    windows.push({
      key: `codex-${kind}`,
      kind,
      windowMinutes: winMin,
      remainingPct,
      usedPct,
      resetAtMs,
      ts,
    });
  }
  return windows;
}

function readCodexOfficialQuota(nowMs, liveCache = null, savedHistory = {}) {
  const files = listRecentCodexSessionFiles(10, 7 * 24 * 60 * 60 * 1000);
  const passiveByKind = { weekly: null, h5: null };
  const historyByKey = {
    'codex-weekly': Array.isArray(savedHistory?.['codex-weekly']) ? [...savedHistory['codex-weekly']] : [],
    'codex-h5': Array.isArray(savedHistory?.['codex-h5']) ? [...savedHistory['codex-h5']] : [],
  };
  let passiveFreshestTs = 0;

  for (const f of files) {
    const samples = readCodexTailRateLimits(f);
    for (const s of samples) {
      if (s.ts > passiveFreshestTs) passiveFreshestTs = s.ts;
      for (const w of s.windows) {
        const key = w.key;
        historyByKey[key].push({
          ts: s.ts,
          remainingPct: w.remainingPct,
          resetAtMs: w.resetAtMs,
        });
        const cur = passiveByKind[w.kind];
        if (!cur || s.ts > cur.ts) {
          passiveByKind[w.kind] = { ...w, ts: s.ts };
        }
      }
    }
  }

  const liveFetchedAtMs = Number(liveCache?.fetchedAtMs || 0);
  const liveByKind = { weekly: null, h5: null };
  if (liveCache?.windows && Array.isArray(liveCache.windows)) {
    for (const w of liveCache.windows) {
      if (!w || !w.kind) continue;
      liveByKind[w.kind] = { ...w, ts: liveFetchedAtMs };
    }
  }
  const hasLive = Boolean(liveFetchedAtMs > 0 && (liveByKind.weekly || liveByKind.h5));
  const useLive = hasLive && liveFetchedAtMs >= passiveFreshestTs;

  const chosenByKind = useLive ? liveByKind : passiveByKind;
  const freshestTs = useLive ? liveFetchedAtMs : passiveFreshestTs;

  if (!chosenByKind.weekly && !chosenByKind.h5) return null;

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
    source: useLive ? 'app-server' : 'session-log',
    planType: liveCache?.planType || null,
    credits: liveCache?.credits || null,
    weekly: formatCodexBucket(chosenByKind.weekly),
    h5: formatCodexBucket(chosenByKind.h5),
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
  #codexCachePath;
  #historyPath;
  #modelCtxPath;
  #captureScriptPath;
  #livePayloadPath;
  #inFlight = null;
  #timer = null;
  #lastError = '';
  #cached = null;
  #codexCached = null;
  #history = {};
  #modelCtxCache = {};
  #modelProbeQueue = [];
  #modelProbeQueuedSet = new Set();
  #modelProbing = false;

  constructor(storage) {
    this.#storage = storage;
    this.#cachePath = join(storage.dataDir, 'quota_cache.json');
    this.#codexCachePath = join(storage.dataDir, 'codex_quota_cache.json');
    this.#historyPath = join(storage.dataDir, 'quota_history.json');
    this.#modelCtxPath = join(storage.dataDir, 'model_context_cache.json');
    this.#captureScriptPath = join(storage.dataDir, 'quota_capture.sh');
    this.#livePayloadPath = join(storage.dataDir, 'quota_live.json');
    this.#loadCache();
    this.#loadCodexCache();
    this.#loadHistory();
    this.#loadModelCtxCache();
    this.#seedModelCtxFromLiveFile();
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

  #loadCodexCache() {
    try {
      if (existsSync(this.#codexCachePath)) {
        this.#codexCached = JSON.parse(readFileSync(this.#codexCachePath, 'utf-8'));
      }
    } catch {
      this.#codexCached = null;
    }
  }

  #saveCodexCache(snapshot) {
    this.#codexCached = snapshot;
    try {
      const tmp = `${this.#codexCachePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      renameSync(tmp, this.#codexCachePath);
    } catch {
      // ignore
    }
  }

  #recordCodexHistory(windows, ts) {
    if (!Array.isArray(windows) || !windows.length) return;
    const maxAgeMs = 6 * 60 * 60 * 1000;
    let changed = false;
    for (const w of windows) {
      if (!w?.key || typeof w.remainingPct !== 'number') continue;
      const list = Array.isArray(this.#history[w.key]) ? this.#history[w.key] : [];
      const pruned = list.filter((pt) => pt && ts - pt.ts <= maxAgeMs);
      const last = pruned[pruned.length - 1];
      if (!last || ts - last.ts >= 45_000 || Math.abs(last.remainingPct - w.remainingPct) >= 0.1) {
        pruned.push({ ts, remainingPct: w.remainingPct, resetAtMs: w.resetAtMs || 0 });
        changed = true;
      }
      this.#history[w.key] = pruned.slice(-120);
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

  #loadHistory() {
    try {
      if (existsSync(this.#historyPath)) {
        this.#history = JSON.parse(readFileSync(this.#historyPath, 'utf-8')) || {};
      }
    } catch {
      this.#history = {};
    }
  }

  #loadModelCtxCache() {
    try {
      if (existsSync(this.#modelCtxPath)) {
        this.#modelCtxCache = JSON.parse(readFileSync(this.#modelCtxPath, 'utf-8')) || {};
      }
    } catch {
      this.#modelCtxCache = {};
    }
  }

  #saveModelCtxCache() {
    try {
      const tmp = `${this.#modelCtxPath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(this.#modelCtxCache, null, 2), 'utf-8');
      renameSync(tmp, this.#modelCtxPath);
    } catch {
      // ignore
    }
  }

  #recordModelCtxFromRaw(raw, requestedModel = '') {
    const size = Number(raw?.context_window?.context_window_size || 0);
    if (!Number.isFinite(size) || size < 4096) return false;
    const returnedName = String(raw?.model?.display_name || raw?.model?.id || '').trim();
    const returnedFam = extractModelFamilyKey(returnedName);
    const nowMs = Date.now();
    let changed = false;

    if (returnedFam) {
      this.#modelCtxCache[`family:${returnedFam}`] = {
        limit: size,
        displayName: returnedName,
        fetchedAtMs: nowMs,
      };
      changed = true;
    }

    if (requestedModel) {
      const reqKey = requestedModel.toLowerCase();
      const reqFam = extractModelFamilyKey(requestedModel);
      if (reqFam && returnedFam && reqFam === returnedFam) {
        this.#modelCtxCache[reqKey] = {
          limit: size,
          displayName: returnedName || requestedModel,
          fetchedAtMs: nowMs,
        };
        changed = true;
      } else {
        // agy fell back to default model because requestedModel is legacy/unknown; remember so we don't loop
        this.#modelCtxCache[reqKey] = {
          limit: 0,
          unmatched: true,
          returnedName,
          fetchedAtMs: nowMs,
        };
        changed = true;
      }
    }

    if (changed) this.#saveModelCtxCache();
    return changed;
  }

  #seedModelCtxFromLiveFile() {
    try {
      if (existsSync(this.#livePayloadPath)) {
        const raw = JSON.parse(readFileSync(this.#livePayloadPath, 'utf-8'));
        if (raw) this.#recordModelCtxFromRaw(raw);
      }
    } catch {
      // ignore
    }
  }

  getModelContextWindow(rawModel) {
    const key = String(rawModel || '').trim().toLowerCase();
    if (!key) return null;
    const nowMs = Date.now();
    const TTL_MS = 24 * 60 * 60 * 1000;
    const UNMATCHED_TTL_MS = 6 * 60 * 60 * 1000;

    const exact = this.#modelCtxCache[key];
    if (exact) {
      if (exact.limit > 0 && nowMs - Number(exact.fetchedAtMs || 0) < TTL_MS) {
        return {
          limit: exact.limit,
          source: 'agy-official',
          displayName: exact.displayName || rawModel,
          fetchedAtMs: exact.fetchedAtMs,
        };
      }
      if (exact.unmatched && nowMs - Number(exact.fetchedAtMs || 0) < UNMATCHED_TTL_MS) {
        return null;
      }
    }

    const fam = extractModelFamilyKey(key);
    const famEntry = fam ? this.#modelCtxCache[`family:${fam}`] : null;
    if (famEntry && famEntry.limit > 0 && nowMs - Number(famEntry.fetchedAtMs || 0) < TTL_MS) {
      return {
        limit: famEntry.limit,
        source: 'agy-official',
        displayName: famEntry.displayName || rawModel,
        fetchedAtMs: famEntry.fetchedAtMs,
      };
    }

    // Queue non-blocking background official probe for recognized AGY model IDs
    if (fam && !key.includes('placeholder') && !key.startsWith('gpt-5') && !key.startsWith('gpt-6')) {
      this.#enqueueModelProbe(rawModel);
    }
    return null;
  }

  #enqueueModelProbe(rawModel) {
    const key = String(rawModel || '').trim().toLowerCase();
    if (!key || this.#modelProbeQueuedSet.has(key)) return;
    this.#modelProbeQueuedSet.add(key);
    this.#modelProbeQueue.push(String(rawModel).trim());
    this.#drainModelProbeQueue();
  }

  #drainModelProbeQueue() {
    if (this.#modelProbing || this.#modelProbeQueue.length === 0) return;
    this.#modelProbing = true;
    const rawModel = this.#modelProbeQueue.shift();
    const key = rawModel.toLowerCase();
    const probeArg = normalizeProbeModelArg(rawModel);
    const probeOut = join(this.#storage.dataDir, `model_ctx_probe_${process.pid}.json`);
    const probeSh = join(this.#storage.dataDir, `model_ctx_probe_${process.pid}.sh`);

    const finish = () => {
      for (const p of [probeOut, `${probeOut}.tmp`, probeSh]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          // ignore
        }
      }
      this.#modelProbeQueuedSet.delete(key);
      this.#modelProbing = false;
      if (this.#modelProbeQueue.length > 0) {
        setTimeout(() => this.#drainModelProbeQueue(), 120);
      }
    };

    try {
      const script = `#!/usr/bin/env bash\ncat > "${probeOut}.tmp" && mv "${probeOut}.tmp" "${probeOut}"\necho "ok"\n`;
      writeFileSync(probeSh, script, 'utf-8');
      chmodSync(probeSh, 0o755);

      const agyBin = findAgyBinary();
      const settingsJson = JSON.stringify({
        statusLine: { type: 'command', command: probeSh, enabled: true },
      });

      const child = spawn('python3', ['-c', PYTHON_MODEL_PROBE_RUNNER, agyBin, probeArg, settingsJson, probeOut], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          PATH: `${join(homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        },
      });

      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 11000);

      child.on('exit', () => {
        clearTimeout(hardKill);
        try {
          if (existsSync(probeOut)) {
            const raw = JSON.parse(readFileSync(probeOut, 'utf-8'));
            this.#recordModelCtxFromRaw(raw, rawModel);
          } else {
            this.#modelCtxCache[key] = { limit: 0, unmatched: true, fetchedAtMs: Date.now() };
            this.#saveModelCtxCache();
          }
        } catch {
          // ignore
        }
        finish();
      });
    } catch {
      finish();
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
    this.#inFlight = Promise.all([this.#runCapture(), this.#runCodexCapture()])
      .then(() => this.getSnapshot())
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  #runCodexCapture() {
    return new Promise((resolve) => {
      let settled = false;
      let child = null;
      let hardKill = null;
      let termKill = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (hardKill) clearTimeout(hardKill);
        if (termKill) clearTimeout(termKill);
        if (child && !child.killed) {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          termKill = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, 1200);
          termKill.unref?.();
        }
        resolve();
      };

      try {
        const codexBin = findCodexBinary();
        child = spawn(codexBin, ['app-server', '--stdio'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}`,
          },
        });

        hardKill = setTimeout(finish, 9000);
        let stdoutBuf = '';
        let sentRateLimitReq = false;

        const sendRpc = (obj) => {
          try {
            child.stdin?.write(`${JSON.stringify(obj)}\n`);
          } catch {
            // ignore
          }
        };

        child.stdout?.on('data', (chunk) => {
          stdoutBuf += chunk.toString('utf-8');
          let nl;
          while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.id === 1 && !sentRateLimitReq) {
              sentRateLimitReq = true;
              sendRpc({ jsonrpc: '2.0', method: 'initialized', params: {} });
              sendRpc({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
            } else if (msg.id === 2) {
              const res = msg.result || {};
              const rl = res.rateLimits || res.rateLimitsByLimitId?.codex || null;
              const nowMs = Date.now();
              const windows = parseCodexRateLimitsObject(rl, nowMs);
              if (windows.length > 0) {
                const balRaw = rl?.credits?.balance;
                const balNum = balRaw !== undefined && balRaw !== null ? Number(balRaw) : null;
                const snap = {
                  fetchedAtMs: nowMs,
                  planType: rl?.planType || null,
                  ordinaryUsageAllowed: res.ordinaryUsageAllowed !== false,
                  credits: rl?.credits
                    ? {
                        hasCredits: Boolean(rl.credits.hasCredits),
                        unlimited: Boolean(rl.credits.unlimited),
                        balance: Number.isFinite(balNum) ? Math.round(balNum * 10) / 10 : null,
                      }
                    : null,
                  windows,
                };
                this.#saveCodexCache(snap);
                this.#recordCodexHistory(windows, nowMs);
              }
              finish();
              return;
            }
          }
        });

        child.on('error', finish);
        child.on('exit', finish);

        sendRpc({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'prism-orbit', version: '3.8.1' } },
        });
      } catch {
        finish();
      }
    });
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
              if (raw) this.#recordModelCtxFromRaw(raw);
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
                resolve(this.getSnapshot());
                return;
              }
            }
            this.#lastError = errBuf.trim().slice(0, 140) || '未捕获到官方额度数据';
          } catch (err) {
            this.#lastError = err.message;
          }
          resolve(this.getSnapshot());
        });
      } catch (err) {
        this.#lastError = err.message;
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

    const codexQuota = readCodexOfficialQuota(nowMs, this.#codexCached, this.#history);

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
