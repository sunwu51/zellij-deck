import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveZellij, bridgePaths } from './platform.mjs';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import {
  MAX_MESSAGE_BYTES, MAX_BUFFER_BYTES, validToken, isExtensionOrigin,
  parseClientMessage, parseSessions, launchArgs, terminalEnv,
} from './protocol.mjs';

const exec = promisify(execFile);
const host = '127.0.0.1';
const port = Number(process.env.WEBSHELL_PORT || 17329);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WEBSHELL_PORT must be between 1024 and 65535.');
// An absolute path works with both Windows ConPTY and macOS Unix PTYs.
const executable = await resolveZellij();
const { stateDir, cwd } = bridgePaths();
if (!(await stat(cwd)).isDirectory()) throw new Error(`Terminal working directory is not a directory: ${cwd}`);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
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
const allowedOrigin = process.env.WEBSHELL_EXTENSION_ID;
if (allowedOrigin && !/^[a-p]{32}$/.test(allowedOrigin)) throw new Error('Invalid WEBSHELL_EXTENSION_ID.');
function originAllowed(origin) {
  return isExtensionOrigin(origin) && (!allowedOrigin || origin === `chrome-extension://${allowedOrigin}`);
}
function validHost(req) { return req.headers.host === `${host}:${port}`; }
function httpOrigin(req) {
  // Privileged extension fetches can omit Origin. Require an explicit extension
  // identity in that case; never use it to override a supplied, hostile Origin.
  if (req.headers.origin !== undefined) return req.headers.origin;
  const extensionId = req.headers['x-side-shell-extension'];
  return typeof extensionId === 'string' ? `chrome-extension://${extensionId}` : undefined;
}
function authorize(req) {
  return validHost(req) && originAllowed(httpOrigin(req)) && validToken(req.headers.authorization?.replace(/^Bearer /, ''), token);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = httpOrigin(req);
  if (!validHost(req) || !originAllowed(origin)) return json(res, 403, { error: 'Extension origin required. Reload the updated extension and restart the bridge.' });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin, X-Side-Shell-Extension');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, X-Side-Shell-Extension' });
    return res.end();
  }
  if (!authorize(req)) return json(res, 401, { error: 'Invalid pairing token.' });
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  if (req.url === '/health') return json(res, 200, { version: version.stdout.trim() });
  if (req.url === '/sessions') {
    try {
      const result = await exec(executable, ['list-sessions', '--no-formatting'], { env, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
      return json(res, 200, { sessions: parseSessions(result.stdout) });
    } catch (error) {
      if (/no (active )?sessions/i.test(`${error.stdout || ''}\n${error.stderr || ''}`)) return json(res, 200, { sessions: [] });
      return json(res, 500, { error: 'Could not list Zellij sessions. Check the bridge terminal.' });
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
        terminal = pty.spawn(executable, launchArgs(message), {
          name: 'xterm-256color', cols: message.cols, rows: message.rows,
          cwd, env,
        });
        subscriptions.push(terminal.onData(data => send({ type: 'output', data })));
        subscriptions.push(terminal.onExit(event => {
          send({ type: 'exit', exitCode: event.exitCode });
          ws.close(1000, 'Zellij client exited.');
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
  console.log(`\nSide Shell bridge — ${version.stdout.trim()}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`Zellij: ${executable}`);
  console.log(`State directory: ${stateDir}`);
  console.log(`Listening only on http://${host}:${port}`);
  console.log(`Pairing token: ${token}`);
  console.log('Paste this token into the extension settings. Do not share it.');
  console.log('Close the sidebar to detach; Zellij sessions keep running.\n');
});
function shutdown() {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
