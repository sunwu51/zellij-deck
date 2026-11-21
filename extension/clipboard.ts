/**
 * OSC 52 ("set clipboard"): programs such as Zellij copy by printing
 * `ESC ] 52 ; <targets> ; <base64 text> ST`. xterm.js ignores it unless something handles
 * it, so the copy would silently go nowhere. Returns the text to copy, or null when the
 * sequence is a query (`?`), malformed, or empty.
 */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1).trim();
  if (!payload || payload === '?') return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes) || null;
  } catch {
    return null;
  }
}

/**
 * Put text on the clipboard. The async API needs the page to be focused and can be refused;
 * then fall back to the old execCommand path, which the extension's clipboardWrite permission
 * also covers. Rejects with the first error when neither works.
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* reported below */ }
    area.remove();
    if (!ok) throw error;
  }
}
