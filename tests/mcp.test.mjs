import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  stripAnsi, toLines, pageLines, findLines, compilePattern, wrapLines, normalizeKey, normalizePaneId,
} from '../bridge/mcp/text.mjs';
import { McpSessionStore, STARTUP_GRACE_MS } from '../bridge/mcp/store.mjs';
import { createMcpHandler } from '../bridge/mcp/handler.mjs';
import { ToolError, createTools } from '../bridge/mcp/tools.mjs';

const HOUR = 3_600_000;

test('terminal text is reduced to plain lines without trailing blank rows', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07ok\x07'), 'red\nok');
  assert.deepEqual(toLines('a  \n\x1b[1mb\x1b[m\n\n   \n'), ['a', 'b']);
});

test('line paging uses absolute offsets and reports the next page', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
  assert.deepEqual(pageLines(lines, { offset: 2, limit: 3 }), { total_lines: 10, start: 2, end: 5, next_offset: 5, text: 'l2\nl3\nl4' });
  assert.equal(pageLines(lines, { tail: 2 }).text, 'l8\nl9');
  assert.equal(pageLines(lines, { tail: 2 }).next_offset, null);
  // Lines dropped from a bounded buffer keep later line numbers stable.
  const trimmed = pageLines(['l5', 'l6'], { offset: 0 }, 5);
  assert.equal(trimmed.start, 5);
  assert.equal(trimmed.first_available_line, 5);
  assert.equal(trimmed.total_lines, 7);
  assert.throws(() => pageLines(lines, { limit: 0 }));
  assert.match(pageLines(['x'.repeat(3000)], {}).text, /…\[\+1000 chars\]$/);
});

test('pattern search returns absolute line numbers from an offset', () => {
  const lines = ['ok', 'ERROR one', 'ok', 'error two'];
  assert.deepEqual(findLines(lines, compilePattern('error', { ignoreCase: true }), { from: 2 }), [{ line: 3, text: 'error two' }]);
  assert.equal(findLines(lines, compilePattern('a.b', { literal: true })).length, 0);
  assert.throws(() => compilePattern('('), /Invalid regular expression/);
});

test('screen rows re-wrap logical lines with wide characters', () => {
  assert.deepEqual(wrapLines(['abcdef'], 4), ['abcd', 'ef']);
  assert.deepEqual(wrapLines(['中文字'], 4), ['中文', '字']);
  assert.deepEqual(wrapLines([''], 4), ['']);
});

test('keys follow Zellij send-keys syntax; pane ids are terminal panes only', () => {
  assert.equal(normalizeKey('ctrl c'), 'Ctrl c');
  assert.equal(normalizeKey('alt shift B'), 'Alt Shift B');
  assert.equal(normalizeKey('enter'), 'Enter');
  assert.equal(normalizeKey('escape'), 'Esc');
  assert.equal(normalizeKey('f5'), 'F5');
  assert.equal(normalizeKey('-'), '-');
  for (const bad of ['Hyper x', 'Ctrl Ctrl c', 'Enterr', '', 'F13']) assert.throws(() => normalizeKey(bad), undefined, bad);
  assert.equal(normalizePaneId('3'), 'terminal_3');
  assert.equal(normalizePaneId(4), 'terminal_4');
  assert.equal(normalizePaneId('terminal_0'), 'terminal_0');
  for (const bad of ['plugin_1', '--help', 'terminal_x', -1]) assert.throws(() => normalizePaneId(bad), undefined, String(bad));
});

test('MCP sessions slide their expiry with each request and are swept when idle', () => {
  let now = 0;
  const store = new McpSessionStore({ token: 't', now: () => now, ttlMs: 24 * HOUR, orphanAfterMs: 2 * HOUR });
  const id = store.create({ name: 'tabpilot' });
  store.own('ag-1', id);
  now = 23 * HOUR;
  assert.ok(store.touch(id), 'Within the TTL');
  now = 46 * HOUR; // 23h after the last request
  assert.ok(store.touch(id), 'Each request renews the TTL');
  assert.equal(store.expiresAt(id), 70 * HOUR);
  assert.deepEqual(store.sweep(), { owners: [], abandoned: [] });
  now = 70 * HOUR + 1;
  assert.equal(store.touch(id), undefined, 'Idle past the TTL');
  assert.deepEqual(store.sweep(), { owners: [id], abandoned: [] });
  assert.equal(store.sessions.has(id), false);
});

test('terminals become adoptable after the orphan threshold, before they expire', () => {
  let now = 0;
  const store = new McpSessionStore({ token: 't', now: () => now, ttlMs: 24 * HOUR, orphanAfterMs: 2 * HOUR });
  const a = store.create();
  store.own('ag-a', a);
  now = HOUR;
  assert.equal(store.isOrphaned(a), false);
  assert.deepEqual(store.orphanedSessions(), []);
  now = 3 * HOUR;
  assert.equal(store.isOrphaned(a), true);
  assert.deepEqual(store.orphanedSessions(), [{ session: 'ag-a', owner_idle_minutes: 180, expires_in_minutes: 1260 }]);
  store.terminate(a);
  assert.equal(store.isOrphaned(a), true, 'A terminated owner is orphaned');
});

test('terminals whose owner record vanished are released one TTL later', () => {
  let now = 0;
  const store = new McpSessionStore({ token: 't', now: () => now, ttlMs: 24 * HOUR });
  store.own('ag-lost', 'mcp_' + 'f'.repeat(32));
  assert.deepEqual(store.sweep().abandoned, [], 'First sweep only marks it');
  now = 24 * HOUR + 1;
  assert.deepEqual(store.sweep().abandoned, ['ag-lost']);
});

test('sessions persist across restarts, with a grace period and token binding', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-store-'));
  const file = path.join(dir, 'mcp-sessions.json');
  try {
    let now = 0;
    const first = new McpSessionStore({ file, token: 'secret', now: () => now, ttlMs: 24 * HOUR });
    const id = first.create({ name: 'x' });
    first.own('ag-1', id, { cols: 120, rows: 30 });
    await first.save();
    assert.equal((await readFile(file, 'utf8')).includes('secret'), false, 'The token itself is never stored');

    // The bridge was stopped for three days: a restart grants a grace period instead of expiring at once.
    now = 72 * HOUR;
    const second = new McpSessionStore({ file, token: 'secret', now: () => now, ttlMs: 24 * HOUR });
    await second.load();
    assert.ok(second.touch(id));
    assert.deepEqual(second.ownership('ag-1').cols, 120);
    now += STARTUP_GRACE_MS + 1;
    const third = new McpSessionStore({ file, token: 'secret', now: () => 72 * HOUR, ttlMs: 24 * HOUR });
    await third.load();
    assert.ok(third.sessions.has(id));

    const rotated = new McpSessionStore({ file, token: 'rotated', now: () => now, ttlMs: 24 * HOUR });
    await rotated.load();
    assert.equal(rotated.touch(id), undefined, 'A rotated token invalidates old session ids');
    assert.equal(rotated.ownerOf('ag-1'), id, 'Their terminals stay recorded so they can expire or be adopted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fakeRequest(method, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}
function fakeResponse() {
  const res = {
    status: 0, headers: {}, body: '', writableEnded: false, listeners: {},
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(payload = '') { this.body = payload; this.writableEnded = true; },
    on(event, handler) { this.listeners[event] = handler; },
  };
  return res;
}
async function request(handler, method, body, headers) {
  const res = fakeResponse();
  await handler.handle(fakeRequest(method, body, headers), res);
  return { status: res.status, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('handler follows MCP session rules and turns tool failures into readable results', async () => {
  const store = new McpSessionStore({ token: 't' });
  const released = [];
  const tools = {
    definitions: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    has: name => ['echo', 'fail', 'crash'].includes(name),
    async call(name, args, { owner }) {
      if (name === 'fail') throw new ToolError('expected failure');
      if (name === 'crash') throw new Error('bug');
      return { owner, args };
    },
    async releaseOwner(owner) { released.push(owner); return ['ag-x']; },
    async releaseSession() {},
  };
  const handler = createMcpHandler({ store, tools, serverInfo: { name: 'test', version: '0' }, log: {} });
  try {
    const init = await request(handler, 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', clientInfo: { name: 'c' } } });
    assert.equal(init.status, 200);
    const sessionId = init.headers['Mcp-Session-Id'];
    assert.match(sessionId, /^mcp_/);
    assert.equal(init.body.result.protocolVersion, '2025-06-18', 'Unknown versions get the latest supported');
    const headers = { 'Mcp-Session-Id': sessionId };

    assert.equal((await request(handler, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 400);
    assert.equal((await request(handler, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': 'mcp_nope' })).status, 404);
    assert.equal((await request(handler, 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status, 202);
    assert.equal((await request(handler, 'POST', '{nope', headers)).status, 400);
    assert.equal((await request(handler, 'GET', undefined, headers)).status, 405);

    const listed = await request(handler, 'POST', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, headers);
    assert.equal(listed.body.result.tools[0].name, 'echo');
    const echoed = await request(handler, 'POST', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } }, headers);
    assert.deepEqual(JSON.parse(echoed.body.result.content[0].text), { owner: sessionId, args: { x: 1 } }, 'The owner is the Mcp-Session-Id, never a model argument');
    assert.deepEqual(echoed.body.result.structuredContent.args, { x: 1 });
    const failed = await request(handler, 'POST', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fail' } }, headers);
    assert.deepEqual(failed.body.result, { content: [{ type: 'text', text: 'expected failure' }], isError: true });
    const crashed = await request(handler, 'POST', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'crash' } }, headers);
    assert.equal(crashed.body.result.isError, true);
    assert.equal((await request(handler, 'POST', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } }, headers)).body.error.code, -32602);
    assert.equal((await request(handler, 'POST', { jsonrpc: '2.0', id: 8, method: 'bogus' }, headers)).body.error.code, -32601);
    const batch = await request(handler, 'POST', [{ jsonrpc: '2.0', id: 9, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 10, method: 'ping' }], headers);
    assert.deepEqual(batch.body.map(reply => reply.id), [9, 10]);

    const deleted = await request(handler, 'DELETE', undefined, headers);
    assert.deepEqual(deleted.body, { terminated: true, released_sessions: ['ag-x'] });
    assert.deepEqual(released, [sessionId]);
    assert.equal((await request(handler, 'POST', { jsonrpc: '2.0', id: 11, method: 'ping' }, headers)).status, 404);
    assert.equal((await request(handler, 'DELETE', undefined, headers)).status, 404);
  } finally { handler.close(); }
});

test('expired sessions are swept and their terminals released', async () => {
  let now = 0;
  const store = new McpSessionStore({ token: 't', now: () => now, ttlMs: HOUR });
  const released = [];
  const tools = { definitions: [], has: () => false, async releaseOwner(owner) { released.push(owner); return []; }, async releaseSession(name) { released.push(name); } };
  const handler = createMcpHandler({ store, tools, serverInfo: {}, log: {} });
  try {
    const id = store.create();
    now = 2 * HOUR;
    await handler.sweep();
    assert.deepEqual(released, [id]);
  } finally { handler.close(); }
});

// A scripted Zellij: one session of terminal panes, each in its own tab. Typing appends to the
// prompt line; Enter prints "result:42" and a new prompt.
function fakeZellij({ session = 'ag-1' } = {}) {
  const state = { session: null, panes: [], nextId: 0, text: 'PS> ', typed: '', actions: [], opened: [], created: [], removed: [] };
  const pane = id => ({ id, is_plugin: false, is_suppressed: false, is_focused: true, tab_name: `tab-${id}`, title: 'pwsh', pane_content_columns: 80, pane_content_rows: 24, exited: false });
  const api = {
    state, cwd: '/',
    async sessions() { return state.session ? [{ name: state.session, exited: false, current: false }] : []; },
    async status(name) { return state.session === name ? 'running' : 'missing'; },
    async ensureAnchor() {},
    async panes() {
      if (!state.session) throw new Error('Session is not running.');
      return state.panes.map(item => ({ ...pane(item.id), ...item }));
    },
    async create(name) {
      state.created.push(name);
      state.session = name;
      state.panes = [{ id: state.nextId++ }];
      return `terminal_${state.panes[0].id}`;
    },
    async openTab(name, options) {
      state.opened.push(options);
      const id = state.nextId++;
      state.panes.push({ id, tab_name: options.name });
      return id;
    },
    async dump() { return state.text; },
    async action(name, args) {
      state.actions.push(args);
      if (args[0] === 'write-chars' || args[0] === 'paste') { state.typed += args.at(-1); state.text += args.at(-1); }
      if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { state.text += '\nresult:42\nPS> '; state.typed = ''; }
      if (args[0] === 'close-pane') {
        const id = Number(/\d+$/.exec(args[2])[0]);
        state.panes = state.panes.filter(item => item.id !== id);
      }
    },
    async remove(name) { state.removed.push(name); state.session = null; state.panes = []; },
  };
  if (session) { state.session = session; state.panes = [{ id: state.nextId++ }]; }
  return api;
}
function toolsWithFake({ session = 'ag-1', now } = {}) {
  const store = new McpSessionStore({ token: 't' });
  const owner = store.create({ name: 'Claude Code' });
  const zellij = fakeZellij({ session });
  if (session) store.own(session, owner, { panes: [0] });
  return { tools: createTools({ store, zellij, ...(now ? { now } : {}) }), zellij, store, owner };
}

test('pane_wait after pane_type matches output that already appeared, but not the echoed command', async () => {
  const { tools, zellij, owner } = toolsWithFake();
  const context = { owner };
  await tools.call('pane_type', { text: 'echo result:$((6*7))', submit: true }, context);
  // The command has already finished before the wait starts (the race that used to time out).
  const hit = await tools.call('pane_wait', { pattern: '^result:42', timeout_s: 1 }, context);
  assert.equal(hit.reason, 'pattern');
  assert.deepEqual(hit.match, { line: 1, text: 'result:42' });

  // The typed text echoed on the prompt line is before the mark, so it is not a match.
  await tools.call('pane_type', { text: 'echo needle-in-command', submit: false }, context);
  const echoed = await tools.call('pane_wait', { pattern: 'needle-in-command', timeout_s: 1 }, context);
  assert.equal(echoed.reason, 'timeout');
  // An explicit offset opts back in to the whole history.
  const explicit = await tools.call('pane_wait', { pattern: 'needle-in-command', since_offset: 0, timeout_s: 1 }, context);
  assert.equal(explicit.reason, 'pattern');
  assert.ok(zellij.state.actions.some(args => args[0] === 'write-chars' && args.at(-1) === 'echo needle-in-command'));
});

test('pane_wait without any earlier input ignores existing output and waits for new lines', async () => {
  const { tools, zellij, owner } = toolsWithFake();
  zellij.state.text = 'old result:42\nPS> ';
  const waited = await tools.call('pane_wait', { pattern: 'result:42', timeout_s: 1 }, { owner });
  assert.equal(waited.reason, 'timeout');
});

test('typed text is sent literally even when it starts with a dash, and keys are validated first', async () => {
  const { tools, zellij, owner } = toolsWithFake();
  await tools.call('pane_type', { text: '--help' }, { owner });
  assert.deepEqual(zellij.state.actions.at(-1), ['write-chars', '--pane-id', 'terminal_0', '--', '--help']);
  await assert.rejects(tools.call('pane_keys', { keys: ['Hyper x'] }, { owner }), /Unknown modifier/);
  assert.equal(zellij.state.actions.some(args => args[0] === 'send-keys'), false, 'Nothing is sent when a key is invalid');
  await tools.call('pane_keys', { keys: ['Down', 'Down', 'Enter'] }, { owner });
  assert.deepEqual(zellij.state.actions.at(-1), ['send-keys', '--pane-id', 'terminal_0', '--', 'Down', 'Down', 'Enter']);
});

test('another MCP session cannot reach your panes through any tool', async () => {
  const { tools } = toolsWithFake();
  const stranger = { owner: 'mcp_' + '1'.repeat(32) };
  for (const [name, args] of [['pane_type', { text: 'x' }], ['pane_keys', { keys: ['Enter'] }], ['pane_read', {}], ['pane_screen', {}], ['pane_wait', { idle_ms: 200 }], ['pane_close', { pane: 'terminal_0' }], ['pane_mouse', { action: 'click', col: 0, row: 0 }], ['pane_type', { pane: 'terminal_0', text: 'x' }]]) {
    await assert.rejects(tools.call(name, args, stranger), /not found|No panes/, name);
  }
  assert.deepEqual((await tools.call('pane_list', {}, stranger)).panes, []);
  assert.deepEqual(await tools.call('session_kill', {}, stranger), { ended: false, note: 'You have no panes.' });
  await assert.rejects(tools.call('session_adopt', { session: 'ag-1' }, stranger), /not found or not adoptable/, 'Live owners cannot be adopted');
});

test('mouse reports use 1-based SGR coordinates; wheel notches repeat', async () => {
  const { mouseSequences } = await import('../bridge/mcp/text.mjs');
  assert.deepEqual(mouseSequences('click', 4, 2), ['\x1b[<0;5;3M', '\x1b[<0;5;3m']);
  assert.equal(mouseSequences('double_click', 0, 0).length, 4);
  assert.deepEqual(mouseSequences('right_click', 0, 0), ['\x1b[<2;1;1M', '\x1b[<2;1;1m']);
  assert.deepEqual(mouseSequences('scroll_up', 9, 9, 2), ['\x1b[<64;10;10M', '\x1b[<64;10;10M']);
  assert.deepEqual(mouseSequences('scroll_down', 0, 0), ['\x1b[<65;1;1M']);
  assert.throws(() => mouseSequences('drag', 0, 0), /action must be one of/);
});

test('pane_mouse writes the escape bytes to the pane and rejects positions outside it', async () => {
  const { tools, zellij, owner } = toolsWithFake();
  const context = { owner };
  await tools.call('pane_mouse', { action: 'click', col: 4, row: 2 }, context);
  const written = zellij.state.actions.at(-1);
  assert.deepEqual(written.slice(0, 3), ['write', '--pane-id', 'terminal_0']);
  assert.equal(Buffer.from(written.slice(3).map(Number)).toString('latin1'), '\x1b[<0;5;3M\x1b[<0;5;3m');
  const before = zellij.state.actions.length;
  await assert.rejects(tools.call('pane_mouse', { action: 'click', col: 80, row: 0 }, context), /outside the pane \(80 columns × 24 rows/);
  await assert.rejects(tools.call('pane_mouse', { action: 'click', row: 0 }, context), /col and row are required/);
  await assert.rejects(tools.call('pane_mouse', { action: 'drag', col: 0, row: 0 }, context), /action must be one of/);
  assert.equal(zellij.state.actions.length, before, 'Nothing is sent for invalid positions');
});

test('pane_type and pane_keys return the offset where their output will start', async () => {
  const { tools, owner } = toolsWithFake();
  const context = { owner };
  const typed = await tools.call('pane_type', { text: 'echo result:$((6*7))', submit: true }, context);
  // One prompt line existed before typing; the echo and output come after the mark.
  assert.equal(typed.offset, 1);
  const read = await tools.call('pane_read', { offset: typed.offset }, context);
  assert.equal(read.text.startsWith('result:42'), true, read.text);
  const keys = await tools.call('pane_keys', { keys: ['Enter'] }, context);
  assert.equal(keys.offset > typed.offset, true, 'The mark advances with the pane');
  const mouse = await tools.call('pane_mouse', { action: 'click', col: 0, row: 0 }, context);
  assert.equal(typeof mouse.offset, 'number');
});

test('the first pane_open creates your session lazily and replaces its default shell tab', async () => {
  const { tools, zellij, store, owner } = toolsWithFake({ session: null });
  const context = { owner };
  assert.deepEqual((await tools.call('pane_list', {}, context)).panes, [], 'Listing creates nothing');
  assert.equal(zellij.state.created.length, 0);

  const opened = await tools.call('pane_open', { command: 'npm run dev', name: 'dev', cwd: process.cwd() }, context);
  assert.deepEqual(opened, { pane: 'terminal_1', name: 'dev', command: 'npm run dev', offset: 1 });
  assert.match(zellij.state.created[0], /^ag-claude-code-[a-f0-9]{6}$/, 'Named after the client');
  assert.deepEqual(zellij.state.opened[0], { name: 'dev', cwd: process.cwd() }, 'The tab is always a shell; the command is typed into it');
  // The session's default shell (terminal_0) was closed; only the requested pane remains.
  assert.deepEqual(zellij.state.panes.map(item => item.id), [1]);
  assert.equal(store.sessionOf(owner), zellij.state.created[0]);
  assert.deepEqual(store.ownership(zellij.state.created[0]).panes, [1]);
});

test('each pane gets its own tab, and several panes require an explicit pane id', async () => {
  const { tools, zellij, owner } = toolsWithFake({ session: null });
  const context = { owner };
  const first = await tools.call('pane_open', {}, context);
  assert.equal(first.name, 'shell');
  assert.equal(zellij.state.opened[0].command, undefined, 'No command opens an idle shell');
  assert.equal(zellij.state.created.length, 1);
  const second = await tools.call('pane_open', { command: 'node -e 1' }, context);
  assert.equal(zellij.state.created.length, 1, 'The session is reused');
  assert.match(second.name, /^node$/);
  assert.equal(zellij.state.opened.length, 2);

  await assert.rejects(tools.call('pane_type', { text: 'x' }, context), /pane is required because 2 panes are open: terminal_1, terminal_2/);
  await tools.call('pane_type', { pane: 'terminal_2', text: 'x' }, context);
  assert.deepEqual(zellij.state.actions.at(-1), ['write-chars', '--pane-id', 'terminal_2', '--', 'x']);
  await assert.rejects(tools.call('pane_type', { pane: 'terminal_9', text: 'x' }, context), /Pane terminal_9 not found/);
  await assert.rejects(tools.call('pane_type', { pane: 'plugin_1', text: 'x' }, context), /terminal pane id/);

  const listed = await tools.call('pane_list', {}, context);
  assert.deepEqual(listed.panes.map(item => [item.pane, item.name]), [['terminal_1', 'shell'], ['terminal_2', 'node']]);
});

test('closing a pane removes it; closing the last pane ends the session, and pane_open starts a new one', async () => {
  const { tools, zellij, store, owner } = toolsWithFake({ session: null });
  const context = { owner };
  await tools.call('pane_open', {}, context);
  await tools.call('pane_open', {}, context);
  assert.deepEqual(await tools.call('pane_close', { pane: 'terminal_1' }, context), { closed: 'terminal_1' });
  assert.deepEqual(zellij.state.actions.at(-1), ['close-pane', '--pane-id', 'terminal_1']);
  assert.deepEqual(store.ownership(store.sessionOf(owner)).panes, [2]);
  assert.equal(zellij.state.session !== null, true, 'The session is still running while a pane remains');

  const firstSession = store.sessionOf(owner);
  const last = await tools.call('pane_close', { pane: 'terminal_2' }, context);
  assert.deepEqual(last, { closed: 'terminal_2', session_ended: true, note: 'That was your last pane, so your session ended. The next pane_open starts a new one.' });
  assert.deepEqual(zellij.state.removed, [firstSession]);
  assert.equal(store.sessionOf(owner), undefined, 'No session is left');
  await assert.rejects(tools.call('pane_read', { pane: 'terminal_2' }, context), /was closed/);
  assert.deepEqual((await tools.call('pane_list', {}, context)).panes, []);

  const reopened = await tools.call('pane_open', {}, context);
  assert.equal(zellij.state.created.length, 2, 'A new Zellij session was created');
  assert.notEqual(store.sessionOf(owner), firstSession);
  await tools.call('pane_type', { pane: reopened.pane, text: 'x' }, context);
  // The same flow through session_kill.
  assert.deepEqual(await tools.call('session_kill', {}, context), { ended: true });
  await tools.call('pane_open', {}, context);
  assert.equal(zellij.state.created.length, 3);
});

test('panes are capped per MCP session', async () => {
  const { tools, owner } = toolsWithFake({ session: null });
  for (let index = 0; index < 12; index++) await tools.call('pane_open', {}, { owner });
  await assert.rejects(tools.call('pane_open', {}, { owner }), /At most 12 panes/);
});

test('a session ended outside the MCP session is reported once, then recreated', async () => {
  const { tools, zellij, store, owner } = toolsWithFake({ session: null });
  const context = { owner };
  await tools.call('pane_open', {}, context);
  zellij.state.session = null; // the user killed it from the terminal
  zellij.state.panes = [];

  await assert.rejects(tools.call('pane_read', {}, context), /No panes yet/);
  const listed = await tools.call('pane_list', {}, context);
  assert.match(listed.note, /no longer exist/);
  assert.equal((await tools.call('pane_list', {}, context)).note, undefined, 'The note is shown once');
  assert.equal(store.sessionOf(owner), undefined);

  const reopened = await tools.call('pane_open', {}, context);
  assert.equal(zellij.state.created.length, 2);
  assert.match(reopened.pane, /^terminal_\d+$/);
});

test('session_kill ends your session; session_adopt resumes an abandoned one', async () => {
  const { tools, zellij, store, owner } = toolsWithFake({ session: null });
  await tools.call('pane_open', {}, { owner });
  const name = store.sessionOf(owner);
  assert.deepEqual(await tools.call('session_kill', {}, { owner }), { ended: true });
  assert.deepEqual(zellij.state.removed, [name]);
  assert.equal(store.sessionOf(owner), undefined);

  // A new MCP session (for example after resuming a conversation) adopts what was abandoned.
  const second = toolsWithFake({ session: null });
  await second.tools.call('pane_open', {}, { owner: second.owner });
  const abandonedName = second.store.sessionOf(second.owner);
  const rescuer = second.store.create({ name: 'resumed' });
  await assert.rejects(second.tools.call('session_adopt', { session: abandonedName }, { owner: rescuer }), /not found or not adoptable/, 'Its owner is still active');
  second.store.terminate(second.owner);
  const adopted = await second.tools.call('session_adopt', { session: abandonedName }, { owner: rescuer });
  assert.equal(adopted.adopted, abandonedName);
  assert.equal(adopted.panes.length, 1);
  assert.equal(second.store.sessionOf(rescuer), abandonedName);
  assert.equal((await second.tools.call('session_adopt', { session: abandonedName }, { owner: rescuer })).note, 'Already yours.');

  // Adoption is refused while you still have panes of your own.
  const third = toolsWithFake({ session: null });
  await third.tools.call('pane_open', {}, { owner: third.owner });
  await assert.rejects(third.tools.call('session_adopt', { session: abandonedName }, { owner: third.owner }), /not found or not adoptable|already have panes/);
});

test('a pane closed by the user is reported as closed, not just missing', async () => {
  const { tools, zellij, owner } = toolsWithFake({ session: null });
  const context = { owner };
  await tools.call('pane_open', {}, context);
  const second = await tools.call('pane_open', {}, context);
  const closedId = Number(second.pane.replace('terminal_', ''));
  zellij.state.panes = zellij.state.panes.filter(item => item.id !== closedId); // user closed that tab

  await assert.rejects(tools.call('pane_type', { pane: second.pane, text: 'x' }, context), /terminal_2 was closed/);
  await assert.rejects(tools.call('pane_type', { pane: 'terminal_9', text: 'x' }, context), /terminal_9 not found/, 'A pane that never existed is just missing');
  assert.deepEqual((await tools.call('pane_list', {}, context)).panes.map(item => item.pane), ['terminal_1']);
  // The surviving pane is now the only one, so it needs no id.
  await tools.call('pane_type', { text: 'x' }, context);
});

test('panes the agent closed itself are remembered as closed too', async () => {
  const { tools, owner } = toolsWithFake({ session: null });
  const context = { owner };
  await tools.call('pane_open', {}, context);
  const second = await tools.call('pane_open', {}, context);
  await tools.call('pane_close', { pane: second.pane }, context);
  await assert.rejects(tools.call('pane_read', { pane: second.pane }, context), /was closed/);
});

test('when the user closes the last tab the session is gone, and the panes are reported as closed', async () => {
  const { tools, zellij, owner } = toolsWithFake({ session: null });
  const context = { owner };
  const opened = await tools.call('pane_open', {}, context);
  zellij.state.session = null;
  zellij.state.panes = [];
  await assert.rejects(tools.call('pane_type', { pane: opened.pane, text: 'x' }, context), /was closed/);
  await assert.rejects(tools.call('pane_type', { text: 'x' }, context), /No panes yet/);
  // A new session reuses small pane ids; they must not inherit the old "closed" mark.
  const again = await tools.call('pane_open', {}, context);
  await tools.call('pane_type', { pane: again.pane, text: 'x' }, context);
});

test('pane_wait returns "closed" when the pane disappears while waiting', async () => {
  const { tools, zellij, owner } = toolsWithFake();
  const waiting = tools.call('pane_wait', { pattern: 'never-appears', timeout_s: 20 }, { owner });
  setTimeout(() => { zellij.state.panes = []; zellij.state.text = ''; }, 150); // Zellij dumps a closed pane as empty text
  const result = await waiting;
  assert.equal(result.reason, 'closed');
  assert.match(result.message, /closed while waiting/);
  assert.ok(result.elapsed_ms < 5000, `noticed quickly (${result.elapsed_ms} ms)`);
  await assert.rejects(tools.call('pane_read', { pane: 'terminal_0' }, { owner }), /was closed/);
});

test('pane_wait returns "closed" when the whole session dies while waiting', async () => {
  const { tools, zellij, owner } = toolsWithFake();
  const waiting = tools.call('pane_wait', { pattern: 'never-appears', timeout_s: 20 }, { owner });
  setTimeout(() => {
    zellij.state.session = null; // Zellij answers a dump of a dead session with this text instead of failing
    zellij.state.text = "Session 'ag-1' not found. The following sessions are active:\nother";
  }, 150);
  const result = await waiting;
  assert.equal(result.reason, 'closed');
  assert.equal(result.match, undefined, 'The error text is never matched as output');
});

test('pane_open with a command types it into the shell once its prompt is up, and the pane stays a usable shell', async () => {
  const { tools, zellij, owner } = toolsWithFake({ session: null });
  const context = { owner };
  const opened = await tools.call('pane_open', { command: 'echo result:$((6*7))', name: 'calc' }, context);
  assert.equal(opened.offset, 1, 'The offset is the pane line count before the command was typed');
  const typed = zellij.state.actions.filter(args => args[0] === 'write-chars' || args[0] === 'send-keys');
  assert.deepEqual(typed, [
    ['write-chars', '--pane-id', 'terminal_1', '--', 'echo result:$((6*7))'],
    ['send-keys', '--pane-id', 'terminal_1', '--', 'Enter'],
  ]);
  // The command is already finished when we wait, and the typed echo is not matched.
  const waited = await tools.call('pane_wait', { pane: 'terminal_1', pattern: '^result:42', timeout_s: 1 }, context);
  assert.equal(waited.reason, 'pattern');
  // Back at a prompt: the same pane takes more input, and it never counts as exited.
  await tools.call('pane_type', { pane: 'terminal_1', text: 'echo again', submit: true }, context);
  assert.deepEqual((await tools.call('pane_list', {}, context)).panes.map(pane => pane.pane), ['terminal_1']);
});

test('pane_open waits for the shell prompt before typing, and validates the command', async () => {
  const { tools, zellij, owner } = toolsWithFake({ session: null });
  const context = { owner };
  // The new shell is silent for a while; the command must not be typed into the void.
  const real = zellij.dump;
  let silent = 3;
  zellij.dump = async (...args) => (zellij.state.opened.length && silent-- > 0 ? '' : real(...args));
  await tools.call('pane_open', { command: 'ls' }, context);
  assert.equal(silent <= 0, true, 'It polled until the shell printed something');
  zellij.dump = real;

  await tools.call('pane_open', { command: 'one\ntwo' }, context);
  assert.equal(zellij.state.actions.some(args => args[0] === 'paste' && args.at(-1) === 'one\ntwo'), true, 'Multi-line commands are pasted');
  await assert.rejects(tools.call('pane_open', { command: '   ' }, context), /must not be empty/);
  await assert.rejects(tools.call('pane_open', { command: 42 }, context), /command must be a string/);
});

test('a pane name defaults to the command\'s program', async () => {
  const { tools, owner } = toolsWithFake({ session: null });
  const context = { owner };
  assert.equal((await tools.call('pane_open', { command: 'npm run dev' }, context)).name, 'npm');
  assert.equal((await tools.call('pane_open', { command: './scripts/build.sh --fast' }, context)).name, 'build');
  assert.equal((await tools.call('pane_open', { command: "& 'C:\\tools\\runner.exe' -x" }, context)).name, 'runner');
  assert.equal((await tools.call('pane_open', {}, context)).name, 'shell');
  assert.equal((await tools.call('pane_open', { command: 'ls', name: 'custom' }, context)).name, 'custom');
});

test('pane names accept both path styles under POSIX and Windows host rules', async () => {
  const original = path.basename;
  try {
    for (const host of [path.posix, path.win32]) {
      path.basename = host.basename;
      const { tools, owner } = toolsWithFake({ session: null });
      for (const command of ["& 'C:\\tools\\runner.exe' -x", '/usr/local/bin/runner --fast']) {
        assert.equal((await tools.call('pane_open', { command }, { owner })).name, 'runner');
      }
    }
  } finally {
    path.basename = original;
  }
});
