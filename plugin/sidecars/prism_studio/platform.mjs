import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';

function detectWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const ver = readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(ver);
  } catch {
    return false;
  }
}

export const IS_WSL = detectWsl();

let cachedWinUserProfile = undefined; // string | null
let cachedWslDistro = undefined; // string | null

export function findWindowsCsc() {
  const candidates = IS_WIN
    ? [
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
      ]
    : IS_WSL
    ? [
        '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
        '/mnt/c/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
      ]
    : [];

  if (IS_WSL && !existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    return '';
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return '';
}

export function getWslDistroName() {
  if (!IS_WSL) return '';
  if (cachedWslDistro !== undefined) return cachedWslDistro || '';
  if (process.env.WSL_DISTRO_NAME) {
    cachedWslDistro = process.env.WSL_DISTRO_NAME;
    return cachedWslDistro;
  }
  try {
    const mapped = execFileSync('wslpath', ['-w', '/'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .toString('utf-8')
      .trim();
    const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i.exec(mapped);
    cachedWslDistro = m ? m[1] : '';
  } catch {
    cachedWslDistro = '';
  }
  return cachedWslDistro || '';
}

export function toWindowsPath(inputPath) {
  const p = String(inputPath || '').trim();
  if (!p) return '';
  if (IS_WIN) return p;
  if (!IS_WSL) return p;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    return p.replace(/\//g, '\\');
  }

  // Fast path: /mnt/<drive>/... -> <DRIVE>:\...
  const mntMatch = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = (mntMatch[2] || '').replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }

  // Fast path: Linux path -> \\wsl.localhost\<distro>\...
  const distro = getWslDistroName();
  if (distro && p.startsWith('/')) {
    return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
  }

  try {
    return execFileSync('wslpath', ['-w', p], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .toString('utf-8')
      .trim();
  } catch {
    return p;
  }
}

export function windowsToWslPath(winPath) {
  const p = String(winPath || '').trim();
  if (!p) return '';
  if (!IS_WSL) return p;
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/').replace(/^\/+/, '');
    return `/mnt/${drive}/${rest}`;
  }
  try {
    return execFileSync('wslpath', ['-u', p], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .toString('utf-8')
      .trim();
  } catch {
    return '';
  }
}

/**
 * In WSL2, resolves the Windows user's profile directory mounted under /mnt/c/Users/<Name>.
 * Returns '' on non-WSL or if unavailable.
 */
export function getWindowsUserProfileInWsl() {
  if (!IS_WSL) return '';
  if (cachedWinUserProfile !== undefined) return cachedWinUserProfile || '';

  // 1. Fast check from inherited Windows PATH entries (zero subprocess cost!)
  const pathEnv = process.env.PATH || '';
  const pathMatch = /\/mnt\/([a-zA-Z])\/Users\/([^/:]+)/i.exec(pathEnv);
  if (pathMatch) {
    const candidate = `/mnt/${pathMatch[1].toLowerCase()}/Users/${pathMatch[2]}`;
    if (existsSync(candidate)) {
      cachedWinUserProfile = candidate;
      return candidate;
    }
  }

  // 2. Fallback: ask Windows cmd.exe once
  const cmdExe = '/mnt/c/Windows/System32/cmd.exe';
  if (existsSync(cmdExe)) {
    try {
      const raw = execFileSync(cmdExe, ['/c', 'echo %USERPROFILE%'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4000,
      })
        .toString('utf-8')
        .trim();
      const mapped = windowsToWslPath(raw);
      if (mapped && existsSync(mapped)) {
        cachedWinUserProfile = mapped;
        return mapped;
      }
    } catch {
      // ignore
    }
  }

  cachedWinUserProfile = '';
  return '';
}

export function getWindowsLocalAppDataDir() {
  if (IS_WIN) {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }
  if (IS_WSL) {
    const winProfile = getWindowsUserProfileInWsl();
    if (winProfile) return join(winProfile, 'AppData', 'Local');
  }
  return '';
}
