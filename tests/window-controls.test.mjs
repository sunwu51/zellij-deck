import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../extension/window-controls.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { popoutUrl, windowTarget, initWindowControls, openDashboard } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const base = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/terminal.html';

test('popout transfers only session/mode and never implicitly creates sessions', () => {
  const url = popoutUrl(base, { session: 'dev', mode: 'create', token: 'must-not-leak' });
  assert.deepEqual(windowTarget(new URL(url).hash), { session: 'dev', mode: 'attach' });
  assert.equal(url.includes('must-not-leak'), false);
  assert.deepEqual(windowTarget(new URL(popoutUrl(base, { session: 'dev', mode: 'watch' })).hash), { session: 'dev', mode: 'watch' });
  assert.equal(windowTarget(new URL(popoutUrl(base)).hash), undefined);
  for (const hash of ['#view=window&session=--help&mode=attach', '#view=window&session=dev&mode=create', '#session=dev&mode=attach']) assert.equal(windowTarget(hash), undefined);
});

test('fullscreen falls back to a dedicated window; popouts retain current session', async () => {
  const keys = ['document', 'window', 'location', 'chrome', 'requestAnimationFrame'];
  const old = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, events: {}, setAttribute() {}, addEventListener(type, handler) { this.events[type] = handler; } });
    return elements.get(id);
  };
  const created = [];
  const updated = [];
  const notices = [];
  let state = 'normal';
  const flush = () => new Promise(resolve => setImmediate(resolve));
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = { getElementById: get, fullscreenEnabled: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.location = { hash: '' };
  globalThis.chrome = {
    runtime: { getURL: () => base },
    windows: {
      async create(options) { created.push(options); return { id: 42 }; },
      async update(id, options) { updated.push({ id, ...options }); state = options.state; },
      async getCurrent() { return { id: 42, state }; },
    },
  };
  try {
    initWindowControls(() => ({ session: 'dev', mode: 'watch' }), text => notices.push(text), () => {});
    get('fullscreen').events.click();
    await flush();
    assert.equal(created[0].type, 'popup');
    assert.deepEqual(windowTarget(new URL(created[0].url).hash), { session: 'dev', mode: 'watch' });
    assert.deepEqual(updated[0], { id: 42, state: 'fullscreen' });
    get('popout').events.click();
    await flush();
    assert.equal(created.length, 2);
    assert.equal(updated.length, 1, 'Ordinary popout should not force fullscreen');
    assert.deepEqual(notices, []);

    elements.clear();
    globalThis.location.hash = '#view=window';
    state = 'maximized';
    initWindowControls(() => undefined, text => notices.push(text), () => {});
    get('fullscreen').events.click();
    await flush();
    assert.equal(state, 'fullscreen');
    get('fullscreen').events.click();
    await flush();
    assert.equal(state, 'maximized', 'Exit must restore the previous window state');
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete globalThis[key];
      else globalThis[key] = old[key];
    }
  }
});

test('session launcher opens Watch, Interact and Create in dedicated popup windows', async () => {
  const { openSessionWindow } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const oldChrome = globalThis.chrome;
  const windows = [];
  globalThis.chrome = {
    runtime: { getURL: () => base },
    windows: { async create(options) { windows.push(options); return { id: windows.length }; } },
  };
  try {
    for (const mode of ['watch', 'attach', 'create']) {
      await openSessionWindow({ session: 'dev', mode });
      const options = windows.at(-1);
      assert.equal(options.type, 'popup');
      assert.equal(options.focused, true);
      assert.equal(options.width, 1100);
      assert.equal(options.height, 760);
      assert.deepEqual(windowTarget(new URL(options.url).hash), { session: 'dev', mode });
    }
    assert.equal(windows.length, 3);
  } finally {
    if (oldChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = oldChrome;
  }
});

test('an explicit Create opens a window that creates once, then only attaches', async () => {
  const { attachedUrl } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const created = popoutUrl(base, { session: 'dev', mode: 'create' }, { create: true });
  assert.deepEqual(windowTarget(new URL(created).hash), { session: 'dev', mode: 'create' }, 'explicit Create asks the window to create');
  assert.deepEqual(windowTarget(new URL(popoutUrl(base, { session: 'dev', mode: 'create' })).hash), { session: 'dev', mode: 'attach' }, 'without the option it never creates');
  assert.deepEqual(windowTarget(new URL(popoutUrl(base, { session: 'dev', mode: 'watch' }, { create: true })).hash), { session: 'dev', mode: 'watch' }, 'only Create sets the flag');
  const afterConnect = attachedUrl(created, { session: 'dev', mode: 'create' });
  assert.deepEqual(windowTarget(new URL(afterConnect).hash), { session: 'dev', mode: 'attach' }, 'once connected, a reload only attaches');
  assert.equal(new URL(afterConnect).pathname, new URL(base).pathname);
  assert.equal(windowTarget('#view=window&session=dev&mode=watch&new=1')?.mode, 'watch', 'new=1 never turns Watch into Create');
});

test('toolbar dashboard entry focuses an existing tab or creates one without side-panel permission', async () => {
  const oldChrome = globalThis.chrome;
  const events = [];
  let contexts = [];
  const url = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/dashboard.html';
  globalThis.chrome = {
    runtime: { getURL: () => url, ContextType: { TAB: 'TAB' }, async getContexts() { return contexts; } },
    tabs: { async create(options) { events.push(['create', options]); }, async update(id, options) { events.push(['tab', id, options]); } },
    windows: { async update(id, options) { events.push(['window', id, options]); } },
  };
  try {
    await openDashboard();
    assert.deepEqual(events, [['create', { url }]]);
    events.length = 0;
    contexts = [{ tabId: 12, windowId: 7 }];
    await openDashboard();
    assert.deepEqual(events, [['tab', 12, { active: true }], ['window', 7, { focused: true }]]);
    const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.name, 'Zellij Deck');
    assert.equal(manifest.side_panel, undefined);
    assert.equal(manifest.permissions.includes('sidePanel'), false);
  } finally {
    if (oldChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = oldChrome;
  }
});
