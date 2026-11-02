// Round-trips the saved-session store on the real OS backend
// (macOS Keychain, Windows DPAPI, Linux keyring/file), using an isolated name
// so a developer's real saved session is never touched.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.GH_IMG_STORE_NAME = `gh-img-test-${process.pid}`;
const { deleteStoredSession, readStoredSession, saveStoredSession } = await import('../src/store.js');

const TOKEN = 'TestToken_0123456789-abcdefghijklmnop';

before(() => deleteStoredSession());
after(() => deleteStoredSession());

test(`stores, reads and deletes a session on ${process.platform}`, () => {
  assert.equal(readStoredSession(), null);
  const where = saveStoredSession(`user_session=${TOKEN}; logged_in=yes`);
  assert.ok(where);
  const stored = readStoredSession();
  assert.equal(stored?.token, TOKEN);
  assert.equal(deleteStoredSession(), true);
  assert.equal(readStoredSession(), null);
});

test('overwrites an existing saved session', () => {
  saveStoredSession(TOKEN);
  saveStoredSession(`${TOKEN}2`);
  assert.equal(readStoredSession()?.token, `${TOKEN}2`);
});

test('strips paste artifacts from the terminal', async () => {
  const { normalizeToken } = await import('../src/store.js');
  assert.equal(normalizeToken(`\x1b[200~${TOKEN}\x1b[201~\r\n`), TOKEN);
  assert.equal(normalizeToken(`\x16${TOKEN}`), TOKEN);
});
