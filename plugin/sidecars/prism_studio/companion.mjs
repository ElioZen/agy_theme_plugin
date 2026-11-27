import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IS_MAC,
  IS_WIN,
  IS_WSL,
  findWindowsCsc,
  getWindowsLocalAppDataDir,
  toWindowsPath,
} from './platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWIFT_SOURCE = join(__dirname, 'mac', 'PrismBackdrop.swift');
const WIN_CS_SOURCE = join(__dirname, 'win', 'PrismBackdrop.cs');

export class BackdropCompanion {
  #storage;
  #child = null;
  #status = 'ready'; // 'unsupported' | 'ready' | 'compiling' | 'running' | 'error'
  #lastError = '';
  #compilePromise = null;
  #backend = 'none'; // 'mac' | 'win' | 'none'

  constructor(storage) {
    this.#storage = storage;
    if (IS_MAC) {
      this.#backend = 'mac';
    } else if ((IS_WIN || IS_WSL) && findWindowsCsc()) {
      this.#backend = 'win';
    } else {
      this.#backend = 'none';
      this.#status = 'unsupported';
    }
  }

  isSupported() {
    return this.#backend !== 'none';
  }

  get sourcePath() {
    return this.#backend === 'mac' ? SWIFT_SOURCE : WIN_CS_SOURCE;
  }

  get binPath() {
    if (this.#backend === 'mac') {
      return join(this.#storage.binDir, 'PrismBackdrop');
    }
    if (this.#backend === 'win') {
      const localAppData = getWindowsLocalAppDataDir();
      if (localAppData) {
        return join(localAppData, 'PrismOrbit', 'PrismBackdrop.exe');
      }
      return join(this.#storage.binDir, 'PrismBackdrop.exe');
    }
    return join(this.#storage.binDir, 'PrismBackdrop');
  }

  getState() {
    const supported = this.isSupported();
    const running = Boolean(this.#child && !this.#child.killed && this.#child.exitCode === null);
    let status = this.#status;
    if (!supported) status = 'unsupported';
    else if (running) status = 'running';
    else if (status === 'running') status = 'ready';

    return {
      supported,
      backend: this.#backend,
      status,
      running,
      pid: running ? this.#child.pid : null,
      error: this.#lastError,
      binaryReady: supported && existsSync(this.binPath),
    };
  }

  #needsCompile() {
    if (!existsSync(this.binPath)) return true;
    try {
      return statSync(this.sourcePath).mtimeMs > statSync(this.binPath).mtimeMs;
    } catch {
      return true;
    }
  }

  async ensureCompiled() {
    if (!this.isSupported()) {
      throw new Error('整窗氛围伴侣仅支持 macOS 与 Windows / WSL2');
    }
    if (!existsSync(this.sourcePath)) {
      throw new Error(`缺少伴侣源码：${this.sourcePath}`);
    }

    if (!this.#needsCompile()) return this.binPath;
    if (this.#compilePromise) return this.#compilePromise;

    this.#status = 'compiling';
    this.#lastError = '';

    if (this.#backend === 'mac') {
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

    // Windows / WSL2 native .NET Framework C# build via built-in csc.exe
    const cscPath = findWindowsCsc();
    if (!cscPath) {
      this.#status = 'error';
      this.#lastError = '未找到 Windows .NET 编译器 (csc.exe)';
      throw new Error(this.#lastError);
    }

    mkdirSync(dirname(this.binPath), { recursive: true });
    const winSrc = toWindowsPath(WIN_CS_SOURCE);
    const winOut = toWindowsPath(this.binPath);

    this.#compilePromise = new Promise((resolve, reject) => {
      execFile(
        cscPath,
        [
          '/nologo',
          '/target:winexe',
          '/unsafe',
          '/optimize+',
          '/r:System.Drawing.dll',
          '/r:System.Windows.Forms.dll',
          '/r:System.Web.Extensions.dll',
          `/out:${winOut}`,
          winSrc,
        ],
        { timeout: 60000, windowsHide: true },
        (err, stdout, stderr) => {
          this.#compilePromise = null;
          if (err) {
            this.#status = 'error';
            this.#lastError = (stderr || stdout || err.message || 'C# 编译失败').trim().slice(0, 240);
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
    if (!this.isSupported()) {
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
      let child;
      if (this.#backend === 'mac') {
        child = spawn(bin, [this.#storage.companionConfigPath, String(process.pid)], {
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: false,
        });
      } else {
        const winConfigPath = toWindowsPath(this.#storage.companionConfigPath);
        const winParentPid = IS_WIN ? String(process.pid) : '0';
        // Keep stdin pipe open so PrismBackdrop.exe exits cleanly & instantly if sidecar terminates
        child = spawn(bin, [winConfigPath, winParentPid], {
          stdio: ['pipe', 'ignore', 'pipe'],
          detached: false,
          windowsHide: true,
        });
      }

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
        // Closing stdin lets Windows/WSL2 PrismBackdrop.exe exit gracefully (hiding overlay & unhooking events)
        this.#child.stdin?.end();
      } catch {
        // ignore
      }
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

export { BackdropCompanion as MacBackdropCompanion };
