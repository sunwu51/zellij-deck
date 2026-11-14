import type { Terminal, IUnicodeVersionProvider } from '@xterm/xterm';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';

/**
 * Use grapheme-aware widths for VS16, joined emoji, skin tones and flags.
 * On Windows the native Zellij/ConPTY output can lose VS16 from ♻️ while
 * the Git UI has already reserved two columns. Preserve that grid width for
 * U+267B on this transport only; do not widen every text-presentation symbol.
 * Shared by live terminals and dashboard snapshot replay.
 */
export function useModernWidths(terminal: Terminal, conpty = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)): void {
  const addon = new UnicodeGraphemesAddon();
  terminal.loadAddon({
    activate(target) {
      const unicode = target.unicode;
      // Adapt providers through the public addon API, not xterm private internals.
      addon.activate({ unicode: {
        register(provider: IUnicodeVersionProvider) {
          unicode.register({
            version: provider.version,
            wcwidth: codepoint => conpty && codepoint === 0x267b ? 2 : provider.wcwidth(codepoint),
            charProperties(codepoint, preceding) {
              const properties = provider.charProperties(codepoint, preceding);
              // xterm's property word: width occupies bits 1–2; retain join/state bits.
              return conpty && codepoint === 0x267b ? (properties & ~6) | 4 : properties;
            },
          });
        },
        get activeVersion() { return unicode.activeVersion; },
        set activeVersion(version: string) { unicode.activeVersion = version; },
      } } as Terminal);
    },
    dispose() { addon.dispose(); },
  });
  terminal.unicode.activeVersion = '15-graphemes';
}
