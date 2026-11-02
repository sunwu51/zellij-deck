import { timingSafeEqual } from 'node:crypto';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export function validToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export function validSession(session) {
  return typeof session === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(session);
}

export function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < 2 || cols > 500 || rows < 2 || rows > 300) return null;
  return { cols, rows };
}

export function parseSessions(output) {
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
    .map(line => {
      const separator = line.indexOf(' [Created ');
      if (separator === -1) return null;
      const name = line.slice(0, separator);
      if (!validSession(name)) return null;
      return { name, exited: /\(EXITED\b/.test(line.slice(separator)), current: /\(current\)/.test(line.slice(separator)) };
    })
    .filter(Boolean);
}

export function parseClientMessage(text) {
  let message;
  try { message = JSON.parse(text); } catch { throw new Error('Invalid JSON message.'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message.');
  if (message.type === 'open') {
    if (!validSession(message.session)) throw new Error('Use a session name with letters, numbers, dots, underscores, or hyphens (up to 96 characters).');
    if (!['watch', 'attach', 'create'].includes(message.mode)) throw new Error('Invalid connection mode.');
    const size = dimensions(message.cols, message.rows);
    if (!size) throw new Error('Invalid terminal size.');
    return { type: 'open', session: message.session, mode: message.mode, ...size };
  }
  if (message.type === 'resize') {
    const size = dimensions(message.cols, message.rows);
    if (!size) throw new Error('Invalid terminal size.');
    return { type: 'resize', ...size };
  }
  if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= 32 * 1024) {
    return { type: 'input', data: message.data };
  }
  throw new Error('Unsupported message.');
}

export function launchArgs({ mode, session }) {
  if (!validSession(session)) throw new Error('Invalid session name.');
  if (mode === 'watch') return ['watch', session];
  if (mode === 'create') return ['attach', '--create', session];
  if (mode === 'attach') return ['attach', session];
  throw new Error('Invalid connection mode.');
}

export function terminalEnv(env = process.env) {
  const clean = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const key of Object.keys(clean)) {
    if (/^ZELLIJ(?:$|_)/i.test(key)) delete clean[key];
  }
  return clean;
}
