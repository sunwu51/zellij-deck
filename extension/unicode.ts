import type { Terminal } from '@xterm/xterm';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';

/**
 * Follow the stream's Unicode 15 grapheme widths for VS16, joined emoji,
 * skin tones and flags. Shared by live terminals and snapshot replay.
 *
 * Do not force bare U+267B to two columns on Windows: ConPTY can send
 * consecutive screen rows as one printable run and rely on automatic wrapping.
 * Widening a source cell shifts every subsequent wrap and absolute cursor update.
 * If upstream strips VS16, its one-column text symbol must stay one column here.
 */
export function useModernWidths(terminal: Terminal): void {
  terminal.loadAddon(new UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15-graphemes';
}
