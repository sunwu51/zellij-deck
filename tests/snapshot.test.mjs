import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import {
  snapshotRoute, snapshotArgs, sanitizeDump, snapshotLayout, snapshotFailure,
  MAX_SNAPSHOT_PANES, MAX_PANE_DUMP_CHARS,
} from '../bridge/protocol.mjs';

const bundle = await build({ entryPoints: [new URL('../extension/snapshot.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { previewTab, drawOrder, frameCells, ansiColor, rgbColor, relativeTime } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const themeBundle = await build({ entryPoints: [new URL('../extension/theme.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { terminalTheme } = await import(`data:text/javascript;base64,${Buffer.from(themeBundle.outputFiles[0].text).toString('base64')}`);

test('snapshot route accepts only valid session names', () => {
  assert.equal(snapshotRoute('/sessions/dev/snapshot'), 'dev');
  assert.equal(snapshotRoute('/sessions/my.session_1-x/snapshot'), 'my.session_1-x');
  assert.equal(snapshotRoute('/sessions'), null);
  assert.equal(snapshotRoute('/sessions/dev/snapshot/extra'), null);
  assert.equal(snapshotRoute('/sessions/dev/snapshot?x=1'), null);
  for (const bad of ['--help', '..%2Fetc', '%E0%A4%A', 'a%20b', '-s']) assert.equal(snapshotRoute(`/sessions/${bad}/snapshot`), false, bad);
});

test('snapshot queries pass the session as a separate validated argument', () => {
  assert.deepEqual(snapshotArgs('dev', ['list-tabs', '--json']), ['--session', 'dev', 'action', 'list-tabs', '--json']);
  assert.throws(() => snapshotArgs('--help', ['list-tabs']));
});

test('pane dumps keep text and SGR styling but drop every other control sequence', () => {
  const raw = '\x1b[38;2;1;2;3mred\x1b[m plain\r\n\x1b]52;c;ZXZpbA==\x07clip\x1b[2J\x1b[Hhome\x1bPdcs\x1b\\\x07bell\x9bcsi\x00\n\n';
  const { content, truncated } = sanitizeDump(raw);
  assert.equal(content, '\x1b[38;2;1;2;3mred\x1b[m plain\ncliphomebellcsi');
  assert.equal(truncated, false);
  assert.equal(sanitizeDump('a\tb').content, 'a\tb');
  assert.equal(sanitizeDump('dangling\x1b').content, 'dangling');
});

test('oversized pane dumps keep the bottom of the screen from a line boundary', () => {
  const line = 'x'.repeat(1023);
  const raw = Array.from({ length: 400 }, (_, i) => `${i}${line}`).join('\n');
  const { content, truncated } = sanitizeDump(raw);
  assert.equal(truncated, true);
  assert.ok(content.length <= MAX_PANE_DUMP_CHARS);
  assert.ok(content.endsWith(`399${line}`));
  assert.match(content, /^\d+x/);
});

const tab = (id, extra = {}) => ({ position: id, name: `Tab #${id + 1}`, active: false, tab_id: id, display_area_columns: 120, display_area_rows: 40, are_floating_panes_visible: false, is_fullscreen_active: false, has_bell_notification: false, ...extra });
const pane = (id, tabId, extra = {}) => ({ id, tab_id: tabId, is_plugin: false, is_focused: false, is_floating: false, is_fullscreen: false, is_suppressed: false, exited: false, title: `pane ${id}`, pane_x: 0, pane_y: 0, pane_columns: 60, pane_rows: 40, pane_content_x: 1, pane_content_y: 1, pane_content_columns: 58, pane_content_rows: 38, ...extra });

test('layout normalization keeps known fields, drops suppressed/invalid panes, and sorts tabs', () => {
  const layout = snapshotLayout(
    [tab(1, { position: 1, active: true, name: 'build\x1b[31m', has_bell_notification: true }), tab(0), { tab_id: 'x' }],
    [pane(0, 0), pane(1, 1, { is_plugin: true, plugin_url: 'status-bar', title: '' }), pane(2, 1, { is_suppressed: true }), pane(3, 7), pane(4, 1, { pane_x: -1 }), pane(5, 1, { secret: 'ignored' })],
  );
  assert.deepEqual(layout.tabs.map(t => [t.id, t.name, t.active, t.bell]), [[0, 'Tab #1', false, false], [1, 'build[31m', true, true]]);
  assert.deepEqual(layout.panes.map(p => p.id).sort(), ['plugin_1', 'terminal_0', 'terminal_5']);
  assert.equal(layout.panes.find(p => p.id === 'plugin_1').title, 'status-bar');
  assert.equal('secret' in layout.panes[0], false);
  assert.equal(layout.panesTruncated, false);
  assert.equal(layout.clients, 0, 'No focused clients means the session is detached');
  assert.throws(() => snapshotLayout({}, []));
});

test('attached clients are counted once across tabs', () => {
  const layout = snapshotLayout([tab(0, { other_focused_clients: [1, 3] }), tab(1, { other_focused_clients: [3, 'x', -1] })], []);
  assert.equal(layout.clients, 2);
});

test('pane cap keeps active-tab terminals first', () => {
  const panes = [
    ...Array.from({ length: MAX_SNAPSHOT_PANES }, (_, i) => pane(i, 0)),
    pane(900, 1, { is_plugin: true }), pane(901, 1),
  ];
  const layout = snapshotLayout([tab(0), tab(1, { active: true })], panes);
  assert.equal(layout.panes.length, MAX_SNAPSHOT_PANES);
  assert.equal(layout.panesTruncated, true);
  assert.ok(layout.panes.some(p => p.id === 'terminal_901'));
  assert.ok(layout.panes.some(p => p.id === 'plugin_900'));
});

test('snapshot failures distinguish missing sessions and old Zellij versions', () => {
  assert.equal(snapshotFailure({ stdout: "Session 'old' not found. The following sessions are active:" }).status, 404);
  assert.equal(snapshotFailure({ stderr: "error: unrecognized subcommand 'list-tabs'" }).status, 501);
  assert.equal(snapshotFailure(new Error('spawn failed')).status, 500);
});

const S = { session: 's', capturedAt: 0, tabs: [], panes: [] };
const geo = (id, extra = {}) => ({ id, tabId: 0, plugin: false, title: id, focused: false, floating: false, fullscreen: false, exited: false, x: 0, y: 0, cols: 10, rows: 5, contentX: 1, contentY: 1, contentCols: 8, contentRows: 3, ...extra });

test('preview follows the user-selected tab, else the session active tab', () => {
  const snapshot = { ...S, tabs: [{ id: 0, active: false }, { id: 3, active: true }] };
  assert.equal(previewTab(snapshot).id, 3);
  assert.equal(previewTab(snapshot, 0).id, 0);
  assert.equal(previewTab(snapshot, 99).id, 3, 'A closed tab falls back to the active tab');
  assert.equal(previewTab(S), undefined);
});

test('draw order paints tiled panes, then visible floating panes with focus on top', () => {
  const panes = [geo('float-focused', { floating: true, focused: true }), geo('tiled'), geo('float', { floating: true }), geo('other-tab', { tabId: 1 })];
  const hidden = drawOrder({ ...S, panes }, { id: 0, floatingVisible: false, fullscreen: false });
  assert.deepEqual(hidden.map(p => p.id), ['tiled']);
  const shown = drawOrder({ ...S, panes }, { id: 0, floatingVisible: true, fullscreen: false });
  assert.deepEqual(shown.map(p => p.id), ['tiled', 'float', 'float-focused']);
  const full = drawOrder({ ...S, panes: [geo('a'), geo('b', { fullscreen: true }), geo('bar', { plugin: true, y: 5, rows: 1 })] }, { id: 0, floatingVisible: false, fullscreen: true });
  assert.deepEqual(full.map(p => p.id), ['b', 'bar']);
});

test('frames follow the gap between pane and content rects, with a fitted title', () => {
  const cells = frameCells(geo('p', { title: 'build' }));
  const at = (x, y) => cells.filter(c => c.x === x && c.y === y).at(-1)?.ch;
  assert.equal(at(0, 0), '╭');
  assert.equal(at(9, 0), '╮');
  assert.equal(at(0, 4), '╰');
  assert.equal(at(9, 4), '╯');
  assert.equal(at(0, 2), '│');
  assert.equal(cells.filter(c => c.title).map(c => c.ch).join(''), ' bui… ');
  assert.deepEqual(frameCells(geo('bare', { contentX: 0, contentY: 0, contentCols: 10, contentRows: 5 })), []);
  // Zellij's top-only title bar (content one row lower, same width).
  const topOnly = frameCells(geo('t', { contentX: 0, contentY: 1, contentCols: 10, contentRows: 4, title: '' }));
  assert.ok(topOnly.every(c => c.y === 0 && c.ch === '─'));
});

test('xterm-256 colors resolve through the active theme', () => {
  assert.equal(ansiColor(1, terminalTheme), terminalTheme.red);
  assert.equal(ansiColor(12, terminalTheme), terminalTheme.brightBlue);
  assert.equal(ansiColor(16, terminalTheme), '#000000');
  assert.equal(ansiColor(196, terminalTheme), '#ff0000');
  assert.equal(ansiColor(231, terminalTheme), '#ffffff');
  assert.equal(ansiColor(232, terminalTheme), '#080808');
  assert.equal(ansiColor(255, terminalTheme), '#eeeeee');
  assert.equal(rgbColor(0x0a0b0c), '#0a0b0c');
});

test('capture age is human readable', () => {
  assert.equal(relativeTime(10_000, 12_000), 'just now');
  assert.equal(relativeTime(0, 42_000), '42s ago');
  assert.equal(relativeTime(0, 3 * 60_000), '3m ago');
  assert.equal(relativeTime(0, 2 * 3_600_000), '2h ago');
});
