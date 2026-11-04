import { validSession, parseSessions, noSessions } from '../protocol.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Zellij operations for MCP tools. `query(args, maxBuffer)` runs the Zellij CLI with the
 * bridge's bounded process queue; `spawnPty(args, options)` starts a PTY client.
 */
export class ZellijClient {
  constructor({ query, spawnPty, cwd }) {
    this.query = query;
    this.spawnPty = spawnPty;
    this.cwd = cwd;
    this.anchors = new Map(); // session -> pty
  }

  async sessions() {
    try { return parseSessions((await this.query(['list-sessions', '--no-formatting'])).stdout); }
    catch (error) { if (noSessions(error)) return []; throw error; }
  }
  async status(name) {
    const session = (await this.sessions()).find(item => item.name === name);
    return session ? (session.exited ? 'exited' : 'running') : 'missing';
  }

  action(session, args, maxBuffer) {
    if (!validSession(session)) throw new Error('Invalid session name.');
    return this.query(['--session', session, 'action', ...args], maxBuffer);
  }
  async actionJson(session, args) {
    // Zellij briefly answers with something other than JSON while a pane or tab closes; retry once.
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await this.action(session, [...args, '--json'], 8 * 1024 * 1024);
      try { return JSON.parse(stdout); }
      catch { if (attempt >= 1) throw new Error(`Session "${session}" is not running.`); }
      await sleep(250);
    }
  }
  panes(session) { return this.actionJson(session, ['list-panes', '--all']); }
  tabs(session) { return this.actionJson(session, ['list-tabs', '--all']); }

  /**
   * Open a program (or the default shell) in a new tab of its own, without moving focus.
   * `new-tab` reports a tab id, which Zellij reuses, so the pane is found by its new id.
   * Callers serialize calls per session.
   */
  async openTab(session, { name, cwd, argv } = {}) {
    const terminals = panes => panes.filter(pane => !pane.is_plugin && !pane.is_suppressed);
    const before = new Set(terminals(await this.panes(session)).map(pane => pane.id));
    const args = ['new-tab', '--no-focus'];
    if (name) args.push('--name', name);
    if (cwd) args.push('--cwd', cwd);
    if (argv?.length) args.push('--', ...argv);
    await this.action(session, args);
    for (let attempt = 0; attempt < 40; attempt++) {
      const fresh = terminals(await this.panes(session)).find(pane => !before.has(pane.id));
      if (fresh) return fresh.id;
      await sleep(150);
    }
    throw new Error('Zellij did not report the new pane.');
  }

  async dump(session, pane, { full = false } = {}) {
    const args = ['dump-screen', '--pane-id', pane];
    if (full) args.push('--full');
    return (await this.action(session, args, 32 * 1024 * 1024)).stdout;
  }

  /**
   * A background session created without a client gets a tiny default size on some
   * platforms. Agent sessions are created by, and kept sized by, a bridge-owned PTY client.
   */
  startAnchor(session, { create = false, cols, rows, cwd } = {}) {
    const existing = this.anchors.get(session);
    if (existing) return existing;
    const args = create
      ? ['attach', '--create', session, 'options', '--default-layout', 'compact', '--scroll-buffer-size', '50000']
      : ['attach', session];
    const anchor = this.spawnPty(args, { cols, rows, cwd: cwd || this.cwd });
    // Output is irrelevant to the anchor; it must still be drained.
    anchor.onData(() => {});
    anchor.onExit(() => { if (this.anchors.get(session) === anchor) this.anchors.delete(session); });
    this.anchors.set(session, anchor);
    return anchor;
  }

  async create(session, { cols, rows, cwd }) {
    this.startAnchor(session, { create: true, cols, rows, cwd });
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(250);
      try {
        const panes = await this.panes(session);
        const shell = panes.find(pane => !pane.is_plugin && !pane.is_suppressed);
        if (shell) return `terminal_${shell.id}`;
      } catch {}
    }
    await this.remove(session);
    throw new Error('Zellij did not start the session within 10 seconds.');
  }

  /** Re-attach the sizing client after a bridge restart. Never resurrects exited sessions. */
  async ensureAnchor(session, size) {
    if (this.anchors.has(session)) return;
    if ((await this.status(session)) !== 'running') return;
    this.startAnchor(session, size);
  }

  async remove(session) {
    const anchor = this.anchors.get(session);
    this.anchors.delete(session);
    try { anchor?.kill(); } catch {}
    try { await this.query(['delete-session', '--force', session]); } catch {}
  }

  shutdown() {
    for (const anchor of this.anchors.values()) { try { anchor.kill(); } catch {} }
    this.anchors.clear();
  }
}
