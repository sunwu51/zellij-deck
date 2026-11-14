import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const { outputFiles } = await build({
  entryPoints: ['extension/theme-controls.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node',
});
const { initThemeControls } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

// Small DOM doubles exercise event wiring and persistence, not browser rendering.
class Element {
  value = '';
  textContent = '';
  disabled = false;
  style = {};
  children = [];
  events = {};
  classList = { toggle() {} };
  replaceChildren(...children) { this.children = children; }
  add(child) { this.children.push(child); }
  addEventListener(type, handler) { this.events[type] = handler; }
  dispatch(type) { return this.events[type]?.(); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('theme controls preview, save live without credentials, reject bad imports, and restore on reload', async () => {
  const old = { document: globalThis.document, chrome: globalThis.chrome, Option: globalThis.Option };
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let saved = {};
  let failSave = false;
  let writes = [];
  globalThis.document = { getElementById: get, createElement: () => new Element() };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  globalThis.chrome = { storage: { local: {
    async get() { return structuredClone(saved); },
    async set(value) {
      if (failSave) throw new Error('Storage unavailable');
      writes.push(value);
      saved = structuredClone(value);
    },
  } } };
  try {
    const terminal = { options: {} };
    await initThemeControls(terminal);
    assert.equal(terminal.options.theme.brightBlue, '#ff79c6');
    assert.deepEqual(get('theme-preset').children.map(item => item.value), ['mocha', 'mocha-claude', 'dracula']);

    get('theme-preset').value = 'dracula';
    get('theme-preset').dispatch('change');
    assert.equal(get('theme-preview').style.backgroundColor, '#282a36');
    assert.equal(terminal.options.theme.background, '#1e1e2e', 'Selection is preview-only');
    get('theme-apply').dispatch('click');
    await flush();
    assert.equal(terminal.options.theme.background, '#282a36');
    assert.equal(get('terminal-region').style.backgroundColor, '#282a36');
    assert.deepEqual(Object.keys(writes[0]), ['appearance'], 'Must not save bridge credentials or detach');

    const beforeInvalid = writes.length;
    get('theme-json').value = '{}';
    get('theme-import').dispatch('click');
    await flush();
    assert.equal(writes.length, beforeInvalid);
    assert.equal(terminal.options.theme.background, '#282a36');
    assert.match(get('theme-feedback').textContent, /background/);

    const example = JSON.parse(await readFile(new URL('../examples/dracula-windows-terminal.json', import.meta.url), 'utf8'));
    get('theme-json').value = JSON.stringify({ ...example, name: 'My custom theme', blue: '#123456' });
    get('theme-import').dispatch('click');
    await flush();
    assert.equal(terminal.options.theme.blue, '#123456');
    assert.equal(saved.appearance.preset, 'custom');

    // Reinitialize against the saved storage with fresh controls and terminal.
    elements.clear();
    const reloaded = { options: {} };
    await initThemeControls(reloaded);
    assert.equal(get('theme-preset').value, 'custom');
    assert.equal(reloaded.options.theme.blue, '#123456');

    failSave = true;
    get('theme-preset').value = 'mocha';
    get('theme-preset').dispatch('change');
    get('theme-apply').dispatch('click');
    await flush();
    assert.equal(reloaded.options.theme.blue, '#123456', 'Failed save must leave active theme unchanged');
    assert.match(get('theme-feedback').textContent, /Could not save/);
    assert.equal(get('theme-apply').disabled, false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('theme controls can save from the dashboard without constructing a terminal', async () => {
  const old = { document: globalThis.document, chrome: globalThis.chrome, Option: globalThis.Option };
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let saved;
  globalThis.document = { getElementById: get, createElement: () => new Element() };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  globalThis.chrome = { storage: { local: { async get() { return {}; }, async set(value) { saved = value; } } } };
  try {
    await initThemeControls();
    get('theme-preset').value = 'dracula';
    get('theme-preset').dispatch('change');
    get('theme-apply').dispatch('click');
    await flush();
    assert.equal(saved.appearance.preset, 'dracula');
    assert.equal(elements.has('terminal-region'), false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
