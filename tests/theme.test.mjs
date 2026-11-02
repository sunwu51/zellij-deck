import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../extension/theme.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { terminalTheme, terminalColorOptions, THEME_PRESETS, PALETTE_KEYS, importPalette, validatePalette, normalizeAppearance, selectedPalette } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('terminal explicitly defines all sixteen ANSI palette colors', () => {
  for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    const bright = `bright${name[0].toUpperCase()}${name.slice(1)}`;
    assert.match(terminalTheme[name], /^#[0-9a-f]{6}$/i, `${name} must not fall back to xterm defaults`);
    assert.match(terminalTheme[bright], /^#[0-9a-f]{6}$/i, `${bright} must not fall back to xterm defaults`);
  }
  assert.notEqual(terminalTheme.brightRed, '#ff0000');
  assert.notEqual(terminalTheme.brightYellow, '#ffff00');
});
test('palette matches the WT Mocha Claude scheme including its pink bright-blue override', () => {
  assert.deepEqual(terminalTheme, {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
    brightBlue: '#ff79c6', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  });
});
test('all presets are complete and standard Mocha does not include the Claude override', () => {
  for (const preset of THEME_PRESETS) assert.deepEqual(validatePalette(preset.colors), preset.colors);
  assert.equal(selectedPalette({ preset: 'mocha' }).brightBlue, '#89b4fa');
  assert.equal(selectedPalette({ preset: 'dracula' }).background, '#282a36');
  assert.equal(selectedPalette({ preset: 'dracula' }).magenta, '#ff79c6');
});
test('imports Windows Terminal aliases without retaining unknown settings', () => {
  const { magenta, brightMagenta, cursor, ...rest } = terminalTheme;
  const custom = importPalette(JSON.stringify({ ...rest, purple: magenta.toUpperCase(), brightPurple: brightMagenta, cursorColor: cursor, name: 'My WT theme', commandline: 'ignored' }));
  assert.equal(custom.name, 'My WT theme');
  assert.deepEqual(custom.colors, terminalTheme);
  assert.equal(custom.colors.commandline, undefined);
});
test('documented Dracula import example matches the Dracula preset', async () => {
  const text = await readFile(new URL('../examples/dracula-windows-terminal.json', import.meta.url), 'utf8');
  assert.deepEqual(importPalette(text).colors, selectedPalette({ preset: 'dracula' }));
});
test('xterm import defaults optional cursor and selection fields', () => {
  const { cursor, selectionBackground, ...required } = terminalTheme;
  const imported = importPalette(JSON.stringify(required));
  assert.equal(imported.colors.cursor, terminalTheme.foreground);
  assert.equal(imported.colors.selectionBackground, terminalTheme.brightBlack);
});
test('rejects invalid, partial, oversized, and full-settings imports', () => {
  for (const text of ['null', '[]', '{', '{}', '{"schemes":[]}', ' '.repeat(32769)]) assert.throws(() => importPalette(text));
  for (const field of PALETTE_KEYS) {
    const value = { ...terminalTheme };
    delete value[field];
    assert.throws(() => importPalette(JSON.stringify(value)), new RegExp(field));
  }
  for (const value of ['red', '#fff', '#ff00ff00', 'url(https://example.com)', 42]) {
    assert.throws(() => importPalette(JSON.stringify({ ...terminalTheme, red: value })));
  }
});
test('saved appearance restores safely and retains custom colors when changing presets', () => {
  const custom = importPalette(JSON.stringify({ ...terminalTheme, name: 'Imported' }));
  const saved = normalizeAppearance(JSON.parse(JSON.stringify({ preset: 'custom', custom })));
  assert.deepEqual(selectedPalette(saved), terminalTheme);
  assert.equal(normalizeAppearance({ preset: 'dracula', custom }).custom.name, 'Imported');
  assert.equal(normalizeAppearance({ preset: 'custom', custom: { colors: {} } }).preset, 'mocha-claude');
  assert.equal(normalizeAppearance({ preset: 'missing' }).preset, 'mocha-claude');
  assert.equal(normalizeAppearance(null).preset, 'mocha-claude');
  const copy = selectedPalette({ preset: 'mocha' });
  copy.red = '#000000';
  assert.notEqual(selectedPalette({ preset: 'mocha' }).red, '#000000');
});
test('bold does not promote colors to the bright bank or force extra contrast', () => {
  assert.equal(terminalColorOptions.drawBoldTextInBrightColors, false);
  assert.equal(terminalColorOptions.minimumContrastRatio, 1);
  assert.equal(terminalColorOptions.theme, terminalTheme);
});
