import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { keyAction, controlCharacter } from './keyboard';

type Settings = { port: number; token: string; fontSize: number; autoReconnect: boolean; session: string; mode: 'watch' | 'attach' };
type Session = { name: string; exited: boolean; current: boolean };
type Target = { session: string; mode: 'watch' | 'attach' | 'create' };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settingsPanel = element('settings');
const toggle = element<HTMLButtonElement>('settings-toggle');
const portInput = element<HTMLInputElement>('port');
const tokenInput = element<HTMLInputElement>('token');
const fontInput = element<HTMLInputElement>('font-size');
const reconnectInput = element<HTMLInputElement>('auto-reconnect');
const sessionSelect = element<HTMLSelectElement>('session');
const watchButton = element<HTMLButtonElement>('watch');
const attachButton = element<HTMLButtonElement>('attach');
const connectButton = element<HTMLButtonElement>('connect');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const refreshButton = element<HTMLButtonElement>('refresh');
const notice = element('notice');
let settings: Settings = { port: 17329, token: '', fontSize: 13, autoReconnect: true, session: '', mode: 'watch' };
let socket: WebSocket | undefined;
let target: Target | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let ready = false;
let outputPending = 0;
let refreshController: AbortController | undefined;

const terminal = new Terminal({
  cursorBlink: true, fontSize: 13,
  fontFamily: 'Cascadia Code, Consolas, Menlo, monospace',
  scrollback: 5000, allowProposedApi: false, allowTransparency: false,
  disableStdin: true,
  theme: { background: '#101315', foreground: '#e5e9e7', cursor: '#a8e6be', selectionBackground: '#3b5548', black: '#242a2d', red: '#e99d91', green: '#a8e6be', yellow: '#e8d49b', blue: '#93bbdf', magenta: '#c6a8dd', cyan: '#92cdd0', white: '#e5e9e7' },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(element('terminal'));
function showNotice(message = '') { notice.textContent = message; notice.hidden = !message; }
function status(text: string, state = '') {
  element('status').textContent = text;
  element('status-dot').className = `status-dot ${state}`;
}
function setSessionControlsOpen(open: boolean) {
  element('session-controls').hidden = !open;
  element('session-toggle').setAttribute('aria-expanded', String(open));
  element('session-toggle-label').textContent = open ? 'Collapse ▴' : 'Expand ▾';
  requestAnimationFrame(resize);
}
element('session-toggle').addEventListener('click', () => {
  setSessionControlsOpen(element('session-controls').hidden);
});
function setSettingsOpen(open: boolean) {
  settingsPanel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
}
function setMode(mode: 'watch' | 'attach') {
  settings.mode = mode;
  watchButton.classList.toggle('selected', mode === 'watch');
  attachButton.classList.toggle('selected', mode === 'attach');
  watchButton.setAttribute('aria-pressed', String(mode === 'watch'));
  attachButton.setAttribute('aria-pressed', String(mode === 'attach'));
}
function setBusy(busy: boolean) {
  connectButton.hidden = false;
  connectButton.textContent = busy ? 'Switch' : 'Open session';
  disconnectButton.hidden = !busy;
  if (!busy) {
    element('session-summary').textContent = 'Session controls';
    setSessionControlsOpen(true);
  }
  // Switching sessions or creating another session detaches only this viewer.
  // Other Zellij sessions and their processes stay running.
}
function resize() {
  if (element('terminal').clientHeight < 30 || element('terminal').clientWidth < 30) return;
  fit.fit();
  element('dimensions').textContent = `${terminal.cols} × ${terminal.rows}`;
  if (ready && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  }
}
let resizeTimer: ReturnType<typeof setTimeout>;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 100);
}).observe(element('terminal'));
function canInput() {
  return ready && !!target && target.mode !== 'watch' && socket?.readyState === WebSocket.OPEN;
}
function sendInput(data: string) {
  if (!canInput() || !socket) return;
  if (socket.bufferedAmount > 128 * 1024) { showNotice('Input is arriving too quickly. Wait before pasting more text.'); return; }
  socket.send(JSON.stringify({ type: 'input', data }));
}
terminal.onData(sendInput);
const isMac = /Mac/i.test(navigator.platform);
const keyboardHint = isMac
  ? 'Paste: Cmd+V · Copy: Cmd+C · Send Ctrl: Ctrl+. then a letter'
  : 'Paste: Ctrl+V · Copy: Ctrl+Shift+C · Send Ctrl: Ctrl+. then a letter';
element('keyboard-hint').textContent = keyboardHint;
let ctrlPending = false;
let ctrlTimer: ReturnType<typeof setTimeout> | undefined;
function clearCtrlPrefix() {
  clearTimeout(ctrlTimer);
  ctrlPending = false;
  element('keyboard-hint').textContent = keyboardHint;
}
function updateKeyboardControls() {
  element<HTMLSelectElement>('ctrl-key').disabled = !canInput();
  element<HTMLButtonElement>('send-ctrl').disabled = !canInput();
}
terminal.attachCustomKeyEventHandler(event => {
  if (ctrlPending) {
    // Consume keyup/keypress too, but wait for the next actual keydown.
    if (event.type !== 'keydown') return false;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return false;
    event.preventDefault();
    clearCtrlPrefix();
    if (event.key === 'Escape') return false;
    if (!event.isComposing && !event.altKey && !event.metaKey) {
      const data = controlCharacter(event.key);
      if (data !== null) sendInput(data);
      else showNotice('After Ctrl+., press A–Z to send a Ctrl key, or Escape to cancel.');
    }
    return false;
  }
  const action = keyAction(event);
  if (action === 'paste') {
    // Do not preventDefault: Chrome must dispatch the real clipboard paste
    // event, which xterm handles with its normal bracketed-paste support.
    // Returning false only skips xterm's Ctrl+V -> ^V translation.
    return false;
  }
  if (action === 'copy') {
    event.preventDefault();
    if (event.type === 'keydown' && terminal.hasSelection()) {
      void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
        showNotice('Clipboard copy failed. Use the browser context menu to copy the selection.');
      });
    }
    return false;
  }
  if (action === 'prefix') {
    event.preventDefault();
    if (event.type === 'keydown' && !event.repeat && canInput()) {
      ctrlPending = true;
      element('keyboard-hint').textContent = 'Send Ctrl: press A–Z now · Escape cancels';
      ctrlTimer = setTimeout(clearCtrlPrefix, 5000);
    }
    return false;
  }
  return true;
});
terminal.textarea?.addEventListener('blur', clearCtrlPrefix);
element('send-ctrl').addEventListener('click', () => {
  const data = controlCharacter(element<HTMLSelectElement>('ctrl-key').value);
  if (data !== null) sendInput(data);
  terminal.focus();
});

function baseUrl() { return `http://127.0.0.1:${settings.port}`; }
async function refreshSessions(quiet = false) {
  if (!settings.token) { setSettingsOpen(true); return; }
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  refreshButton.disabled = true;
  try {
    const response = await fetch(`${baseUrl()}/sessions`, {
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'X-Side-Shell-Extension': chrome.runtime.id,
      }, signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Bridge returned ${response.status}.`);
    const selected = sessionSelect.value || target?.session || settings.session;
    const sessions = data.sessions as Session[];
    sessionSelect.replaceChildren(new Option(sessions.length ? 'Choose a session' : 'No Zellij sessions yet', ''));
    for (const session of sessions) {
      sessionSelect.add(new Option(`${session.name}${session.exited ? ' · exited' : ''}${session.current ? ' · current' : ''}`, session.name));
    }
    if (Array.from(sessionSelect.options).some(option => option.value === selected)) sessionSelect.value = selected;
    element('session-help').textContent = sessions.length
      ? `${sessions.filter(session => !session.exited).length} running · Choose a session and open it. Switching keeps other sessions running.`
      : 'Bridge connected. Create a session below, or start one in your local Zellij terminal.';
    if (!quiet) showNotice();
    if (!target) status('Bridge connected · choose a session');
  } catch (error) {
    if (refreshController !== controller || quiet) return;
    element('session-help').textContent = 'Could not load sessions from the bridge. This is a connection error, not an empty session list.';
    showNotice(error instanceof Error && error.name !== 'AbortError'
      ? `${error.message} Make sure npm run bridge is running and the token matches.`
      : 'Bridge request timed out. Check the bridge and retry.');
    if (!target) status('Bridge unavailable');
  } finally {
    clearTimeout(timeout);
    if (refreshController === controller) refreshButton.disabled = false;
  }
}
function detach() {
  clearTimeout(retryTimer);
  target = undefined;
  ready = false;
  const old = socket;
  socket = undefined;
  old?.close(1000, 'Sidebar detached.');
  terminal.options.disableStdin = true;
  clearCtrlPrefix();
  updateKeyboardControls();
  setBusy(false);
  status('Detached · session kept running');
}
function connect(next: Target, retry = false) {
  if (!settings.token) { showNotice('Add your pairing token in settings first.'); setSettingsOpen(true); return; }
  if (!retry) {
    detach();
    retries = 0;
    settings.session = next.session;
    void chrome.storage.local.set({ settings });
  }
  target = next;
  ready = false;
  terminal.options.disableStdin = true;
  setBusy(true);
  showNotice();
  status(`${retry ? 'Reconnecting' : 'Connecting'} · ${next.session}`, 'connecting');
  resize();
  let ws: WebSocket;
  try { ws = new WebSocket(`ws://127.0.0.1:${settings.port}/terminal`, ['side-shell-v1', `pair.${settings.token}`]); }
  catch (error) { detach(); showNotice(String(error)); return; }
  socket = ws;
  let intentionalExit = false;
  const timeout = setTimeout(() => { if (socket === ws && !ready) ws.close(); }, 10000);
  ws.onopen = () => {
    if (socket !== ws) return ws.close();
    terminal.reset();
    ws.send(JSON.stringify({ type: 'open', ...next, cols: terminal.cols, rows: terminal.rows }));
  };
  ws.onmessage = event => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'output') {
        if (typeof message.data !== 'string') throw new Error('Invalid terminal output.');
        const length = message.data.length;
        outputPending += length;
        if (outputPending > 2 * 1024 * 1024) {
          intentionalExit = true;
          showNotice('Too much pending terminal output. Reconnect to redraw the session.');
          ws.close();
          return;
        }
        terminal.write(message.data, () => { outputPending -= length; });
      } else if (message.type === 'ready') {
        clearTimeout(timeout);
        ready = true;
        retries = 0;
        // Never recreate a session automatically after the first successful connection.
        if (target?.mode === 'create') target = { ...target, mode: 'attach' };
        terminal.options.disableStdin = next.mode === 'watch';
        updateKeyboardControls();
        element('empty-state').hidden = true;
        if (!Array.from(sessionSelect.options).some(option => option.value === next.session)) {
          sessionSelect.add(new Option(next.session, next.session));
        }
        sessionSelect.value = next.session;
        element('session-summary').textContent = `${next.session} · ${next.mode === 'watch' ? 'Watch' : 'Interact'}`;
        setSettingsOpen(false);
        setSessionControlsOpen(false);
        status(`${next.mode === 'watch' ? 'Watching' : 'Interactive'} · ${next.session}`, 'connected');
        if (next.mode !== 'watch') terminal.focus();
        resize();
        // Zellij may announce the session slightly after the PTY starts.
        setTimeout(() => { void refreshSessions(true); }, 750);
      } else if (message.type === 'exit') {
        intentionalExit = true;
        showNotice(`Zellij client exited (code ${message.exitCode}). The session may have ended or been detached.`);
      } else if (message.type === 'error') {
        intentionalExit = true;
        showNotice(message.message);
      }
    } catch {
      intentionalExit = true;
      showNotice('Invalid response from the local bridge.');
      ws.close();
    }
  };
  ws.onerror = () => {
    if (socket === ws) showNotice('Cannot connect to the bridge. Check the port, pairing token, and bridge terminal.');
  };
  ws.onclose = event => {
    clearTimeout(timeout);
    if (socket !== ws) return;
    ready = false;
    terminal.options.disableStdin = true;
    clearCtrlPrefix();
    updateKeyboardControls();
    if (!intentionalExit && event.code !== 1008 && settings.autoReconnect && target && retries < 10) {
      const delay = Math.min(1000 * 2 ** retries++, 15000);
      status(`Retrying in ${delay / 1000}s`, 'connecting');
      retryTimer = setTimeout(() => { if (target) connect(target, true); }, delay);
    } else {
      socket = undefined;
      target = undefined;
      setBusy(false);
      status('Disconnected');
    }
  };
}

toggle.addEventListener('click', () => setSettingsOpen(settingsPanel.hidden));
watchButton.addEventListener('click', () => setMode('watch'));
attachButton.addEventListener('click', () => setMode('attach'));
refreshButton.addEventListener('click', () => { void refreshSessions(); });
connectButton.addEventListener('click', () => {
  if (!sessionSelect.value) { showNotice('Choose a session, or create a new one below.'); return; }
  connect({ session: sessionSelect.value, mode: settings.mode });
});
disconnectButton.addEventListener('click', () => { detach(); showNotice(); });
element('create-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = element<HTMLInputElement>('new-name').value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) { showNotice('Use letters, numbers, dots, underscores, or hyphens for session names.'); return; }
  setMode('attach');
  connect({ session: name, mode: 'create' });
});
element('save-settings').addEventListener('click', async () => {
  const port = Number(portInput.value);
  const fontSize = Number(fontInput.value);
  const token = tokenInput.value.trim();
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return showNotice('Port must be between 1024 and 65535.');
  if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) return showNotice('Font size must be between 10 and 24.');
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) return showNotice('Paste the full pairing token printed by the bridge (32–256 letters, numbers, underscores, or hyphens).');
  detach();
  settings = { ...settings, port, fontSize, token, autoReconnect: reconnectInput.checked };
  try { await chrome.storage.local.set({ settings }); }
  catch { showNotice('Could not save settings. Please retry.'); return; }
  terminal.options.fontSize = fontSize;
  setSettingsOpen(false);
  resize();
  await refreshSessions();
});
window.addEventListener('pagehide', detach);
async function init() {
  try {
    const stored = await chrome.storage.local.get('settings');
    if (stored.settings && typeof stored.settings === 'object') {
      settings = { ...settings, ...(stored.settings as Partial<Settings>) };
    }
  } catch { showNotice('Could not load saved settings.'); }
  portInput.value = String(settings.port);
  tokenInput.value = settings.token;
  fontInput.value = String(settings.fontSize);
  reconnectInput.checked = settings.autoReconnect;
  terminal.options.fontSize = settings.fontSize;
  setMode(settings.mode);
  resize();
  if (!settings.token) setSettingsOpen(true);
  else await refreshSessions();
}
void init();
