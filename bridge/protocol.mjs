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

export function noSessions(error) {
  const output = `${error.stdout || ''}\n${error.stderr || ''}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return /\bno (?:active )?(?:zellij )?sessions(?:\b|$)/i.test(output);
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
    if (!OPEN_MODES.includes(message.mode)) throw new Error('Invalid connection mode.');
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

// 'shell' and 'bare' are lag-diagnosis modes: a plain shell with no Zellij at all, and Zellij
// started from an empty config with a single bare pane (no plugins, keybindings or themes).
export const OPEN_MODES = ['watch', 'attach', 'create', 'shell', 'bare'];

export function bareConfig(layoutDir) {
  const dir = String(layoutDir).replaceAll(String.fromCharCode(92), '/').replaceAll('"', '');
  return ['show_startup_tips false', 'show_release_notes false', 'session_serialization false', 'pane_frames false',
    'default_layout "bare"', `layout_dir "${dir}"`, ''].join('\n');
}
export const BARE_LAYOUT = 'layout {\n    pane\n}\n';

/** Candidate shells: pwsh, then Windows PowerShell, on Windows; the user's login shell elsewhere. */
export function shellCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return [env.SHELL || '/bin/sh'];
  const dirs = (env.PATH || env.Path || '').split(';').filter(Boolean).map(d => d.replace(/^"|"$/g, ''));
  return ['pwsh.exe', 'powershell.exe'].flatMap(name => dirs.map(d => `${d}/${name}`));
}
export function shellArgs(file) { return /(?:pwsh|powershell)(?:\.exe)?$/i.test(file) ? ['-NoLogo'] : []; }

export function launchArgs({ mode, session }, { bareConfigPath } = {}) {
  if (!validSession(session)) throw new Error('Invalid session name.');
  if (mode === 'bare') {
    if (!bareConfigPath) throw new Error('Bare Zellij configuration is unavailable.');
    return ['--config', bareConfigPath, 'attach', '--create', session];
  }
  if (mode === 'watch') return ['watch', session];
  if (mode === 'create') return ['attach', '--create', session];
  if (mode === 'attach') return ['attach', session];
  throw new Error('Invalid connection mode.');
}

export function terminalEnv(env = process.env) {
  const clean = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const key of Object.keys(clean)) {
    // Remove nesting identity, not discovery/configuration. In particular,
    // ZELLIJ_SOCKET_DIR must match the user's other terminal clients.
    if (/^(?:ZELLIJ|ZELLIJ_SESSION_NAME|ZELLIJ_PANE_ID)$/i.test(key)) delete clean[key];
  }
  return clean;
}

// ---- Session snapshots -------------------------------------------------------
// Snapshots use Zellij's query actions (list-tabs, list-panes, dump-screen), so
// previewing never attaches a client or changes a session's size, focus, or tab.
export const MAX_SNAPSHOT_PANES = 48;
export const MAX_PANE_DUMP_CHARS = 256 * 1024;

/** Returns the session for /sessions/<name>/snapshot, false for an invalid name, or null for other routes. */
export function snapshotRoute(url) {
  const match = /^\/sessions\/([^/?#]+)\/snapshot$/.exec(url || '');
  if (!match) return null;
  let name;
  try { name = decodeURIComponent(match[1]); } catch { return false; }
  return validSession(name) ? name : false;
}

export function snapshotArgs(session, action) {
  if (!validSession(session)) throw new Error('Invalid session name.');
  return ['--session', session, 'action', ...action];
}

function cleanText(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max) : '';
}
function count(value, max = 10000) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

/** Keep only printable text, newlines, tabs, and SGR color/style sequences. */
export function sanitizeDump(text) {
  let clean = String(text).replace(/\r\n?/g, '\n')
    // Drop every escape sequence except SGR (ESC [ ... m), including OSC/DCS strings.
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[\s\S]?)/g,
      sequence => /^\x1b\[[0-9;:]*m$/.test(sequence) ? sequence : '')
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f]/g, '')
    .replace(/\n+$/, '');
  let truncated = false;
  if (clean.length > MAX_PANE_DUMP_CHARS) {
    // Keep the bottom of the viewport, starting at a line boundary.
    const start = clean.indexOf('\n', clean.length - MAX_PANE_DUMP_CHARS);
    clean = start === -1 ? '' : clean.slice(start + 1);
    truncated = true;
  }
  return { content: clean, truncated };
}

/** Normalize `list-tabs --json --all` and `list-panes --json --all` into a bounded preview layout. */
export function snapshotLayout(tabsJson, panesJson) {
  if (!Array.isArray(tabsJson) || !Array.isArray(panesJson)) throw new Error('Unexpected Zellij layout output.');
  const tabs = tabsJson.flatMap(tab => {
    const id = count(tab?.tab_id);
    const cols = count(tab?.display_area_columns, 2000);
    const rows = count(tab?.display_area_rows, 1000);
    if (id === null || !cols || !rows) return [];
    return [{
      id, position: count(tab.position) ?? 0, name: cleanText(tab.name, 64) || `Tab ${id + 1}`,
      active: tab.active === true, cols, rows,
      floatingVisible: tab.are_floating_panes_visible === true,
      fullscreen: tab.is_fullscreen_active === true,
      bell: tab.has_bell_notification === true,
    }];
  }).sort((a, b) => a.position - b.position);
  const tabIds = new Set(tabs.map(tab => tab.id));
  const activeTab = tabs.find(tab => tab.active)?.id;
  const panes = panesJson.flatMap(pane => {
    const id = count(pane?.id);
    const tabId = count(pane?.tab_id);
    const geometry = {
      x: count(pane?.pane_x), y: count(pane?.pane_y), cols: count(pane?.pane_columns), rows: count(pane?.pane_rows),
      contentX: count(pane?.pane_content_x), contentY: count(pane?.pane_content_y),
      contentCols: count(pane?.pane_content_columns), contentRows: count(pane?.pane_content_rows),
    };
    if (id === null || !tabIds.has(tabId) || pane.is_suppressed === true || Object.values(geometry).some(value => value === null)) return [];
    if (!geometry.cols || !geometry.rows) return [];
    const plugin = pane.is_plugin === true;
    return [{
      id: `${plugin ? 'plugin' : 'terminal'}_${id}`, tabId, plugin,
      title: cleanText(pane.title) || (plugin ? cleanText(pane.plugin_url) : ''),
      focused: pane.is_focused === true, floating: pane.is_floating === true,
      fullscreen: pane.is_fullscreen === true, exited: pane.exited === true,
      ...geometry,
    }];
  });
  // Under the cap, prefer the active tab, then terminal panes (plugins have no dumpable text).
  const ranked = panes.map((pane, index) => ({ pane, index }))
    .sort((a, b) => Number(b.pane.tabId === activeTab) - Number(a.pane.tabId === activeTab)
      || Number(a.pane.plugin) - Number(b.pane.plugin) || a.index - b.index);
  const kept = new Set(ranked.slice(0, MAX_SNAPSHOT_PANES).map(item => item.pane));
  // Every attached client has exactly one focused tab, so the union is the attached-client set.
  // A session with zero clients is still running in the background (detached).
  const clients = new Set(tabsJson.flatMap(tab => Array.isArray(tab?.other_focused_clients) ? tab.other_focused_clients.filter(id => count(id) !== null) : []));
  return { tabs, panes: panes.filter(pane => kept.has(pane)), panesTruncated: panes.length > MAX_SNAPSHOT_PANES, clients: clients.size };
}

/** Classify a failed snapshot query into an HTTP status and a user-facing message. */
export function snapshotFailure(error) {
  const output = `${error?.stdout || ''}\n${error?.stderr || ''}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/session '.*' not found|no (?:active )?(?:zellij )?sessions?/i.test(output)) {
    return { status: 404, error: 'Session is not running. Exited sessions have no live screen to preview.' };
  }
  if (/unrecognized subcommand|unexpected argument|Found argument/i.test(output)) {
    return { status: 501, error: 'This Zellij version cannot report tabs and panes. Upgrade Zellij to use session previews.' };
  }
  return { status: 500, error: 'Could not capture the session preview. Check the bridge terminal.' };
}
