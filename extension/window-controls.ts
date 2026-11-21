/** `shell` is a plain PowerShell and `bare` an empty-config Zellij; both exist to diagnose lag. */
export type WindowTarget = { session: string; mode: 'watch' | 'attach' | 'create' | 'shell' | 'bare' };
const baseMode = (mode: WindowTarget['mode']) => (mode === 'watch' || mode === 'shell' || mode === 'bare' ? mode : 'attach');
const WINDOW_SIZE = { width: 1100, height: 760 };
/**
 * A window attaches to an existing session and never creates one implicitly. Only an explicit
 * "Create" (`create: true`) adds the one-time `new=1` flag; the window drops it once connected
 * (see `attachedUrl`), so reloading it never re-creates or resurrects a session.
 */
export function popoutUrl(base: string, target?: WindowTarget, options: { create?: boolean } = {}): string {
  const url = new URL(base);
  const params = new URLSearchParams({ view: 'window' });
  if (target) {
    params.set('session', target.session);
    params.set('mode', baseMode(target.mode));
    if (options.create && target.mode === 'create') params.set('new', '1');
  }
  url.hash = params.toString();
  return url.href;
}
export function windowTarget(hash: string): WindowTarget | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const session = params.get('session') || '';
  const mode = params.get('mode');
  if (params.get('view') !== 'window' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(session) || (mode !== 'watch' && mode !== 'attach' && mode !== 'shell' && mode !== 'bare')) return;
  if (mode === 'attach' && params.get('new') === '1') return { session, mode: 'create' };
  return { session, mode };
}
/** The window's URL once its session is connected: same session and mode, never `new=1`. */
export function attachedUrl(href: string, target: WindowTarget): string {
  return popoutUrl(href.split('#')[0], { session: target.session, mode: baseMode(target.mode) });
}
/** Open a session in its own terminal window (launched from the dashboard). */
export async function openSessionWindow(target: WindowTarget): Promise<void> {
  await chrome.windows.create({
    url: popoutUrl(chrome.runtime.getURL('terminal.html'), target, { create: true }),
    type: 'popup', ...WINDOW_SIZE, focused: true,
  });
}

export function initWindowControls(getTarget: () => WindowTarget | undefined, notify: (message: string) => void, resize: () => void) {
  const fullscreen = document.getElementById('fullscreen') as HTMLButtonElement;
  const popout = document.getElementById('popout') as HTMLButtonElement;
  const inWindow = new URLSearchParams(location.hash.slice(1)).get('view') === 'window';
  let previousState: 'normal' | 'maximized' = 'normal';
  let busy = false;
  async function openWindow(full = false) {
    const created = await chrome.windows.create({
      url: popoutUrl(chrome.runtime.getURL('terminal.html'), getTarget()),
      type: 'popup', ...WINDOW_SIZE, focused: true,
    });
    if (full && created?.id !== undefined) await chrome.windows.update(created.id, { state: 'fullscreen' });
  }
  async function updateLabel() {
    let active = !!document.fullscreenElement;
    if (inWindow) {
      try { active = (await chrome.windows.getCurrent()).state === 'fullscreen'; } catch {}
    }
    fullscreen.textContent = active ? '⤡' : '⛶';
    fullscreen.title = active ? 'Exit fullscreen' : 'Fullscreen';
    fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreen.setAttribute('aria-pressed', String(active));
    requestAnimationFrame(resize);
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    fullscreen.disabled = popout.disabled = true;
    try { await action(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not change terminal window.'); }
    finally { busy = false; fullscreen.disabled = popout.disabled = false; await updateLabel(); }
  }
  popout.addEventListener('click', () => { void perform(() => openWindow()); });
  fullscreen.addEventListener('click', () => {
    void perform(async () => {
      if (inWindow) {
        const current = await chrome.windows.getCurrent();
        if (current.id === undefined) throw new Error('Could not locate the terminal window.');
        if (current.state === 'fullscreen') await chrome.windows.update(current.id, { state: previousState });
        else {
          previousState = current.state === 'maximized' ? 'maximized' : 'normal';
          await chrome.windows.update(current.id, { state: 'fullscreen' });
        }
      } else if (document.fullscreenElement) await document.exitFullscreen();
      else {
        try {
          if (!document.fullscreenEnabled) throw new Error('Fullscreen unavailable');
          await document.documentElement.requestFullscreen();
        } catch { await openWindow(true); }
      }
    });
  });
  document.addEventListener('fullscreenchange', () => { void updateLabel(); });
  window.addEventListener('resize', () => { void updateLabel(); });
  void updateLabel();
}

/** Focus the existing session-previews tab, or open one. */
export async function openDashboard() {
  const url = chrome.runtime.getURL('dashboard.html');
  const [existing] = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB], documentUrls: [url] });
  if (existing?.tabId !== undefined && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
