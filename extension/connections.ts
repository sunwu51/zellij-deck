import { validBridgeIp } from './network';

/** One bridge the extension can talk to. Credentials stay in extension storage, never in URLs. */
export type Connection = { id: string; name: string; host: string; port: number; token: string; lastSession?: string };
export type ConnectionInput = { name: string; host: string; port: number; token: string };
export type Health = 'online' | 'unauthorized' | 'offline';

export const MAX_NAME_LENGTH = 40;
/** The id migrated from the single pre-connections bridge; fixed so concurrent first loads agree. */
export const LOCAL_ID = 'local';
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const LEGACY_KEYS = ['host', 'port', 'token', 'session'] as const;

export function validConnectionId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
export function defaultName(host: string): string {
  return host === '127.0.0.1' ? 'Local' : host;
}

/** Returns the first problem with a connection, or undefined when it is usable. */
export function validateConnection(input: ConnectionInput): string | undefined {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return `Name must be 1–${MAX_NAME_LENGTH} characters.`;
  if (!validBridgeIp(input.host)) return 'Enter a specific IPv4 address, such as 192.168.1.10.';
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) return 'Port must be between 1024 and 65535.';
  if (!TOKEN_PATTERN.test(input.token)) return 'Paste the full pairing token printed by the bridge (32–256 letters, numbers, underscores, or hyphens).';
}

function checked(list: Connection[], input: ConnectionInput, ignoreId?: string): ConnectionInput {
  const clean = { name: input.name.trim(), host: input.host.trim(), port: input.port, token: input.token.trim() };
  const problem = validateConnection(clean);
  if (problem) throw new Error(problem);
  if (list.some(item => item.id !== ignoreId && item.host === clean.host && item.port === clean.port)) {
    throw new Error(`A connection to ${clean.host}:${clean.port} already exists.`);
  }
  return clean;
}
export function addConnection(list: Connection[], input: ConnectionInput, id: string = crypto.randomUUID()): Connection[] {
  return [...list, { id, ...checked(list, input) }];
}
export function updateConnection(list: Connection[], id: string, input: ConnectionInput): Connection[] {
  const clean = checked(list, input, id);
  return list.map(item => (item.id === id ? { ...item, ...clean } : item));
}
/** Removing the active connection falls back to the first remaining one. */
export function removeConnection(list: Connection[], active: string, id: string): { connections: Connection[]; active: string } {
  const connections = list.filter(item => item.id !== id);
  return { connections, active: connections.some(item => item.id === active) ? active : connections[0]?.id ?? '' };
}

export const httpBase = (c: Connection) => `http://${c.host}:${c.port}`;
export const wsUrl = (c: Connection) => `ws://${c.host}:${c.port}/terminal`;

/** Authenticated JSON request to one bridge. */
export async function bridgeJson<T>(c: Connection, path: string, options: { method?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`${httpBase(c)}${path}`, {
    method: options.method ?? 'GET',
    headers: { Authorization: `Bearer ${c.token}`, 'X-Side-Shell-Extension': chrome.runtime.id },
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
  let body: { error?: string } & T;
  try { body = await response.json(); } catch { throw new Error(`Bridge returned ${response.status}.`); }
  if (!response.ok) throw new Error(body.error || `Bridge returned ${response.status}.`);
  return body;
}

/** One cheap request (no Zellij involved), used only when the user asks for a status check. */
export async function checkHealth(c: Connection, fetchImpl: typeof fetch = fetch): Promise<Health> {
  try {
    const response = await fetchImpl(`${httpBase(c)}/health`, {
      headers: { Authorization: `Bearer ${c.token}`, 'X-Side-Shell-Extension': chrome.runtime.id },
      signal: AbortSignal.timeout(4000),
    });
    return response.ok ? 'online' : response.status === 401 ? 'unauthorized' : 'offline';
  } catch { return 'offline'; }
}

type Stored = { settings?: Record<string, unknown>; connections?: unknown; activeConnection?: unknown };
export type ConnectionState = { connections: Connection[]; active: string; settings?: Record<string, unknown>; migrated: boolean };

function sanitize(value: unknown): Connection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Connection => !!item && typeof item === 'object'
    && validConnectionId(item.id) && typeof item.name === 'string' && typeof item.host === 'string'
    && Number.isInteger(item.port) && typeof item.token === 'string');
}

/**
 * Pure migration from the single-bridge `settings.host/port/token` layout. Idempotent: once
 * `connections` exists nothing is derived from `settings` again.
 */
export function migrate(stored: Stored): ConnectionState {
  if (stored.connections !== undefined) {
    const connections = sanitize(stored.connections);
    const active = typeof stored.activeConnection === 'string' && connections.some(item => item.id === stored.activeConnection)
      ? stored.activeConnection : connections[0]?.id ?? '';
    return { connections, active, settings: stored.settings, migrated: false };
  }
  const old = stored.settings;
  const token = typeof old?.token === 'string' ? old.token : '';
  const connections: Connection[] = [];
  if (token) {
    const host = typeof old?.host === 'string' ? old.host : '127.0.0.1';
    connections.push({
      id: LOCAL_ID, name: defaultName(host), host,
      port: Number.isInteger(old?.port) ? (old!.port as number) : 17329, token,
      ...(typeof old?.session === 'string' && old.session ? { lastSession: old.session } : {}),
    });
  }
  let settings = stored.settings;
  if (settings) {
    settings = { ...settings };
    for (const key of LEGACY_KEYS) delete settings[key];
  }
  return { connections, active: connections[0]?.id ?? '', settings, migrated: true };
}

export async function loadConnections(): Promise<ConnectionState> {
  const stored = await chrome.storage.local.get(['settings', 'connections', 'activeConnection']) as Stored;
  const state = migrate(stored);
  if (state.migrated) {
    await chrome.storage.local.set({
      connections: state.connections, activeConnection: state.active,
      ...(state.settings ? { settings: state.settings } : {}),
    });
  }
  return state;
}
export async function saveConnections(connections: Connection[], active: string): Promise<void> {
  await chrome.storage.local.set({ connections, activeConnection: active });
}
/** Remember a window's last session on its own connection. */
export async function rememberSession(id: string, session: string): Promise<void> {
  const { connections, active } = await loadConnections();
  if (!connections.some(item => item.id === id && item.lastSession !== session)) return;
  await saveConnections(connections.map(item => (item.id === id ? { ...item, lastSession: session } : item)), active);
}
