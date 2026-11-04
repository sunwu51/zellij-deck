import type { Palette } from './theme';
import { ANSI_KEYS } from './theme';

export type SnapshotTab = {
  id: number; position: number; name: string; active: boolean; cols: number; rows: number;
  floatingVisible: boolean; fullscreen: boolean; bell: boolean;
};
export type SnapshotPane = {
  id: string; tabId: number; plugin: boolean; title: string; focused: boolean; floating: boolean;
  fullscreen: boolean; exited: boolean;
  x: number; y: number; cols: number; rows: number;
  contentX: number; contentY: number; contentCols: number; contentRows: number;
  content?: string; truncated?: boolean;
};
export type Snapshot = { session: string; capturedAt: number; tabs: SnapshotTab[]; panes: SnapshotPane[]; panesTruncated?: boolean; clients?: number };

/** The tab to preview: the user's pick if it still exists, otherwise the session's active tab. */
export function previewTab(snapshot: Snapshot, preferred?: number): SnapshotTab | undefined {
  return snapshot.tabs.find(tab => tab.id === preferred)
    ?? snapshot.tabs.find(tab => tab.active)
    ?? snapshot.tabs[0];
}

/** Panes of a tab in paint order: tiled panes, then visible floating panes (focused last). */
export function drawOrder(snapshot: Snapshot, tab: SnapshotTab): SnapshotPane[] {
  const panes = snapshot.panes.filter(pane => pane.tabId === tab.id);
  const fullscreen = tab.fullscreen ? panes.find(pane => pane.fullscreen && !pane.floating) : undefined;
  // In fullscreen, only UI bars (unselectable plugins outside the pane) remain beside the fullscreen pane.
  const tiled = panes.filter(pane => !pane.floating && (!fullscreen || pane === fullscreen || (pane.plugin && !overlaps(pane, fullscreen))));
  const floating = tab.floatingVisible ? panes.filter(pane => pane.floating) : [];
  floating.sort((a, b) => Number(a.focused) - Number(b.focused));
  return [...tiled, ...floating];
}
function overlaps(a: SnapshotPane, b: SnapshotPane) {
  return a.x < b.x + b.cols && b.x < a.x + a.cols && a.y < b.y + b.rows && b.y < a.y + a.rows;
}

export type FrameCell = { x: number; y: number; ch: string; title?: boolean };
/**
 * Frame characters around a pane's content. Zellij reports the outer pane rect and the
 * inner content rect; any side where they differ carries a border (or a title bar).
 */
export function frameCells(pane: SnapshotPane, title = pane.title): FrameCell[] {
  const top = pane.contentY > pane.y;
  const bottom = pane.contentY + pane.contentRows < pane.y + pane.rows;
  const left = pane.contentX > pane.x;
  const right = pane.contentX + pane.contentCols < pane.x + pane.cols;
  if (!top && !bottom && !left && !right) return [];
  // One cell per position: later writes (corners, title) replace earlier edge glyphs.
  const cells = new Map<string, FrameCell>();
  const set = (x: number, y: number, ch: string, isTitle = false) => cells.set(`${x},${y}`, isTitle ? { x, y, ch, title: true } : { x, y, ch });
  const x0 = pane.x, y0 = pane.y, x1 = pane.x + pane.cols - 1, y1 = pane.y + pane.rows - 1;
  if (top) for (let x = x0; x <= x1; x++) set(x, y0, '─');
  if (bottom) for (let x = x0; x <= x1; x++) set(x, y1, '─');
  if (left) for (let y = y0; y <= y1; y++) set(x0, y, '│');
  if (right) for (let y = y0; y <= y1; y++) set(x1, y, '│');
  if (top && left) set(x0, y0, '╭');
  if (top && right) set(x1, y0, '╮');
  if (bottom && left) set(x0, y1, '╰');
  if (bottom && right) set(x1, y1, '╯');
  if (top && title) {
    const start = x0 + (left ? 2 : 1);
    const room = x1 - start - (right ? 1 : 0);
    const text = [...` ${title} `];
    const fitted = text.length > room ? [...text.slice(0, Math.max(0, room - 2)), '…', ' '] : text;
    if (room >= 4) fitted.forEach((ch, i) => set(start + i, y0, ch, true));
  }
  return [...cells.values()];
}

function hex(value: number) { return value.toString(16).padStart(2, '0'); }
export function rgbColor(value: number): string {
  return `#${hex((value >> 16) & 255)}${hex((value >> 8) & 255)}${hex(value & 255)}`;
}
/** xterm-256 palette: 0–15 from the theme, 16–231 the 6×6×6 cube, 232–255 grayscale. */
export function ansiColor(index: number, palette: Palette): string {
  if (index < 16) return palette[ANSI_KEYS[index]];
  if (index < 232) {
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    const i = index - 16;
    return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}

export function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
