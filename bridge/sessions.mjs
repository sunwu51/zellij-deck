import { validSession, parseSessions, noSessions } from './protocol.mjs';

/** null means another route; false means a malformed session path. */
export function sessionRoute(url) {
  const match = /^\/sessions\/([^/?#]+)$/.exec(url || '');
  if (!match) return null;
  let name;
  try { name = decodeURIComponent(match[1]); } catch { return false; }
  return validSession(name) ? name : false;
}

/** Force deletes running AND exited sessions, including Zellij's resurrection data. */
export async function deleteSession(name, query) {
  if (!validSession(name)) throw new Error('Invalid session name.');
  let sessions;
  try { sessions = parseSessions((await query(['list-sessions', '--no-formatting'])).stdout); }
  catch (error) { if (noSessions(error)) sessions = []; else throw error; }
  if (!sessions.some(session => session.name === name)) return false;
  // Separate arguments, never a shell command. --force kills before deleting.
  await query(['delete-session', '--force', name]);
  return true;
}
