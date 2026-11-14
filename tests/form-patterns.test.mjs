import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validSession } from '../bridge/protocol.mjs';

for (const page of ['dashboard', 'terminal']) {
  test(`${page} session-name pattern compiles with HTML's Unicode sets flag and matches bridge validation`, async () => {
    const html = await readFile(new URL(`../extension/${page}.html`, import.meta.url), 'utf8');
    const pattern = html.match(/\bpattern="([^"]+)"/)?.[1];
    assert.ok(pattern, 'Session name input must have a pattern');
    // Modern HTML pattern attributes use v, not the older u flag. A literal
    // hyphen in a character class must be escaped even in the final position.
    const regex = new RegExp(`^(?:${pattern})$`, 'v');
    const names = ['a', 'dev-1', 'build.logs_v2', 'A'.repeat(96), '', '-dev', '_dev', '.dev', '--help', 'a/b', 'a\\b', 'a b', 'a|b', 'a[b]', 'a\nb', '中文', 'a'.repeat(97)];
    for (const name of names) assert.equal(regex.test(name), validSession(name), JSON.stringify(name));
    for (let code = 0; code < 128; code++) {
      const name = `dev${String.fromCharCode(code)}`;
      assert.equal(regex.test(name), validSession(name), JSON.stringify(name));
    }
  });
}
