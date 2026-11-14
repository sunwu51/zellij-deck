import { Terminal, type IBufferCell } from '@xterm/xterm';
import type { Palette } from './theme';
import { useModernWidths } from './unicode';
import { FONT_FAMILY } from './font';
import { ansiColor, drawOrder, frameCells, rgbColor, type Snapshot, type SnapshotTab } from './snapshot';

export type Cell = {
  ch: string; width: number; fg?: string; bg?: string;
  bold?: boolean; italic?: boolean; dim?: boolean; underline?: boolean; strike?: boolean;
};
export type Grid = { cols: number; rows: number; cells: Cell[] };
export { FONT_FAMILY };

/**
 * Zellij's dump re-joins soft-wrapped lines and trims blank rows. Replaying it into an
 * unopened xterm buffer of the pane's content size re-wraps it exactly as the pane shows it.
 */
async function parsePane(content: string, cols: number, rows: number): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, scrollback: 0, convertEol: true, allowProposedApi: true });
  useModernWidths(terminal);
  await new Promise<void>(resolve => terminal.write(content, resolve));
  return terminal;
}

function cellColor(cell: IBufferCell, foreground: boolean, palette: Palette): string | undefined {
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return rgbColor(foreground ? cell.getFgColor() : cell.getBgColor());
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return ansiColor(foreground ? cell.getFgColor() : cell.getBgColor(), palette);
  return undefined;
}

export async function composeTab(snapshot: Snapshot, tab: SnapshotTab, palette: Palette): Promise<Grid> {
  const { cols, rows } = tab;
  const cells: Cell[] = Array.from({ length: cols * rows }, () => ({ ch: '', width: 1 }));
  const put = (x: number, y: number, cell: Cell) => { if (x >= 0 && y >= 0 && x < cols && y < rows) cells[y * cols + x] = cell; };
  for (const pane of drawOrder(snapshot, tab)) {
    // Clear the full pane rect so floating panes hide what is underneath.
    for (let y = pane.y; y < pane.y + pane.rows; y++) for (let x = pane.x; x < pane.x + pane.cols; x++) put(x, y, { ch: '', width: 1 });
    const frameColor = pane.focused ? palette.green : palette.brightBlack;
    for (const frame of frameCells(pane)) {
      put(frame.x, frame.y, { ch: frame.ch, width: 1, fg: frame.title ? (pane.focused ? palette.green : palette.foreground) : frameColor, bold: frame.title && pane.focused });
    }
    if (pane.plugin || pane.content === undefined) {
      // Plugin panes (bars, sidebars) have no dumpable text; label them instead.
      const label = [...`⧉ ${pane.title || 'plugin'}`].slice(0, Math.max(0, pane.contentCols - 1));
      if (pane.contentRows > 0) label.forEach((ch, i) => put(pane.contentX + 1 + i, pane.contentY, { ch, width: 1, fg: palette.brightBlack, italic: true }));
      continue;
    }
    if (pane.contentCols < 1 || pane.contentRows < 1) continue;
    const terminal = await parsePane(pane.content, pane.contentCols, pane.contentRows);
    try {
      const buffer = terminal.buffer.active;
      let reuse: IBufferCell | undefined;
      for (let y = 0; y < pane.contentRows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        if (!line) continue;
        for (let x = 0; x < pane.contentCols; x++) {
          const cell = line.getCell(x, reuse);
          if (!cell) continue;
          reuse = cell;
          const width = cell.getWidth();
          if (width === 0) { put(pane.contentX + x, pane.contentY + y, { ch: '', width: 0 }); continue; }
          let fg = cellColor(cell, true, palette);
          let bg = cellColor(cell, false, palette);
          if (cell.isInverse()) [fg, bg] = [bg ?? palette.background, fg ?? palette.foreground];
          put(pane.contentX + x, pane.contentY + y, {
            ch: cell.isInvisible() ? '' : cell.getChars(), width, fg, bg,
            bold: !!cell.isBold(), italic: !!cell.isItalic(), dim: !!cell.isDim(),
            underline: !!cell.isUnderline(), strike: !!cell.isStrikethrough(),
          });
        }
      }
    } finally { terminal.dispose(); }
  }
  return { cols, rows, cells };
}

let glyphRatio = 0;
/** Draw a grid sized to fill `cssWidth` CSS pixels at device resolution. */
export function drawGrid(canvas: HTMLCanvasElement, grid: Grid, palette: Palette, cssWidth: number) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx || cssWidth < 1) return;
  if (!glyphRatio) {
    ctx.font = `100px ${FONT_FAMILY}`;
    glyphRatio = ctx.measureText('M').width / 100 || 0.6;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cellWidth = (cssWidth * dpr) / grid.cols;
  const fontSize = cellWidth / glyphRatio;
  const cellHeight = Math.max(1, fontSize * 1.2);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(grid.rows * cellHeight);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Backgrounds first, with integer edges so adjacent cells do not leave seams.
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const cell = grid.cells[y * grid.cols + x];
      if (!cell.bg || cell.width === 0) continue;
      const left = Math.floor(x * cellWidth), top = Math.floor(y * cellHeight);
      ctx.fillStyle = cell.bg;
      ctx.fillRect(left, top, Math.ceil((x + cell.width) * cellWidth) - left, Math.ceil((y + 1) * cellHeight) - top);
    }
  }
  ctx.textBaseline = 'middle';
  let font = '';
  for (let y = 0; y < grid.rows; y++) {
    const middle = y * cellHeight + cellHeight / 2;
    for (let x = 0; x < grid.cols; x++) {
      const cell = grid.cells[y * grid.cols + x];
      if (!cell.ch || cell.ch === ' ' || cell.width === 0) continue;
      const next = `${cell.italic ? 'italic ' : ''}${cell.bold ? '700 ' : ''}${fontSize}px ${FONT_FAMILY}`;
      if (next !== font) { ctx.font = next; font = next; }
      ctx.fillStyle = cell.fg ?? palette.foreground;
      ctx.globalAlpha = cell.dim ? 0.55 : 1;
      ctx.fillText(cell.ch, x * cellWidth, middle, cellWidth * cell.width * 1.05);
      if (cell.underline || cell.strike) {
        const lineY = cell.underline ? y * cellHeight + cellHeight * 0.9 : middle;
        ctx.fillRect(x * cellWidth, lineY, cellWidth * cell.width, Math.max(1, fontSize / 14));
      }
    }
  }
  ctx.globalAlpha = 1;
}
