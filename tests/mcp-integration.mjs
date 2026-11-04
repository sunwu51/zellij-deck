// End-to-end MCP test against a real bridge and native Zellij. Creates only its own
// agent sessions, uses a temporary state directory, and deletes everything it made.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { terminalEnv } from '../bridge/protocol.mjs';
import { resolveZellij } from '../bridge/platform.mjs';

const exec = promisify(execFile);
const executable = await resolveZellij();
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const token = `mcp-integration-token-${Date.now()}`;
const stateDir = await mkdtemp(path.join(tmpdir(), 'side-shell-mcp-'));
const bridge = spawn(process.execPath, ['bridge/server.mjs'], {
  env: { ...process.env, WEBSHELL_PORT: String(port), WEBSHELL_TOKEN: token, WEBSHELL_STATE_DIR: stateDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
bridge.stdout.on('data', data => { logs += data.toString(); });
bridge.stderr.on('data', data => { logs += data.toString(); });
const created = new Set();
const deadline = setTimeout(() => { console.error('MCP integration deadline exceeded.'); bridge.kill(); process.exit(1); }, 120000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = `http://127.0.0.1:${port}/mcp`;
const pass = message => console.log(`PASS: ${message}`);

let rpcId = 0;
async function post(body, sessionId, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}), ...extraHeaders,
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
}
async function initialize(name) {
  const response = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1' } } });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.match(sessionId, /^mcp_[a-f0-9]{32}$/);
  const body = await response.json();
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.ok(body.result.instructions.includes('Isolation'));
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)).status, 202);
  return sessionId;
}
async function call(sessionId, name, args = {}) {
  const response = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, sessionId);
  assert.equal(response.status, 200, `${name} HTTP status`);
  const body = await response.json();
  assert.ok(body.result, `${name}: ${JSON.stringify(body.error)}`);
  const text = body.result.content[0].text;
  if (body.result.isError) return { error: text };
  return JSON.parse(text);
}
async function ok(sessionId, name, args) {
  const result = await call(sessionId, name, args);
  assert.equal(result.error, undefined, `${name} failed: ${result.error}`);
  return result;
}
async function zellijSessions() {
  try { return (await exec(executable, ['list-sessions', '--no-formatting', '--short'], { env: terminalEnv(), timeout: 5000 })).stdout.split(/\r?\n/).filter(Boolean); }
  catch { return []; }
}

try {
  for (let i = 0; i < 100 && !logs.includes('Listening only'); i++) await pause(100);
  assert.ok(logs.includes('MCP endpoint'), logs);

  // Transport and session rules from the MCP specification.
  assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 400, 'Missing session id');
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `mcp_${'0'.repeat(32)}`)).status, 404, 'Unknown session id');
  const extensionInit = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, undefined, { Origin: `chrome-extension://${'b'.repeat(32)}` });
  assert.equal(extensionInit.status, 200);
  assert.equal(extensionInit.headers.get('access-control-expose-headers'), 'Mcp-Session-Id');
  pass('Bearer token, website-origin rejection, and Mcp-Session-Id rules (400 missing / 404 unknown)');

  const a = await initialize('agent-a');
  const b = await initialize('agent-b');
  const listed = await (await post({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }, a)).json();
  const toolNames = listed.result.tools.map(tool => tool.name);
  for (const name of ['pane_open', 'pane_list', 'pane_close', 'pane_type', 'pane_keys', 'pane_mouse', 'pane_read', 'pane_screen', 'pane_wait', 'session_kill', 'session_adopt', 'exec', 'job_output']) {
    assert.ok(toolNames.includes(name), `tool ${name} listed`);
  }
  assert.equal(toolNames.some(name => /^(session_create|session_list|pane_run|job_list)$/.test(name)), false, 'Removed tools are gone');
  assert.ok(listed.result.tools.every(tool => !JSON.stringify(tool.inputSchema).includes('"session"') || tool.name === 'session_adopt'), 'No tool takes a session argument');
  pass(`${toolNames.length} tools, and none but session_adopt takes a session argument`);

  const sessionsOf = async prefix => (await zellijSessions()).filter(name => name.startsWith(prefix));
  const tabsOf = async name => JSON.parse((await exec(executable, ['--session', name, 'action', 'list-tabs', '--json'], { env: terminalEnv(), timeout: 5000 })).stdout);

  // Nothing is created until the first pane_open.
  assert.deepEqual((await ok(a, 'pane_list')).panes, []);
  assert.deepEqual(await sessionsOf('ag-agent-a-'), []);
  const shellPane = await ok(a, 'pane_open', { name: 'work' });
  const zname = (await sessionsOf('ag-agent-a-'))[0];
  assert.match(zname, /^ag-agent-a-[a-f0-9]{6}$/, 'Session is named after the client');
  created.add(zname);
  assert.match(shellPane.pane, /^terminal_\d+$/);
  const firstTabs = await tabsOf(zname);
  assert.deepEqual(firstTabs.map(tab => tab.name), ['work'], 'The default shell tab was replaced by the requested pane');
  pass(`pane_open created ${zname} lazily with one tab (${shellPane.pane})`);

  // Isolation: B can neither see nor touch A's panes, and has no session of its own yet.
  assert.deepEqual((await ok(b, 'pane_list')).panes, []);
  assert.match((await call(b, 'pane_type', { pane: shellPane.pane, text: 'echo hijack', submit: true })).error, /not found/);
  assert.match((await call(b, 'pane_close', { pane: shellPane.pane })).error, /not found/);
  assert.match((await call(b, 'pane_read', {})).error, /No panes yet/);
  assert.match((await call(b, 'session_adopt', { session: zname })).error, /not adoptable/, 'Live owners cannot be adopted');
  assert.equal((await ok(a, 'pane_list')).panes.length, 1);
  pass('Another MCP session cannot list, type into, close, or adopt the panes');

  // Interactive flow, the way a model uses it: type, then wait. No since_offset: the wait
  // starts at the end of the pane when we typed, so output that already appeared still matches.
  await pause(1500); // let the shell print its prompt
  await ok(a, 'pane_type', { text: 'echo side-shell-$((6*7))-done', submit: false });
  await ok(a, 'pane_keys', { keys: ['Home', 'End'] });
  const sent = await ok(a, 'pane_type', { text: '', submit: true });
  // 42 exists only in the command's output; the typed text contains $((6*7)).
  const waited = await ok(a, 'pane_wait', { pattern: 'side-shell-42-done', timeout_s: 20 });
  assert.equal(waited.reason, 'pattern', JSON.stringify(waited));
  // The offset returned by the input call scopes pane_read to what that input produced.
  const produced = await ok(a, 'pane_read', { offset: sent.offset, limit: 5 });
  assert.equal(produced.text.split('\n')[0], 'side-shell-42-done', JSON.stringify(produced));
  const read = await ok(a, 'pane_read', { pattern: 'side-shell-42-done', literal: true });
  assert.ok(read.matches.length >= 1);
  const screen = await ok(a, 'pane_screen', {});
  assert.equal(screen.cols, 160);
  assert.ok(screen.text.includes('side-shell-42-done'));
  pass('pane_type + pane_keys + pane_wait(pattern, no offset) + pane_read + pane_screen round trip (pane omitted: only one open)');

  const leading = await ok(a, 'pane_type', { text: '-literal-dash-text' });
  assert.equal(leading.typed_chars, 18, 'Text starting with "-" is typed, not parsed as a flag');
  await ok(a, 'pane_keys', { keys: ['Ctrl c'] });
  assert.match((await call(a, 'pane_keys', { keys: ['Hyper x'] })).error, /Unknown modifier/);

  // Every further pane gets its own tab, opened without stealing focus. A command runs inside
  // the pane's shell, so when it finishes the pane is back at an idle prompt and still usable.
  const activeBefore = firstTabs.find(tab => tab.active)?.tab_id;
  const ran = await ok(a, 'pane_open', { command: 'echo run-out', name: 'echoer' });
  assert.equal(typeof ran.offset, 'number');
  const tabsAfter = await tabsOf(zname);
  assert.deepEqual(tabsAfter.map(tab => tab.name).sort(), ['echoer', 'work']);
  if (activeBefore !== undefined) assert.equal(tabsAfter.find(tab => tab.active)?.tab_id, activeBefore, 'The active tab did not change');
  assert.match((await call(a, 'pane_type', { text: 'x' })).error, /pane is required because 2 panes are open/);
  const finished = await ok(a, 'pane_wait', { pane: ran.pane, pattern: '^run-out$', timeout_s: 20 });
  assert.equal(finished.reason, 'pattern', JSON.stringify(finished));
  // The command is done, yet the pane accepts input: it is a shell, not a frozen program view.
  await ok(a, 'pane_type', { pane: ran.pane, text: 'echo second-ok', submit: true });
  const again = await ok(a, 'pane_wait', { pane: ran.pane, pattern: '^second-ok$', timeout_s: 20 });
  assert.equal(again.reason, 'pattern', JSON.stringify(again));
  const panes = (await ok(a, 'pane_list')).panes;
  assert.deepEqual(panes.map(item => [item.pane, item.name]).sort(), [[shellPane.pane, 'work'], [ran.pane, 'echoer']].sort());
  pass('pane_open puts each pane in its own tab without moving focus; after its command finishes the pane is an idle shell that accepts input');

  // Output far longer than the screen: the first lines are scrolled out of view but stay
  // readable (Zellij keeps scrollback; pane_read dumps it), by offset or from the end.
  const tall = await ok(a, 'pane_open', { command: 'node -e "for (let i = 0; i < 300; i++) console.log(\'row-\' + i); console.log(\'END-OF-ROWS\')"', name: 'tall' });
  await ok(a, 'pane_wait', { pane: tall.pane, pattern: '^END-OF-ROWS$', timeout_s: 30 });
  const visible = await ok(a, 'pane_screen', { pane: tall.pane });
  assert.equal(visible.text.includes('row-0\n'), false, 'row-0 has scrolled off the visible screen');
  // Zellij's dump of an argv pane starts with a blank line, so locate row-0 rather than assume line 0.
  const first = await ok(a, 'pane_read', { pane: tall.pane, pattern: '^row-0$', limit: 1 });
  assert.equal(first.matches.length, 1, 'row-0 is still in the scrollback');
  const start = first.matches[0].line;
  const head = await ok(a, 'pane_read', { pane: tall.pane, offset: start, limit: 3 });
  assert.equal(head.text, 'row-0\nrow-1\nrow-2');
  assert.ok(head.total_lines >= 301, 'total_lines counts scrollback: ' + head.total_lines);
  assert.equal(head.next_offset, start + 3);
  const latest = await ok(a, 'pane_read', { pane: tall.pane, tail: 3 });
  assert.match(latest.text, /row-299\nEND-OF-ROWS(\n|$)/);
  pass('pane_read reaches scrolled-off lines by offset and the newest lines by tail (total_lines ' + head.total_lines + ')');

  // A TUI that enabled mouse tracking receives clicks and wheel events from pane_mouse.
  const tuiSource = "process.stdout.write('\\x1b[?1000h\\x1b[?1006h'); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', d => console.log('GOT ' + JSON.stringify(d.toString('latin1')))); console.log('MOUSE-READY'); setTimeout(() => process.exit(0), 25000)";
  await writeFile(path.join(stateDir, 'tui.cjs'), tuiSource);
  const tui = await ok(a, 'pane_open', { command: 'node tui.cjs', cwd: stateDir, name: 'mouse-tui' });
  await ok(a, 'pane_wait', { pane: tui.pane, pattern: 'MOUSE-READY', since_offset: 0, timeout_s: 20 });
  await ok(a, 'pane_mouse', { pane: tui.pane, action: 'click', col: 4, row: 2 });
  await ok(a, 'pane_mouse', { pane: tui.pane, action: 'scroll_up', col: 4, row: 2, count: 2 });
  const gotClick = await ok(a, 'pane_wait', { pane: tui.pane, pattern: 'GOT .*<64;5;3M', timeout_s: 20 });
  assert.equal(gotClick.reason, 'pattern', JSON.stringify(gotClick));
  const seen = (await ok(a, 'pane_read', { pane: tui.pane, tail: 20 })).text;
  assert.ok(seen.includes('<0;5;3M') && seen.includes('<0;5;3m'), seen);
  assert.equal(seen.split('<64;5;3M').length - 1, 2, 'two wheel notches');
  assert.match((await call(a, 'pane_mouse', { pane: tui.pane, action: 'click', col: 9999, row: 0 })).error, /outside the pane/);
  pass('pane_mouse delivers a click (1-based SGR) and two wheel notches to a mouse-enabled TUI');

  // Closing a pane removes its tab.
  const tabsBeforeClose = (await tabsOf(zname)).length;
  assert.deepEqual(await ok(a, 'pane_close', { pane: tui.pane }), { closed: tui.pane });
  assert.deepEqual(await ok(a, 'pane_close', { pane: tall.pane }), { closed: tall.pane });
  assert.deepEqual(await ok(a, 'pane_close', { pane: ran.pane }), { closed: ran.pane });
  await pause(300);
  assert.equal((await tabsOf(zname)).length, tabsBeforeClose - 3, 'Each closed pane took its tab with it');
  assert.equal((await ok(a, 'pane_list')).panes.length, 1);
  pass('pane_close removes the pane and its tab');

  // Someone closes an agent pane from outside (here: the Zellij CLI, as a user would from the UI).
  const victim = await ok(a, 'pane_open', { command: 'node -e "setTimeout(() => {}, 60000)"', name: 'victim' });
  const waitingOnVictim = ok(a, 'pane_wait', { pane: victim.pane, pattern: 'never-appears', timeout_s: 30 });
  await pause(1200);
  const closedAt = Date.now();
  await exec(executable, ['--session', zname, 'action', 'close-pane', '--pane-id', victim.pane], { env: terminalEnv(), timeout: 5000 });
  const interrupted = await waitingOnVictim;
  assert.equal(interrupted.reason, 'closed', JSON.stringify(interrupted));
  assert.ok(Date.now() - closedAt < 8000, 'The wait noticed the closure promptly instead of running to its timeout');
  assert.match((await call(a, 'pane_type', { pane: victim.pane, text: 'x' })).error, new RegExp(`${victim.pane} was closed`));
  assert.match((await call(a, 'pane_read', { pane: 'terminal_9999' })).error, /not found/, 'A pane that never existed is just missing');
  assert.deepEqual((await ok(a, 'pane_list')).panes.map(item => item.pane), [shellPane.pane]);
  pass('A pane closed from outside ends pane_wait with "closed" and is reported as closed afterwards');

  // exec: separate streams, exit codes, background continuation, paging, kill.
  const direct = await ok(a, 'exec', { argv: [process.execPath, '-e', "console.log('to-stdout'); console.error('to-stderr'); process.exit(5)"] });
  assert.equal(direct.status, 'exited');
  assert.equal(direct.exit_code, 5);
  assert.equal(direct.stdout.text, 'to-stdout');
  assert.equal(direct.stderr.text, 'to-stderr');
  const shell = await ok(a, 'exec', { command: 'echo shell-ok' });
  assert.equal(shell.exit_code, 0, JSON.stringify(shell));
  assert.ok(shell.stdout.text.includes('shell-ok'));
  const many = await ok(a, 'exec', { argv: [process.execPath, '-e', 'for (let i = 0; i < 500; i++) console.log(`line ${i}`)'] });
  assert.equal(many.stdout.total_lines, 500);
  const page = await ok(a, 'job_output', { job_id: many.job_id, offset: 10, limit: 3 });
  assert.equal(page.text, 'line 10\nline 11\nline 12');
  assert.equal(page.next_offset, 13);
  const slow = await ok(a, 'exec', { argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeout_s: 1 });
  assert.equal(slow.status, 'running');
  assert.match((await call(b, 'job_output', { job_id: slow.job_id })).error, /not found/, 'Jobs are private too');
  assert.ok((await ok(a, 'pane_list')).jobs.some(job => job.job_id === slow.job_id), 'pane_list also lists your jobs');
  const killed = await ok(a, 'job_kill', { job_id: slow.job_id });
  assert.equal(killed.status, 'killed');
  pass('exec separates stdout/stderr, reports exit codes, pages output, backgrounds and kills jobs');

  // session_kill ends your session; the next pane_open starts a fresh one.
  await ok(b, 'pane_open', {});
  const bName = (await sessionsOf('ag-agent-b-'))[0];
  created.add(bName);
  assert.ok(bName, 'agent-b has its own session');
  assert.deepEqual(await ok(b, 'session_kill'), { ended: true });
  await pause(500);
  assert.deepEqual(await sessionsOf('ag-agent-b-'), []);
  await ok(b, 'pane_open', {});
  const bSecond = (await sessionsOf('ag-agent-b-'))[0];
  created.add(bSecond);
  assert.ok(bSecond && bSecond !== bName, 'A fresh session was created');
  pass('session_kill ends the session and pane_open starts a new one');

  // Closing the last pane ends the session too, and the next pane_open creates another.
  const lastPane = (await ok(b, 'pane_list')).panes[0].pane;
  const lastClose = await ok(b, 'pane_close', { pane: lastPane });
  assert.equal(lastClose.session_ended, true, JSON.stringify(lastClose));
  await pause(500);
  assert.deepEqual(await sessionsOf('ag-agent-b-'), [], 'Closing the last pane ended the Zellij session');
  assert.deepEqual((await ok(b, 'pane_list')).panes, []);
  assert.match((await call(b, 'pane_read', { pane: lastPane })).error, /was closed/);
  await ok(b, 'pane_open', {});
  const bThird = (await sessionsOf('ag-agent-b-'))[0];
  created.add(bThird);
  assert.ok(bThird && bThird !== bSecond, 'pane_open created a new session after the last pane was closed');
  pass('closing the last pane ends the session; pane_open then starts a new one');

  // DELETE ends the MCP session and releases its terminals.
  const deleted = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': a } });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).released_sessions, [zname]);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, a)).status, 404, 'Terminated session id is rejected');
  await pause(500);
  assert.equal((await zellijSessions()).includes(zname), false, 'DELETE removed the Zellij session');
  created.delete(zname);
  pass('DELETE terminates the MCP session and removes its Zellij session');
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': b } });
  await pause(500);
  assert.deepEqual(await sessionsOf('ag-agent-'), [], 'No agent sessions are left');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  clearTimeout(deadline);
  for (const name of created) {
    try { await exec(executable, ['delete-session', '--force', name], { env: terminalEnv(), timeout: 5000 }); } catch {}
  }
  bridge.kill();
  await pause(300);
  await rm(stateDir, { recursive: true, force: true });
}
