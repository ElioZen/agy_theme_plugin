import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWIFT_SOURCE = join(__dirname, 'mac', 'PrismBackdrop.swift');

export class MacBackdropCompanion {
  #storage;
  #child = null;
  #status = 'ready'; // 'unsupported' | 'ready' | 'compiling' | 'running' | 'error'
  #lastError = '';
  #compilePromise = null;

  constructor(storage) {
    this.#storage = storage;
    if (process.platform !== 'darwin') {
      this.#status = 'unsupported';
    }
  }

  get binPath() {
    return join(this.#storage.binDir, 'PrismBackdrop');
  }

  getState() {
    const supported = process.platform === 'darwin';
    const running = Boolean(this.#child && !this.#child.killed && this.#child.exitCode === null);
    let status = this.#status;
    if (!supported) status = 'unsupported';
    else if (running) status = 'running';
    else if (status === 'running') status = 'ready';

    return {
      supported,
      status,
      running,
      pid: running ? this.#child.pid : null,
      error: this.#lastError,
      binaryReady: existsSync(this.binPath),
    };
  }

  #needsCompile() {
    if (!existsSync(this.binPath)) return true;
    try {
      return statSync(SWIFT_SOURCE).mtimeMs > statSync(this.binPath).mtimeMs;
    } catch {
      return true;
    }
  }

  async ensureCompiled() {
    if (process.platform !== 'darwin') {
      throw new Error('整窗氛围伴侣仅支持 macOS');
    }
    if (!existsSync(SWIFT_SOURCE)) {
      throw new Error('缺少 PrismBackdrop.swift 源码');
    }

    if (!this.#needsCompile()) return this.binPath;
    if (this.#compilePromise) return this.#compilePromise;

    this.#status = 'compiling';
    this.#lastError = '';
    this.#compilePromise = new Promise((resolve, reject) => {
      execFile(
        'swiftc',
        [
          '-O',
          '-framework', 'AppKit',
          '-framework', 'CoreGraphics',
          '-framework', 'CoreImage',
          '-framework', 'QuartzCore',
          SWIFT_SOURCE,
          '-o', this.binPath,
        ],
        { timeout: 60000 },
        (err, _stdout, stderr) => {
          this.#compilePromise = null;
          if (err) {
            this.#status = 'error';
            this.#lastError = (stderr || err.message || 'Swift 编译失败').trim().slice(0, 240);
            reject(new Error(this.#lastError));
            return;
          }
          this.#status = 'ready';
          resolve(this.binPath);
        },
      );
    });
    return this.#compilePromise;
  }

  async start(settings) {
    if (process.platform !== 'darwin') {
      return this.getState();
    }
    this.#storage.syncCompanionConfig(settings);
    const isRunning = Boolean(this.#child && !this.#child.killed && this.#child.exitCode === null);
    if (isRunning && !this.#needsCompile()) {
      return this.getState();
    }
    if (isRunning) {
      this.stop();
    }

    try {
      const bin = await this.ensureCompiled();
      const child = spawn(bin, [this.#storage.companionConfigPath, String(process.pid)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });

      this.#child = child;
      this.#status = 'running';
      this.#lastError = '';

      let errBuf = '';
      child.stderr?.on('data', (chunk) => {
        errBuf += chunk.toString();
      });

      child.on('exit', (code, signal) => {
        if (this.#child === child) {
          this.#child = null;
          if (code && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
            this.#status = 'error';
            this.#lastError = errBuf.trim().slice(0, 200) || `伴侣进程退出 (${code})`;
          } else {
            this.#status = 'ready';
          }
        }
      });

      return this.getState();
    } catch (err) {
      this.#status = 'error';
      this.#lastError = err.message;
      return this.getState();
    }
  }

  stop() {
    if (this.#child && !this.#child.killed) {
      try {
        this.#child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.#child = null;
    if (this.#status === 'running') {
      this.#status = 'ready';
    }
    return this.getState();
  }

  async syncWithSettings(settings) {
    this.#storage.syncCompanionConfig(settings);
    if (settings.companion?.enabled) {
      return this.start(settings);
    }
    return this.stop();
  }
}
