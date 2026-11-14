import type { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';

/**
 * xterm.js measures characters with Unicode 6 tables by default, where emoji such as ✨ are one
 * column wide. Zellij (and Windows Terminal, iTerm2, kitty) use current tables and give them two,
 * so every line containing one was drawn a column short: borders and separators after it shifted
 * left. Switch to Unicode 11 widths so the grid matches the one Zellij laid out.
 * The terminal must be created with `allowProposedApi: true` for `terminal.unicode`.
 */
export function useModernWidths(terminal: Terminal): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
}
