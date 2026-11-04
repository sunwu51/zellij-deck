import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { validSession } from '../protocol.mjs';
import {
  toLines, pageLines, findLines, compilePattern, wrapLines, normalizeKey, normalizePaneId, intInRange,
  mouseSequences, MOUSE_ACTIONS,
} from './text.mjs';

export const MAX_PANES_PER_OWNER = 12;
/** Tool calls must finish well inside common client timeouts (TabManager: 60 s). */
export const MAX_WAIT_SECONDS = 45;
const SESSION_COLS = 160;
const SESSION_ROWS = 45;
const POLL_MS = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const SERVER_INSTRUCTIONS = [
  'Side Shell gives you private terminals ("panes") on the user\'s computer, backed by Zellij. Each pane runs in its own full-size tab, so there are no splits or layouts to manage.',
  'Isolation: your MCP session (Mcp-Session-Id) has its own set of panes. The user\'s sessions and other agents\' panes are invisible to you.',
  'Interactive work: pane_open (a shell; pass command to run something right away), then pane_type (submit: true), pane_wait (pattern or idle), and pane_read (offset from the input call, or tail) or pane_screen for TUIs. A pane is always a shell: when a program finishes you are back at an idle prompt in the same pane and can keep typing. Use exec instead when you need a command\'s exit code. Use pane_keys for Enter, Esc, arrows, Ctrl combinations and menu navigation, and pane_mouse when a TUI needs a click or wheel scroll. With several panes open, pass pane every time.',
  'One-shot commands that need an exit code and separate stdout/stderr: exec. It runs outside Zellij; if it is still running when timeout_s elapses it continues as a background job (job_wait, job_output, job_kill).',
  `Every call returns within about ${MAX_WAIT_SECONDS} seconds; long work keeps running, so poll with pane_wait or job_wait.`,
  'Read output incrementally: the input tools return offset (the pane\'s line count just before your input); pane_read with that offset returns what the input produced.',
].join('\n');

export class ToolError extends Error {}

function bool(value, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ToolError(`${field} must be a boolean.`);
  return value;
}
function text(value, field, max) {
  if (typeof value !== 'string' || value.length > max) throw new ToolError(`${field} must be a string of at most ${max} characters.`);
  return value;
}
async function directory(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new ToolError('cwd must be an absolute directory path.');
  try { if ((await stat(value)).isDirectory()) return value; } catch {}
  throw new ToolError(`cwd does not exist or is not a directory: ${value}`);
}
function paneInfo(pane) {
  return {
    pane: `terminal_${pane.id}`, name: pane.tab_name, title: pane.title,
    cols: pane.pane_content_columns, rows: pane.pane_content_rows,
  };
}
function slug(value, max) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
}
const PANE = { type: 'string', description: 'Pane id from pane_open or pane_list, such as "terminal_3". Optional only while exactly one pane is open.' };

export function createTools({ store, zellij, jobs }) {
  const locks = new Map();
  // Line count of each pane at the moment input was last sent to it. pane_wait matches only
  // lines after this mark by default, so "type, then wait" cannot race the command's output
  // and never matches the echo of the typed command itself.
  const inputMarks = new Map();
  const lostOwners = new Set();
  // Panes that existed but are gone (closed by the agent, by the user, or with their session).
  // Pane ids are never reused within a session, so a remembered id cannot name another pane.
  const closedPanes = new Set();
  const lastSession = new Map();
  const closedKey = (session, id) => `${session}/terminal_${id}`;
  function closedError(session, id) {
    return new ToolError(`Pane ${id} was closed (by you, or by someone outside this MCP session). Call pane_list, or pane_open to create one.`);
  }
  const DEAD_SESSION = /Session '[^']*' not found/;
  async function paneAlive(session, id) {
    try { return (await zellij.panes(session)).some(pane => !pane.is_plugin && pane.id === id); }
    catch { return false; }
  }
  const markKey = (session, id) => `${session}/${id}`;
  async function markInput(session, id) {
    const offset = toLines(await zellij.dump(session, id, { full: true })).length;
    inputMarks.set(markKey(session, id), offset);
    return offset;
  }
  function forgetMarks(session) {
    for (const key of inputMarks.keys()) if (key.startsWith(`${session}/`)) inputMarks.delete(key);
  }
  async function withLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const chained = previous.then(() => current);
    locks.set(key, chained);
    await previous;
    try { return await task(); }
    finally { release(); if (locks.get(key) === chained) locks.delete(key); }
  }

  /** The caller's live terminal session and its panes, or undefined when it has none (yet). */
  async function context(owner) {
    const session = store.sessionOf(owner);
    if (!session) return undefined;
    lastSession.set(owner, session);
    const status = await zellij.status(session);
    if (status !== 'running') {
      // Killed or exited behind our back: forget it so the next pane_open starts clean.
      for (const id of store.ownership(session)?.panes ?? []) closedPanes.add(closedKey(session, id));
      if (status === 'exited') await zellij.remove(session);
      store.release(session);
      forgetMarks(session);
      lostOwners.add(owner);
      return undefined;
    }
    const record = store.ownership(session);
    await zellij.ensureAnchor(session, { cols: record?.cols, rows: record?.rows });
    const known = new Set(record?.panes ?? []);
    const live = (await zellij.panes(session)).filter(pane => !pane.is_plugin && !pane.is_suppressed && known.has(pane.id));
    const alive = new Set(live.map(pane => pane.id));
    // A tab or pane was closed outside our control.
    for (const id of known) if (!alive.has(id)) closedPanes.add(closedKey(session, id));
    if (live.length !== known.size) store.update(session, { panes: live.map(pane => pane.id) });
    return { session, panes: live };
  }
  function takeLostNote(owner) {
    return lostOwners.delete(owner)
      ? 'Your previous terminals no longer exist (the Zellij session was ended outside this MCP session), so this is a fresh session.'
      : undefined;
  }
  async function requirePane(owner, requested) {
    const ctx = await context(owner);
    let id;
    if (requested !== undefined) {
      try { id = normalizePaneId(requested); } catch (error) { throw new ToolError(error.message); }
    }
    const was = session => id && session && closedPanes.has(`${session}/${id}`);
    if (!ctx?.panes.length) {
      if (was(ctx?.session ?? lastSession.get(owner))) throw closedError(ctx?.session ?? lastSession.get(owner), id);
      throw id ? new ToolError(`Pane ${id} not found. Call pane_list, or pane_open to create one.`) : new ToolError('No panes yet. Call pane_open first.');
    }
    if (id === undefined) {
      if (ctx.panes.length === 1) return { session: ctx.session, pane: ctx.panes[0], count: 1 };
      throw new ToolError(`pane is required because ${ctx.panes.length} panes are open: ${ctx.panes.map(pane => `terminal_${pane.id}`).join(', ')}.`);
    }
    const found = ctx.panes.find(pane => `terminal_${pane.id}` === id);
    if (!found) {
      if (was(ctx.session)) throw closedError(ctx.session, id);
      throw new ToolError(`Pane ${id} not found. Call pane_list, or pane_open to create one.`);
    }
    return { session: ctx.session, pane: found, count: ctx.panes.length };
  }
  /** Type a command line into a fresh shell once it has printed its prompt, so nothing is lost during startup. */
  async function runInShell(session, target, command) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (toLines(await zellij.dump(session, target, { full: true })).length) break;
      await sleep(150);
    }
    const offset = await markInput(session, target);
    await zellij.action(session, [command.includes('\n') ? 'paste' : 'write-chars', '--pane-id', target, '--', command]);
    await zellij.action(session, ['send-keys', '--pane-id', target, '--', 'Enter']);
    return offset;
  }
  async function createSession(owner) {
    const existing = new Set((await zellij.sessions()).map(item => item.name));
    let name;
    do {
      const who = slug(store.clientName(owner), 16);
      name = `ag-${who ? `${who}-` : ''}${randomBytes(3).toString('hex')}`;
    } while (existing.has(name) || store.ownership(name));
    store.own(name, owner, { cols: SESSION_COLS, rows: SESSION_ROWS, panes: [] });
    try {
      const shell = await zellij.create(name, { cols: SESSION_COLS, rows: SESSION_ROWS });
      const initial = Number(/\d+/.exec(shell)?.[0]);
      store.update(name, { panes: [initial] });
      return { session: name, initial };
    } catch (error) {
      store.release(name);
      throw new ToolError(error.message);
    }
  }

  const tools = [
    {
      name: 'pane_open',
      description: 'Open a new pane: a shell in its own full-size tab. With command, that command line is typed into the shell and run immediately (in the shell\'s own syntax: PowerShell on Windows), so when the program finishes the pane is back at an idle prompt and stays usable; it never freezes on a finished program. Use panes for servers, long builds, REPLs and TUIs that you or the user may want to watch or steer; use exec for one-off commands that need an exit code. A program that never ends keeps running until you stop it with pane_keys ["Ctrl c"] or close the pane. Your first pane_open also creates your private Zellij session, visible in the Side Shell dashboard. Returns the pane id for the other pane_* tools, and, with command, the offset to pass to pane_read.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        command: { type: 'string', description: 'Command line to run in the new shell, e.g. "npm run dev". Omit for an idle shell.' },
        name: { type: 'string', description: 'Short name for the pane (shown as its tab title).' },
        cwd: { type: 'string', description: 'Absolute working directory. Defaults to the bridge working directory.' },
      } },
      async run(args, { owner }) {
        let command;
        if (args.command !== undefined) {
          command = text(args.command, 'command', 32_768);
          if (!command.trim()) throw new ToolError('command must not be empty; omit it for an idle shell.');
        }
        const cwd = await directory(args.cwd);
        const firstWord = command?.trim().split(/\s+/).find(word => word !== '&') ?? 'shell';
        const name = (args.name !== undefined ? text(args.name, 'name', 64) : path.basename(firstWord.replace(/^["'.]+|["']+$/g, '')).replace(/\.(exe|cmd|bat|ps1|sh)$/i, ''))
          .replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'pane';
        let ctx = await context(owner);
        const note = takeLostNote(owner);
        let created;
        if (!ctx) {
          created = await createSession(owner);
          ctx = { session: created.session, panes: [{ id: created.initial }] };
        } else if (ctx.panes.length >= MAX_PANES_PER_OWNER) {
          throw new ToolError(`At most ${MAX_PANES_PER_OWNER} panes are open. Close one with pane_close first.`);
        }
        const { session } = ctx;
        let id, offset;
        try {
          id = await withLock(session, async () => {
            const opened = await zellij.openTab(session, { name, cwd });
            if (command) offset = await runInShell(session, `terminal_${opened}`, command);
            const known = (store.ownership(session)?.panes ?? []).filter(item => item !== created?.initial);
            store.update(session, { panes: [...known, opened] });
            // A new session starts with a default shell tab; the requested pane replaces it.
            if (created) await zellij.action(session, ['close-pane', '--pane-id', `terminal_${created.initial}`]);
            return opened;
          });
        } catch (error) {
          if (created) { await zellij.remove(session); store.release(session); }
          throw new ToolError(error.message);
        }
        return { pane: `terminal_${id}`, name, ...(command ? { command, offset } : {}), ...(note ? { note } : {}) };
      },
    },
    {
      name: 'pane_list',
      description: 'List your open panes (name, title, size) and your exec jobs. With include_orphaned, also list terminal sessions abandoned by ended or long-idle MCP sessions, which session_adopt can take over.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        include_orphaned: { type: 'boolean', description: 'Also list adoptable orphaned agent sessions.' },
      } },
      async run(args, { owner }) {
        const wantOrphans = bool(args.include_orphaned, 'include_orphaned');
        const ctx = await context(owner);
        const note = takeLostNote(owner);
        const result = {
          panes: (ctx?.panes ?? []).map(paneInfo),
          jobs: jobs.list(owner).map(job => ({
            job_id: job.id, status: job.status, exit_code: job.exitCode, command: job.command.slice(0, 200),
            duration_ms: (job.ended ?? Date.now()) - job.started,
          })),
          ...(note ? { note } : {}),
        };
        if (wantOrphans) {
          const live = new Set((await zellij.sessions()).filter(item => !item.exited).map(item => item.name));
          result.orphaned = store.orphanedSessions().filter(item => live.has(item.session) && store.ownerOf(item.session) !== owner);
        }
        return result;
      },
    },
    {
      name: 'pane_close',
      description: 'Close a pane and its tab, ending its process. Closing your last open pane ends your Zellij session (like session_kill); the next pane_open starts a fresh one.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['pane'], properties: { pane: PANE } },
      async run(args, { owner }) {
        const { session, pane: found, count } = await requirePane(owner, args.pane);
        const target = `terminal_${found.id}`;
        if (count <= 1) {
          // Zellij ends a session when its last tab closes, so end it cleanly; pane_open makes a new one.
          closedPanes.add(closedKey(session, found.id));
          await zellij.remove(session);
          store.release(session);
          forgetMarks(session);
          return { closed: target, session_ended: true, note: 'That was your last pane, so your session ended. The next pane_open starts a new one.' };
        }
        await withLock(session, async () => {
          await zellij.action(session, ['close-pane', '--pane-id', target]);
          store.update(session, { panes: (store.ownership(session)?.panes ?? []).filter(item => item !== found.id) });
        });
        inputMarks.delete(markKey(session, target));
        closedPanes.add(closedKey(session, found.id));
        return { closed: target };
      },
    },
    {
      name: 'pane_type',
      description: 'Type text into a pane as if pasted by the user. Set submit to press Enter afterwards. Multi-line text uses bracketed paste. For TUIs such as Claude Code or Codex the input box is focused by default, so typing then submitting sends a prompt. The result includes offset: the pane\'s line count just before your input, so pane_read with that offset returns what the input produced (shells; a TUI that redraws in place needs pane_screen).',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: {
        pane: PANE,
        text: { type: 'string', description: 'Text to type (up to 32,768 characters).' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
      } },
      async run(args, { owner }) {
        const { session, pane: found } = await requirePane(owner, args.pane);
        const target = `terminal_${found.id}`;
        const input = text(args.text, 'text', 32_768);
        const submit = bool(args.submit, 'submit');
        let offset;
        await withLock(session, async () => {
          offset = await markInput(session, target);
          if (input) await zellij.action(session, [input.includes('\n') ? 'paste' : 'write-chars', '--pane-id', target, '--', input]);
          if (submit) await zellij.action(session, ['send-keys', '--pane-id', target, '--', 'Enter']);
        });
        return { pane: target, typed_chars: input.length, submitted: submit, offset };
      },
    },
    {
      name: 'pane_keys',
      description: 'Send key presses to a pane, in order. Examples: ["Enter"], ["Ctrl c"], ["Down", "Down", "Enter"] to pick a menu item, ["Esc"], ["Tab"], ["Alt Shift b"], ["F5"]. Returns offset like pane_type.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['keys'], properties: {
        pane: PANE,
        keys: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' }, description: 'Keys: a character, F1–F12, Enter, Esc, Tab, Backspace, Delete, Insert, Home, End, PageUp, PageDown, Up, Down, Left, Right, Space; optionally prefixed by Ctrl/Alt/Shift/Super.' },
      } },
      async run(args, { owner }) {
        const { session, pane: found } = await requirePane(owner, args.pane);
        const target = `terminal_${found.id}`;
        if (!Array.isArray(args.keys) || !args.keys.length || args.keys.length > 64) throw new ToolError('keys must be an array of 1–64 keys.');
        let keys;
        try { keys = args.keys.map(normalizeKey); } catch (error) { throw new ToolError(error.message); }
        let offset;
        await withLock(session, async () => {
          offset = await markInput(session, target);
          await zellij.action(session, ['send-keys', '--pane-id', target, '--', ...keys]);
        });
        return { pane: target, sent: keys, offset };
      },
    },
    {
      name: 'pane_mouse',
      description: 'Click or scroll with the mouse at a screen position (0-based col and row, as in pane_screen). Use it when a TUI has several input areas or buttons and keyboard focus is not where you need it, or to scroll a full-screen program (vim, less, an agent TUI) whose earlier output is not in the scrollback. Only works in programs that enabled mouse tracking; elsewhere the escape codes are typed as stray text, so confirm with pane_screen first and prefer pane_keys (Tab, arrows) when that suffices. For ordinary shell output, read history with pane_read instead of scrolling. Returns offset like pane_type.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'col', 'row'], properties: {
        pane: PANE,
        action: { type: 'string', enum: MOUSE_ACTIONS },
        col: { type: 'integer', minimum: 0, description: 'Column, 0 = leftmost.' },
        row: { type: 'integer', minimum: 0, description: 'Row, 0 = top row of the pane.' },
        count: { type: 'integer', minimum: 1, maximum: 50, description: 'Wheel notches for scroll_up / scroll_down (default 3).' },
      } },
      async run(args, { owner }) {
        const { session, pane: found } = await requirePane(owner, args.pane);
        const target = `terminal_${found.id}`;
        let sequences;
        try {
          const col = intInRange(args.col, 0, Number.MAX_SAFE_INTEGER, undefined);
          const row = intInRange(args.row, 0, Number.MAX_SAFE_INTEGER, undefined);
          if (col === undefined || row === undefined) throw new Error('col and row are required.');
          if (col >= found.pane_content_columns || row >= found.pane_content_rows) {
            throw new Error(`Position is outside the pane (${found.pane_content_columns} columns × ${found.pane_content_rows} rows, 0-based).`);
          }
          sequences = mouseSequences(args.action, col, row, intInRange(args.count, 1, 50, 3));
        } catch (error) { throw new ToolError(error.message); }
        const bytes = [...Buffer.from(sequences.join(''), 'latin1')].map(String);
        let offset;
        await withLock(session, async () => {
          offset = await markInput(session, target);
          await zellij.action(session, ['write', '--pane-id', target, ...bytes]);
        });
        return { pane: target, action: args.action, col: args.col, row: args.row, offset };
      },
    },
    {
      name: 'pane_read',
      description: 'Read a pane\'s output (scrollback plus screen) as plain text lines. Use tail for the latest lines, or offset/limit to page; the result includes total_lines and next_offset. With pattern, returns matching lines with their line numbers instead.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        pane: PANE,
        tail: { type: 'integer', minimum: 1, maximum: 2000, description: 'Return the last N lines.' },
        offset: { type: 'integer', minimum: 0, description: 'First line number (0-based) to return, e.g. the offset returned by pane_type.' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum lines to return (default 200).' },
        pattern: { type: 'string', description: 'Regular expression; return matching lines (from offset, if given).' },
        literal: { type: 'boolean', description: 'Treat pattern as plain text.' },
        ignore_case: { type: 'boolean' },
      } },
      async run(args, { owner }) {
        const { session, pane: target } = await requirePane(owner, args.pane);
        const lines = toLines(await zellij.dump(session, `terminal_${target.id}`, { full: true }));
        const base = { pane: `terminal_${target.id}` };
        try {
          if (args.pattern !== undefined) {
            const matcher = compilePattern(args.pattern, { literal: bool(args.literal, 'literal'), ignoreCase: bool(args.ignore_case, 'ignore_case') });
            return { ...base, total_lines: lines.length, matches: findLines(lines, matcher, { from: intInRange(args.offset, 0, Number.MAX_SAFE_INTEGER, 0), max: intInRange(args.limit, 1, 2000, 50) }) };
          }
          if (args.tail === undefined && args.offset === undefined) return { ...base, ...pageLines(lines, { tail: 50 }) };
          return { ...base, ...pageLines(lines, { offset: args.offset, limit: args.limit, tail: args.tail }) };
        } catch (error) { throw new ToolError(error.message); }
      },
    },
    {
      name: 'pane_screen',
      description: 'Return exactly what the pane shows now (rows wrapped to the pane width) and the cursor position. Best for TUIs: menus, approval prompts, and input boxes.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: { pane: PANE } },
      async run(args, { owner }) {
        const { session, pane: target } = await requirePane(owner, args.pane);
        const cols = target.pane_content_columns;
        const rows = target.pane_content_rows;
        let screen = wrapLines(toLines(await zellij.dump(session, `terminal_${target.id}`)), cols);
        if (screen.length > rows) screen = screen.slice(-rows);
        const cursor = Array.isArray(target.cursor_coordinates_in_pane) ? { col: target.cursor_coordinates_in_pane[0], row: target.cursor_coordinates_in_pane[1] } : null;
        return {
          pane: `terminal_${target.id}`, title: target.title, cols, rows, cursor,
          text: screen.join('\n'),
        };
      },
    },
    {
      name: 'pane_wait',
      description: `Wait until a pane prints a pattern, goes quiet for idle_ms — whichever condition you set happens first (default: idle 1500 ms). Returns within timeout_s (max ${MAX_WAIT_SECONDS}); reason "timeout" means the work is still running, so call again, and reason "closed" means the pane was closed while you waited. Pattern matching considers only lines after since_offset; by default that is the end of the pane at your last pane_type/pane_keys, so type-then-wait works and the echo of the command you typed is not matched (the typed line itself is excluded, but a pattern can still match output that merely repeats it — prefer distinctive output, or anchor with ^). Line-based waiting suits shells; for TUIs that redraw in place, poll pane_screen instead.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        pane: PANE,
        pattern: { type: 'string', description: 'Regular expression to wait for.' },
        literal: { type: 'boolean', description: 'Treat pattern as plain text.' },
        ignore_case: { type: 'boolean' },
        since_offset: { type: 'integer', minimum: 0, description: 'Only match lines at or after this line number (e.g. total_lines or next_offset from pane_read). Default: the end of the pane when you last typed.' },
        idle_ms: { type: 'integer', minimum: 200, maximum: 30000, description: 'Return once the output has not changed for this long.' },
        timeout_s: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, description: `Maximum wait (default 30).` },
      } },
      async run(args, { owner, signal }) {
        const { session, pane: target } = await requirePane(owner, args.pane);
        const id = `terminal_${target.id}`;
        let matcher, idleMs, timeoutMs, since;
        try {
          matcher = args.pattern !== undefined ? compilePattern(args.pattern, { literal: bool(args.literal, 'literal'), ignoreCase: bool(args.ignore_case, 'ignore_case') }) : undefined;
          // With no condition given, wait for the output to settle.
          idleMs = intInRange(args.idle_ms, 200, 30000, matcher ? undefined : 1500);
          timeoutMs = intInRange(args.timeout_s, 1, MAX_WAIT_SECONDS, 30) * 1000;
          since = intInRange(args.since_offset, 0, Number.MAX_SAFE_INTEGER, undefined);
        } catch (error) { throw new ToolError(error.message); }
        const started = Date.now();
        let lines = toLines(await zellij.dump(session, id, { full: true }));
        since ??= inputMarks.get(markKey(session, id)) ?? lines.length;
        let snapshot = lines.join('\n');
        let changed = Date.now();
        const finish = (reason, extra = {}) => ({
          pane: id, reason, elapsed_ms: Date.now() - started, total_lines: lines.length, ...extra,
          tail: lines.slice(-15).join('\n'),
        });
        const closedResult = () => {
          closedPanes.add(closedKey(session, target.id));
          return finish('closed', { message: 'The pane was closed while waiting (by you, or by someone outside this MCP session).' });
        };
        let polls = 0;
        for (;;) {
          if (matcher) {
            const [match] = findLines(lines, matcher, { from: since, max: 1 });
            if (match) return finish('pattern', { match });
          }
          if (idleMs !== undefined && Date.now() - changed >= idleMs) return finish('idle');
          if (Date.now() - started >= timeoutMs) return finish('timeout');
          if (signal?.aborted) return finish('cancelled');
          await sleep(POLL_MS);
          lines = toLines(await zellij.dump(session, id, { full: true }));
          const next = lines.join('\n');
          if (next !== snapshot) { snapshot = next; changed = Date.now(); }
          // Zellij answers a dump of a closed pane with empty text, and of a dead session with a
          // "Session not found" message, instead of failing. Check on those signs, and now and then.
          if ((lines.length === 0 || DEAD_SESSION.test(next) || ++polls % 5 === 0) && !(await paneAlive(session, target.id))) {
            return closedResult();
          }
        }
      },
    },
    {
      name: 'session_kill',
      description: 'End all of your panes and your Zellij session, killing every process in them. The next pane_open starts a fresh session. Exec jobs are not affected.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      async run(args, { owner }) {
        const session = store.sessionOf(owner);
        if (!session) return { ended: false, note: 'You have no panes.' };
        await zellij.remove(session);
        store.release(session);
        forgetMarks(session);
        return { ended: true };
      },
    },
    {
      name: 'session_adopt',
      description: 'Take over the terminals of an orphaned agent session (listed by pane_list with include_orphaned), for example after resuming a conversation with a new MCP session. Only possible while you have no panes of your own, and never for sessions whose MCP session is still active.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['session'], properties: {
        session: { type: 'string', description: 'Session name from pane_list orphaned.' },
      } },
      async run(args, { owner }) {
        const name = args.session;
        const record = typeof name === 'string' && validSession(name) ? store.ownership(name) : undefined;
        if (record?.owner === owner) return { adopted: name, note: 'Already yours.' };
        if (!record || !store.isOrphaned(record.owner)) throw new ToolError(`Session "${name}" not found or not adoptable.`);
        if (store.sessionOf(owner)) throw new ToolError('You already have panes. Call session_kill first if you want to adopt another session.');
        store.own(name, owner, { cols: record.cols, rows: record.rows, panes: record.panes ?? [] });
        await context(owner); // prunes panes that no longer exist
        return { adopted: name, panes: (store.ownership(name)?.panes ?? []).map(id => `terminal_${id}`) };
      },
    },
    {
      name: 'exec',
      description: `Run a command outside Zellij and return its exit code with separate stdout and stderr (last 100 lines of each; page with job_output). command runs through the platform shell (PowerShell on Windows, $SHELL/sh elsewhere); argv runs a program directly. If it is still running after timeout_s (default 30, max ${MAX_WAIT_SECONDS}) it keeps running as a background job: use job_wait, job_output, or job_kill.`,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        command: { type: 'string', description: 'Shell command string.' },
        argv: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Program and arguments, run without a shell.' },
        cwd: { type: 'string', description: 'Absolute working directory.' },
        stdin: { type: 'string', description: 'Text written to the process\'s standard input.' },
        timeout_s: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'Seconds to wait before returning; 0 returns immediately with a job id.' },
      } },
      async run(args, { owner, signal }) {
        let job, wait;
        try {
          wait = intInRange(args.timeout_s, 0, MAX_WAIT_SECONDS, 30) * 1000;
          if (args.stdin !== undefined) text(args.stdin, 'stdin', 1024 * 1024);
          job = jobs.start(owner, { command: args.command, argv: args.argv, cwd: await directory(args.cwd), stdin: args.stdin });
        } catch (error) { throw new ToolError(error.message); }
        await jobs.wait(job, wait, signal);
        return jobs.summary(job);
      },
    },
    {
      name: 'job_output',
      description: 'Page through a job\'s stdout or stderr by line: tail for the latest lines, or offset/limit. Returns total_lines and next_offset.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: {
        job_id: { type: 'string' },
        stream: { type: 'string', enum: ['stdout', 'stderr'], description: 'Default stdout.' },
        tail: { type: 'integer', minimum: 1, maximum: 2000 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      } },
      async run(args, { owner }) {
        const job = jobs.get(owner, args.job_id);
        if (!job) throw new ToolError(`Job "${args.job_id}" not found.`);
        const stream = args.stream ?? 'stdout';
        if (stream !== 'stdout' && stream !== 'stderr') throw new ToolError('stream must be "stdout" or "stderr".');
        try {
          const page = job[stream].page(args.tail === undefined && args.offset === undefined ? { tail: 100 } : { offset: args.offset, limit: args.limit, tail: args.tail });
          return { job_id: job.id, status: job.status, exit_code: job.exitCode, stream, ...page };
        } catch (error) { throw new ToolError(error.message); }
      },
    },
    {
      name: 'job_wait',
      description: `Wait for a job to finish (up to timeout_s, max ${MAX_WAIT_SECONDS}) and return its status and output tails.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: {
        job_id: { type: 'string' },
        timeout_s: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS },
      } },
      async run(args, { owner, signal }) {
        const job = jobs.get(owner, args.job_id);
        if (!job) throw new ToolError(`Job "${args.job_id}" not found.`);
        let wait;
        try { wait = intInRange(args.timeout_s, 1, MAX_WAIT_SECONDS, 30) * 1000; } catch (error) { throw new ToolError(error.message); }
        await jobs.wait(job, wait, signal);
        return jobs.summary(job);
      },
    },
    {
      name: 'job_kill',
      description: 'Stop a running job and its child processes.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: { type: 'string' } } },
      async run(args, { owner }) {
        const job = jobs.get(owner, args.job_id);
        if (!job) throw new ToolError(`Job "${args.job_id}" not found.`);
        jobs.kill(job);
        await jobs.wait(job, 5000);
        return jobs.summary(job, { tail: 20 });
      },
    },
  ];

  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return {
    definitions: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
    has: name => byName.has(name),
    async call(name, args, context) {
      const tool = byName.get(name);
      if (!tool) throw new ToolError(`Unknown tool: ${name}`);
      if (args !== undefined && (typeof args !== 'object' || Array.isArray(args) || args === null)) throw new ToolError('Tool arguments must be an object.');
      return tool.run(args ?? {}, context);
    },
    /** Release everything an MCP session owns (DELETE / termination). */
    async releaseOwner(owner) {
      jobs.dropOwner(owner);
      lostOwners.delete(owner);
      const sessions = store.owned(owner);
      for (const name of sessions) {
        await zellij.remove(name);
        store.release(name);
        forgetMarks(name);
      }
      return sessions;
    },
    /** Kill one terminal session whose owner is gone (expiry sweep). */
    async releaseSession(name) {
      await zellij.remove(name);
      store.release(name);
      forgetMarks(name);
    },
  };
}
