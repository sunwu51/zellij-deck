import { addConnection, bridgeJson, checkHealth, loadConnections, migrate, removeConnection, saveConnections, updateConnection, type Connection, type Health } from './connections';
import { normalizeAppearance, selectedPalette, type Palette } from './theme';
import { previewTab, relativeTime, type Snapshot } from './snapshot';
import { composeTab, drawGrid, type Grid } from './snapshot-render';
import { openSessionWindow, type WindowTarget } from './window-controls';
import { initThemeControls } from './theme-controls';
import { DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT, MIN_FONT_SIZE, MAX_FONT_SIZE, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT, migrateFontSize, lineHeightOrDefault } from './font';
import { normalizeRenderer, type RendererPreference } from './renderer';

type Settings = { fontSize: number; lineHeight: number; fontDefaultsV2: boolean; autoReconnect: boolean; mode: 'watch' | 'attach'; renderer: RendererPreference };
type Session = { name: string; exited: boolean; current: boolean };
type Card = {
  name: string; current: boolean;
  root: HTMLElement; canvas: HTMLCanvasElement; state: HTMLElement; tabs: HTMLElement; meta: HTMLElement; updated: HTMLElement; detached: HTMLElement;
  snapshot?: Snapshot; error?: string; selectedTab?: number;
  grid?: Grid; gridKey?: string; drawnWidth?: number;
};

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = element('grid');
const focusDialog = element<HTMLDialogElement>('focus');
const focusCanvas = element<HTMLCanvasElement>('focus-canvas');
const filterInput = element<HTMLInputElement>('filter');
const cards = new Map<string, Card>();
let settings: Settings = { fontSize: DEFAULT_FONT_SIZE, lineHeight: DEFAULT_LINE_HEIGHT, fontDefaultsV2: true, autoReconnect: true, mode: 'watch', renderer: 'webgl' };
let connections: Connection[] = [];
let activeId = '';
let editingId: string | undefined;
const health = new Map<string, Health | 'checking'>();
const connectionSelect = element<HTMLSelectElement>('connection');
const active = () => connections.find(item => item.id === activeId);
let palette: Palette = selectedPalette(normalizeAppearance(undefined));
let refreshing = false;
let refreshAgain = false;
let focused: string | undefined;
let deletionSupported = false;
let focusDrawn: { key?: string; width?: number } = {};

function notice(message = '') {
  element('notice').textContent = message;
  element('notice').hidden = !message;
}
function status(text: string, state = '') {
  element('status').textContent = text;
  element('status-dot').className = `status-dot ${state}`;
}
async function bridge<T>(path: string, method = 'GET', conn = active()): Promise<T> {
  if (!conn) throw new Error('No connection selected.');
  return bridgeJson<T>(conn, path, { method });
}
function openWindow(session: string, mode: WindowTarget['mode']) {
  const conn = active();
  if (!conn) { setSettingsOpen(true); notice('Add a connection in Settings first.'); return; }
  void openSessionWindow({ session, mode, connection: conn.id }).catch(error => notice(error instanceof Error ? error.message : 'Could not open the terminal window.'));
}
function button(label: string, onClick: () => void, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (className) node.className = className;
  node.addEventListener('click', onClick);
  return node;
}

function createCard(session: Session): Card {
  const root = document.createElement('article');
  root.className = 'card';
  const header = document.createElement('div');
  header.className = 'card-header';
  const dot = document.createElement('span');
  dot.className = 'status-dot connected';
  const title = document.createElement('h2');
  title.textContent = session.name;
  title.title = session.name;
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.textContent = 'CURRENT';
  pill.title = 'The session the bridge reports as current';
  pill.hidden = !session.current;
  const detached = document.createElement('span');
  detached.className = 'pill detached';
  detached.textContent = 'DETACHED';
  detached.title = 'No terminal client is attached. The session still runs in the background until it is killed or exits.';
  detached.hidden = true;
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  header.append(dot, title, pill, detached, meta);
  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'preview';
  preview.setAttribute('aria-label', `Enlarge preview of ${session.name}`);
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Terminal snapshot of ${session.name}`);
  const state = document.createElement('div');
  state.className = 'preview-state';
  state.textContent = 'Capturing…';
  preview.append(canvas, state);
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', `Tabs in ${session.name}`);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const updated = document.createElement('span');
  updated.className = 'updated';
  actions.append(
    button('Watch', () => openWindow(session.name, 'watch')),
    button('Interact', () => openWindow(session.name, 'attach')),
    button('Delete', () => requestDelete(session.name), 'danger'),
    updated,
  );
  root.append(header, preview, tabs, actions);
  const card: Card = { name: session.name, current: session.current, root, canvas, state, tabs, meta, updated, detached };
  preview.addEventListener('click', () => openFocus(card.name));
  return card;
}

function renderTabs(container: HTMLElement, card: Card) {
  const snapshot = card.snapshot;
  if (!snapshot) { container.replaceChildren(); return; }
  const shown = previewTab(snapshot, card.selectedTab);
  container.replaceChildren(...snapshot.tabs.map(tab => {
    const chip = button(tab.name, () => {
      card.selectedTab = tab.id;
      void renderCard(card);
      if (focused === card.name) void renderFocus();
    }, `tab${tab.active ? ' live' : ''}${tab.bell ? ' bell' : ''}`);
    chip.title = `${tab.name}${tab.active ? ' · active tab' : ''} · ${tab.cols}×${tab.rows}`;
    chip.setAttribute('aria-pressed', String(tab.id === shown?.id));
    return chip;
  }));
}

/** Compose (when content changed) and draw (when content or width changed). */
async function paint(card: Card, canvas: HTMLCanvasElement, width: number, drawn: { key?: string; width?: number }) {
  const snapshot = card.snapshot;
  const tab = snapshot && previewTab(snapshot, card.selectedTab);
  if (!snapshot || !tab) return false;
  const panes = snapshot.panes.filter(pane => pane.tabId === tab.id);
  const key = JSON.stringify([tab, panes, palette.background, palette.foreground, palette.green]);
  if (card.gridKey !== key || !card.grid) {
    card.grid = await composeTab(snapshot, tab, palette);
    card.gridKey = key;
  }
  // Letterbox in the terminal background rather than black.
  canvas.parentElement!.style.backgroundColor = palette.background;
  if (drawn.key === key && drawn.width === width) return true;
  drawGrid(canvas, card.grid, palette, width);
  drawn.key = key;
  drawn.width = width;
  return true;
}
const cardDrawn = new WeakMap<Card, { key?: string; width?: number }>();
async function renderCard(card: Card) {
  renderTabs(card.tabs, card);
  const snapshot = card.snapshot;
  const tab = snapshot && previewTab(snapshot, card.selectedTab);
  const terminals = snapshot?.panes.filter(pane => !pane.plugin && pane.tabId === tab?.id).length ?? 0;
  card.detached.hidden = snapshot?.clients !== 0;
  card.meta.textContent = snapshot ? `${snapshot.tabs.length} tab${snapshot.tabs.length === 1 ? '' : 's'} · ${terminals} pane${terminals === 1 ? '' : 's'}` : '';
  card.root.classList.toggle('stale', !!card.error && !!snapshot);
  card.state.hidden = !!snapshot && !card.error;
  card.state.classList.toggle('error', !!card.error);
  if (card.error) card.state.textContent = card.error;
  if (!snapshot) return;
  const drawn = cardDrawn.get(card) ?? {};
  cardDrawn.set(card, drawn);
  await paint(card, card.canvas, card.canvas.clientWidth || card.root.clientWidth, drawn);
  card.canvas.setAttribute('aria-label', `Terminal snapshot of ${card.name}, tab ${tab?.name ?? ''}`);
  updateTimes();
}
function updateTimes() {
  for (const card of cards.values()) {
    card.updated.textContent = card.snapshot ? `${card.error ? 'stale · ' : ''}${relativeTime(card.snapshot.capturedAt)}` : '';
  }
}

function openFocus(name: string) {
  focused = name;
  focusDrawn = {};
  element('focus-title').textContent = name;
  if (!focusDialog.open) focusDialog.showModal();
  void renderFocus();
}
async function renderFocus() {
  const card = focused ? cards.get(focused) : undefined;
  if (!card) { focusDialog.close(); return; }
  renderTabs(element('focus-tabs'), card);
  const snapshot = card.snapshot;
  const tab = snapshot && previewTab(snapshot, card.selectedTab);
  element('focus-meta').textContent = snapshot && tab
    ? `${tab.name} · ${tab.cols}×${tab.rows} · captured ${relativeTime(snapshot.capturedAt)}${card.error ? ` · refresh failed: ${card.error}` : ''}${snapshot.panesTruncated ? ' · some panes omitted' : ''}`
    : card.error || 'Capturing…';
  const width = element('focus-canvas').parentElement!.clientWidth;
  await paint(card, focusCanvas, width, focusDrawn);
}
focusDialog.addEventListener('close', () => { focused = undefined; });
element('focus-close').addEventListener('click', () => focusDialog.close());
focusDialog.addEventListener('click', event => { if (event.target === focusDialog) focusDialog.close(); });
focusDialog.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(action => {
  action.addEventListener('click', () => { if (focused) openWindow(focused, action.dataset.mode === 'watch' ? 'watch' : 'attach'); });
});

async function refreshCard(card: Card) {
  const conn = active();
  try {
    card.snapshot = await bridge<Snapshot>(`/sessions/${encodeURIComponent(card.name)}/snapshot`, 'GET', conn);
    card.error = undefined;
  } catch (error) {
    if (conn?.id !== activeId) return; // The dashboard moved to another connection meanwhile.
    card.error = error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Snapshot timed out.';
  }
  if (conn?.id !== activeId) return;
  await renderCard(card);
  if (focused === card.name) await renderFocus();
}
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
}
function applyFilter() {
  const query = filterInput.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cards.values()) {
    card.root.hidden = !!query && !card.name.toLowerCase().includes(query);
    if (!card.root.hidden) visible++;
  }
  const empty = element('empty');
  if (cards.size && !visible) {
    empty.hidden = false;
    empty.replaceChildren(Object.assign(document.createElement('strong'), { textContent: 'No sessions match this filter.' }));
  } else if (cards.size) empty.hidden = true;
}
function renderExited(sessions: Session[]) {
  const details = element('exited');
  details.hidden = !sessions.length;
  element('exited-summary').textContent = `Exited sessions (${sessions.length})`;
  element('exited-list').replaceChildren(...sessions.map(session => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = session.name;
    name.title = session.name;
    item.append(name, button('Resurrect', () => openWindow(session.name, 'attach')), button('Delete', () => requestDelete(session.name), 'danger'));
    return item;
  }));
}
function showEmpty(title: string, detail: string) {
  const empty = element('empty');
  const strong = document.createElement('strong');
  strong.textContent = title;
  empty.replaceChildren(strong, document.createTextNode(detail));
  empty.hidden = false;
}

async function refreshAll() {
  if (refreshing) { refreshAgain = true; return; }
  const conn = active();
  if (!conn) {
    setSettingsOpen(true);
    showEmpty('Pair the bridge first.', 'Add a connection in Settings above: the bridge address and the pairing token it printed.');
    status('Not paired');
    return;
  }
  refreshing = true;
  element<HTMLButtonElement>('refresh').disabled = true;
  status('Refreshing…', 'connecting');
  try {
    const info = await bridge<{ features?: string[] }>('/health', 'GET', conn);
    if (conn.id !== activeId) return;
    if (!info.features?.includes('snapshots')) {
      // The running bridge predates session previews: snapshot requests would only return "Not found."
      throw new Error('The running bridge is out of date and cannot capture previews. Stop it (Ctrl+C in its terminal) and restart it.');
    }
    deletionSupported = info.features.includes('session-delete');
    const { sessions } = await bridge<{ sessions: Session[] }>('/sessions', 'GET', conn);
    if (conn.id !== activeId) return;
    const picker = element<HTMLSelectElement>('session');
    const selected = picker.value || conn.lastSession || "";
    picker.replaceChildren(new Option(sessions.length ? 'Choose a session' : 'No sessions yet', ''), ...sessions.map(session => new Option(`${session.name}${session.exited ? ' · exited' : ''}`, session.name)));
    if (sessions.some(session => session.name === selected)) picker.value = selected;
    notice();
    const running = sessions.filter(session => !session.exited);
    for (const [name, card] of cards) {
      if (!running.some(session => session.name === name)) { card.root.remove(); cards.delete(name); }
    }
    running.forEach(session => {
      let card = cards.get(session.name);
      if (!card) { card = createCard(session); cards.set(session.name, card); }
      card.current = session.current;
      card.root.classList.toggle('current', session.current);
      card.root.querySelector<HTMLElement>('.pill')!.hidden = !session.current;
      grid.append(card.root); // Re-append keeps the bridge's ordering.
    });
    renderExited(sessions.filter(session => session.exited));
    if (!running.length) showEmpty('No running sessions.', 'Create a session using the controls above, or start one in Zellij. Exited sessions are listed below.');
    else element('empty').hidden = true;
    applyFilter();
    if (focused && !cards.has(focused)) focusDialog.close();
    // Capture visible cards first; hidden (filtered) cards still refresh afterwards.
    const ordered = [...cards.values()].sort((a, b) => Number(a.root.hidden) - Number(b.root.hidden));
    await pool(ordered, 3, refreshCard);
    if (conn.id !== activeId) return;
    const failed = [...cards.values()].filter(card => card.error).length;
    status(`${running.length} running · ${sessions.length - running.length} exited${failed ? ` · ${failed} failed` : ''}`, 'connected');
    element('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (conn.id !== activeId) return;
    status('Bridge unavailable');
    const message = error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Bridge request timed out.';
    const outdated = message.includes('out of date');
    notice(outdated ? message : `${message} Make sure the bridge is running and the token matches.`);
    if (outdated) { status('Bridge needs restart'); showEmpty('Restart the bridge to enable previews.', 'The bridge process was started before session previews were added.'); }
    for (const card of cards.values()) { card.error = outdated ? 'Restart the bridge to enable previews.' : 'Bridge unavailable'; void renderCard(card); }
  } finally {
    refreshing = false;
    element<HTMLButtonElement>('refresh').disabled = false;
    if (refreshAgain) { refreshAgain = false; void refreshAll(); }
  }
}

function setSettingsOpen(open: boolean) {
  const opening = open && element('settings').hidden;
  element('settings').hidden = !open;
  element('settings-toggle').setAttribute('aria-expanded', String(open));
  // One-time status check per connection; never a timer (queries can stall Zellij clients).
  if (opening) connections.forEach(conn => void testConnection(conn));
}
function fillSettings() {
  element<HTMLInputElement>('font-size').value = String(settings.fontSize);
  element<HTMLInputElement>('line-height').value = String(settings.lineHeight);
  element<HTMLInputElement>('auto-reconnect').checked = settings.autoReconnect;
  element<HTMLSelectElement>('renderer').value = normalizeRenderer(settings.renderer);
  element<HTMLSelectElement>('mode').value = settings.mode;
}
element('settings-toggle').addEventListener('click', () => setSettingsOpen(element('settings').hidden));
element('save-settings').addEventListener('click', async () => {
  const fontSize = Number(element<HTMLInputElement>('font-size').value);
  const lineHeight = Number(element<HTMLInputElement>('line-height').value);
  if (!Number.isInteger(fontSize) || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) return notice(`Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`);
  if (!(lineHeight >= MIN_LINE_HEIGHT && lineHeight <= MAX_LINE_HEIGHT)) return notice(`Line height must be between ${MIN_LINE_HEIGHT} and ${MAX_LINE_HEIGHT}.`);
  const next = { ...settings, fontSize, lineHeight, fontDefaultsV2: true, autoReconnect: element<HTMLInputElement>('auto-reconnect').checked, renderer: normalizeRenderer(element<HTMLSelectElement>('renderer').value) };
  try { await chrome.storage.local.set({ settings: next }); }
  catch { notice('Could not save settings. Please retry.'); return; }
  settings = next;
  setSettingsOpen(false);
  notice();
});

// ---- Connections ---------------------------------------------------------------------------
const HEALTH_LABEL: Record<string, string> = { online: 'Online', unauthorized: 'Token rejected', offline: 'Unreachable', checking: 'Checking…' };
const HEALTH_CLASS: Record<string, string> = { online: 'connected', unauthorized: 'connecting', offline: 'offline', checking: 'connecting' };
async function testConnection(conn: Connection) {
  health.set(conn.id, 'checking');
  renderConnections();
  health.set(conn.id, await checkHealth(conn));
  renderConnections();
}
function renderConnections() {
  connectionSelect.replaceChildren(...connections.map(conn => new Option(conn.name, conn.id)));
  connectionSelect.value = activeId;
  connectionSelect.hidden = !connections.length;
  element('connection-list').replaceChildren(...connections.map(conn => {
    const item = document.createElement('li');
    item.classList.toggle('active', conn.id === activeId);
    const state = health.get(conn.id);
    const dot = document.createElement('span');
    dot.className = `status-dot ${state ? HEALTH_CLASS[state] : ''}`;
    dot.title = state ? HEALTH_LABEL[state] : 'Not checked';
    const info = document.createElement('span');
    info.className = 'conn-info';
    info.append(document.createTextNode(conn.name), Object.assign(document.createElement('small'), { textContent: `${conn.host}:${conn.port}` }));
    item.append(dot, info);
    if (conn.id !== activeId) item.append(button('Use', () => { void selectConnection(conn.id); }));
    item.append(button('Test', () => { void testConnection(conn); }), button('Edit', () => fillConnectionForm(conn)), button('Delete', () => { void deleteConnection(conn); }, 'danger'));
    return item;
  }));
}
function fillConnectionForm(conn?: Connection) {
  editingId = conn?.id;
  element<HTMLInputElement>('conn-name').value = conn?.name ?? '';
  element<HTMLInputElement>('conn-host').value = conn?.host ?? '127.0.0.1';
  element<HTMLInputElement>('conn-port').value = String(conn?.port ?? 17329);
  element<HTMLInputElement>('conn-token').value = conn?.token ?? '';
  element('connection-form-title').textContent = conn ? `Edit ${conn.name}` : 'Add connection';
  element('conn-save').textContent = conn ? 'Save changes' : 'Add & use';
  element('conn-cancel').hidden = !conn;
  updateHostHint();
}
function updateHostHint() {
  const host = element<HTMLInputElement>('conn-host').value.trim();
  element('conn-hint').hidden = host === '127.0.0.1' || !host;
}
element('conn-host').addEventListener('input', updateHostHint);
element('conn-cancel').addEventListener('click', () => fillConnectionForm());
/** Forget everything shown for the previous connection before another one loads. */
function resetView() {
  for (const card of cards.values()) card.root.remove();
  cards.clear();
  focused = undefined;
  if (focusDialog.open) focusDialog.close();
  element<HTMLSelectElement>('session').replaceChildren(new Option('Choose a session', ''));
  renderExited([]);
  element('empty').hidden = true;
  deletionSupported = false;
  notice();
}
async function selectConnection(id: string) {
  if (id === activeId || !connections.some(item => item.id === id)) { connectionSelect.value = activeId; return; }
  activeId = id;
  try { await saveConnections(connections, activeId); }
  catch { notice('Could not save the selected connection.'); }
  resetView();
  renderConnections();
  await refreshAll();
}
connectionSelect.addEventListener('change', () => { void selectConnection(connectionSelect.value); });
element('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = {
    name: element<HTMLInputElement>('conn-name').value,
    host: element<HTMLInputElement>('conn-host').value,
    port: Number(element<HTMLInputElement>('conn-port').value),
    token: element<HTMLInputElement>('conn-token').value,
  };
  const editing = editingId;
  const before = active();
  let next: Connection[];
  try { next = editing ? updateConnection(connections, editing, input) : addConnection(connections, input); }
  catch (error) { return notice(error instanceof Error ? error.message : 'Invalid connection.'); }
  const nextActive = editing ? activeId : next[next.length - 1].id;
  try { await saveConnections(next, nextActive); }
  catch { return notice('Could not save the connection. Please retry.'); }
  connections = next;
  activeId = nextActive;
  const now = active()!;
  fillConnectionForm();
  renderConnections();
  void testConnection(editing ? connections.find(item => item.id === editing)! : now);
  const changed = before?.id !== now.id || before.host !== now.host || before.port !== now.port || before.token !== now.token;
  if (changed) { if (before?.id !== now.id) resetView(); notice(); await refreshAll(); }
});
async function deleteConnection(conn: Connection) {
  if (!confirm(`Delete connection "${conn.name}"? Terminal windows already open for it keep running until you close them.`)) return;
  const result = removeConnection(connections, activeId, conn.id);
  try { await saveConnections(result.connections, result.active); }
  catch { return notice('Could not delete the connection. Please retry.'); }
  const switched = result.active !== activeId;
  connections = result.connections;
  activeId = result.active;
  health.delete(conn.id);
  if (editingId === conn.id) fillConnectionForm();
  renderConnections();
  if (switched) { resetView(); await refreshAll(); }
}
element('connect').addEventListener('click', () => {
  const session = element<HTMLSelectElement>('session').value;
  if (!session) return notice('Choose a session, or create a new one.');
  openWindow(session, element<HTMLSelectElement>('mode').value === 'watch' ? 'watch' : 'attach');
});
element('create-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = element<HTMLInputElement>('new-name').value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) return notice('Use letters, numbers, dots, underscores, or hyphens for session names.');
  openWindow(name, 'create');
});

const deleteDialog = element<HTMLDialogElement>('delete-dialog');
let deleting: string | undefined;
let deleteBusy = false;
function requestDelete(name: string) {
  if (deleteBusy) return;
  if (!deletionSupported) { notice('Restart the bridge (Ctrl+C, then start it again) to enable killing and deleting sessions.'); return; }
  deleting = name;
  element('delete-description').textContent = `Kill and delete “${name}”?`;
  element('delete-error').hidden = true;
  deleteDialog.showModal();
}
element('focus-delete').addEventListener('click', () => { if (focused) requestDelete(focused); });
deleteDialog.addEventListener('cancel', event => { if (deleteBusy) event.preventDefault(); });
element('delete-confirm').addEventListener('click', async () => {
  if (!deleting || deleteBusy) return;
  const name = deleting;
  deleteBusy = true;
  element<HTMLButtonElement>('delete-confirm').disabled = true;
  element<HTMLButtonElement>('delete-cancel').disabled = true;
  try {
    await bridge(`/sessions/${encodeURIComponent(name)}`, 'DELETE');
    deleteDialog.close();
    deleting = undefined;
    // Queue a fresh listing if a snapshot refresh is already in progress.
    if (focused === name) focusDialog.close();
    cards.get(name)?.root.remove();
    cards.delete(name);
    await refreshAll();
  } catch (error) {
    element('delete-error').textContent = error instanceof Error ? error.message : 'Could not delete the session.';
    element('delete-error').hidden = false;
  } finally {
    deleteBusy = false;
    element<HTMLButtonElement>('delete-confirm').disabled = false;
    element<HTMLButtonElement>('delete-cancel').disabled = false;
  }
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const card of cards.values()) void renderCard(card);
    if (focused) void renderFocus();
  }, 150);
}).observe(grid);
element('refresh').addEventListener('click', () => { void refreshAll(); });
filterInput.addEventListener('input', applyFilter);
setInterval(updateTimes, 5000);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.appearance) {
    palette = selectedPalette(normalizeAppearance(changes.appearance.newValue));
    for (const card of cards.values()) void renderCard(card);
    if (focused) void renderFocus();
  }
  if (changes.settings?.newValue) {
    // Terminal windows rewrite preferences too; those never touch the connection, so no refresh.
    settings = { ...settings, ...(changes.settings.newValue as Partial<Settings>) };
    fillSettings();
  }
  if (changes.connections || changes.activeConnection) {
    const state = migrate({
      connections: changes.connections ? changes.connections.newValue : connections,
      activeConnection: changes.activeConnection ? changes.activeConnection.newValue : activeId,
    });
    const before = active();
    connections = state.connections;
    activeId = state.active;
    const now = active();
    renderConnections();
    const changed = before?.id !== now?.id || (!!now && !!before && (before.host !== now.host || before.port !== now.port || before.token !== now.token));
    // Edits made here already refreshed; this covers changes made from another page.
    if (changed) { if (before?.id !== now?.id) resetView(); void refreshAll(); }
  }
});

async function init() {
  await initThemeControls();
  try {
    const state = await loadConnections();
    connections = state.connections;
    activeId = state.active;
    const stored = await chrome.storage.local.get(['settings', 'appearance']);
    const saved = stored.settings as Partial<Settings> | undefined;
    if (saved && typeof saved === 'object') settings = { ...settings, ...saved, fontSize: migrateFontSize(saved), lineHeight: lineHeightOrDefault(saved.lineHeight), fontDefaultsV2: true };
    palette = selectedPalette(normalizeAppearance(stored.appearance));
  } catch { notice('Could not load saved bridge settings.'); }
  fillSettings();
  renderConnections();
  fillConnectionForm();
  // Powerline glyphs live in the bundled symbol font; load it before the first canvas draw.
  try { await document.fonts.load('13px "wshell Symbols"', ''); } catch {}
  await refreshAll();
}
void init();
