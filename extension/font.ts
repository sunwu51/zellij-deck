/**
 * Terminal font defaults, chosen to look like Windows Terminal out of the box: its default is
 * Cascadia Mono at 12 pt (16 CSS px) with a line box about 1.2 times the font size.
 */
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_LINE_HEIGHT = 1.2;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const MIN_LINE_HEIGHT = 1;
export const MAX_LINE_HEIGHT = 1.6;

/** The bundled symbols font goes first for Powerline/Nerd Font glyphs (private-use ranges only).
 * Fallbacks cover Latin text (Cascadia, Consolas, Menlo/SF Mono) and Chinese, so CJK text does not
 * fall to whatever the browser picks for the generic `monospace`. */
export const FONT_FAMILY = [
  '"Side Shell Symbols"', '"Cascadia Mono"', '"Cascadia Code"', 'Consolas', 'Menlo', '"SF Mono"',
  '"Microsoft YaHei UI"', '"Microsoft YaHei"', '"PingFang SC"', '"Noto Sans Mono CJK SC"', 'monospace',
].join(', ');

/** Settings saved before these defaults existed hold the old default size (13); move them once. */
export function migrateFontSize(saved: { fontSize?: unknown; fontDefaultsV2?: unknown }): number {
  const size = Number(saved.fontSize);
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return saved.fontDefaultsV2 !== true && size === 13 ? DEFAULT_FONT_SIZE : size;
}

export function lineHeightOrDefault(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= MIN_LINE_HEIGHT && number <= MAX_LINE_HEIGHT ? number : DEFAULT_LINE_HEIGHT;
}
