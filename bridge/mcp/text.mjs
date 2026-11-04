// Text helpers for MCP tool output: plain text, line paging, and screen wrapping.

export const MAX_LINE_CHARS = 2000;
export const MAX_RESULT_CHARS = 60_000;

/** Remove escape sequences and control characters, keeping tabs and newlines. */
export function stripAnsi(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[\s\S]?)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Split terminal output into lines, dropping trailing blank lines (unused screen rows). */
export function toLines(text) {
  const lines = stripAnsi(text).split('\n').map(line => line.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

function clip(line) {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[+${line.length - MAX_LINE_CHARS} chars]` : line;
}

export function intInRange(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Expected an integer between ${min} and ${max}.`);
  return value;
}

/**
 * Page through lines by absolute offset. `base` is the absolute number of the first
 * retained line (lines dropped from the head of a bounded buffer keep later offsets stable).
 */
export function pageLines(lines, { offset, limit, tail } = {}, base = 0) {
  const total = base + lines.length;
  const count = intInRange(limit, 1, 2000, 200);
  let start;
  if (tail !== undefined) start = Math.max(base, total - intInRange(tail, 1, 2000, 50));
  else start = Math.max(base, intInRange(offset, 0, Number.MAX_SAFE_INTEGER, base));
  const selected = [];
  let chars = 0;
  let end = start;
  const stop = tail !== undefined ? total : Math.min(total, start + count);
  for (let index = start; index < stop; index++) {
    const line = clip(lines[index - base]);
    if (chars + line.length + 1 > MAX_RESULT_CHARS && selected.length) break;
    selected.push(line);
    chars += line.length + 1;
    end = index + 1;
  }
  return {
    total_lines: total,
    start,
    end,
    next_offset: end < total ? end : null,
    ...(base > 0 ? { first_available_line: base } : {}),
    text: selected.join('\n'),
  };
}

/** Find lines matching a pattern from `from` onwards. */
export function findLines(lines, pattern, { from = 0, base = 0, max = 50 } = {}) {
  const matches = [];
  for (let index = Math.max(from, base); index < base + lines.length && matches.length < max; index++) {
    const line = lines[index - base];
    pattern.lastIndex = 0;
    if (pattern.test(line)) matches.push({ line: index, text: clip(line) });
  }
  return matches;
}

export function compilePattern(source, { literal = false, ignoreCase = false } = {}) {
  if (typeof source !== 'string' || !source || source.length > 500) throw new Error('pattern must be a non-empty string of at most 500 characters.');
  const body = literal ? source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : source;
  try { return new RegExp(body, ignoreCase ? 'i' : ''); }
  catch (error) { throw new Error(`Invalid regular expression: ${error.message}`); }
}

/** Terminal display width of a code point (0, 1, or 2 columns). */
export function charWidth(codePoint) {
  if (codePoint === 0x200b || (codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x200c && codePoint <= 0x200f)) return 0;
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) || (codePoint >= 0x20000 && codePoint <= 0x3fffd)) return 2;
  return 1;
}

/** Re-wrap logical lines (Zellij joins soft-wrapped rows) to the pane width. */
export function wrapLines(lines, cols) {
  const rows = [];
  for (const line of lines) {
    let row = '';
    let width = 0;
    for (const char of line) {
      const w = charWidth(char.codePointAt(0));
      if (width + w > cols) { rows.push(row); row = ''; width = 0; }
      row += char;
      width += w;
    }
    rows.push(row);
  }
  return rows;
}

const NAMED_KEYS = ['Enter', 'Esc', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Space'];
/** Zellij `send-keys` syntax: optional modifiers then one key, e.g. "Ctrl c", "Alt Shift b", "F5", "Enter". */
export function normalizeKey(key) {
  if (typeof key !== 'string') throw new Error('Each key must be a string.');
  const parts = key.trim().split(/\s+/);
  const base = parts.pop() || '';
  const modifiers = parts.map(part => {
    const match = ['Ctrl', 'Alt', 'Shift', 'Super'].find(name => name.toLowerCase() === part.toLowerCase());
    if (!match) throw new Error(`Unknown modifier "${part}" in key "${key}". Use Ctrl, Alt, Shift, or Super.`);
    return match;
  });
  if (new Set(modifiers).size !== modifiers.length) throw new Error(`Repeated modifier in key "${key}".`);
  let name = NAMED_KEYS.find(item => item.toLowerCase() === base.toLowerCase());
  if (!name && /^escape$/i.test(base)) name = 'Esc';
  if (!name && /^f([1-9]|1[0-2])$/i.test(base)) name = base.toUpperCase();
  if (!name && [...base].length === 1 && base.codePointAt(0) > 0x20) name = base;
  if (!name) throw new Error(`Unsupported key "${key}". Use a single character, F1–F12, or one of: ${NAMED_KEYS.join(', ')}.`);
  return [...modifiers, name].join(' ');
}

/**
 * xterm SGR mouse reports (ESC [ < button ; column ; row M|m), 1-based on the wire.
 * Only programs that enabled mouse tracking (vim, less, htop, most TUIs) understand them.
 */
export const MOUSE_ACTIONS = ['click', 'double_click', 'right_click', 'scroll_up', 'scroll_down'];
export function mouseSequences(action, col, row, count = 1) {
  if (!MOUSE_ACTIONS.includes(action)) throw new Error(`action must be one of: ${MOUSE_ACTIONS.join(', ')}.`);
  const x = col + 1;
  const y = row + 1;
  const press = button => `\x1b[<${button};${x};${y}M`;
  const release = button => `\x1b[<${button};${x};${y}m`;
  switch (action) {
    case 'click': return [press(0), release(0)];
    case 'double_click': return [press(0), release(0), press(0), release(0)];
    case 'right_click': return [press(2), release(2)];
    case 'scroll_up': return Array.from({ length: count }, () => press(64));
    default: return Array.from({ length: count }, () => press(65));
  }
}

export function normalizePaneId(pane) {
  if (typeof pane === 'number' && Number.isInteger(pane) && pane >= 0) return `terminal_${pane}`;
  if (typeof pane === 'string') {
    const match = /^(?:terminal_)?(\d{1,9})$/.exec(pane.trim());
    if (match) return `terminal_${Number(match[1])}`;
  }
  throw new Error('pane must be a terminal pane id such as "terminal_0" (plugin panes are not supported).');
}
