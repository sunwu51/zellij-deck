export type Key = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing'>;
export type KeyAction = 'paste' | 'copy' | 'prefix' | 'default';

export function keyAction(event: Key): KeyAction {
  if (event.isComposing || event.altKey) return 'default';
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'v') return 'paste';
  if ((event.ctrlKey && event.shiftKey && !event.metaKey && key === 'c') || (event.metaKey && !event.ctrlKey && key === 'c')) return 'copy';
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && (event.code === 'Period' || key === '.')) return 'prefix';
  return 'default';
}

/**
 * Kitty keyboard protocol flags requested by the program on the other side (Zellij pushes
 * CSI > 1 u at startup). The protocol keeps a stack: CSI > f u pushes, CSI < n u pops n,
 * CSI = f ; m u replaces (m=1), sets (m=2) or clears (m=3) bits of the top entry.
 * https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */
export function applyKittyKeyboard(stack: readonly number[], prefix: string, params: (number | number[])[]): number[] {
  const value = (index: number, fallback: number) => {
    const param = params[index];
    const number = Array.isArray(param) ? param[0] : param;
    return typeof number === 'number' && number >= 0 ? number : fallback;
  };
  const next = [...stack];
  if (prefix === '>') {
    next.push(value(0, 0));
    if (next.length > 16) next.shift();
  } else if (prefix === '<') {
    next.splice(Math.max(0, next.length - Math.max(1, value(0, 1))));
  } else if (prefix === '=') {
    const flags = value(0, 0);
    const top = next.length ? next.pop()! : 0;
    const mode = value(1, 1);
    next.push(mode === 2 ? top | flags : mode === 3 ? top & ~flags : flags);
  }
  return next;
}

/**
 * xterm.js does not implement the kitty keyboard protocol, so it sends a bare CR for Shift+Enter
 * and the modifier is lost. When the program has enabled the protocol (any flags; bit 1 is
 * "disambiguate"), encode Shift+Enter as kitty does: CSI 13 ; 2 u. That is what Windows Terminal,
 * kitty and Ghostty send, and what lets Claude Code inside Zellij insert a newline.
 */
export function shiftEnterSequence(event: Key, kittyFlags: number): string | null {
  if (!kittyFlags || event.key !== 'Enter' || !event.shiftKey) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return null;
  return '\x1b[13;2u';
}

export function controlCharacter(key: string): string | null {
  if (!/^[a-z@\[\\\]\^_? ]$/i.test(key)) return null;
  if (key === ' ' || key === '@') return '\x00';
  if (key === '?') return '\x7f';
  const code = key.toUpperCase().charCodeAt(0);
  return code >= 65 && code <= 95 ? String.fromCharCode(code - 64) : null;
}
