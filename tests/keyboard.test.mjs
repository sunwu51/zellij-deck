import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/keyboard.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { keyAction, controlCharacter, shiftEnterSequence, applyKittyKeyboard } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const key = (value, options = {}) => ({ key: value, code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...options });

test('clipboard shortcuts bypass terminal control-character translation', () => {
  assert.equal(keyAction(key('v', { ctrlKey: true })), 'paste');
  assert.equal(keyAction(key('V', { ctrlKey: true, shiftKey: true })), 'paste');
  assert.equal(keyAction(key('v', { metaKey: true })), 'paste');
  assert.equal(keyAction(key('C', { ctrlKey: true, shiftKey: true })), 'copy');
  assert.equal(keyAction(key('c', { metaKey: true })), 'copy');
});
test('Ctrl+C stays a terminal interrupt, and Alt/AltGr/IME remain untouched', () => {
  assert.equal(keyAction(key('c', { ctrlKey: true })), 'default');
  assert.equal(keyAction(key('v', { altKey: true })), 'default');
  assert.equal(keyAction(key('v', { ctrlKey: true, altKey: true })), 'default');
  assert.equal(keyAction(key('v', { ctrlKey: true, isComposing: true })), 'default');
  assert.equal(keyAction(key('t', { ctrlKey: true })), 'default');
});
test('Ctrl+Period is the scoped send-control prefix', () => {
  assert.equal(keyAction(key('.', { ctrlKey: true, code: 'Period' })), 'prefix');
  assert.equal(keyAction(key('.', { ctrlKey: true })), 'prefix');
  assert.equal(keyAction(key('.', { ctrlKey: true, shiftKey: true })), 'default');
  assert.equal(keyAction(key('.')), 'default');
});
test('custom Ctrl punctuation maps to standard control bytes', () => {
  for (const [key, byte] of [[' ', 0], ['@', 0], ['[', 27], ['\\', 28], [']', 29], ['^', 30], ['_', 31], ['?', 127]]) {
    assert.equal(controlCharacter(key), String.fromCharCode(byte));
  }
  for (const key of ['ab', 'ß', '中', '0', '🎉']) assert.equal(controlCharacter(key), null);
});
test('Shift+Enter is sent as kitty CSI 13;2u only while the kitty keyboard protocol is on', () => {
  const shiftEnter = key('Enter', { shiftKey: true });
  assert.equal(shiftEnterSequence(shiftEnter, 1), '\x1b[13;2u');
  assert.equal(shiftEnterSequence(shiftEnter, 0), null, 'without the protocol Shift+Enter stays a CR');
  assert.equal(shiftEnterSequence(key('Enter'), 1), null, 'plain Enter is unchanged');
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
    assert.equal(shiftEnterSequence(key('Enter', { shiftKey: true, [modifier]: true }), 1), null);
  }
  assert.equal(shiftEnterSequence(key('a', { shiftKey: true }), 1), null);
});
test('kitty keyboard flags follow the push/pop/set stack', () => {
  let stack = applyKittyKeyboard([], '>', [1]);
  assert.deepEqual(stack, [1], 'Zellij pushes CSI > 1 u');
  stack = applyKittyKeyboard(stack, '>', [3]);
  assert.deepEqual(applyKittyKeyboard(stack, '<', []), [1], 'CSI < u pops one entry');
  assert.deepEqual(applyKittyKeyboard(stack, '<', [5]), [], 'popping too many empties the stack');
  assert.deepEqual(applyKittyKeyboard([1], '=', [4, 2]), [5], 'mode 2 sets bits');
  assert.deepEqual(applyKittyKeyboard([5], '=', [1, 3]), [4], 'mode 3 clears bits');
  assert.deepEqual(applyKittyKeyboard([5], '=', [0]), [0], 'mode 1 (default) replaces');
  assert.deepEqual(applyKittyKeyboard([], '>', []), [0]);
});
test('send-control letters map to exact ASCII control bytes', () => {
  assert.equal(controlCharacter('t'), '\x14');
  assert.equal(controlCharacter('w'), '\x17');
  assert.equal(controlCharacter('v'), '\x16');
  assert.equal(controlCharacter('C'), '\x03');
  for (let i = 0; i < 26; i++) assert.equal(controlCharacter(String.fromCharCode(97 + i)), String.fromCharCode(i + 1));
  for (const invalid of ['Enter', 'Escape', 'é', '', '1', '.']) assert.equal(controlCharacter(invalid), null);
});

// font.ts is a pure module: test it with the same esbuild-in-memory approach.
const fontSource = await readFile(new URL('../extension/font.ts', import.meta.url), 'utf8');
const fontModule = await import(`data:text/javascript;base64,${Buffer.from((await transform(fontSource, { loader: 'ts', format: 'esm' })).code).toString('base64')}`);
test('font defaults match Windows Terminal, and the old saved default is migrated once', () => {
  const { DEFAULT_FONT_SIZE, FONT_FAMILY, migrateFontSize, lineHeightOrDefault } = fontModule;
  assert.equal(DEFAULT_FONT_SIZE, 16, '12 pt = 16 px');
  assert.match(FONT_FAMILY, /^"wshell Symbols", "Cascadia Mono"/);
  assert.match(FONT_FAMILY, /"Microsoft YaHei UI".*monospace$/, 'Chinese fallbacks come before the generic family');
  assert.equal(migrateFontSize({ fontSize: 13 }), 16, 'the old default is moved');
  assert.equal(migrateFontSize({ fontSize: 13, fontDefaultsV2: true }), 13, 'a size chosen after the migration is kept');
  assert.equal(migrateFontSize({ fontSize: 18 }), 18);
  assert.equal(migrateFontSize({}), 16);
  assert.equal(lineHeightOrDefault(1.35), 1.35);
  for (const bad of [undefined, 0.5, 3, 'x', NaN]) assert.equal(lineHeightOrDefault(bad), 1.2);
});
