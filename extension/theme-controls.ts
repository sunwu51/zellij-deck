import type { Terminal } from '@xterm/xterm';
import {
  ANSI_KEYS, THEME_PRESETS, MAX_PALETTE_LENGTH, importPalette,
  normalizeAppearance, selectedPalette, type Appearance,
} from './theme';

export async function initThemeControls(terminal?: Terminal) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const select = get<HTMLSelectElement>('theme-preset');
  const apply = get<HTMLButtonElement>('theme-apply');
  const importButton = get<HTMLButtonElement>('theme-import');
  const fileInput = get<HTMLInputElement>('theme-file');
  const textarea = get<HTMLTextAreaElement>('theme-json');
  const feedback = get('theme-feedback');
  let draft: Appearance = normalizeAppearance(undefined);
  function message(text: string, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
  }
  function fillOptions() {
    select.replaceChildren(...THEME_PRESETS.map(preset => new Option(preset.name, preset.id)));
    if (draft.custom) select.add(new Option(`Custom · ${draft.custom.name}`, 'custom'));
    select.value = draft.preset;
  }
  function preview() {
    const colors = selectedPalette(draft);
    const sample = get('theme-preview');
    sample.style.backgroundColor = colors.background;
    sample.style.color = colors.foreground;
    get('theme-preview-pink').style.color = colors.brightBlue;
    get('theme-preview-yellow').style.color = colors.yellow;
    const swatches = ANSI_KEYS.map(key => {
      const span = document.createElement('span');
      span.style.backgroundColor = colors[key];
      span.title = `${key}: ${colors[key]}`;
      return span;
    });
    get('theme-swatches').replaceChildren(...swatches);
  }
  function updateTerminal() {
    if (!terminal) return;
    const colors = selectedPalette(draft);
    terminal.options.theme = colors;
    // Include the terminal's outer gutter, which xterm itself does not paint.
    get('terminal-region').style.backgroundColor = colors.background;
    get('empty-state').style.backgroundColor = colors.background;
  }
  function busy(value: boolean) {
    select.disabled = value;
    apply.disabled = value;
    importButton.disabled = value;
    fileInput.disabled = value;
    textarea.disabled = value;
  }
  async function save() {
    busy(true);
    try {
      // Appearance is separate from credentials: changing colors never detaches
      // a session and never persists an unfinished bridge-settings edit.
      await chrome.storage.local.set({ appearance: draft });
      updateTerminal();
      message('Theme saved on this device. No reconnect needed.');
    } catch { message('Could not save the theme. Your active terminal theme was not changed; retry Apply theme.', true); }
    finally { busy(false); }
  }
  busy(true);
  try {
    const stored = await chrome.storage.local.get('appearance');
    draft = normalizeAppearance(stored.appearance);
  } catch { message('Could not load the saved theme. Using Mocha (Claude).', true); }
  fillOptions();
  preview();
  updateTerminal();
  busy(false);
  select.addEventListener('change', () => {
    draft = { ...draft, preset: select.value };
    preview();
    message('Preview only. Click Apply theme to save and use it.');
  });
  apply.addEventListener('click', () => { void save(); });
  importButton.addEventListener('click', () => {
    try {
      const custom = importPalette(textarea.value);
      draft = { preset: 'custom', custom };
      fillOptions();
      preview();
      void save();
    } catch (error) { message(error instanceof Error ? error.message : 'Invalid palette.', true); }
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    busy(true);
    try {
      if (file.size > MAX_PALETTE_LENGTH) throw new Error('Palette file must be 32 KB or smaller.');
      const text = await file.text();
      // Validate before replacing a previous draft. Import still requires a click.
      importPalette(text);
      textarea.value = text;
      message('File loaded. Click Import & apply to save this palette.');
    } catch (error) { message(error instanceof Error ? error.message : 'Could not read palette file.', true); }
    finally { fileInput.value = ''; busy(false); }
  });
}
