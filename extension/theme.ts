import type { ITerminalOptions, ITheme } from '@xterm/xterm';

export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
export const PALETTE_KEYS = ['background', 'foreground', ...ANSI_KEYS] as const;
export type Palette = Required<Pick<ITheme, typeof PALETTE_KEYS[number] | 'cursor' | 'selectionBackground'>>;
export type CustomPalette = { name: string; colors: Palette };
export type Appearance = { preset: string; custom?: CustomPalette };
export const DEFAULT_PRESET = 'mocha-claude';
export const MAX_PALETTE_LENGTH = 32 * 1024;

const mocha: Palette = {
  background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
  brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};
export const THEME_PRESETS = [
  { id: 'mocha', name: 'Catppuccin Mocha', colors: mocha },
  { id: 'mocha-claude', name: 'Catppuccin Mocha (Claude)', colors: { ...mocha, magenta: '#f5c2e7', brightMagenta: '#f5c2e7', brightBlue: '#ff79c6' } },
  { id: 'dracula', name: 'Dracula', colors: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
    brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  } },
] satisfies { id: string; name: string; colors: Palette }[];

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) {
    throw new Error(`${field} must be a six-digit hex color, such as #f5c2e7.`);
  }
  return value.toLowerCase();
}
export function validatePalette(value: unknown): Palette {
  if (!object(value)) throw new Error('Import one color-scheme object, not an array or a full terminal settings file.');
  if ('schemes' in value || 'profiles' in value) throw new Error('Copy one object from the Windows Terminal schemes array, not the full settings file.');
  const colors = {} as Palette;
  for (const key of PALETTE_KEYS) {
    // Windows Terminal calls these purple; xterm calls them magenta.
    const alias = key === 'magenta' ? 'purple' : key === 'brightMagenta' ? 'brightPurple' : key;
    colors[key] = color(value[key] ?? value[alias], key);
  }
  colors.cursor = color(value.cursor ?? value.cursorColor ?? colors.foreground, 'cursor');
  colors.selectionBackground = color(value.selectionBackground ?? colors.brightBlack, 'selectionBackground');
  return colors;
}
export function importPalette(text: string): CustomPalette {
  if (text.length > MAX_PALETTE_LENGTH) throw new Error('Palette JSON must be 32 KB or smaller.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid JSON. Use a single JSON object with double-quoted keys and no comments or trailing commas.'); }
  const colors = validatePalette(value);
  const rawName = object(value) && typeof value.name === 'string' ? value.name : 'Imported palette';
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Imported palette';
  return { name, colors };
}
export function normalizeAppearance(value: unknown): Appearance {
  if (!object(value)) return { preset: DEFAULT_PRESET };
  let custom: CustomPalette | undefined;
  if (object(value.custom)) {
    try { custom = importPalette(JSON.stringify({ ...validatePalette(value.custom.colors), name: value.custom.name })); } catch {}
  }
  const preset = typeof value.preset === 'string' && (THEME_PRESETS.some(item => item.id === value.preset) || (value.preset === 'custom' && custom))
    ? value.preset : DEFAULT_PRESET;
  return { preset, ...(custom ? { custom } : {}) };
}
export function selectedPalette(appearance: Appearance): Palette {
  if (appearance.preset === 'custom' && appearance.custom) return { ...appearance.custom.colors };
  return { ...(THEME_PRESETS.find(item => item.id === appearance.preset) ?? THEME_PRESETS.find(item => item.id === DEFAULT_PRESET)!).colors };
}

// Keep the previous default for installations that have no saved appearance.
export const terminalTheme = selectedPalette({ preset: DEFAULT_PRESET });
export const terminalColorOptions: ITerminalOptions = {
  theme: terminalTheme,
  drawBoldTextInBrightColors: false,
  minimumContrastRatio: 1,
};
