import { validBridgeIp } from './network';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ImageAddon } from '@xterm/addon-image';
import { createRendererController, normalizeRenderer, rendererLabel, type RendererPreference } from './renderer';
import { keyAction, controlCharacter, shiftEnterSequence, applyKittyKeyboard } from './keyboard';
import { terminalColorOptions, selectedPalette, normalizeAppearance } from './theme';
import { copyToClipboard, osc52Text } from './clipboard';
import { useModernWidths } from './unicode';
import {
  FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT, MIN_FONT_SIZE, MAX_FONT_SIZE, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT,
  migrateFontSize, lineHeightOrDefault,
} from './font';
import { initThemeControls } from './theme-controls';
import { initWindowControls, openDashboard, windowTarget, windowConnection, attachedUrl } from './window-controls';
import { bridgeJson, loadConnections, migrate, rememberSession, wsUrl, type Connection } from './connections';

type Settings = { fontSize: number; lineHeight: number; fontDefaultsV2: boolean; autoReconnect: boolean; mode: 'watch' | 'attach'; renderer: RendererPreference };
type Session = { name: string; exited: boolean; current: boolean };
type Target = { session: string; mode: 'watch' | 'attach' | 'create' };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// This page is only a dedicated terminal; the dashboard is the launcher.
const settingsPanel = element('settings');
const toggle = element<HTMLButtonElement>('settings-toggle');
const fontInput = element<HTMLInputElement>('font-size');
const lineHeightInput = element<HTMLInputElement>('line-height');
const reconnectInput = element<HTMLInputElement>('auto-reconnect');
const rendererInput = element<HTMLSelectElement>('renderer');
const sessionSelect = element<HTMLSelectElement>('session');
const watchButton = element<HTMLButtonElement>('watch');
const attachButton = element<HTMLButtonElement>('attach');
const connectButton = element<HTMLButtonElement>('connect');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const refreshButton = element<HTMLButtonElement>('refresh');
const notice = element('notice');
let settings: Settings = { fontSize: DEFAULT_FONT_SIZE, lineHeight: DEFAULT_LINE_HEIGHT, fontDefaultsV2: true, autoReconnect: true, mode: 'watch', renderer: 'webgl' };
let socket: WebSocket | undefined;
// The bridge this window is bound to for its whole life; the dashboard's selection never changes it.
let bound: Connection | undefined;
let target: Target | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let ready = false;
let outputPending = 0;
let refreshController: AbortController | undefined;

// Powerline/Nerd Font glyphs live in Unicode's private-use ranges. Load the
// packaged fallback before xterm measures or draws its first terminal cells.
let symbolFontFailed = false;
try {
  const faces = await document.fonts.load('13px "wshell Symbols"', '');
  symbolFontFailed = faces.length === 0;
} catch { symbolFontFailed = true; }

const terminal = new Terminal({
  cursorStyle: 'bar', cursorWidth: 2, cursorBlink: true,
  fontSize: DEFAULT_FONT_SIZE, lineHeight: DEFAULT_LINE_HEIGHT,
  fontFamily: FONT_FAMILY,
  scrollback: 5000, allowProposedApi: true, allowTransparency: false,
  // macOS composes Option+letter into symbols (Option+D -> ∂); send ESC+letter so Zellij sees Alt.
  macOptionIsMeta: true,
  disableStdin: true,
  ...terminalColorOptions,
});
useModernWidths(terminal);
const fit = new FitAddon();
terminal.loadAddon(fit);
// Sixel (and iTerm2 inline image) support, so Zellij can pass through image previews such as yazi's.
terminal.loadAddon(new ImageAddon());
terminal.open(element('terminal'));
function showNotice(message = '') {
  const text = message || (symbolFontFailed ? 'Terminal symbol font could not load. Rebuild and reload the extension to restore Powerline icons.' : '');
  notice.textContent = text;
  notice.hidden = !text;
}
showNotice();
// The renderer is applied once saved settings load (see init) and live on settings changes.
const renderer = createRendererController(terminal, () => new WebglAddon(), (_state, problem) => {
  updateDimensions();
  if (problem) showNotice(problem);
});
function updateDimensions() {
  element('dimensions').textContent = `${terminal.cols} × ${terminal.rows} · ${rendererLabel(renderer.state)}`;
}
function status(text: string, state = '') {
  element('status').textContent = text;
  element('status-dot').className = `status-dot ${state}`;
}
function setSessionControlsOpen(open: boolean) {
  element('session-controls').hidden = !open;
  element('session-toggle').setAttribute('aria-expanded', String(open));
  element('session-toggle-label').textContent = open ? 'Collapse ▴' : 'Expand ▾';
  // Collapsing also hides the brand header so the terminal gets that height; the
  // header buttons move into the slim session bar so they stay one click away.
  element('header').hidden = !open;
  (open ? element('header') : element('session-bar')).append(element('header-actions'));
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
  updateDimensions();
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
// The Zellij client enables the kitty keyboard protocol (CSI > 1 u); track it so Shift+Enter
// can be encoded the way Windows Terminal and kitty send it.
let kittyKeyboard: number[] = [];
for (const prefix of ['>', '<', '=']) {
  terminal.parser.registerCsiHandler({ prefix, final: 'u' }, params => {
    kittyKeyboard = applyKittyKeyboard(kittyKeyboard, prefix, params);
    return true;
  });
}
// Zellij copies with OSC 52; without a handler the "copied" message is a lie.
terminal.parser.registerOscHandler(52, data => {
  const text = osc52Text(data);
  if (text !== null) {
    // Only failures are shown: the notice bar resizes the terminal.
    copyToClipboard(text).catch(error => {
      showNotice(`Clipboard copy failed (${error instanceof Error ? error.name + ': ' + error.message : String(error)}).`);
    });
  }
  return true;
});
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
  element<HTMLInputElement>('custom-ctrl').disabled = !canInput();
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
  const shiftEnter = shiftEnterSequence(event, kittyKeyboard.at(-1) ?? 0);
  if (shiftEnter !== null) {
    // Swallow the keypress/keyup too, so xterm.js never sends its own CR.
    event.preventDefault();
    if (event.type === 'keydown') sendInput(shiftEnter);
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
element('ctrl-key').addEventListener('change', () => {
  const custom = element<HTMLInputElement>('custom-ctrl');
  custom.hidden = element<HTMLSelectElement>('ctrl-key').value !== 'custom';
  if (!custom.hidden) custom.focus();
});
function sendSelectedCtrl() {
  if (!canInput()) return;
  const selected = element<HTMLSelectElement>('ctrl-key').value;
  const custom = element<HTMLInputElement>('custom-ctrl');
  const data = controlCharacter(selected === 'custom' ? custom.value : selected);
  if (data === null) {
    showNotice('Enter one Ctrl character: A–Z, @, [, backslash, ], ^, _, ?, or Space. Other characters have no standard terminal Ctrl byte.');
    custom.focus();
    return;
  }
  sendInput(data);
  terminal.focus();
}
element('send-ctrl').addEventListener('click', sendSelectedCtrl);
element('custom-ctrl').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendSelectedCtrl(); }
});
initWindowControls(() => ready && target ? { ...target, connection: bound?.id } : undefined, showNotice, resize, () => bound?.id);
element('dashboard').addEventListener('click', () => {
  void openDashboard().catch(error => showNotice(error instanceof Error ? error.message : 'Could not open session previews.'));
});

function showConnection() {
  const label = bound ? `${bound.name} · ${bound.host}:${bound.port}` : 'No connection';
  element('connection-label').textContent = bound ? bound.name : 'NO CONNECTION';
  element('connection-info').textContent = label;
  updateTitle();
}
function updateTitle() {
  document.title = ['Zellij Deck', bound?.name, target?.session].filter(Boolean).join(' · ');
}
async function refreshSessions(quiet = false) {
  const conn = bound;
  if (!conn) { showNotice('This window has no bridge connection. Add one in the dashboard.'); setSettingsOpen(true); return; }
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  refreshButton.disabled = true;
  try {
    const data = await bridgeJson<{ sessions: Session[] }>(conn, '/sessions', { signal: controller.signal });
    const selected = sessionSelect.value || target?.session || conn.lastSession || '';
    const sessions = data.sessions as Session[];
    sessionSelect.replaceChildren(new Option(sessions.length ? 'Choose a session' : 'No Zellij sessions yet', ''));
    for (const session of sessions) {
      sessionSelect.add(new Option(`${session.name}${session.exited ? ' · exited' : ''}${session.current ? ' · current' : ''}`, session.name));
    }
    if (Array.from(sessionSelect.options).some(option => option.value === selected)) sessionSelect.value = selected;
    element('session-help').textContent = sessions.length
      ? `${sessions.filter(session => !session.exited).length} running · Choose a session and open it. Other sessions keep running.`
      : 'Bridge connected. Create a session below, or start one in your local Zellij terminal.';
    if (!quiet) showNotice();
    if (!target) status('Bridge connected · choose a session');
  } catch (error) {
    if (refreshController !== controller || quiet) return;
    element('session-help').textContent = 'Could not load sessions from the bridge. This is a connection error, not an empty session list.';
    showNotice(error instanceof Error && error.name !== 'AbortError'
      ? `${error.message} Make sure the bridge is running and the token matches.`
      : 'Bridge request timed out. Check the bridge and retry.');
    if (!target) status('Bridge unavailable');
  } finally {
    clearTimeout(timeout);
    if (refreshController === controller) refreshButton.disabled = false;
  }
}
// Zellij draws a frame in several chunks (ConPTY splits them), with the cursor parked at
// intermediate positions such as the status line. Writing each chunk as it arrives lets the
// browser paint between them; xterm moves its hidden input box to the cursor on every paint,
// so an open IME candidate window jumped there and back on each redraw. Hand xterm everything
// that arrives within a few milliseconds as one write, so only the final cursor is painted.
const OUTPUT_BATCH_MS = 8;
let batch = '';
let batchLength = 0;
let batchTimer: ReturnType<typeof setTimeout> | undefined;
function flushOutput() {
  clearTimeout(batchTimer);
  batchTimer = undefined;
  if (!batch) return;
  const data = batch, length = batchLength;
  batch = '';
  batchLength = 0;
  terminal.write(data, () => { outputPending -= length; });
}
function queueOutput(data: string, length: number) {
  batch += data;
  batchLength += length;
  batchTimer ??= setTimeout(flushOutput, OUTPUT_BATCH_MS);
}
function dropQueuedOutput() {
  clearTimeout(batchTimer);
  batchTimer = undefined;
  outputPending -= batchLength;
  batch = '';
  batchLength = 0;
}
function detach() {
  dropQueuedOutput();
  clearTimeout(retryTimer);
  target = undefined;
  updateTitle();
  ready = false;
  const old = socket;
  socket = undefined;
  old?.close(1000, 'Terminal detached.');
  terminal.options.disableStdin = true;
  clearCtrlPrefix();
  updateKeyboardControls();
  setBusy(false);
  status('Detached · session kept running');
}
function connect(next: Target, retry = false) {
  if (!bound) { showNotice('This window has no bridge connection. Add one in the dashboard.'); setSettingsOpen(true); return; }
  if (!retry) {
    detach();
    retries = 0;
    void rememberSession(bound.id, next.session).catch(() => {});
  }
  target = next;
  updateTitle();
  ready = false;
  terminal.options.disableStdin = true;
  setBusy(true);
  showNotice();
  status(`${retry ? 'Reconnecting' : 'Connecting'} · ${next.session}`, 'connecting');
  resize();
  let ws: WebSocket;
  try { ws = new WebSocket(wsUrl(bound), ['wshell-v1', `pair.${bound.token}`]); }
  catch (error) { detach(); showNotice(String(error)); return; }
  socket = ws;
  let intentionalExit = false;
  const timeout = setTimeout(() => { if (socket === ws && !ready) ws.close(); }, 10000);
  ws.onopen = () => {
    if (socket !== ws) return ws.close();
    dropQueuedOutput();
    terminal.reset();
    kittyKeyboard = []; // the new Zellij client enables it again
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
        queueOutput(message.data, length);
      } else if (message.type === 'ready') {
        clearTimeout(timeout);
        ready = true;
        retries = 0;
        // Never recreate a session automatically after the first successful connection.
        if (target?.mode === 'create') target = { ...target, mode: 'attach' };
        // drop a window's one-time create flag, so reloading it only attaches
        if (target) history.replaceState(null, '', attachedUrl(location.href, target));
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
        showNotice(`Terminal process exited (code ${message.exitCode}). The session may have ended or been detached.`);
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
      updateTitle();
      setBusy(false);
      status('Disconnected');
    }
  };
}

toggle.addEventListener('click', () => setSettingsOpen(settingsPanel.hidden));
watchButton.addEventListener('click', () => setMode('watch'));
attachButton.addEventListener('click', () => setMode('attach'));
refreshButton.addEventListener('click', () => { void refreshSessions(); });
function openSession(next: Target) {
  connect(next);
}
connectButton.addEventListener('click', () => {
  if (!sessionSelect.value) { showNotice('Choose a session, or create a new one below.'); return; }
  void openSession({ session: sessionSelect.value, mode: settings.mode });
});
disconnectButton.addEventListener('click', () => { detach(); showNotice(); });
element('create-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = element<HTMLInputElement>('new-name').value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) { showNotice('Use letters, numbers, dots, underscores, or hyphens for session names.'); return; }
  setMode('attach');
  void openSession({ session: name, mode: 'create' });
});
element('save-settings').addEventListener('click', async () => {
  const fontSize = Number(fontInput.value);
  const lineHeight = Number(lineHeightInput.value);
  if (!Number.isInteger(fontSize) || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) return showNotice(`Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`);
  if (!(lineHeight >= MIN_LINE_HEIGHT && lineHeight <= MAX_LINE_HEIGHT)) return showNotice(`Line height must be between ${MIN_LINE_HEIGHT} and ${MAX_LINE_HEIGHT}.`);
  settings = { ...settings, fontSize, lineHeight, fontDefaultsV2: true, autoReconnect: reconnectInput.checked, renderer: normalizeRenderer(rendererInput.value) };
  try { await chrome.storage.local.set({ settings }); }
  catch { showNotice('Could not save settings. Please retry.'); return; }
  terminal.options.fontSize = fontSize;
  terminal.options.lineHeight = lineHeight;
  renderer.apply(settings.renderer);
  setSettingsOpen(false);
  resize();
});
window.addEventListener('pagehide', detach);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.appearance) {
    const colors = selectedPalette(normalizeAppearance(changes.appearance.newValue));
    terminal.options.theme = colors;
    element('terminal-region').style.backgroundColor = colors.background;
    element('empty-state').style.backgroundColor = colors.background;
  }
  if (changes.settings?.newValue) {
    const saved = changes.settings.newValue as Partial<Settings>;
    // Credentials are used on the next connection; do not drop an active session.
    settings = { ...settings, ...saved, fontSize: migrateFontSize(saved), lineHeight: lineHeightOrDefault(saved.lineHeight), renderer: normalizeRenderer(saved.renderer) };
    fontInput.value = String(settings.fontSize);
    lineHeightInput.value = String(settings.lineHeight);
    reconnectInput.checked = settings.autoReconnect;
    rendererInput.value = settings.renderer;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.lineHeight = settings.lineHeight;
    // A renderer switch applies live and keeps the session attached.
    renderer.apply(settings.renderer);
    resize();
  }
  if (changes.connections && bound) {
    // Edited credentials apply from the next (re)connect; a live session is never dropped.
    const current = migrate({ connections: changes.connections.newValue }).connections.find(item => item.id === bound!.id);
    if (current) { bound = current; showConnection(); }
    else showNotice('This connection was deleted in the dashboard. The open session keeps running until you close the window.');
  }
});
async function init() {
  await initThemeControls(terminal);
  try {
    const state = await loadConnections();
    const wanted = windowConnection(location.hash);
    bound = wanted ? state.connections.find(item => item.id === wanted) : state.connections.find(item => item.id === state.active);
    if (wanted && !bound) showNotice('The connection this window was opened for no longer exists. Open a session from the dashboard.');
    const stored = await chrome.storage.local.get('settings');
    if (stored.settings && typeof stored.settings === 'object') {
      const saved = stored.settings as Partial<Settings>;
      settings = { ...settings, ...saved, fontSize: migrateFontSize(saved), lineHeight: lineHeightOrDefault(saved.lineHeight), fontDefaultsV2: true, renderer: normalizeRenderer(saved.renderer) };
    }
  } catch { showNotice('Could not load saved settings.'); }
  showConnection();
  fontInput.value = String(settings.fontSize);
  lineHeightInput.value = String(settings.lineHeight);
  reconnectInput.checked = settings.autoReconnect;
  rendererInput.value = settings.renderer;
  terminal.options.fontSize = settings.fontSize;
  terminal.options.lineHeight = settings.lineHeight;
  renderer.apply(settings.renderer);
  setMode(settings.mode);
  resize();
  const requested = windowTarget(location.hash);
  if (requested) {
    setMode(requested.mode === 'watch' ? 'watch' : 'attach');
  }
  if (!bound) setSettingsOpen(true);
  else {
    await refreshSessions();
    if (requested) connect(requested);
  }
}
void init();
