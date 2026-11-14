import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRoute, deleteSession } from '../bridge/sessions.mjs';

test('session deletion routes reject flags, paths and malformed encodings', () => {
  assert.equal(sessionRoute('/sessions/dev-1'), 'dev-1');
  assert.equal(sessionRoute('/sessions/%64ev'), 'dev');
  for (const route of ['/sessions/--help', '/sessions/%2e%2e', '/sessions/a%2fb', '/sessions/%', '/sessions/a%00']) assert.equal(sessionRoute(route), false);
  for (const route of ['/sessions', '/sessions/dev/snapshot', '/sessions/dev?force=true']) assert.equal(sessionRoute(route), null);
});

test('deletion force kills and deletes both running and exited sessions using separate args', async () => {
  for (const exited of [false, true]) {
    const calls = [];
    const query = async args => {
      calls.push(args);
      return { stdout: args[0] === 'list-sessions' ? `dev [Created 1h ago]${exited ? ' (EXITED - attach to resurrect)' : ''}\nother [Created 2h ago]\n` : '' };
    };
    assert.equal(await deleteSession('dev', query), true);
    assert.deepEqual(calls, [['list-sessions', '--no-formatting'], ['delete-session', '--force', 'dev']]);
  }
});

test('missing sessions are not deleted and errors are never swallowed', async () => {
  let calls = 0;
  assert.equal(await deleteSession('dev', async () => { calls++; return { stdout: '' }; }), false);
  assert.equal(calls, 1);
  assert.equal(await deleteSession('dev', async () => { throw { stderr: 'No sessions found.' }; }), false);
  await assert.rejects(deleteSession('--all', () => assert.fail('must validate before executing')), /Invalid session/);
  await assert.rejects(deleteSession('dev', async args => {
    if (args[0] === 'list-sessions') return { stdout: 'dev [Created 1h ago]\n' };
    throw new Error('permission denied');
  }), /permission denied/);
  await assert.rejects(deleteSession('dev', async () => { throw new Error('listing failed'); }), /listing failed/);
});
