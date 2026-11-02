import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/keyboard.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { keyAction, controlCharacter } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
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
test('send-control letters map to exact ASCII control bytes', () => {
  assert.equal(controlCharacter('t'), '\x14');
  assert.equal(controlCharacter('w'), '\x17');
  assert.equal(controlCharacter('v'), '\x16');
  assert.equal(controlCharacter('C'), '\x03');
  for (let i = 0; i < 26; i++) assert.equal(controlCharacter(String.fromCharCode(97 + i)), String.fromCharCode(i + 1));
  for (const invalid of ['Enter', 'Escape', 'é', '', '1', '.']) assert.equal(controlCharacter(invalid), null);
});
