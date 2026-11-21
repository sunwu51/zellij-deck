import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['extension/renderer.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { createRendererController, normalizeRenderer, rendererLabel } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

// A WebGL addon double: records disposal and lets tests fire GPU context loss.
function fakeAddon({ failActivate = false } = {}) {
  const addon = {
    disposed: 0, lossHandlers: [],
    activate() { if (failActivate) throw new Error('WebGL2 not supported'); },
    dispose() { this.disposed++; },
    onContextLoss(handler) { this.lossHandlers.push(handler); return { dispose() {} }; },
  };
  return addon;
}
function fakeTerminal() {
  return { loaded: [], loadAddon(addon) { this.loaded.push(addon); addon.activate(this); } };
}

test('missing and unknown preferences default to WebGL; only an explicit "dom" opts out', () => {
  assert.equal(normalizeRenderer(undefined), 'webgl');
  assert.equal(normalizeRenderer('canvas'), 'webgl');
  assert.equal(normalizeRenderer('dom'), 'dom');
  assert.equal(rendererLabel('dom-fallback'), 'DOM (WebGL unavailable)');
});

test('switching between WebGL and DOM loads and unloads one addon, without duplicates', () => {
  const terminal = fakeTerminal();
  const addons = [];
  const changes = [];
  const controller = createRendererController(terminal, () => { const a = fakeAddon(); addons.push(a); return a; }, (state, problem) => changes.push([state, problem]));
  assert.equal(controller.apply('webgl'), 'webgl');
  assert.equal(controller.apply('webgl'), 'webgl', 'Re-applying the same preference must not stack addons');
  assert.equal(addons.length, 1);
  assert.equal(controller.apply('dom'), 'dom');
  assert.equal(addons[0].disposed, 1, 'Unloading WebGL restores the DOM renderer');
  assert.equal(controller.apply('webgl'), 'webgl');
  assert.equal(addons.length, 2);
  assert.deepEqual(changes.map(c => c[0]), ['webgl', 'dom', 'webgl']);
  assert.ok(changes.every(([, problem]) => problem === undefined));
});

test('an unavailable WebGL context falls back to DOM, unregisters the addon and reports why', () => {
  const terminal = fakeTerminal();
  const addon = fakeAddon({ failActivate: true });
  const changes = [];
  const controller = createRendererController(terminal, () => addon, (state, problem) => changes.push([state, problem]));
  assert.equal(controller.apply('webgl'), 'dom-fallback');
  assert.equal(addon.disposed, 1);
  assert.match(changes[0][1], /WebGL2 not supported/);
  // Choosing DOM later is a normal state, not an error.
  assert.equal(controller.apply('dom'), 'dom');
  assert.equal(changes.at(-1)[1], undefined);
});

test('GPU context loss disposes WebGL once and keeps rendering with DOM', () => {
  const terminal = fakeTerminal();
  const addon = fakeAddon();
  const changes = [];
  const controller = createRendererController(terminal, () => addon, (state, problem) => changes.push([state, problem]));
  controller.apply('webgl');
  addon.lossHandlers[0]();
  addon.lossHandlers[0]();
  assert.equal(controller.state, 'dom-fallback');
  assert.equal(addon.disposed, 1);
  assert.match(changes.at(-1)[1], /context was lost/);
});

test('a stale context-loss event from a replaced addon does not disable the current one', () => {
  const terminal = fakeTerminal();
  const addons = [];
  const controller = createRendererController(terminal, () => { const a = fakeAddon(); addons.push(a); return a; });
  controller.apply('webgl');
  controller.apply('dom');
  controller.apply('webgl');
  addons[0].lossHandlers[0]();
  assert.equal(controller.state, 'webgl');
  assert.equal(addons[1].disposed, 0);
});
