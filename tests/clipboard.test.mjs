import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/clipboard.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { osc52Text } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

test('OSC 52 decodes the base64 text for any target selection', () => {
  assert.equal(osc52Text(`c;${b64('hello')}`), 'hello');
  assert.equal(osc52Text(`;${b64('no target')}`), 'no target');
  assert.equal(osc52Text(`p;${b64('multi\nline')}`), 'multi\nline');
});
test('OSC 52 keeps UTF-8 text intact', () => {
  assert.equal(osc52Text(`c;${b64('∂ 中文 🚀')}`), '∂ 中文 🚀');
});
test('OSC 52 queries, empty and malformed payloads are ignored', () => {
  assert.equal(osc52Text('c;?'), null);
  assert.equal(osc52Text('c;'), null);
  assert.equal(osc52Text('nothing'), null);
  assert.equal(osc52Text('c;!!!not base64!!!'), null);
});
