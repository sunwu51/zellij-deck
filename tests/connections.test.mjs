import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: [new URL('../extension/connections.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const mod = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const { migrate, addConnection, updateConnection, removeConnection, validateConnection, httpBase, wsUrl, checkHealth, defaultName, loadConnections } = mod;

const TOKEN = 'a'.repeat(40);
const input = (over = {}) => ({ name: 'Local', host: '127.0.0.1', port: 17329, token: TOKEN, ...over });

test('legacy single-bridge settings migrate to one Local connection, once', () => {
  const state = migrate({ settings: { host: '127.0.0.1', port: 17400, token: TOKEN, session: 'dev', fontSize: 14, mode: 'watch' } });
  assert.equal(state.migrated, true);
  assert.deepEqual(state.connections, [{ id: 'local', name: 'Local', host: '127.0.0.1', port: 17400, token: TOKEN, lastSession: 'dev' }]);
  assert.equal(state.active, 'local');
  assert.deepEqual(state.settings, { fontSize: 14, mode: 'watch' }, 'connection fields leave settings');
  const again = migrate({ settings: state.settings, connections: state.connections, activeConnection: state.active });
  assert.equal(again.migrated, false);
  assert.deepEqual(again.connections, state.connections);
});
test('migration names a LAN bridge by its address and skips unpaired installs', () => {
  assert.equal(migrate({ settings: { host: '192.168.1.10', port: 17329, token: TOKEN } }).connections[0].name, '192.168.1.10');
  const empty = migrate({ settings: { host: '127.0.0.1', port: 17329, token: '' } });
  assert.deepEqual(empty.connections, []);
  assert.equal(empty.active, '');
  assert.deepEqual(migrate({}).connections, []);
});
test('stored connections are sanitized and a stale active id falls back to the first', () => {
  const good = { id: 'one', name: 'A', host: '127.0.0.1', port: 17329, token: TOKEN };
  const state = migrate({ connections: [good, { id: 'bad id!' }, null, { id: 'x', name: 1 }], activeConnection: 'gone' });
  assert.deepEqual(state.connections, [good]);
  assert.equal(state.active, 'one');
});
test('validation covers name, address, port and token', () => {
  assert.equal(validateConnection(input()), undefined);
  assert.match(validateConnection(input({ name: '  ' })), /Name/);
  assert.match(validateConnection(input({ name: 'x'.repeat(41) })), /Name/);
  assert.match(validateConnection(input({ host: 'example.com' })), /IPv4/);
  assert.match(validateConnection(input({ port: 80 })), /Port/);
  assert.match(validateConnection(input({ token: 'short' })), /token/);
});
test('add, update and remove keep host:port unique and the active id valid', () => {
  let list = addConnection([], input(), 'a');
  list = addConnection(list, input({ name: 'Remote', host: '192.168.1.10' }), 'b');
  assert.deepEqual(list.map(item => item.id), ['a', 'b']);
  assert.throws(() => addConnection(list, input({ name: 'Dup' })), /already exists/);
  assert.throws(() => addConnection(list, input({ port: 1 })), /Port/);
  list = updateConnection(list, 'b', input({ name: 'Remote 2', host: '192.168.1.10', port: 17330 }));
  assert.equal(list[1].port, 17330);
  assert.equal(list[1].id, 'b');
  assert.doesNotThrow(() => updateConnection(list, 'a', input({ name: 'Renamed' })), 'a connection may keep its own address');
  assert.throws(() => updateConnection(list, 'a', input({ host: '192.168.1.10', port: 17330 })), /already exists/);
  assert.deepEqual(removeConnection(list, 'a', 'a'), { connections: [list[1]], active: 'b' });
  assert.deepEqual(removeConnection(list, 'a', 'b').active, 'a');
  assert.deepEqual(removeConnection([list[0]], 'a', 'a'), { connections: [], active: '' });
});
test('URLs and names derive from the connection', () => {
  const c = { id: 'a', ...input({ host: '10.0.0.2', port: 17330 }) };
  assert.equal(httpBase(c), 'http://10.0.0.2:17330');
  assert.equal(wsUrl(c), 'ws://10.0.0.2:17330/terminal');
  assert.equal(defaultName('127.0.0.1'), 'Local');
});
test('health check distinguishes online, bad token and unreachable bridges', async () => {
  globalThis.chrome = { runtime: { id: 'ext' } };
  const c = { id: 'a', ...input() };
  const respond = status => async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:17329/health');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return { ok: status === 200, status };
  };
  assert.equal(await checkHealth(c, respond(200)), 'online');
  assert.equal(await checkHealth(c, respond(401)), 'unauthorized');
  assert.equal(await checkHealth(c, respond(500)), 'offline');
  assert.equal(await checkHealth(c, async () => { throw new Error('refused'); }), 'offline');
});
test('loadConnections writes the migration back to storage', async () => {
  let store = { settings: { host: '127.0.0.1', port: 17329, token: TOKEN, session: 's', fontSize: 15 } };
  globalThis.chrome = { runtime: { id: 'ext' }, storage: { local: {
    get: async () => structuredClone(store),
    set: async values => { store = { ...store, ...structuredClone(values) }; },
  } } };
  const first = await loadConnections();
  assert.equal(first.connections.length, 1);
  assert.deepEqual(store.settings, { fontSize: 15 });
  assert.equal(store.activeConnection, 'local');
  const second = await loadConnections();
  assert.deepEqual(second.connections, first.connections);
});
