import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveZellij, bridgePaths, projectRoot } from './platform.mjs';
import { McpSessionStore, DEFAULT_TTL_MS } from './mcp/store.mjs';
import { ZellijClient } from './mcp/zellij.mjs';
import { createTools } from './mcp/tools.mjs';
import { createMcpHandler } from './mcp/handler.mjs';
import { sessionRoute, deleteSession } from './sessions.mjs';
import { preparePty } from '../scripts/prepare-pty.mjs';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import {
  MAX_MESSAGE_BYTES, MAX_BUFFER_BYTES, validToken, isExtensionOrigin,
  parseClientMessage, parseSessions, noSessions, launchArgs, terminalEnv,
  bareConfig, BARE_LAYOUT, shellCandidates, shellArgs,
  snapshotRoute, snapshotArgs, snapshotLayout, sanitizeDump, snapshotFailure,
} from './protocol.mjs';

await preparePty();
const exec = promisify(execFile);
const host = '127.0.0.1';
const port = Number(process.env.WEBSHELL_PORT || 17329);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WEBSHELL_PORT must be between 1024 and 65535.');
// An absolute path works with both Windows ConPTY and macOS Unix PTYs.
const executable = await resolveZellij();
const { stateDir, cwd } = bridgePaths();
if (!(await stat(cwd)).isDirectory()) throw new Error(`Terminal working directory is not a directory: ${cwd}`);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
// Lag-diagnosis modes: an empty Zellij config (no plugins/keybindings) and a bare layout.
const bareDir = path.join(stateDir, 'bare');
const bareConfigPath = path.join(bareDir, 'config.kdl');
await mkdir(path.join(bareDir, 'layouts'), { recursive: true, mode: 0o700 });
await writeFile(path.join(bareDir, 'layouts', 'bare.kdl'), BARE_LAYOUT);
await writeFile(bareConfigPath, bareConfig(path.join(bareDir, 'layouts')));
let shellFile;
for (const candidate of shellCandidates()) {
  try { if ((await stat(candidate)).isFile()) { shellFile = candidate; break; } } catch {}
}
const tokenPath = path.join(stateDir, 'token');
let token = process.env.WEBSHELL_TOKEN;
if (!token) {
  try { token = (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = randomBytes(32).toString('hex');
    try {
      const file = await open(tokenPath, 'wx', 0o600);
      try { await file.writeFile(generated); } finally { await file.close(); }
      token = generated;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      token = (await readFile(tokenPath, 'utf8')).trim();
    }
  }
}
if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token || '')) throw new Error('Pairing token must contain 32–256 letters, numbers, underscores, or hyphens.');
const env = terminalEnv();
const version = await exec(executable, ['--version'], { env, timeout: 5000, windowsHide: true });
// Optional pin: one or more comma-separated extension IDs (e.g. wshell and TabManager).
const allowedExtensions = (process.env.WEBSHELL_EXTENSION_ID || '').split(',').map(id => id.trim()).filter(Boolean);
if (allowedExtensions.some(id => !/^[a-p]{32}$/.test(id))) throw new Error('Invalid WEBSHELL_EXTENSION_ID.');
function originAllowed(origin) {
  return isExtensionOrigin(origin) && (!allowedExtensions.length || allowedExtensions.includes(origin.slice('chrome-extension://'.length)));
}
function validHost(req) { return req.headers.host === `${host}:${port}`; }
function httpOrigin(req) {
  // Privileged extension fetches can omit Origin. Require an explicit extension
  // identity in that case; never use it to override a supplied, hostile Origin.
  if (req.headers.origin !== undefined) return req.headers.origin;
  const extensionId = req.headers['x-wshell-extension'] || req.headers['x-side-shell-extension'];
  return typeof extensionId === 'string' ? `chrome-extension://${extensionId}` : undefined;
}
function authorize(req) {
  return validHost(req) && originAllowed(httpOrigin(req)) && validToken(req.headers.authorization?.replace(/^Bearer /, ''), token);
}
// Bound concurrent Zellij query processes so a dashboard refresh cannot fork-bomb the machine.
const queryQueue = [];
let queryActive = 0;
async function zellijQuery(args, maxBuffer = 1024 * 1024) {
  if (queryActive >= 6) await new Promise(resolve => queryQueue.push(resolve));
  queryActive++;
  try { return await exec(executable, args, { env, timeout: 5000, windowsHide: true, maxBuffer }); }
  finally { queryActive--; queryQueue.shift()?.(); }
}
async function queryJson(session, action) {
  const result = await zellijQuery(snapshotArgs(session, action), 4 * 1024 * 1024);
  // An unknown session exits 0 but prints a session listing instead of JSON.
  try { return JSON.parse(result.stdout); }
  catch { throw Object.assign(new Error('Unexpected Zellij output.'), { stdout: result.stdout, stderr: result.stderr }); }
}
async function captureSnapshot(session) {
  const [tabs, panes] = await Promise.all([
    queryJson(session, ['list-tabs', '--json', '--all']),
    queryJson(session, ['list-panes', '--json', '--all']),
  ]);
  const layout = snapshotLayout(tabs, panes);
  await Promise.all(layout.panes.filter(pane => !pane.plugin).map(async pane => {
    try {
      const result = await zellijQuery(snapshotArgs(session, ['dump-screen', '--pane-id', pane.id, '--ansi']), 2 * 1024 * 1024);
      Object.assign(pane, sanitizeDump(result.stdout));
    } catch {
      // A pane can close between listing and dumping; show it empty rather than failing the session.
      pane.content = '';
    }
  }));
  return { session, capturedAt: Date.now(), ...layout };
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---- MCP (Streamable HTTP) -----------------------------------------------------
const ttlHours = Number(process.env.WEBSHELL_MCP_TTL_HOURS || DEFAULT_TTL_MS / 3_600_000);
if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 720) throw new Error('WEBSHELL_MCP_TTL_HOURS must be between 1 and 720.');
const packageVersion = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
const mcpStore = new McpSessionStore({ file: path.join(stateDir, 'mcp-sessions.json'), token, ttlMs: ttlHours * 3_600_000 });
await mcpStore.load();
const zellijClient = new ZellijClient({
  query: zellijQuery, cwd,
  spawnPty: (args, options) => pty.spawn(executable, args, { name: 'xterm-256color', cols: options.cols || 160, rows: options.rows || 45, cwd: options.cwd || cwd, env }),
});
const mcp = createMcpHandler({
  store: mcpStore,
  tools: createTools({ store: mcpStore, zellij: zellijClient }),
  serverInfo: { name: 'wshell', title: 'wshell terminals', version: packageVersion },
});
function handleMcp(req, res) {
  if (!validHost(req)) return json(res, 403, { error: 'Invalid Host header.' });
  // Native MCP clients send no Origin. Browsers always send one on cross-origin requests,
  // so a present Origin must be an allowed extension: websites can never reach the shell.
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin)) return json(res, 403, { error: 'Origin not allowed.' });
  if (origin !== undefined) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (!validToken(req.headers.authorization?.replace(/^Bearer /, ''), token)) return json(res, 401, { error: 'Invalid or missing bearer token.' });
  return mcp.handle(req, res);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/mcp') return handleMcp(req, res);
  const origin = httpOrigin(req);
  if (!validHost(req) || !originAllowed(origin)) return json(res, 403, { error: 'Extension origin required. Reload the updated extension and restart the bridge.' });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin, X-WShell-Extension, X-Side-Shell-Extension');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, X-WShell-Extension, X-Side-Shell-Extension' });
    return res.end();
  }
  if (!authorize(req)) return json(res, 401, { error: 'Invalid pairing token.' });
  if (req.method === 'DELETE') {
    const name = sessionRoute(req.url);
    if (name === false) return json(res, 400, { error: 'Invalid session name.' });
    if (!name) return json(res, 404, { error: 'Not found.' });
    try {
      if (!(await deleteSession(name, zellijQuery))) return json(res, 404, { error: 'Session not found. Refresh the dashboard.' });
      return json(res, 200, { deleted: name });
    } catch (error) {
      console.error(`Deleting session ${name} failed:`, error.stderr || error.stdout || error.message);
      return json(res, 500, { error: 'Could not kill and delete the session. Check the bridge terminal and retry.' });
    }
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  // `features` lets the extension detect a bridge started before a capability existed.
  if (req.url === '/health') return json(res, 200, { version: version.stdout.trim(), features: ['snapshots', 'mcp', 'session-delete'] });
  if (req.url === '/sessions') {
    try {
      const result = await exec(executable, ['list-sessions', '--no-formatting'], { env, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
      return json(res, 200, { sessions: parseSessions(result.stdout) });
    } catch (error) {
      if (noSessions(error)) return json(res, 200, { sessions: [] });
      console.error('Zellij session listing failed:', error.stderr || error.stdout || error.message);
      return json(res, 500, { error: 'Could not list Zellij sessions. Check the bridge terminal.' });
    }
  }
  const snapshotSession = snapshotRoute(req.url);
  if (snapshotSession === false) return json(res, 400, { error: 'Invalid session name.' });
  if (snapshotSession) {
    try { return json(res, 200, await captureSnapshot(snapshotSession)); }
    catch (error) {
      const failure = snapshotFailure(error);
      if (failure.status === 500) console.error(`Snapshot of ${snapshotSession} failed:`, error.stderr || error.stdout || error.message);
      return json(res, failure.status, { error: failure.error });
    }
  }
  json(res, 404, { error: 'Not found.' });
});
server.headersTimeout = 10000;
server.requestTimeout = 10000;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  if (!validHost(req) || !originAllowed(req.headers.origin) || req.url !== '/terminal' || wss.clients.size >= 8) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  // WebSocket browser APIs cannot set Authorization headers. Use a subprotocol,
  // never a query parameter, to keep the token out of URL/access logs.
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim());
  const credential = protocols.find(v => v.startsWith('pair.'))?.slice(5);
  if (!validToken(credential, token)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});

wss.on('connection', ws => {
  let terminal;
  let mode;
  let alive = true;
  let disposed = false;
  const subscriptions = [];
  const send = message => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFER_BYTES) return ws.close(1013, 'Terminal output exceeded buffer; reconnect.');
    ws.send(JSON.stringify(message));
  };
  const openTimeout = setTimeout(() => ws.close(1008, 'Open a session within ten seconds.'), 10000);
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30000);
  ws.on('pong', () => { alive = true; });
  function cleanup() {
    if (disposed) return;
    disposed = true;
    clearTimeout(openTimeout);
    clearInterval(heartbeat);
    for (const subscription of subscriptions) subscription.dispose();
    // This kills only this PTY's Zellij client, not the session server.
    try { terminal?.kill(); } catch {}
  }
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  ws.on('message', (raw, binary) => {
    try {
      if (binary) throw new Error('Binary messages are not supported.');
      const message = parseClientMessage(raw.toString());
      if (message.type === 'open') {
        if (terminal) throw new Error('A session is already open.');
        clearTimeout(openTimeout);
        mode = message.mode;
        // 'shell' runs a plain shell with no Zellij at all, to compare against Zellij sessions.
        if (mode === 'shell' && !shellFile) throw new Error('No PowerShell or shell found on PATH.');
        const [file, args] = mode === 'shell' ? [shellFile, shellArgs(shellFile)] : [executable, launchArgs(message, { bareConfigPath })];
        terminal = pty.spawn(file, args, {
          name: 'xterm-256color', cols: message.cols, rows: message.rows,
          cwd, env,
        });
        subscriptions.push(terminal.onData(data => send({ type: 'output', data })));
        subscriptions.push(terminal.onExit(event => {
          send({ type: 'exit', exitCode: event.exitCode });
          ws.close(1000, 'Terminal process exited.');
        }));
        send({ type: 'ready', mode, session: message.session });
      } else if (!terminal) {
        throw new Error('Open a session first.');
      } else if (message.type === 'resize') {
        terminal.resize(message.cols, message.rows);
      } else if (message.type === 'input' && mode !== 'watch') {
        terminal.write(message.data);
      }
    } catch (error) {
      send({ type: 'error', message: error.message || 'Terminal request failed.' });
      ws.close(1008, 'Terminal request failed.');
    }
  });
});

server.on('error', error => {
  console.error(`Bridge failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`\nwshell bridge — ${version.stdout.trim()}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`Zellij: ${executable}`);
  console.log(`Shell for the plain-shell test: ${shellFile || 'not found'}`);
  console.log(`State directory: ${stateDir}`);
  console.log(`Listening only on http://${host}:${port}`);
  console.log(`Pairing token: ${token}`);
  console.log('Paste this token into the extension settings. Do not share it.');
  console.log(`MCP endpoint: http://${host}:${port}/mcp (Authorization: Bearer <token>; idle MCP sessions expire after ${ttlHours}h)`);
  console.log('Close a terminal window to detach; Zellij sessions keep running.\n');
  // Release anything that expired while the bridge was stopped (after a startup grace period).
  void mcp.sweep().catch(error => console.error(`MCP sweep failed: ${error.message}`));
});
function shutdown() {
  mcp.close();
  // Only the bridge's sizing clients exit; agent Zellij sessions keep running.
  zellijClient.shutdown();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
