import { normalizeAppearance, selectedPalette, type Palette } from './theme';
import { previewTab, relativeTime, type Snapshot } from './snapshot';
import { composeTab, drawGrid, type Grid } from './snapshot-render';
import { popoutUrl } from './window-controls';

type Settings = { port: number; token: string };
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
const intervalSelect = element<HTMLSelectElement>('interval');
const filterInput = element<HTMLInputElement>('filter');
const cards = new Map<string, Card>();
let settings: Settings = { port: 17329, token: '' };
let palette: Palette = selectedPalette(normalizeAppearance(undefined));
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let focused: string | undefined;
let focusDrawn: { key?: string; width?: number } = {};

function notice(message = '') {
  element('notice').textContent = message;
  element('notice').hidden = !message;
}
function status(text: string, state = '') {
  element('status').textContent = text;
  element('status-dot').className = `status-dot ${state}`;
}
async function bridge<T>(path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${settings.port}${path}`, {
    headers: { Authorization: `Bearer ${settings.token}`, 'X-Side-Shell-Extension': chrome.runtime.id },
    signal: AbortSignal.timeout(10000),
  });
  let body: { error?: string } & T;
  try { body = await response.json(); } catch { throw new Error(`Bridge returned ${response.status}.`); }
  if (!response.ok) throw new Error(body.error || `Bridge returned ${response.status}.`);
  return body;
}
function openWindow(session: string, mode: 'watch' | 'attach') {
  void chrome.windows.create({
    url: popoutUrl(chrome.runtime.getURL('sidepanel.html'), { session, mode }),
    type: 'popup', width: 1100, height: 760, focused: true,
  }).catch(error => notice(error instanceof Error ? error.message : 'Could not open the terminal window.'));
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
  try {
    card.snapshot = await bridge<Snapshot>(`/sessions/${encodeURIComponent(card.name)}/snapshot`);
    card.error = undefined;
  } catch (error) {
    card.error = error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Snapshot timed out.';
  }
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
    item.append(name, button('Resurrect', () => openWindow(session.name, 'attach')));
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
  clearTimeout(timer);
  if (refreshing) return;
  if (!settings.token) {
    showEmpty('Pair the bridge first.', 'Open the Side Shell side panel, paste the bridge token in Settings, then reload this page.');
    status('Not paired');
    return;
  }
  refreshing = true;
  element<HTMLButtonElement>('refresh').disabled = true;
  status('Refreshing…', 'connecting');
  try {
    const health = await bridge<{ features?: string[] }>('/health');
    if (!health.features?.includes('snapshots')) {
      // The running bridge predates session previews: snapshot requests would only return "Not found."
      throw new Error('The running bridge is out of date and cannot capture previews. Stop it (Ctrl+C in its terminal) and run npm run bridge again.');
    }
    const { sessions } = await bridge<{ sessions: Session[] }>('/sessions');
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
    if (!running.length) showEmpty('No running sessions.', 'Start a session in Zellij or create one from the side panel. Exited sessions are listed below.');
    else element('empty').hidden = true;
    applyFilter();
    if (focused && !cards.has(focused)) focusDialog.close();
    // Capture visible cards first; hidden (filtered) cards still refresh afterwards.
    const ordered = [...cards.values()].sort((a, b) => Number(a.root.hidden) - Number(b.root.hidden));
    await pool(ordered, 3, refreshCard);
    const failed = [...cards.values()].filter(card => card.error).length;
    status(`${running.length} running · ${sessions.length - running.length} exited${failed ? ` · ${failed} failed` : ''}`, 'connected');
    element('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    status('Bridge unavailable');
    const message = error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Bridge request timed out.';
    const outdated = message.includes('out of date');
    notice(outdated ? message : `${message} Make sure npm run bridge is running and the token matches.`);
    if (outdated) { status('Bridge needs restart'); showEmpty('Restart the bridge to enable previews.', 'The bridge process was started before session previews were added.'); }
    for (const card of cards.values()) { card.error = outdated ? 'Restart the bridge to enable previews.' : 'Bridge unavailable'; void renderCard(card); }
  } finally {
    refreshing = false;
    element<HTMLButtonElement>('refresh').disabled = false;
    schedule();
  }
}
function schedule() {
  clearTimeout(timer);
  const interval = Number(intervalSelect.value);
  // Do not spawn Zellij queries for a page nobody is looking at.
  if (interval > 0 && !document.hidden) timer = setTimeout(() => { void refreshAll(); }, interval);
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const card of cards.values()) void renderCard(card);
    if (focused) void renderFocus();
  }, 150);
}).observe(grid);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else void refreshAll(); });
element('refresh').addEventListener('click', () => { void refreshAll(); });
filterInput.addEventListener('input', applyFilter);
intervalSelect.addEventListener('change', () => {
  try { localStorage.setItem('side-shell-dashboard-interval', intervalSelect.value); } catch {}
  schedule();
});
setInterval(updateTimes, 5000);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.appearance) {
    palette = selectedPalette(normalizeAppearance(changes.appearance.newValue));
    for (const card of cards.values()) void renderCard(card);
    if (focused) void renderFocus();
  }
  if (changes.settings?.newValue) {
    const next = changes.settings.newValue as Partial<Settings>;
    settings = { port: next.port ?? settings.port, token: next.token ?? settings.token };
    void refreshAll();
  }
});

async function init() {
  try {
    const saved = localStorage.getItem('side-shell-dashboard-interval');
    if (saved && Array.from(intervalSelect.options).some(option => option.value === saved)) intervalSelect.value = saved;
  } catch {}
  try {
    const stored = await chrome.storage.local.get(['settings', 'appearance']);
    const saved = stored.settings as Partial<Settings> | undefined;
    if (saved && typeof saved === 'object') settings = { port: saved.port ?? settings.port, token: saved.token ?? '' };
    palette = selectedPalette(normalizeAppearance(stored.appearance));
  } catch { notice('Could not load saved bridge settings.'); }
  // Powerline glyphs live in the bundled symbol font; load it before the first canvas draw.
  try { await document.fonts.load('13px "Side Shell Symbols"', ''); } catch {}
  await refreshAll();
}
void init();
