import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

const HOUR = 3_600_000;
/** Sliding lifetime: every request renews an MCP session for another TTL. */
export const DEFAULT_TTL_MS = 24 * HOUR;
/** After this much inactivity another MCP session may adopt the terminals (before they expire). */
export const ORPHAN_AFTER_MS = 2 * HOUR;
/** Time granted after a bridge start, so downtime alone never expires a session. */
export const STARTUP_GRACE_MS = HOUR;

export function tokenFingerprint(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

/**
 * MCP sessions (Mcp-Session-Id) and the Zellij sessions each one owns. Persisted so a
 * bridge restart does not orphan every client's terminals.
 *
 * Lifetime: a session expires after `ttlMs` without requests (each request renews it).
 * Expired sessions are swept and everything they own is killed, so a client that never
 * sends DELETE cannot leak terminals forever.
 */
export class McpSessionStore {
  constructor({ file, token, now = Date.now, ttlMs = DEFAULT_TTL_MS, orphanAfterMs = ORPHAN_AFTER_MS } = {}) {
    this.file = file;
    this.fingerprint = tokenFingerprint(token ?? '');
    this.now = now;
    this.ttlMs = ttlMs;
    this.orphanAfterMs = Math.min(orphanAfterMs, ttlMs);
    this.sessions = new Map();
    this.owners = new Map(); // zellij session name -> { owner, created, cols, rows, abandonedAt? }
    this.saving = undefined;
    this.dirty = false;
  }

  async load() {
    if (!this.file) return;
    let data;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error(`Ignoring unreadable MCP session file: ${error.message}`); return; }
    const graceFloor = this.now() - this.ttlMs + STARTUP_GRACE_MS;
    // A rotated pairing token invalidates every MCP session; their terminals become abandoned.
    if (data?.fingerprint === this.fingerprint && data.sessions && typeof data.sessions === 'object') {
      for (const [id, record] of Object.entries(data.sessions)) {
        if (/^mcp_[a-f0-9]{32}$/.test(id) && Number.isFinite(record?.lastSeen)) {
          this.sessions.set(id, { ...record, lastSeen: Math.max(record.lastSeen, graceFloor) });
        }
      }
    }
    if (data?.zellij && typeof data.zellij === 'object') {
      for (const [name, record] of Object.entries(data.zellij)) {
        if (typeof record?.owner !== 'string') continue;
        const abandonedAt = Number.isFinite(record.abandonedAt) ? Math.max(record.abandonedAt, graceFloor) : undefined;
        this.owners.set(name, { ...record, ...(abandonedAt !== undefined ? { abandonedAt } : {}) });
      }
    }
  }

  save() {
    if (!this.file) return Promise.resolve();
    this.dirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const data = JSON.stringify({
          version: 1, fingerprint: this.fingerprint,
          sessions: Object.fromEntries(this.sessions), zellij: Object.fromEntries(this.owners),
        });
        const temporary = `${this.file}.${process.pid}.tmp`;
        try {
          await writeFile(temporary, data, { mode: 0o600 });
          await rename(temporary, this.file);
        } catch (error) { console.error(`Could not save MCP sessions: ${error.message}`); }
      }
      this.saving = undefined;
    })();
    return this.saving;
  }

  create(clientInfo = {}) {
    const id = `mcp_${randomBytes(16).toString('hex')}`;
    const now = this.now();
    const client = {
      name: String(clientInfo?.name ?? '').slice(0, 80),
      version: String(clientInfo?.version ?? '').slice(0, 40),
    };
    this.sessions.set(id, { created: now, lastSeen: now, client });
    void this.save();
    return id;
  }

  /** Renew a live session's TTL and return its record; expired or unknown ids return undefined. */
  touch(id) {
    const record = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!record) return undefined;
    const now = this.now();
    if (now - record.lastSeen > this.ttlMs) return undefined; // expired; the sweeper releases it
    // Minute resolution is plenty for a TTL measured in hours; avoid a write per call.
    const persist = now - record.lastSeen > 60_000;
    record.lastSeen = now;
    if (persist) void this.save();
    return record;
  }

  expiresAt(id) {
    const record = this.sessions.get(id);
    return record ? record.lastSeen + this.ttlMs : undefined;
  }

  terminate(id) {
    const existed = this.sessions.delete(id);
    if (existed) void this.save();
    return existed;
  }

  own(name, owner, details = {}) {
    this.owners.set(name, { owner, created: this.now(), ...details });
    void this.save();
  }
  release(name) {
    if (this.owners.delete(name)) void this.save();
  }
  /** Merge fields (for example the pane list) into an owned terminal session's record. */
  update(name, patch) {
    const record = this.owners.get(name);
    if (!record) return;
    Object.assign(record, patch);
    void this.save();
  }
  /** Each MCP session owns at most one terminal session. */
  sessionOf(owner) { return this.owned(owner)[0]; }
  clientName(owner) { return this.sessions.get(owner)?.client?.name ?? ''; }
  ownerOf(name) { return this.owners.get(name)?.owner; }
  ownership(name) { return this.owners.get(name); }
  owned(owner) {
    return [...this.owners].filter(([, record]) => record.owner === owner).map(([name]) => name);
  }

  /** Adoptable: the owning MCP session ended, expired, or has been idle past the orphan threshold. */
  isOrphaned(owner) {
    const record = this.sessions.get(owner);
    return !record || this.now() - record.lastSeen > this.orphanAfterMs;
  }
  orphanedSessions() {
    return [...this.owners].filter(([, record]) => this.isOrphaned(record.owner)).map(([name, record]) => {
      const session = this.sessions.get(record.owner);
      return {
        session: name,
        owner_idle_minutes: session ? Math.round((this.now() - session.lastSeen) / 60_000) : null,
        expires_in_minutes: Math.max(0, Math.round(((session ? session.lastSeen : record.abandonedAt ?? this.now()) + this.ttlMs - this.now()) / 60_000)),
      };
    });
  }

  /**
   * Find what must be cleaned up now:
   * - `owners`: MCP sessions idle longer than the TTL (removed here; caller kills their terminals),
   * - `abandoned`: terminals whose owner record is gone (e.g. token rotated) for longer than the TTL.
   */
  sweep() {
    const now = this.now();
    const owners = [];
    for (const [id, record] of this.sessions) {
      if (now - record.lastSeen > this.ttlMs) { this.sessions.delete(id); owners.push(id); }
    }
    const expiredOwners = new Set(owners);
    const abandoned = [];
    let changed = owners.length > 0;
    for (const [name, record] of this.owners) {
      if (expiredOwners.has(record.owner) || this.sessions.has(record.owner)) continue;
      if (record.abandonedAt === undefined) { record.abandonedAt = now; changed = true; }
      else if (now - record.abandonedAt > this.ttlMs) abandoned.push(name);
    }
    if (changed) void this.save();
    return { owners, abandoned };
  }
}
