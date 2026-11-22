import { access, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting } from './env.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function executableCandidates({ platform = process.platform, env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configured = env.ZELLIJ_PATH;
  if (configured && paths.isAbsolute(configured)) return [configured];
  if (configured && /[/\\]/.test(configured)) return [paths.resolve(cwd, configured)];
  const name = configured || (platform === 'win32' ? 'zellij.exe' : 'zellij');
  const directories = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin', paths.join(home, '.cargo', 'bin'));
  if (platform === 'win32' && env.LOCALAPPDATA) directories.push(paths.join(env.LOCALAPPDATA, 'Zellij'));
  const names = platform === 'win32' && !paths.extname(name) ? [`${name}.exe`, name] : [name];
  return [...new Set(directories.flatMap(directory => names.map(file => paths.resolve(cwd, directory.replace(/^"|"$/g, ''), file))))];
}

export async function resolveZellij(options = {}) {
  const platform = options.platform || process.platform;
  for (const candidate of executableCandidates(options)) {
    try {
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error('Zellij executable not found. Install Zellij, add it to PATH, or set ZELLIJ_PATH to its absolute path. On macOS: brew install zellij.');
}

export function bridgePaths(env = process.env, { home = homedir(), legacyDir = path.join(projectRoot, '.bridge') } = {}) {
  const state = setting(env, 'STATE_DIR');
  const cwd = setting(env, 'CWD');
  return {
    // Keep credentials stable when the bridge is launched from a different cwd. A package install
    // cannot keep state beside its code, so default to the home directory; an existing checkout-local
    // `.bridge` (from before the package existed) keeps being used so its pairing token stays valid.
    stateDir: state ? path.resolve(state) : existsSync(legacyDir) ? legacyDir : path.join(home, '.zellij-deck'),
    cwd: cwd ? path.resolve(cwd) : home,
  };
}
