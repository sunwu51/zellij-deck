import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import xterm from '@xterm/xterm';

const { outputFiles } = await build({
  entryPoints: ['extension/unicode.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node',
});
const { useModernWidths } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const snapshotBundle = await build({ entryPoints: ['extension/snapshot-render.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { composeTab } = await import(`data:text/javascript;base64,${Buffer.from(snapshotBundle.outputFiles[0].text).toString('base64')}`);
const { Terminal } = xterm;
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
function createTerminal(cols = 80, conpty = false) {
  const terminal = new Terminal({ cols, rows: 5, allowProposedApi: true });
  useModernWidths(terminal, conpty);
  return terminal;
}

test('styled emoji sequences preserve subsequent columns', async () => {
  const terminal = createTerminal();
  try {
    await write(terminal, 'A\x1b[32m♻️\x1b[0m |');
    assert.equal(terminal.buffer.active.getLine(0).getCell(1).getChars(), '♻️');
    assert.equal(terminal.buffer.active.getLine(0).getCell(4).getChars(), '|');
  } finally { terminal.dispose(); }
});

for (const emoji of ['♻️', '✨', '🐛', '❤️', '⚙️', '👩‍💻', '👍🏽', '🇨🇳', '1️⃣']) {
  test(`${emoji} occupies one two-column grapheme and preserves trailing borders`, async () => {
    const terminal = createTerminal();
    try {
      await write(terminal, `A${emoji} |`);
      const line = terminal.buffer.active.getLine(0);
      assert.equal(line.getCell(1).getChars(), emoji);
      assert.equal(line.getCell(1).getWidth(), 2);
      assert.equal(line.getCell(2).getWidth(), 0);
      assert.equal(line.getCell(4).getChars(), '|');
      assert.equal(terminal.buffer.active.cursorX, 5);
    } finally { terminal.dispose(); }
  });
}

test('VS16 widens its base even across separate PTY output writes', async () => {
  const terminal = createTerminal();
  try {
    await write(terminal, 'A♻');
    assert.equal(terminal.buffer.active.cursorX, 2);
    await write(terminal, '️ |');
    assert.equal(terminal.buffer.active.getLine(0).getCell(1).getChars(), '♻️');
    assert.equal(terminal.buffer.active.getLine(0).getCell(4).getChars(), '|');
    assert.equal(terminal.buffer.active.cursorX, 5);
  } finally { terminal.dispose(); }
});

test('ASCII, bare text symbols, combining accents, CJK and Powerline keep their widths', async () => {
  const terminal = createTerminal();
  try {
    for (const [text, width] of [['hello', 5], ['♻', 1], ['é', 1], ['中文', 4], ['', 1]]) {
      terminal.reset();
      await write(terminal, `${text}|`);
      assert.equal(terminal.buffer.active.getLine(0).getCell(width).getChars(), '|', text);
      assert.equal(terminal.buffer.active.cursorX, width + 1, text);
    }
  } finally { terminal.dispose(); }
});

test('Windows Zellij/ConPTY output without VS16 preserves the Git UI two-column recycle glyph', async () => {
  const terminal = createTerminal(80, true);
  try {
    // Captured from native Zellij 0.45.1 through ConPTY: source ♻️ becomes
    // bare U+267B; no selector survives to trigger standard grapheme widening.
    const recycle = '♻ VS16 recycle                         | right border';
    const sparkles = '✨ sparkles                             | right border';
    await write(terminal, `\x1b[2;1H${recycle}\x1b[4;1H${sparkles}`);
    assert.equal(terminal.buffer.active.getLine(1).getCell(0).getChars(), '♻');
    assert.equal(terminal.buffer.active.getLine(1).getCell(0).getWidth(), 2);
    assert.equal(terminal.buffer.active.getLine(1).getCell(40).getChars(), '|');
    assert.equal(terminal.buffer.active.getLine(3).getCell(40).getChars(), '|');
  } finally { terminal.dispose(); }
});

test('ConPTY compatibility keeps intact VS16 sequences at two columns, not three', async () => {
  const terminal = createTerminal(80, true);
  try {
    await write(terminal, 'A♻️ |');
    assert.equal(terminal.buffer.active.getLine(0).getCell(1).getChars(), '♻️');
    assert.equal(terminal.buffer.active.getLine(0).getCell(4).getChars(), '|');
  } finally { terminal.dispose(); }
});

test('dashboard snapshot replay uses the same emoji widths as the live terminal', async () => {
  const tab = { id: 0, cols: 10, rows: 1, floatingVisible: false, fullscreen: false };
  const pane = {
    id: 'terminal_1', tabId: 0, plugin: false, focused: false, floating: false,
    x: 0, y: 0, cols: 10, rows: 1, contentX: 0, contentY: 0, contentCols: 10, contentRows: 1,
    content: 'A♻️ |',
  };
  const grid = await composeTab({ tabs: [tab], panes: [pane] }, tab, {});
  assert.equal(grid.cells[1].ch, '♻️');
  assert.equal(grid.cells[1].width, 2);
  assert.equal(grid.cells[2].width, 0);
  assert.equal(grid.cells[4].ch, '|');
});

test('the affected historical commit row keeps the same columns as other emoji rows', async () => {
  const terminal = createTerminal(120);
  try {
    const rows = [['♻️', ' Remove standalone MCP exec and job tools'], ['✨', ' Open Side Shell sessions in dedicated terminal windows']];
    for (const [emoji, message] of rows) {
      terminal.reset();
      // The UI pads the message to 70 columns, with the emoji occupying two.
      const padding = 70 - 2 - message.length;
      await write(terminal, emoji + message + ' '.repeat(padding) + 'frank |');
      const line = terminal.buffer.active.getLine(0);
      assert.equal(line.getCell(70).getChars(), 'f');
      assert.equal(line.getCell(76).getChars(), '|');
    }
  } finally { terminal.dispose(); }
});
