import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executableCandidates, resolveZellij, bridgePaths, projectRoot } from '../bridge/platform.mjs';

test('Windows discovery returns absolute PATH and native installation candidates', () => {
  const result = executableCandidates({ platform: 'win32', env: { Path: 'C:\\tools;"C:\\Program Files\\bin"', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, home: 'C:\\Users\\test', cwd: 'C:\\project' });
  assert.ok(result.includes('C:\\tools\\zellij.exe'));
  assert.ok(result.includes('C:\\Program Files\\bin\\zellij.exe'));
  assert.ok(result.includes('C:\\Users\\test\\AppData\\Local\\Zellij\\zellij.exe'));
});
test('macOS discovery supports Apple Silicon, Intel Homebrew, and Cargo', () => {
  const result = executableCandidates({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/test', cwd: '/project' });
  for (const candidate of ['/usr/bin/zellij', '/opt/homebrew/bin/zellij', '/usr/local/bin/zellij', '/Users/test/.cargo/bin/zellij']) assert.ok(result.includes(candidate));
});
test('explicit paths take precedence and do not silently select another install', () => {
  assert.deepEqual(executableCandidates({ platform: 'darwin', env: { ZELLIJ_PATH: '/custom/zellij', PATH: '/bin' } }), ['/custom/zellij']);
  assert.deepEqual(executableCandidates({ platform: 'win32', env: { ZELLIJ_PATH: 'C:\\custom\\zellij.exe' } }), ['C:\\custom\\zellij.exe']);
  assert.deepEqual(executableCandidates({ platform: 'darwin', cwd: '/project', env: { ZELLIJ_PATH: './bin/zellij' } }), ['/project/bin/zellij']);
});
test('state location is project-relative, not dependent on launch directory', () => {
  assert.equal(bridgePaths({}).stateDir, path.join(projectRoot, '.bridge'));
  assert.equal(bridgePaths({ WEBSHELL_STATE_DIR: './custom-state' }).stateDir, path.resolve('./custom-state'));
});
test('resolver finds an executable file and rejects missing explicit files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'side-shell-platform-'));
  try {
    const executable = path.join(directory, process.platform === 'win32' ? 'zellij.exe' : 'zellij');
    await writeFile(executable, 'test fixture, never executed');
    if (process.platform !== 'win32') await chmod(executable, 0o700);
    assert.equal(await resolveZellij({ env: { ZELLIJ_PATH: executable } }), executable);
    await assert.rejects(resolveZellij({ env: { ZELLIJ_PATH: path.join(directory, 'missing') } }), /Zellij executable not found/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
