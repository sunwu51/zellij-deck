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

export function controlCharacter(key: string): string | null {
  if (!/^[a-z@\[\\\]\^_? ]$/i.test(key)) return null;
  if (key === ' ' || key === '@') return '\x00';
  if (key === '?') return '\x7f';
  const code = key.toUpperCase().charCodeAt(0);
  return code >= 65 && code <= 95 ? String.fromCharCode(code - 64) : null;
}
