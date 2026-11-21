import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validToken, isExtensionOrigin, validSession, dimensions, parseSessions,
  parseClientMessage, launchArgs, terminalEnv, noSessions,
} from '../bridge/protocol.mjs';

test('token authentication rejects missing and wrong credentials', () => {
  assert.equal(validToken(undefined, 'secret'), false);
  assert.equal(validToken('secre', 'secret'), false);
  assert.equal(validToken('xxxxxx', 'secret'), false);
  assert.equal(validToken('secret', 'secret'), true);
});
test('only Chrome extension origins are accepted', () => {
  assert.equal(isExtensionOrigin(`chrome-extension://${'a'.repeat(32)}`), true);
  for (const origin of [undefined, 'null', 'http://localhost', 'https://example.com', `chrome-extension://${'z'.repeat(32)}`, `chrome-extension://${'a'.repeat(32)}/`]) {
    assert.equal(isExtensionOrigin(origin), false);
  }
});
test('session names cannot become flags or paths', () => {
  for (const session of ['--help', '../foo', 'a b', 'a;whoami', '', 'a'.repeat(97)]) assert.equal(validSession(session), false);
  assert.equal(validSession('dev.logs_2-3'), true);
});
test('resize dimensions have bounded integer sizes', () => {
  assert.deepEqual(dimensions(80, 24), { cols: 80, rows: 24 });
  for (const pair of [[0, 24], [80, 1], [501, 24], [80, 301], [80.5, 24], ['80', 24]]) assert.equal(dimensions(...pair), null);
});
test('fresh installations report no sessions across Zellij output variants', () => {
  for (const text of ['No sessions found.', 'No active sessions found.', 'No Zellij sessions found.', '\x1b[31mNo active Zellij sessions found.\x1b[0m']) {
    assert.equal(noSessions({ stderr: text }), true);
    assert.equal(noSessions({ stdout: text }), true);
  }
  assert.equal(noSessions({ stderr: 'Permission denied' }), false);
  assert.equal(noSessions({ stderr: 'Failed to read sessions' }), false);
});
test('session listing preserves active and exited state', () => {
  assert.deepEqual(parseSessions('\x1b[32mdev\x1b[0m [Created 1h ago] (current)\r\nold [Created 2h ago] (EXITED - attach to resurrect)\nnoise\n'), [
    { name: 'dev', exited: false, current: true },
    { name: 'old', exited: true, current: false },
  ]);
});
test('protocol rejects arbitrary process execution and invalid payloads', () => {
  for (const value of ['null', '[]', '{', '{"type":"exec","command":"whoami"}', '{"type":"open","mode":"bash","session":"dev","cols":80,"rows":24}', '{"type":"resize","cols":1,"rows":24}']) {
    assert.throws(() => parseClientMessage(value));
  }
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'input', data: 'x'.repeat(33000) })));
  assert.deepEqual(parseClientMessage('{"type":"input","data":"hello"}'), { type: 'input', data: 'hello' });
  assert.deepEqual(parseClientMessage('{"type":"open","session":"dev","mode":"watch","cols":80,"rows":24,"command":"ignored"}'), { type: 'open', session: 'dev', mode: 'watch', cols: 80, rows: 24 });
});
test('launches Zellij directly with fixed command arguments', () => {
  assert.deepEqual(launchArgs({ mode: 'watch', session: 'dev' }), ['watch', 'dev']);
  assert.deepEqual(launchArgs({ mode: 'attach', session: 'dev' }), ['attach', 'dev']);
  assert.deepEqual(launchArgs({ mode: 'create', session: 'dev' }), ['attach', '--create', 'dev']);
  assert.throws(() => launchArgs({ mode: 'create', session: '--help' }));
});
test('bridge does not inherit nested Zellij session variables', () => {
  const source = { PATH: '/bin', ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'parent', ZELLIJ_PANE_ID: '1', ZELLIJ_CONFIG_FILE: 'parent.kdl', ZELLIJ_SOCKET_DIR: '/tmp/zj' };
  assert.deepEqual(terminalEnv(source), { PATH: '/bin', ZELLIJ_CONFIG_FILE: 'parent.kdl', ZELLIJ_SOCKET_DIR: '/tmp/zj', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  assert.equal(source.ZELLIJ_SESSION_NAME, 'parent');
});

test('diagnostic modes: plain shell and bare Zellij are accepted, bare uses an isolated config', async () => {
  const { bareConfig, BARE_LAYOUT, shellCandidates, shellArgs } = await import('../bridge/protocol.mjs');
  for (const mode of ['shell', 'bare']) {
    assert.equal(parseClientMessage(JSON.stringify({ type: 'open', session: 'x-test', mode, cols: 80, rows: 24 })).mode, mode);
  }
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'open', session: 'x', mode: 'root', cols: 80, rows: 24 })));
  assert.deepEqual(launchArgs({ mode: 'bare', session: 'bare-test' }, { bareConfigPath: 'C:/s/config.kdl' }),
    ['--config', 'C:/s/config.kdl', 'attach', '--create', 'bare-test']);
  assert.throws(() => launchArgs({ mode: 'bare', session: 'bare-test' }));
  const config = bareConfig(["C:", "state", "bare", "layouts"].join(String.fromCharCode(92)));
  assert.match(config, /layout_dir "C:\/state\/bare\/layouts"/);
  assert.match(config, /default_layout "bare"/);
  assert.match(BARE_LAYOUT, /^layout \{\s+pane\s+\}/);
  assert.deepEqual(shellCandidates({ platform: "win32", env: { PATH: "C:/a;\"C:/b\"" } }).slice(0, 4), ["C:/a/pwsh.exe", "C:/b/pwsh.exe", "C:/a/powershell.exe", "C:/b/powershell.exe"]);
  assert.deepEqual(shellCandidates({ platform: 'linux', env: { SHELL: '/bin/zsh' } }), ['/bin/zsh']);
  assert.deepEqual(shellArgs('C:/x/pwsh.exe'), ['-NoLogo']);
  assert.deepEqual(shellArgs('/bin/zsh'), []);
});
