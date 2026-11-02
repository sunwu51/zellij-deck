import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fontUrl = new URL('../extension/fonts/nerd-fonts-v3.4.0/SymbolsNerdFontMono-Regular.ttf', import.meta.url);

function glyphId(font, point) {
  const tableCount = font.readUInt16BE(4);
  let cmap;
  for (let i = 0; i < tableCount; i++) {
    const entry = 12 + i * 16;
    if (font.toString('ascii', entry, entry + 4) === 'cmap') cmap = font.readUInt32BE(entry + 8);
  }
  assert.notEqual(cmap, undefined, 'Font must contain a Unicode character map');
  const count = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < count; i++) {
    const offset = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = font.readUInt16BE(offset);
    if (format === 12) {
      const groups = font.readUInt32BE(offset + 12);
      for (let j = 0; j < groups; j++) {
        const group = offset + 16 + j * 12;
        const start = font.readUInt32BE(group);
        const end = font.readUInt32BE(group + 4);
        if (point >= start && point <= end) return font.readUInt32BE(group + 8) + point - start;
      }
    }
    if (format === 4 && point <= 0xffff) {
      const segments = font.readUInt16BE(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let j = 0; j < segments; j++) {
        if (point < font.readUInt16BE(starts + j * 2) || point > font.readUInt16BE(ends + j * 2)) continue;
        const delta = font.readInt16BE(deltas + j * 2);
        const range = font.readUInt16BE(ranges + j * 2);
        if (!range) return (point + delta) & 0xffff;
        const glyph = font.readUInt16BE(ranges + j * 2 + range + 2 * (point - font.readUInt16BE(starts + j * 2)));
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
    }
  }
  return 0;
}

test('bundled font contains Zellij Powerline separator glyphs', async () => {
  const font = await readFile(fontUrl);
  assert.equal(font.readUInt32BE(0), 0x00010000, 'Asset must be a TrueType font, not a download error');
  for (const point of [0xe0b0, 0xe0b1, 0xe0b2, 0xe0b3]) {
    assert.notEqual(glyphId(font, point), 0, `Missing Powerline glyph U+${point.toString(16)}`);
  }
});

test('font is scoped to symbols, loaded before xterm, and included in build', async () => {
  const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../extension/sidepanel.ts', import.meta.url), 'utf8');
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(css, /unicode-range:U\+E000-F8FF/);
  assert.match(css, /SymbolsNerdFontMono-Regular\.ttf/);
  assert.ok(panel.indexOf('await document.fonts.load') < panel.indexOf('new Terminal('));
  assert.match(build, /cp\('extension\/fonts', 'dist\/fonts'/);
  const license = await readFile(new URL('../extension/fonts/nerd-fonts-v3.4.0/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Permission is hereby granted/);
});
