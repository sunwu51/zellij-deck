import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { terminalEnv } from '../bridge/protocol.mjs';
import { resolveZellij } from '../bridge/platform.mjs';
const executable = await resolveZellij();

const exec = promisify(execFile);
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const token = 'integration-test-token-' + Date.now();
const origin = `chrome-extension://${'a'.repeat(32)}`;
// macOS TMPDIR is long and Unix domain sockets have a 103-byte path limit.
const session = `ss-${process.pid.toString(36)}-${Date.now().toString(36).slice(-5)}`;
const secondSession = `${session}-b`;
// Never share the real .bridge state (MCP session ownership) with a test bridge.
const stateDir = await mkdtemp(path.join(tmpdir(), 'side-shell-it-'));
const configPath = path.join(stateDir, 'integration.kdl');
await writeFile(configPath, 'session_serialization true\nserialization_interval 1\ndisable_session_metadata false\n');
const testEnv = { ...process.env, ZELLIJ_CONFIG_FILE: configPath };
const bridge = spawn(process.execPath, ['bridge/server.mjs'], {
  env: { ...testEnv, ZELLIJ_DECK_PORT: String(port), ZELLIJ_DECK_TOKEN: token, ZELLIJ_DECK_STATE_DIR: stateDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
bridge.stdout.on('data', data => { logs += data.toString(); });
bridge.stderr.on('data', data => { logs += data.toString(); });
const sockets = [];
const terminalOutputs = new Map();
const deadline = setTimeout(() => { console.error('Integration test deadline exceeded.'); bridge.kill(); process.exitCode = 1; }, 45000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
function request(route, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${route}`, { headers: { Origin: origin, ...headers }, signal: AbortSignal.timeout(6000) });
}
async function listSessions() {
  const response = await request('/sessions', { Authorization: `Bearer ${token}` });
  assert.equal(response.status, 200);
  return (await response.json()).sessions;
}
async function connect(mode, sessionName = session) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, ['side-shell-v1', `pair.${token}`], { origin });
  sockets.push(ws);
  let output = '';
  let failure = '';
  let ready = false;
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'ready') ready = true;
    if (message.type === 'error') failure = message.message;
    if (message.type === 'output') {
      output += message.data;
      terminalOutputs.set(sessionName, output.slice(-16000));
      // Simulate xterm's terminal capability responses for the headless smoke test.
      let response = '';
      if (message.data.includes('\x1b[6n')) response += '\x1b[1;1R';
      if (message.data.includes('\x1b[c')) response += '\x1b[?1;2c';
      if (message.data.includes('\x1b[>c')) response += '\x1b[>0;0;0c';
      if (response && mode !== 'watch') ws.send(JSON.stringify({ type: 'input', data: response }));
    }
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'open', session: sessionName, mode, cols: 90, rows: 30 }));
  await waitFor(() => { if (failure) throw new Error(failure); return ready; }, 'PTY ready');
  return { ws, output: () => output, failure: () => failure };
}
try {
  await waitFor(() => logs.includes('Listening on http://'), 'bridge startup');
  assert.equal((await request('/health')).status, 401);
  assert.equal((await request('/health', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request('/health', { Origin: 'https://example.com', Authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await request('/health', { Authorization: `Bearer ${token}` })).status, 200);
  // Chrome extension fetch can omit Origin, unlike browser WebSocket upgrades.
  const originless = headers => fetch(`http://127.0.0.1:${port}/sessions`, { headers, signal: AbortSignal.timeout(6000) });
  const identity = { 'X-Side-Shell-Extension': 'a'.repeat(32) };
  assert.equal((await originless({ ...identity, Authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await originless(identity)).status, 401);
  assert.equal((await originless({ ...identity, Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await originless({ Authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await request('/sessions', { ...identity, Origin: 'https://example.com', Authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await request('/sessions', { ...identity, Origin: 'null', Authorization: `Bearer ${token}` })).status, 403);
  console.log('PASS: Origin-less extension discovery works; tokens and website-origin restrictions remain enforced');
  const rejected = new WebSocket(`ws://127.0.0.1:${port}/terminal`, ['side-shell-v1', 'pair.wrong'], { origin });
  await new Promise((resolve, reject) => { rejected.on('error', resolve); rejected.on('open', () => { rejected.close(); reject(new Error('Invalid WebSocket token was accepted.')); }); });
  console.log('PASS: WebSocket rejects an invalid token');
  const interactive = await connect('create');
  await waitFor(async () => (await listSessions()).some(s => s.name === session && !s.exited), 'new Zellij session appears', 18000);
  await waitFor(() => interactive.output().length > 50, 'PTY produces terminal output');
  interactive.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 35 }));
  console.log(`PASS: Native ${process.platform}/${process.arch} PTY creates Zellij and streams output`);
  interactive.ws.close();
  await once(interactive.ws, 'close');
  await pause(500);
  assert.ok((await listSessions()).some(s => s.name === session && !s.exited), 'Session must survive detaching');
  console.log('PASS: Closing the client preserves the Zellij session');
  const second = await connect('create', secondSession);
  await waitFor(async () => (await listSessions()).some(s => s.name === secondSession && !s.exited), 'second Zellij session appears', 18000);
  await waitFor(() => second.output().length > 50, 'second PTY produces output');
  // Wait for a real layout and one serialization tick before detaching; initial PTY
  // output can be just ConPTY's preamble, before Zellij has saved resurrection data.
  await waitFor(async () => {
    try {
      const result = await exec(executable, ['--session', secondSession, 'action', 'list-panes', '--json', '--all'], { env: terminalEnv(testEnv), timeout: 5000 });
      return JSON.parse(result.stdout).length > 0;
    } catch { return false; }
  }, 'second session layout ready');
  await pause(2500);
  second.ws.close();
  await once(second.ws, 'close');
  await pause(500);
  const sessions = await listSessions();
  assert.ok(sessions.some(s => s.name === session && !s.exited));
  assert.ok(sessions.some(s => s.name === secondSession && !s.exited));
  console.log('PASS: Two separately created sessions remain discoverable and running after detach');
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await request(`/sessions/${session}/snapshot`)).status, 401);
  assert.equal((await request('/sessions/--help/snapshot', auth)).status, 400);
  const snapshotResponse = await request(`/sessions/${session}/snapshot`, auth);
  if (snapshotResponse.status === 501) console.log('SKIP: This Zellij version cannot report tabs/panes for session previews');
  else {
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.session, session);
    // A session with no attached client reports no active tab; previews fall back to the first.
    assert.ok(snapshot.tabs.length >= 1);
    assert.ok(snapshot.panes.some(pane => !pane.plugin && typeof pane.content === 'string'), 'A terminal pane must be dumped');
    assert.equal((await request(`/sessions/${session}-missing/snapshot`, auth)).status, 404);
    assert.ok((await listSessions()).some(s => s.name === session && !s.exited), 'Snapshots must not disturb the session');
    console.log(`PASS: Session preview captured ${snapshot.tabs.length} tab(s) and ${snapshot.panes.length} pane(s) without attaching`);
  }
  const watcher = await connect('watch');
  await waitFor(() => watcher.output().length > 50, 'watcher produces terminal output', 18000);
  watcher.ws.send(JSON.stringify({ type: 'input', data: 'echo SHOULD_NOT_RUN\r' }));
  await pause(300);
  assert.equal(watcher.ws.readyState, WebSocket.OPEN);
  assert.equal(watcher.failure(), '');
  assert.equal(watcher.output().includes('SHOULD_NOT_RUN'), false, 'Read-only input must not reach the terminal');
  console.log('PASS: Read-only watcher reconnects, receives output, and drops input');
  const remove = (name, headers = auth) => fetch(`http://127.0.0.1:${port}/sessions/${name}`, {
    method: 'DELETE', headers: { Origin: origin, ...headers }, signal: AbortSignal.timeout(10000),
  });
  assert.equal((await remove(session, {})).status, 401);
  assert.equal((await remove(session, { ...auth, Origin: 'https://example.com' })).status, 403);
  assert.equal((await remove('--help')).status, 400);
  assert.equal((await remove(`${session}-missing`)).status, 404);
  const preflight = await fetch(`http://127.0.0.1:${port}/sessions/${session}`, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
  const closed = once(watcher.ws, 'close');
  const deleted = await remove(session);
  assert.equal(deleted.status, 200, await deleted.text());
  await closed;
  assert.equal((await listSessions()).some(s => s.name === session), false, 'Deleted session must not remain as exited/resurrectable');
  assert.ok((await listSessions()).some(s => s.name === secondSession && !s.exited), 'Other sessions must keep running');
  await exec(executable, ['kill-session', secondSession], { env: terminalEnv(testEnv), timeout: 5000 });
  await waitFor(async () => !(await listSessions()).some(s => s.name === secondSession && !s.exited), 'second session stops');
  if ((await listSessions()).some(s => s.name === secondSession && s.exited)) {
    assert.equal((await remove(secondSession)).status, 200);
    assert.equal((await listSessions()).some(s => s.name === secondSession), false);
    console.log('PASS: Exited session resurrection data is deleted');
  } else {
    console.log('SKIP: Native exited-session deletion: this Zellij build did not persist the disposable session; running/exited command handling is covered by unit tests');
  }
  console.log('PASS: Authenticated deletion kills running viewers, removes the session, and preserves other sessions');
} catch (error) {
  for (const [name, output] of terminalOutputs) console.error(`Terminal output (${name}): ${JSON.stringify(output)}`);
  try {
    const listing = await exec(executable, ['list-sessions', '--no-formatting'], { env: terminalEnv(testEnv), timeout: 5000 });
    console.error('Raw Zellij listing:', JSON.stringify(listing.stdout), JSON.stringify(listing.stderr));
  } catch (listingError) {
    console.error('Raw Zellij listing error:', JSON.stringify(listingError.stdout), JSON.stringify(listingError.stderr));
  }
  throw error;
} finally {
  clearTimeout(deadline);
  for (const ws of sockets) ws.terminate();
  for (const name of [session, secondSession]) {
    try { await exec(executable, ['delete-session', '--force', name], { env: terminalEnv(testEnv), timeout: 5000 }); } catch {}
  }
  bridge.kill();
  await new Promise(resolve => setTimeout(resolve, 300));
  await rm(stateDir, { recursive: true, force: true });
}
