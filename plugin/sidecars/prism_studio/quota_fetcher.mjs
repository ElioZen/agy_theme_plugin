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
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { IS_WIN, IS_WSL, getWindowsUserProfileInWsl, toWindowsPath } from './platform.mjs';

function buildCliPathEnv() {
  const extra = [];
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    extra.push(
      join(localAppData, 'agy', 'bin'),
      join(homedir(), '.local', 'bin'),
      join(appData, 'npm'),
    );
  } else {
    extra.push(
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.npm-global', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    );
  }
  const cur = process.env.PATH || '';
  return [...extra, cur].filter(Boolean).join(delimiter);
}

function findAgyBinary() {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const candidates = [
      join(localAppData, 'agy', 'bin', 'agy.exe'),
      join(homedir(), '.local', 'bin', 'agy.exe'),
      join(appData, 'npm', 'agy.cmd'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return { bin: p, found: true, isWinExe: true };
    }
    return { bin: 'agy', found: false, isWinExe: true };
  }

  const posixCandidates = [
    join(homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    join(homedir(), '.npm-global', 'bin', 'agy'),
  ];
  for (const p of posixCandidates) {
    if (existsSync(p)) return { bin: p, found: true, isWinExe: false };
  }

  if (IS_WSL) {
    const winProfile = getWindowsUserProfileInWsl();
    if (winProfile) {
      const winCandidates = [
        join(winProfile, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
        join(winProfile, '.local', 'bin', 'agy.exe'),
      ];
      for (const p of winCandidates) {
        if (existsSync(p)) return { bin: p, found: true, isWinExe: true };
      }
    }
  }

  return { bin: 'agy', found: false, isWinExe: false };
}

function findCodexBinary() {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const candidates = [
      join(appData, 'npm', 'codex.cmd'),
      join(localAppData, 'Programs', 'codex', 'codex.exe'),
      join(homedir(), '.local', 'bin', 'codex.exe'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        return { bin: p, useShell: /\.(cmd|bat)$/i.test(p), useWslCmd: false };
      }
    }
    return { bin: 'codex', useShell: true, useWslCmd: false };
  }

  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.npm-global', 'bin', 'codex'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { bin: p, useShell: false, useWslCmd: false };
  }

  if (IS_WSL) {
    const winProfile = getWindowsUserProfileInWsl();
    if (winProfile) {
      const winCodex = join(winProfile, 'AppData', 'Roaming', 'npm', 'codex.cmd');
      if (existsSync(winCodex)) {
        return { bin: winCodex, useShell: false, useWslCmd: true };
      }
    }
  }

  return { bin: 'codex', useShell: false, useWslCmd: false };
}

function killProcessGroup(child, signal = 'SIGTERM') {
  if (!child) return;
  if (!IS_WIN && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall back to direct child signal
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

const PYTHON_PTY_RUNNER = `
import fcntl, os, pty, select, signal, subprocess, sys, termios, time

agy_bin, settings_json, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.exists(out_path):
    try:
        os.remove(out_path)
    except OSError:
        pass

def _on_term(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, _on_term)

master, slave = pty.openpty()

def _setup_child():
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except OSError:
        pass

proc = subprocess.Popen(
    [agy_bin, "--project", "default-cli-project", "--settings", settings_json],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
    preexec_fn=_setup_child,
)
os.close(slave)

deadline = time.time() + 14.0
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
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            proc.wait(timeout=1.0)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=1.0)
            except Exception:
                pass
    try:
        os.close(master)
    except OSError:
        pass
`;

const PYTHON_MODEL_PROBE_RUNNER = `
import fcntl, json, os, pty, select, signal, subprocess, sys, termios, time

agy_bin, model_id, settings_json, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
if os.path.exists(out_path):
    try:
        os.remove(out_path)
    except OSError:
        pass

def _on_term(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, _on_term)

master, slave = pty.openpty()

def _setup_child():
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except OSError:
        pass

proc = subprocess.Popen(
    [agy_bin, "--project", "default-cli-project", "--model", model_id, "--settings", settings_json],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
    preexec_fn=_setup_child,
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
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            proc.wait(timeout=1.0)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=1.0)
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

// ==================== DATE & LEDGER HELPERS ====================
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LEDGER_RETENTION_DAYS = 35;
const WEEKLY_LOOKBACK_DAYS = 14;
const EWMA_HALF_LIFE_DAYS = 3.5;

function toLocalDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addLocalDays(dayKey, delta) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return toLocalDayKey(new Date(y, m - 1, d + delta, 0, 0, 0, 0).getTime());
}

function dayDiffBetweenKeys(fromKey, toKey) {
  const [ay, am, ad] = fromKey.split('-').map(Number);
  const [by, bm, bd] = toKey.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

function clusterCycleId(resetAtMs) {
  const n = Number(resetAtMs || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / (2 * HOUR_MS)) * (2 * HOUR_MS);
}

function normalizeHourlyShare(hourWeight, totalWeight, activeDayCount) {
  const uniform = 1 / 24;
  if (!totalWeight || totalWeight <= 0 || activeDayCount <= 0) {
    return new Array(24).fill(uniform);
  }
  const uniformAlpha = activeDayCount >= 5 ? 0.15 : activeDayCount >= 2 ? 0.35 : 0.65;
  return hourWeight.map((w) => (1 - uniformAlpha) * (w / totalWeight) + uniformAlpha * uniform);
}

function computeDiurnalExposure(nowMs, hourlyShare) {
  const d = new Date(nowMs);
  const h = d.getHours();
  const minFrac = (d.getMinutes() + d.getSeconds() / 60) / 60;
  const share =
    Array.isArray(hourlyShare) && hourlyShare.length === 24
      ? hourlyShare
      : new Array(24).fill(1 / 24);
  let sum = 0;
  for (let i = 0; i < h; i += 1) sum += Number(share[i] || 0);
  sum += minFrac * Number(share[h] || 0);
  return Math.max(0, Math.min(1, sum));
}

function upsertLedgerEntry(list, { ts, remainingPct, usedPct, resetAtMs, windowMs }) {
  if (!ts || typeof usedPct !== 'number') return false;
  const dayKey = toLocalDayKey(ts);
  const cycleId = clusterCycleId(resetAtMs);
  let entry = list.find((e) => e && e.dayKey === dayKey && e.cycleId === cycleId);
  let changed = false;

  if (!entry) {
    entry = {
      dayKey,
      cycleId,
      resetAtMs: resetAtMs || 0,
      windowMs: windowMs || 0,
      firstUsedPct: usedPct,
      minUsedPct: usedPct,
      maxUsedPct: usedPct,
      lastUsedPct: usedPct,
      minRemPct: remainingPct,
      firstTs: ts,
      lastTs: ts,
      samples: 1,
    };
    list.push(entry);
    changed = true;
  } else {
    if (usedPct < entry.minUsedPct) {
      entry.minUsedPct = usedPct;
      changed = true;
    }
    if (usedPct > entry.maxUsedPct) {
      entry.maxUsedPct = usedPct;
      changed = true;
    }
    if (remainingPct < entry.minRemPct) {
      entry.minRemPct = remainingPct;
      changed = true;
    }
    if (ts < entry.firstTs) {
      entry.firstTs = ts;
      entry.firstUsedPct = usedPct;
      changed = true;
    }
    if (ts >= entry.lastTs) {
      if (Math.abs(entry.lastUsedPct - usedPct) >= 0.05 || ts - entry.lastTs >= 15 * 60_000) {
        changed = true;
      }
      entry.lastTs = ts;
      entry.lastUsedPct = usedPct;
      if (resetAtMs > 0) entry.resetAtMs = resetAtMs;
      if (windowMs > 0) entry.windowMs = windowMs;
    }
    entry.samples = Number(entry.samples || 0) + 1;
  }

  return changed;
}

function pruneLedgerList(list, nowMs) {
  const cutoffDay = addLocalDays(toLocalDayKey(nowMs), -LEDGER_RETENTION_DAYS);
  return (list || [])
    .filter((e) => e && e.dayKey && e.dayKey >= cutoffDay)
    .sort((a, b) => (a.dayKey === b.dayKey ? a.cycleId - b.cycleId : a.dayKey.localeCompare(b.dayKey)));
}

// ==================== CODEX OFFICIAL RATE-LIMIT READER ====================
const codexRateLimitFileCache = new Map();
let codexSessionDirCache = { fetchedAtMs: 0, files: [] };

function listRecentCodexSessionFiles(limit = 220, maxAgeMs = 21 * DAY_MS, force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - codexSessionDirCache.fetchedAtMs < 10_000 && codexSessionDirCache.files.length > 0) {
    return codexSessionDirCache.files.slice(0, limit);
  }
  const roots = [join(homedir(), '.codex', 'sessions')];
  if (IS_WSL) {
    const winProfile = getWindowsUserProfileInWsl();
    if (winProfile) {
      const winSessions = join(winProfile, '.codex', 'sessions');
      if (!roots.includes(winSessions)) roots.push(winSessions);
    }
  }
  const existingRoots = roots.filter((r) => existsSync(r));
  if (existingRoots.length === 0) return [];
  const cutoff = nowMs - maxAgeMs;
  const out = [];
  const seen = new Set();

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
      } else if (ent.isFile() && ent.name.endsWith('.jsonl') && !seen.has(full)) {
        seen.add(full);
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

  for (const root of existingRoots) walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  codexSessionDirCache = { fetchedAtMs: nowMs, files: out };
  return out.slice(0, limit);
}

function readCodexFileRateLimits(fileInfo) {
  const cacheKey = `${fileInfo.mtimeMs}:${fileInfo.size}`;
  const cached = codexRateLimitFileCache.get(fileInfo.path);
  if (cached && cached.cacheKey === cacheKey) return cached.data;

  const CHUNK_BYTES = 256 * 1024;
  const recentCutoffMs = fileInfo.mtimeMs - 8 * HOUR_MS;
  const latestByKind = { weekly: null, h5: null };
  const recentByKey = { 'codex-weekly': [], 'codex-h5': [] };
  const ledgerByKey = new Map();
  const hourHits = new Array(24).fill(0);
  const activeDays = new Set();
  let freshestTs = 0;

  let fd;
  try {
    fd = openSync(fileInfo.path, 'r');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let leftover = '';
    let pos = 0;

    const processLine = (line) => {
      if (!line || !line.includes('"rate_limits"')) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const rl = obj?.payload?.rate_limits;
      if (!rl || typeof rl !== 'object') return;
      const ts = Date.parse(obj.timestamp || '') || fileInfo.mtimeMs;
      if (ts > freshestTs) freshestTs = ts;
      const dObj = new Date(ts);
      hourHits[dObj.getHours()] += 1;
      const dayKey = toLocalDayKey(ts);
      activeDays.add(dayKey);

      for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number') continue;
        const winMin = Number(w.window_minutes || 0);
        const kind = winMin > 0 && winMin <= 600 ? 'h5' : 'weekly';
        const key = `codex-${kind}`;
        const resetAtMs = Number(w.resets_at || 0) * 1000;
        const windowMs =
          winMin > 0
            ? winMin * 60 * 1000
            : kind === 'h5'
            ? 5 * HOUR_MS
            : 7 * DAY_MS;
        const usedPct = Math.max(0, Math.min(100, Math.round(Number(w.used_percent) * 10) / 10));
        const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);

        const curLatest = latestByKind[kind];
        if (!curLatest || ts > curLatest.ts) {
          latestByKind[kind] = {
            key,
            kind,
            windowMinutes: winMin,
            windowMs,
            remainingPct,
            usedPct,
            resetAtMs,
            ts,
          };
        }

        if (ts >= recentCutoffMs) {
          const arr = recentByKey[key];
          const prev = arr[arr.length - 1];
          if (!prev || ts - prev.ts >= 45_000 || Math.abs(prev.remainingPct - remainingPct) >= 0.1) {
            arr.push({ ts, remainingPct, resetAtMs });
          }
        }

        if (kind === 'weekly') {
          const cycleId = clusterCycleId(resetAtMs);
          const lKey = `${dayKey}::${cycleId}`;
          let entry = ledgerByKey.get(lKey);
          if (!entry) {
            entry = {
              dayKey,
              cycleId,
              resetAtMs,
              windowMs,
              firstUsedPct: usedPct,
              minUsedPct: usedPct,
              maxUsedPct: usedPct,
              lastUsedPct: usedPct,
              minRemPct: remainingPct,
              firstTs: ts,
              lastTs: ts,
              samples: 1,
            };
            ledgerByKey.set(lKey, entry);
          } else {
            if (usedPct < entry.minUsedPct) entry.minUsedPct = usedPct;
            if (usedPct > entry.maxUsedPct) entry.maxUsedPct = usedPct;
            if (remainingPct < entry.minRemPct) entry.minRemPct = remainingPct;
            if (ts < entry.firstTs) {
              entry.firstTs = ts;
              entry.firstUsedPct = usedPct;
            }
            if (ts >= entry.lastTs) {
              entry.lastTs = ts;
              entry.lastUsedPct = usedPct;
              if (resetAtMs > 0) entry.resetAtMs = resetAtMs;
            }
            entry.samples += 1;
          }
        }
      }
    };

    while (pos < fileInfo.size) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (n <= 0) break;
      pos += n;
      const chunkStr = leftover + decoder.write(buf.subarray(0, n));
      const parts = chunkStr.split('\n');
      leftover = parts.pop() || '';
      for (const line of parts) processLine(line);
    }
    const tail = leftover + decoder.end();
    if (tail) processLine(tail);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  const data = {
    freshestTs,
    latestByKind,
    recentByKey,
    weeklyLedger: [...ledgerByKey.values()],
    hourHits,
    activeDays: [...activeDays],
  };
  codexRateLimitFileCache.set(fileInfo.path, { cacheKey, data });
  return data;
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

function readCodexOfficialQuota(
  nowMs,
  liveCache = null,
  savedSamples = {},
  savedLedger = {},
  fallbackHourlyShare = null,
  forceScan = false,
) {
  const files = listRecentCodexSessionFiles(220, 21 * DAY_MS, forceScan);
  const passiveByKind = { weekly: null, h5: null };
  const historyByKey = {
    'codex-weekly': Array.isArray(savedSamples?.['codex-weekly']) ? [...savedSamples['codex-weekly']] : [],
    'codex-h5': Array.isArray(savedSamples?.['codex-h5']) ? [...savedSamples['codex-h5']] : [],
  };
  const weeklyLedger = Array.isArray(savedLedger?.['codex-weekly'])
    ? savedLedger['codex-weekly'].map((e) => ({ ...e }))
    : [];
  const codexHourHits = new Array(24).fill(0);
  const codexActiveDays = new Set();
  let codexTotalHits = 0;
  let passiveFreshestTs = 0;

  for (const f of files) {
    const parsed = readCodexFileRateLimits(f);
    if (!parsed) continue;
    if (parsed.freshestTs > passiveFreshestTs) passiveFreshestTs = parsed.freshestTs;

    for (const kind of ['weekly', 'h5']) {
      const w = parsed.latestByKind[kind];
      if (w && (!passiveByKind[kind] || w.ts > passiveByKind[kind].ts)) {
        passiveByKind[kind] = w;
      }
    }
    for (const key of ['codex-weekly', 'codex-h5']) {
      if (parsed.recentByKey[key]?.length) {
        historyByKey[key].push(...parsed.recentByKey[key]);
      }
    }
    if (parsed.weeklyLedger?.length) {
      weeklyLedger.push(...parsed.weeklyLedger);
    }
    for (let h = 0; h < 24; h += 1) {
      codexHourHits[h] += parsed.hourHits[h] || 0;
      codexTotalHits += parsed.hourHits[h] || 0;
    }
    for (const dk of parsed.activeDays || []) codexActiveDays.add(dk);
  }

  const codexHourlyShare =
    codexActiveDays.size >= 3 && codexTotalHits >= 40
      ? normalizeHourlyShare(codexHourHits, codexTotalHits, codexActiveDays.size)
      : fallbackHourlyShare;

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
        ? 5 * HOUR_MS
        : 7 * DAY_MS;
    const base = {
      key: raw.key,
      remainingPct,
      usedPct,
      resetAtMs: expired ? 0 : raw.resetAtMs,
      resetInMs: expired ? 0 : Math.max(0, raw.resetAtMs - nowMs),
      windowMs,
    };
    return attachBurnMetrics(base, historyByKey[raw.key] || [], nowMs, {
      ledgerEntries: raw.kind === 'weekly' ? weeklyLedger : [],
      fallbackHourlyShare: codexHourlyShare,
    });
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

// ==================== DUAL-SCALE BURN RATE & DEPLETION FORECAST ====================
function sumHourlyCostInRange(hourlyBuckets, startMs, endMs) {
  if (!Array.isArray(hourlyBuckets) || !hourlyBuckets.length || endMs <= startMs) return 0;
  let total = 0;
  for (const b of hourlyBuckets) {
    const bStart = Number(b.hourMs || 0);
    const bEnd = bStart + HOUR_MS;
    if (bEnd <= startMs || bStart >= endMs) continue;
    const overlap = Math.min(bEnd, endMs) - Math.max(bStart, startMs);
    if (overlap > 0) {
      total += Number(b.costUsd || 0) * (overlap / HOUR_MS);
    }
  }
  return total;
}

function medianOfSorted(sorted) {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeWeeklyBurnForecast(
  bucket,
  ledgerEntries = [],
  { familyActivity = null, fallbackHourlyShare = null, cachedCalibration = null, nowMs = Date.now() } = {},
) {
  const windowMs = bucket.windowMs || 7 * DAY_MS;
  const todayKey = toLocalDayKey(nowMs);
  const safeDailyBudgetPct =
    bucket.resetInMs > HOUR_MS ? Math.round((bucket.remainingPct / (bucket.resetInMs / DAY_MS)) * 10) / 10 : 0;

  const elapsedMs =
    bucket.windowMs > 0 && bucket.resetInMs > 0 ? Math.max(0, bucket.windowMs - bucket.resetInMs) : 0;
  const cycleDailyRaw =
    bucket.usedPct >= 0.5 && elapsedMs >= 6 * HOUR_MS && elapsedMs <= bucket.windowMs
      ? bucket.usedPct / (elapsedMs / DAY_MS)
      : 0;

  // Idle / untouched weekly bucket (e.g. 100% remaining, no active reset cycle)
  if (bucket.remainingPct >= 99.95 && bucket.usedPct <= 0.05 && (!bucket.resetAtMs || bucket.resetInMs <= 0)) {
    return {
      burnUnit: 'day',
      burnPctPerDay: 0,
      burnPctPerHour: 0,
      burnSource: '',
      etaMs: 0,
      willExhaustBeforeReset: false,
      burnMeta: {
        sampleDays: 0,
        officialDays: 0,
        calibratedDays: 0,
        excludedCappedDays: 0,
        todayUsedPct: 0,
        todayExposure: Math.round(computeDiurnalExposure(nowMs, familyActivity?.hourlyShare || fallbackHourlyShare) * 100) / 100,
        safeDailyBudgetPct,
        cycleDailyPct: 0,
        etaDays: 0,
      },
      freshCalibration: null,
    };
  }

  // 1. Merge saved ledger entries + current live official bucket reading
  const mergedRaw = [];
  for (const e of ledgerEntries || []) {
    if (!e || !e.dayKey) continue;
    if ((e.resetAtMs || 0) <= 0 && (e.maxUsedPct || 0) <= 0) continue;
    mergedRaw.push({ ...e });
  }
  if (bucket.resetAtMs > 0 || bucket.usedPct > 0) {
    mergedRaw.push({
      dayKey: todayKey,
      cycleId: clusterCycleId(bucket.resetAtMs),
      resetAtMs: bucket.resetAtMs || 0,
      windowMs,
      firstUsedPct: bucket.usedPct,
      minUsedPct: bucket.usedPct,
      maxUsedPct: bucket.usedPct,
      lastUsedPct: bucket.usedPct,
      minRemPct: bucket.remainingPct,
      firstTs: nowMs,
      lastTs: nowMs,
      samples: 1,
      isLive: true,
    });
  }

  // 2. Cluster into distinct reset cycles (absorbs ±3h resets_at drift)
  mergedRaw.sort((a, b) => (a.resetAtMs || 0) - (b.resetAtMs || 0));
  const cycles = [];
  for (const e of mergedRaw) {
    const r = Number(e.resetAtMs || 0);
    let target = null;
    if (r > 0) {
      for (let i = cycles.length - 1; i >= 0; i -= 1) {
        if (cycles[i].anchorResetMs > 0 && Math.abs(r - cycles[i].anchorResetMs) <= 3 * HOUR_MS) {
          target = cycles[i];
          break;
        }
      }
    } else {
      target = cycles.find((c) => c.anchorResetMs === 0) || null;
    }
    if (!target) {
      target = { anchorResetMs: r, maxResetMs: r, windowMs: e.windowMs || windowMs, entries: [] };
      cycles.push(target);
    }
    if (r > target.maxResetMs) target.maxResetMs = r;
    if (e.windowMs > 0) target.windowMs = e.windowMs;
    target.entries.push(e);
  }

  // 3. Reconstruct monotonic high-water-mark daily official increments & detect capped days
  const dailyCost = familyActivity?.dailyCost || null;
  const dayMap = Object.create(null); // dayKey -> { officialPct, observed, isCapped, officialCycleCount }
  const ensureDay = (dk) => {
    if (!dayMap[dk]) {
      dayMap[dk] = { officialPct: 0, observed: false, isCapped: false };
    }
    return dayMap[dk];
  };

  let hasPriorDayInCurrentCycle = false;
  const curCycleResetMs = Number(bucket.resetAtMs || 0);

  for (const cyc of cycles) {
    // Combine entries on the same local day inside this cycle
    const byDay = new Map();
    for (const e of cyc.entries) {
      const cur = byDay.get(e.dayKey);
      if (!cur) {
        byDay.set(e.dayKey, {
          dayKey: e.dayKey,
          minUsedPct: Number(e.minUsedPct ?? e.lastUsedPct ?? 0),
          maxUsedPct: Number(e.maxUsedPct ?? e.lastUsedPct ?? 0),
          minRemPct: Number(e.minRemPct ?? (100 - Number(e.maxUsedPct ?? 0))),
          firstTs: Number(e.firstTs || 0),
          lastTs: Number(e.lastTs || 0),
        });
      } else {
        cur.minUsedPct = Math.min(cur.minUsedPct, Number(e.minUsedPct ?? e.lastUsedPct ?? 0));
        cur.maxUsedPct = Math.max(cur.maxUsedPct, Number(e.maxUsedPct ?? e.lastUsedPct ?? 0));
        cur.minRemPct = Math.min(cur.minRemPct, Number(e.minRemPct ?? (100 - Number(e.maxUsedPct ?? 0))));
        if (e.firstTs && (!cur.firstTs || e.firstTs < cur.firstTs)) cur.firstTs = e.firstTs;
        if (e.lastTs && e.lastTs > cur.lastTs) cur.lastTs = e.lastTs;
      }
    }

    const days = [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
    if (!days.length) continue;

    const cycWinMs = cyc.windowMs || windowMs;
    const cycStartMs = cyc.maxResetMs > 0 ? cyc.maxResetMs - cycWinMs : 0;
    const cycStartDay = cycStartMs > 0 ? toLocalDayKey(cycStartMs) : '';
    const isCurrentCycle = Boolean(
      curCycleResetMs > 0 && cyc.maxResetMs > 0 && Math.abs(cyc.maxResetMs - curCycleResetMs) <= 3 * HOUR_MS,
    );

    const d0 = days[0];
    let hwm =
      (cycStartDay && d0.dayKey <= cycStartDay) || d0.minUsedPct <= 2.0 ? 0 : d0.minUsedPct;

    if (isCurrentCycle) {
      if (cycStartDay && cycStartDay === todayKey) {
        hasPriorDayInCurrentCycle = true;
      } else if (days.some((d) => d.dayKey < todayKey)) {
        hasPriorDayInCurrentCycle = true;
      }
    }

    let prevDayKey = '';
    for (const cur of days) {
      const nextHwm = Math.max(hwm, cur.maxUsedPct);
      const delta = Math.max(0, nextHwm - hwm);
      const gapDays = [];
      if (prevDayKey) {
        const diff = dayDiffBetweenKeys(prevDayKey, cur.dayKey);
        for (let g = 1; g < diff && g <= 14; g += 1) {
          gapDays.push(addLocalDays(prevDayKey, g));
        }
      }

      let allocatedCurrent = false;
      if (gapDays.length > 0) {
        if (hwm >= 98.5) {
          for (const gdk of gapDays) {
            const rec = ensureDay(gdk);
            rec.isCapped = true;
            rec.observed = true;
          }
        } else if (delta <= 0.2) {
          for (const gdk of gapDays) {
            const rec = ensureDay(gdk);
            rec.observed = true;
          }
        } else if (dailyCost) {
          const spanKeys = [...gapDays, cur.dayKey];
          const weights = spanKeys.map((dk) => Math.max(0, Number(dailyCost[dk] || 0)));
          const totalW = weights.reduce((s, x) => s + x, 0);
          if (totalW > 0) {
            spanKeys.forEach((dk, idx) => {
              const rec = ensureDay(dk);
              rec.officialPct += delta * (weights[idx] / totalW);
              rec.observed = true;
            });
            allocatedCurrent = true;
          }
        }
      }

      const rec = ensureDay(cur.dayKey);
      if (!allocatedCurrent) {
        rec.officialPct += delta;
        rec.observed = true;
      }

      // Right-censored / exhausted day detection
      const alreadyCapped = hwm >= 98.5;
      const hitCapWithTinySliver = nextHwm >= 99.0 && cur.minRemPct <= 1.0 && delta < 8.0;
      if (alreadyCapped || hitCapWithTinySliver) {
        rec.isCapped = true;
      }

      hwm = nextHwm;
      prevDayKey = cur.dayKey;
    }

    // Mark post-exhaustion silent days between last observation and cycle reset as capped
    if (hwm >= 98.5 && cyc.maxResetMs > 0) {
      const resetDay = toLocalDayKey(cyc.maxResetMs);
      const lastObservedDay = days[days.length - 1].dayKey;
      const silentDiff = dayDiffBetweenKeys(lastObservedDay, resetDay);
      for (let g = 1; g < silentDiff && g <= 7; g += 1) {
        const gdk = addLocalDays(lastObservedDay, g);
        if (gdk >= todayKey) break;
        const rec = ensureDay(gdk);
        rec.isCapped = true;
        rec.observed = true;
      }
    }
  }

  // 4. Self-calibrate pctPerUsd (official % per $1 of local weighted transcript cost) for cold-start backfill
  let pctPerUsd = 0;
  let freshCalibration = null;
  if (familyActivity) {
    let calPctSum = 0;
    let calUsdSum = 0;
    const curCycleStartMs = curCycleResetMs > 0 ? curCycleResetMs - windowMs : 0;
    const curCycleStartDay = curCycleStartMs > 0 ? toLocalDayKey(curCycleStartMs) : '';

    if (curCycleStartMs > 0 && bucket.usedPct >= 1.5) {
      const cycleUsd = sumHourlyCostInRange(familyActivity.hourlyBuckets, curCycleStartMs, nowMs);
      if (cycleUsd >= 0.5) {
        calPctSum += bucket.usedPct;
        calUsdSum += cycleUsd;
      }
    }

    // Also incorporate any completed historical official days strictly before the current cycle
    if (dailyCost) {
      for (const [dk, rec] of Object.entries(dayMap)) {
        if (!rec.observed || rec.isCapped || dk >= todayKey) continue;
        if (curCycleStartDay && dk >= curCycleStartDay) continue;
        const usd = Number(dailyCost[dk] || 0);
        if (rec.officialPct >= 1.0 && usd >= 0.5) {
          calPctSum += rec.officialPct;
          calUsdSum += usd;
        }
      }
    }

    if (calUsdSum >= 1.0 && calPctSum >= 1.5) {
      const rawRatio = calPctSum / calUsdSum;
      if (Number.isFinite(rawRatio) && rawRatio >= 0.01 && rawRatio <= 50) {
        pctPerUsd = rawRatio;
        freshCalibration = { pctPerUsd: Math.round(rawRatio * 10000) / 10000, updatedAtMs: nowMs };
      }
    } else if (
      cachedCalibration &&
      typeof cachedCalibration.pctPerUsd === 'number' &&
      cachedCalibration.pctPerUsd >= 0.01 &&
      cachedCalibration.pctPerUsd <= 50 &&
      nowMs - Number(cachedCalibration.updatedAtMs || 0) <= 30 * DAY_MS
    ) {
      pctPerUsd = cachedCalibration.pctPerUsd;
    }
  }

  // 5. Assemble past WEEKLY_LOOKBACK_DAYS completed days (yesterday .. 14 days ago)
  const earliestObservedDay = Object.keys(dayMap)
    .filter((dk) => dayMap[dk].observed && dk < todayKey)
    .sort()[0] || '';

  const rawCompleted = [];
  for (let age = WEEKLY_LOOKBACK_DAYS; age >= 1; age -= 1) {
    const dk = addLocalDays(todayKey, -age);
    const rec = dayMap[dk];
    if (rec?.isCapped) {
      rawCompleted.push({ dayKey: dk, age, pct: 0, capped: true, source: 'official' });
    } else if (rec?.observed) {
      rawCompleted.push({ dayKey: dk, age, pct: rec.officialPct, capped: false, source: 'official' });
    } else if (pctPerUsd > 0 && dailyCost) {
      const usd = Number(dailyCost[dk] || 0);
      rawCompleted.push({ dayKey: dk, age, pct: usd * pctPerUsd, capped: false, source: 'calibrated' });
    } else if (earliestObservedDay && dk > earliestObservedDay) {
      rawCompleted.push({ dayKey: dk, age, pct: 0, capped: false, source: 'official' });
    }
  }

  // Trim leading empty days before the user's first recorded activity
  const firstActiveIdx = rawCompleted.findIndex((d) => !d.capped && d.pct > 0.05);
  const completedSeries = firstActiveIdx >= 0 ? rawCompleted.slice(firstActiveIdx) : [];

  const excludedCappedDays = completedSeries.filter((d) => d.capped).length;
  const validDays = completedSeries.filter((d) => !d.capped);
  const officialDays = validDays.filter((d) => d.source === 'official').length;
  const calibratedDays = validDays.filter((d) => d.source === 'calibrated').length;

  // 6. Determine today's usage & diurnal exposure fraction
  const todayRec = dayMap[todayKey];
  const todayOfficial = todayRec?.observed ? todayRec.officialPct : null;
  const todayCalibrated = pctPerUsd > 0 && dailyCost ? Number(dailyCost[todayKey] || 0) * pctPerUsd : null;

  let todayUsedPct = null;
  if (todayOfficial !== null && hasPriorDayInCurrentCycle) {
    todayUsedPct = todayOfficial;
  } else if (todayOfficial !== null && todayCalibrated !== null) {
    // Day-1 mid-day upgrade: recover morning usage before the first official sample if present in local logs
    todayUsedPct = Math.min(bucket.usedPct, Math.max(todayOfficial, todayCalibrated));
  } else if (todayCalibrated !== null) {
    todayUsedPct = Math.min(bucket.usedPct > 0 ? bucket.usedPct : todayCalibrated, todayCalibrated);
  } else if (todayOfficial !== null) {
    todayUsedPct = todayOfficial;
  }

  const hourlyShare = familyActivity?.hourlyShare || fallbackHourlyShare;
  const todayExposure = computeDiurnalExposure(nowMs, hourlyShare);
  const todayIsCapped = bucket.remainingPct <= 0.5 || Boolean(todayRec?.isCapped);

  // 7. Soft-Huber outlier damping (when >= 5 completed days) + Exposure-Weighted EWMA
  let spikeCap = Infinity;
  if (validDays.length >= 5) {
    const allSorted = validDays.map((d) => d.pct).sort((a, b) => a - b);
    const posSorted = allSorted.filter((v) => v > 0.2);
    const medAll = medianOfSorted(allSorted);
    const medPos = medianOfSorted(posSorted);
    spikeCap = Math.max(medAll * 2.8, medPos * 2.2, 30);
  }
  const damp = (v, cap = spikeCap) => (v > cap ? cap + 0.35 * (v - cap) : v);

  let wSum = 0;
  let vSum = 0;
  for (const d of validDays) {
    const w = Math.pow(2, -(d.age - 1) / EWMA_HALF_LIFE_DAYS);
    wSum += w;
    vSum += w * damp(d.pct);
  }

  const includeToday = todayUsedPct !== null && !todayIsCapped && (validDays.length > 0 || todayExposure >= 0.25);
  const todayCap = Number.isFinite(spikeCap) ? Math.max(spikeCap * 1.2, 45) : Infinity;
  const effNum = vSum + (includeToday ? damp(todayUsedPct, todayCap) : 0);
  const effDen = wSum + (includeToday ? todayExposure : 0);

  let rawDailyRate = 0;
  let burnSource = '';

  if (effDen >= 1.5 && effNum / effDen >= 0.15) {
    rawDailyRate = effNum / effDen;
    burnSource =
      officialDays > 0 && calibratedDays > 0
        ? 'hybrid-ewma'
        : officialDays > 0
        ? 'official-ewma'
        : 'calibrated-ewma';
  } else if (effDen >= 0.5 && cycleDailyRaw >= 0.15) {
    // Cold-start Bayesian shrinkage toward current cycle daily pace
    const priorW = Math.max(0, 1.5 - effDen);
    rawDailyRate = (effNum + priorW * cycleDailyRaw) / (effDen + priorW);
    burnSource = officialDays > 0 ? 'official-ewma' : calibratedDays > 0 ? 'calibrated-ewma' : 'cycle';
  } else if (cycleDailyRaw >= 0.15 && bucket.usedPct >= 1.0) {
    rawDailyRate = cycleDailyRaw;
    burnSource = 'cycle';
  }

  let etaMs = 0;
  let etaDays = 0;
  let willExhaustBeforeReset = false;
  if (rawDailyRate >= 0.15 && bucket.remainingPct > 0) {
    // Compute ETA from UNROUNDED daily rate to prevent quantization distortion!
    etaDays = bucket.remainingPct / rawDailyRate;
    etaMs = Math.round(etaDays * DAY_MS);
    willExhaustBeforeReset = Boolean(bucket.resetInMs > 0 && etaMs < bucket.resetInMs);
  }

  const burnPctPerDay = rawDailyRate >= 0.15 ? Math.round(rawDailyRate * 10) / 10 : 0;
  const burnPctPerHour = rawDailyRate >= 0.15 ? Math.round((rawDailyRate / 24) * 100) / 100 : 0;

  return {
    burnUnit: 'day',
    burnPctPerDay,
    burnPctPerHour,
    burnSource,
    etaMs,
    willExhaustBeforeReset,
    burnMeta: {
      sampleDays: validDays.length,
      officialDays,
      calibratedDays,
      excludedCappedDays,
      todayUsedPct: todayUsedPct !== null ? Math.round(todayUsedPct * 10) / 10 : null,
      todayExposure: Math.round(todayExposure * 100) / 100,
      safeDailyBudgetPct,
      cycleDailyPct: cycleDailyRaw > 0 ? Math.round(cycleDailyRaw * 10) / 10 : 0,
      etaDays: etaDays > 0 ? Math.round(etaDays * 10) / 10 : 0,
    },
    freshCalibration,
  };
}

export function attachBurnMetrics(bucket, rawHistory, nowMs, options = {}) {
  if (!bucket) return null;
  const alertLevel =
    bucket.remainingPct <= 10 ? 'critical' : bucket.remainingPct < 20 ? 'warn' : 'normal';

  // Multi-day / weekly budgets use daily exposure-weighted EWMA forecasting
  if (bucket.windowMs >= 2 * DAY_MS) {
    const forecast = computeWeeklyBurnForecast(bucket, options.ledgerEntries || [], {
      familyActivity: options.familyActivity || null,
      fallbackHourlyShare: options.fallbackHourlyShare || null,
      cachedCalibration: options.cachedCalibration || null,
      nowMs,
    });
    if (forecast.freshCalibration && typeof options.onCalibration === 'function') {
      options.onCalibration(forecast.freshCalibration);
    }
    return {
      ...bucket,
      alertLevel,
      burnUnit: forecast.burnUnit,
      burnPctPerDay: forecast.burnPctPerDay,
      burnPctPerHour: forecast.burnPctPerHour,
      burnSource: forecast.burnSource,
      burnMeta: forecast.burnMeta,
      etaMs: forecast.etaMs,
      willExhaustBeforeReset: forecast.willExhaustBeforeReset,
    };
  }

  // Short-window (e.g. 5h burst) budgets use smoothed hourly velocity without premature rounding
  const LOOKBACK_MS = 2 * HOUR_MS;
  const MIN_SPAN_MS = 6 * 60 * 1000;
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

  let anchor = null;
  if (valid.length > 0) {
    let nextVal = bucket.remainingPct;
    for (let i = valid.length - 1; i >= 0; i -= 1) {
      const pt = valid[i];
      if (pt.remainingPct < nextVal - 1.5) break;
      anchor = pt;
      nextVal = Math.max(nextVal, pt.remainingPct);
    }
  }

  let recentRate = 0;
  let recentSpanMs = 0;
  if (anchor && nowMs - anchor.ts >= MIN_SPAN_MS) {
    const dropped = anchor.remainingPct - bucket.remainingPct;
    if (dropped >= 0.5) {
      recentSpanMs = nowMs - anchor.ts;
      recentRate = dropped / (recentSpanMs / HOUR_MS);
    }
  }

  let cycleRate = 0;
  if (bucket.usedPct >= 1.0 && bucket.windowMs > 0 && bucket.resetInMs > 0) {
    const elapsedMs = bucket.windowMs - bucket.resetInMs;
    if (elapsedMs >= 10 * 60 * 1000 && elapsedMs <= bucket.windowMs) {
      cycleRate = bucket.usedPct / (elapsedMs / HOUR_MS);
    }
  }

  let rawHourlyRate = 0;
  let burnSource = '';
  if (recentRate >= 0.1 && cycleRate >= 0.1) {
    const recentWeight = recentSpanMs >= 45 * 60 * 1000 ? 0.8 : 0.65;
    rawHourlyRate = recentWeight * recentRate + (1 - recentWeight) * cycleRate;
    burnSource = 'recent';
  } else if (recentRate >= 0.1) {
    rawHourlyRate = recentRate;
    burnSource = 'recent';
  } else if (cycleRate >= 0.1) {
    rawHourlyRate = cycleRate;
    burnSource = 'cycle';
  }

  let etaMs = 0;
  let willExhaustBeforeReset = false;
  if (rawHourlyRate >= 0.1 && bucket.remainingPct > 0) {
    etaMs = Math.round((bucket.remainingPct / rawHourlyRate) * HOUR_MS);
    willExhaustBeforeReset = Boolean(bucket.resetInMs > 0 && etaMs < bucket.resetInMs);
  }

  const burnPctPerHour = rawHourlyRate >= 0.1 ? Math.round(rawHourlyRate * 10) / 10 : 0;

  return {
    ...bucket,
    alertLevel,
    burnUnit: 'hour',
    burnPctPerDay: 0,
    burnPctPerHour,
    burnSource,
    burnMeta: {
      cycleHourlyPct: cycleRate >= 0.1 ? Math.round(cycleRate * 10) / 10 : 0,
    },
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
  #history = { version: 2, samples: {}, dailyLedger: {}, calibration: {} };
  #lastActivityProfile = null;
  #lastCalibrationSaveMs = 0;
  #modelCtxCache = {};
  #modelProbeQueue = [];
  #modelProbeQueuedSet = new Set();
  #modelProbing = false;
  #activeChildren = new Set();

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

  #saveHistory() {
    try {
      const tmp = `${this.#historyPath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(this.#history), 'utf-8');
      renameSync(tmp, this.#historyPath);
    } catch {
      // ignore
    }
  }

  #recordSampleAndLedger(key, { ts, remainingPct, usedPct, resetAtMs, windowMs }) {
    const sampleMaxAgeMs = 24 * HOUR_MS;
    const samplesMap = this.#history.samples;
    const list = Array.isArray(samplesMap[key]) ? samplesMap[key] : [];
    const pruned = list.filter((pt) => pt && ts - pt.ts <= sampleMaxAgeMs);
    const last = pruned[pruned.length - 1];
    let changed = false;

    if (!last || ts - last.ts >= 45_000 || Math.abs(last.remainingPct - remainingPct) >= 0.1) {
      pruned.push({ ts, remainingPct, resetAtMs: resetAtMs || 0 });
      changed = true;
    }
    samplesMap[key] = pruned.slice(-240);

    if (windowMs >= 2 * DAY_MS || key.includes('weekly')) {
      const ledgerMap = this.#history.dailyLedger;
      const ledgerList = Array.isArray(ledgerMap[key]) ? ledgerMap[key] : [];
      if (resetAtMs > 0 || usedPct > 0) {
        if (upsertLedgerEntry(ledgerList, { ts, remainingPct, usedPct, resetAtMs, windowMs })) {
          changed = true;
        }
      }
      ledgerMap[key] = pruneLedgerList(ledgerList, ts);
    }
    return changed;
  }

  #recordCodexHistory(windows, ts) {
    if (!Array.isArray(windows) || !windows.length) return;
    let changed = false;
    for (const w of windows) {
      if (!w?.key || typeof w.remainingPct !== 'number') continue;
      const windowMs =
        w.windowMinutes > 0
          ? w.windowMinutes * 60 * 1000
          : w.kind === 'h5'
          ? 5 * HOUR_MS
          : 7 * DAY_MS;
      const usedPct =
        typeof w.usedPct === 'number'
          ? w.usedPct
          : Math.max(0, Math.round((100 - w.remainingPct) * 10) / 10);
      if (
        this.#recordSampleAndLedger(w.key, {
          ts,
          remainingPct: w.remainingPct,
          usedPct,
          resetAtMs: w.resetAtMs || 0,
          windowMs,
        })
      ) {
        changed = true;
      }
    }
    if (changed) this.#saveHistory();
  }

  #loadHistory() {
    const empty = { version: 2, samples: {}, dailyLedger: {}, calibration: {} };
    try {
      if (!existsSync(this.#historyPath)) {
        this.#history = empty;
        return;
      }
      const raw = JSON.parse(readFileSync(this.#historyPath, 'utf-8')) || {};
      if (raw.version === 2 && raw.samples && typeof raw.samples === 'object') {
        this.#history = {
          version: 2,
          samples: raw.samples || {},
          dailyLedger: raw.dailyLedger && typeof raw.dailyLedger === 'object' ? raw.dailyLedger : {},
          calibration: raw.calibration && typeof raw.calibration === 'object' ? raw.calibration : {},
        };
        return;
      }

      // Smooth v1 -> v2 migration: preserve existing samples and backfill dailyLedger from them
      const migrated = { version: 2, samples: {}, dailyLedger: {}, calibration: {} };
      for (const [key, arr] of Object.entries(raw)) {
        if (!Array.isArray(arr)) continue;
        migrated.samples[key] = arr;
        if (key.includes('weekly')) {
          const windowMs = 7 * DAY_MS;
          const ledger = [];
          for (const pt of arr) {
            if (!pt || !pt.ts || typeof pt.remainingPct !== 'number') continue;
            const usedPct = Math.max(0, Math.round((100 - pt.remainingPct) * 10) / 10);
            if ((pt.resetAtMs || 0) <= 0 && usedPct <= 0) continue;
            upsertLedgerEntry(ledger, {
              ts: pt.ts,
              remainingPct: pt.remainingPct,
              usedPct,
              resetAtMs: pt.resetAtMs || 0,
              windowMs,
            });
          }
          if (ledger.length) migrated.dailyLedger[key] = pruneLedgerList(ledger, Date.now());
        }
      }
      this.#history = migrated;
      this.#saveHistory();
    } catch {
      this.#history = empty;
    }
  }

  #saveCalibrationLazy(key, freshCal, nowMs) {
    if (!freshCal || typeof freshCal.pctPerUsd !== 'number') return;
    const prev = this.#history.calibration[key];
    const diffRatio =
      prev && prev.pctPerUsd > 0 ? Math.abs(freshCal.pctPerUsd - prev.pctPerUsd) / prev.pctPerUsd : 1;
    this.#history.calibration[key] = freshCal;
    if (!prev || diffRatio > 0.05 || nowMs - this.#lastCalibrationSaveMs > HOUR_MS) {
      this.#lastCalibrationSaveMs = nowMs;
      this.#saveHistory();
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
      const agy = findAgyBinary();
      const useNodeCapture = IS_WIN || agy.isWinExe;
      let statusCmd = probeSh;
      if (useNodeCapture) {
        const probeMjs = join(this.#storage.dataDir, `model_ctx_probe_${process.pid}.mjs`);
        const outTarget = IS_WSL ? toWindowsPath(probeOut) : probeOut;
        const mjsSrc = `import { readFileSync, renameSync, writeFileSync } from 'node:fs';\nconst out = ${JSON.stringify(outTarget)};\nconst data = readFileSync(0, 'utf-8');\nwriteFileSync(out + '.tmp', data, 'utf-8');\nrenameSync(out + '.tmp', out);\nconsole.log('ok');\n`;
        writeFileSync(probeMjs, mjsSrc, 'utf-8');
        const scriptRef = IS_WSL ? toWindowsPath(probeMjs) : probeMjs;
        statusCmd = `"${IS_WIN ? process.execPath : 'node'}" "${scriptRef}"`;
      } else {
        const script = `#!/usr/bin/env bash\ncat > "${probeOut}.tmp" && mv "${probeOut}.tmp" "${probeOut}"\necho "ok"\n`;
        writeFileSync(probeSh, script, 'utf-8');
        chmodSync(probeSh, 0o755);
      }

      const settingsJson = JSON.stringify({
        statusLine: { type: 'command', command: statusCmd, enabled: true },
      });

      const env = { ...process.env, PATH: buildCliPathEnv() };
      let child;
      let pollTimer = null;

      if (IS_WIN) {
        child = spawn(agy.bin, ['--project', 'default-cli-project', '--model', probeArg, '--settings', settingsJson], {
          stdio: ['pipe', 'ignore', 'ignore'],
          env,
          shell: /\.(cmd|bat)$/i.test(agy.bin),
          windowsHide: true,
        });
        pollTimer = setInterval(() => {
          try {
            if (existsSync(probeOut)) {
              const data = JSON.parse(readFileSync(probeOut, 'utf-8'));
              if (data?.context_window?.context_window_size) {
                try { child.stdin?.write('\x04\x04'); child.stdin?.end(); } catch {}
                try { child.kill(); } catch {}
              }
            }
          } catch {
            // ignore
          }
        }, 180);
      } else {
        child = spawn('python3', ['-c', PYTHON_MODEL_PROBE_RUNNER, agy.bin, probeArg, settingsJson, probeOut], {
          stdio: ['ignore', 'ignore', 'ignore'],
          env,
          detached: true,
        });
      }

      this.#activeChildren.add(child);
      let settled = false;
      const softKill = setTimeout(() => {
        killProcessGroup(child, 'SIGTERM');
      }, 10500);
      const hardKill = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, 12500);

      const onDone = () => {
        if (settled) return;
        settled = true;
        this.#activeChildren.delete(child);
        clearTimeout(softKill);
        clearTimeout(hardKill);
        if (pollTimer) clearInterval(pollTimer);
        try {
          const probeMjs = join(this.#storage.dataDir, `model_ctx_probe_${process.pid}.mjs`);
          if (existsSync(probeMjs)) unlinkSync(probeMjs);
        } catch {
          // ignore
        }
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
      };

      child.on('error', onDone);
      child.on('exit', onDone);
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
    let changed = false;

    for (const [key, b] of Object.entries(rawQuota)) {
      if (!b || typeof b !== 'object') continue;
      const frac = Number(b.remaining_fraction);
      if (!Number.isFinite(frac)) continue;
      const remainingPct = Math.max(0, Math.min(100, Math.round(frac * 1000) / 10));
      const usedPct = Math.max(0, Math.round((100 - remainingPct) * 10) / 10);
      const resetAtMs = b.reset_time
        ? Date.parse(b.reset_time)
        : Number.isFinite(Number(b.reset_in_seconds))
        ? ts + Number(b.reset_in_seconds) * 1000
        : 0;
      const windowMs = key.includes('5h')
        ? 5 * HOUR_MS
        : key.includes('weekly')
        ? 7 * DAY_MS
        : 0;

      if (
        this.#recordSampleAndLedger(key, {
          ts,
          remainingPct,
          usedPct,
          resetAtMs: resetAtMs > 0 ? resetAtMs : 0,
          windowMs,
        })
      ) {
        changed = true;
      }
    }

    if (changed) this.#saveHistory();
  }

  #ensureCaptureScript(useNodeCapture = false) {
    if (useNodeCapture) {
      const mjsPath = join(this.#storage.dataDir, 'quota_capture.mjs');
      const outTarget = IS_WSL ? toWindowsPath(this.#livePayloadPath) : this.#livePayloadPath;
      const mjsSrc = `import { readFileSync, renameSync, writeFileSync } from 'node:fs';\nconst out = ${JSON.stringify(outTarget)};\nconst data = readFileSync(0, 'utf-8');\nwriteFileSync(out + '.tmp', data, 'utf-8');\nrenameSync(out + '.tmp', out);\nconsole.log('ok');\n`;
      writeFileSync(mjsPath, mjsSrc, 'utf-8');
      const scriptRef = IS_WSL ? toWindowsPath(mjsPath) : mjsPath;
      return `"${IS_WIN ? process.execPath : 'node'}" "${scriptRef}"`;
    }
    const script = `#!/usr/bin/env bash\ncat > "${this.#livePayloadPath}.tmp" && mv "${this.#livePayloadPath}.tmp" "${this.#livePayloadPath}"\necho "ok"\n`;
    writeFileSync(this.#captureScriptPath, script, 'utf-8');
    chmodSync(this.#captureScriptPath, 0o755);
    return this.#captureScriptPath;
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
    for (const child of this.#activeChildren) {
      killProcessGroup(child, 'SIGTERM');
    }
    this.#activeChildren.clear();
  }

  async refresh() {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = Promise.all([this.#runCapture(), this.#runCodexCapture()])
      .then(() => this.getSnapshot(null, { forceCodexScan: true }))
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
        if (child) {
          this.#activeChildren.delete(child);
        }
        if (child && !child.killed && child.exitCode === null) {
          killProcessGroup(child, 'SIGTERM');
          termKill = setTimeout(() => {
            killProcessGroup(child, 'SIGKILL');
          }, 1200);
          termKill.unref?.();
        }
        resolve();
      };

      try {
        const codex = findCodexBinary();
        const env = { ...process.env, PATH: buildCliPathEnv() };
        if (codex.useWslCmd) {
          child = spawn('/mnt/c/Windows/System32/cmd.exe', ['/c', toWindowsPath(codex.bin), 'app-server', '--stdio'], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env,
            detached: !IS_WIN,
            windowsHide: true,
          });
        } else {
          child = spawn(codex.bin, ['app-server', '--stdio'], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env,
            shell: codex.useShell,
            detached: !IS_WIN,
            windowsHide: true,
          });
        }
        this.#activeChildren.add(child);

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
        const agy = findAgyBinary();
        const statusCmd = this.#ensureCaptureScript(IS_WIN || agy.isWinExe);
        const settingsJson = JSON.stringify({
          statusLine: {
            type: 'command',
            command: statusCmd,
            enabled: true,
          },
        });

        const env = { ...process.env, PATH: buildCliPathEnv() };
        let child;
        let pollTimer = null;

        if (IS_WIN) {
          try {
            if (existsSync(this.#livePayloadPath)) unlinkSync(this.#livePayloadPath);
          } catch {
            // ignore
          }
          child = spawn(agy.bin, ['--project', 'default-cli-project', '--settings', settingsJson], {
            stdio: ['pipe', 'ignore', 'pipe'],
            env,
            shell: /\.(cmd|bat)$/i.test(agy.bin),
            windowsHide: true,
          });
          let capturedAt = 0;
          pollTimer = setInterval(() => {
            try {
              if (existsSync(this.#livePayloadPath)) {
                const txt = readFileSync(this.#livePayloadPath, 'utf-8');
                if (txt.includes('"quota"') && txt.includes('"remaining_fraction"')) {
                  if (!capturedAt) capturedAt = Date.now();
                  else if (Date.now() - capturedAt >= 350) {
                    try { child.stdin?.write('\x04\x04'); child.stdin?.end(); } catch {}
                    try { child.kill(); } catch {}
                  }
                }
              }
            } catch {
              // ignore
            }
          }, 200);
        } else {
          child = spawn('python3', ['-c', PYTHON_PTY_RUNNER, agy.bin, settingsJson, this.#livePayloadPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env,
            detached: true,
          });
        }

        this.#activeChildren.add(child);
        let errBuf = '';
        let settled = false;
        child.stderr?.on('data', (c) => {
          errBuf += c.toString();
        });

        const softKill = setTimeout(() => {
          killProcessGroup(child, 'SIGTERM');
        }, 17000);
        const hardKill = setTimeout(() => {
          killProcessGroup(child, 'SIGKILL');
        }, 19000);

        const onDone = (spawnErr) => {
          if (settled) return;
          settled = true;
          this.#activeChildren.delete(child);
          clearTimeout(softKill);
          clearTimeout(hardKill);
          if (pollTimer) clearInterval(pollTimer);
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
              if (raw && raw.agent_state === 'authenticating') {
                this.#lastError = 'agy CLI 尚未登录（请在终端运行一次 agy 完成账号登录）';
                resolve(this.getSnapshot());
                return;
              }
            }
            const errText = (spawnErr?.message || errBuf || '').trim();
            if (!agy.found && /ENOENT|FileNotFoundError|not found|No such file/i.test(errText)) {
              this.#lastError = '未检测到 agy CLI（安装后可自动同步 Gemini / Claude 官方额度）';
            } else {
              this.#lastError = errText.slice(0, 140) || '未捕获到官方额度数据';
            }
          } catch (err) {
            this.#lastError = err.message;
          }
          resolve(this.getSnapshot());
        };

        child.on('error', (err) => onDone(err));
        child.on('exit', () => onDone(null));
      } catch (err) {
        this.#lastError = err.message;
        resolve(this.getSnapshot());
      }
    });
  }

  getSnapshot(activityProfile = null, { forceCodexScan = false } = {}) {
    const nowMs = Date.now();
    if (activityProfile && typeof activityProfile === 'object') {
      this.#lastActivityProfile = activityProfile;
    }
    const act = activityProfile || this.#lastActivityProfile || null;
    const raw = this.#cached?.rawQuota || null;
    const fetchedAtMs = this.#cached?.fetchedAtMs || 0;

    // Seed initial history & daily ledger from cache if empty
    if (raw && fetchedAtMs && Object.keys(this.#history.samples || {}).length === 0) {
      this.#recordHistory(raw, fetchedAtMs);
    }

    const resolveFamilyActivity = (key) => {
      if (!act) return null;
      if (key.startsWith('gemini')) return act.gemini || null;
      if (key.startsWith('3p') || key.startsWith('claude')) return act.claude || null;
      return null;
    };

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
        ? 5 * HOUR_MS
        : key.includes('weekly')
        ? 7 * DAY_MS
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
        this.#history.samples?.[key] || [],
        nowMs,
        {
          ledgerEntries: this.#history.dailyLedger?.[key] || [],
          familyActivity: resolveFamilyActivity(key),
          fallbackHourlyShare: act?.globalHourlyShare || null,
          cachedCalibration: this.#history.calibration?.[key] || null,
          onCalibration: (cal) => this.#saveCalibrationLazy(key, cal, nowMs),
        },
      );
    };

    const codexQuota = readCodexOfficialQuota(
      nowMs,
      this.#codexCached,
      this.#history.samples,
      this.#history.dailyLedger,
      act?.globalHourlyShare || null,
      forceCodexScan,
    );

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
