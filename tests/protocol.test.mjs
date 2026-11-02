import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validToken, isExtensionOrigin, validSession, dimensions, parseSessions,
  parseClientMessage, launchArgs, terminalEnv,
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
test('session listing preserves active and exited state', () => {
  assert.deepEqual(parseSessions('\x1b[32mdev\x1b[0m [Created 1h ago] (current)\r\nold [Created 2h ago] (EXITED - attach to resurrect)\nnoise\n'), [
    { name: 'dev', exited: false, current: true },
    { name: 'old', exited: true, current: false },
  ]);
});
test('protocol rejects arbitrary process execution and invalid payloads', () => {
  for (const value of ['null', '[]', '{', '{"type":"exec","command":"whoami"}', '{"type":"open","mode":"shell","session":"dev","cols":80,"rows":24}', '{"type":"resize","cols":1,"rows":24}']) {
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
  const source = { PATH: '/bin', ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'parent', ZELLIJ_CONFIG_FILE: 'parent.kdl' };
  assert.deepEqual(terminalEnv(source), { PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  assert.equal(source.ZELLIJ_SESSION_NAME, 'parent');
});
