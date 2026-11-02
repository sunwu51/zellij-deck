import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../extension/window-controls.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { popoutUrl, windowTarget, initWindowControls } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const base = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html';

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
