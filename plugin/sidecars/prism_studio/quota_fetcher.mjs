import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export class AgyQuotaFetcher {
  #storage;
  #cachePath;
  #captureScriptPath;
  #livePayloadPath;
  #inFlight = null;
  #timer = null;
  #lastError = '';
  #cached = null;

  constructor(storage) {
    this.#storage = storage;
    this.#cachePath = join(storage.dataDir, 'quota_cache.json');
    this.#captureScriptPath = join(storage.dataDir, 'quota_capture.sh');
    this.#livePayloadPath = join(storage.dataDir, 'quota_live.json');
    this.#loadCache();
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

  #saveCache(snapshot) {
    this.#cached = snapshot;
    const tmp = `${this.#cachePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    renameSync(tmp, this.#cachePath);
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
                const snap = {
                  fetchedAtMs: Date.now(),
                  planTier: raw.plan_tier || null,
                  rawQuota: raw.quota,
                };
                this.#saveCache(snap);
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
      return {
        key,
        remainingPct,
        usedPct,
        resetAtMs: expired ? 0 : finalResetAtMs,
        resetInMs: expired ? 0 : Math.max(0, finalResetAtMs - nowMs),
      };
    };

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
      available: Boolean(raw),
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
      extras,
    };
  }
}
