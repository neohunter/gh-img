import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { test } from 'node:test';
import { decryptValue, deriveKey } from '../src/cookies.js';
import { extractRepositoryId, extractUploadToken, extractUserLogin } from '../src/session-upload.js';
import { altFromFilename, fileInfo, formatResult, parseRepo, repoFromRemoteUrl } from '../src/util.js';

function encrypt(plain, key, { hostHash } = {}) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const payload = hostHash ? Buffer.concat([createHash('sha256').update('.github.com').digest(), Buffer.from(plain)]) : Buffer.from(plain);
  return Buffer.concat([Buffer.from('v10'), cipher.update(payload), cipher.final()]);
}

test('decrypts macOS v10 cookies (old schema)', () => {
  const key = deriveKey('secret-from-keychain', 1003);
  assert.equal(decryptValue(encrypt('abc123', key), { v10: key }, false), 'abc123');
});

test('decrypts v10 cookies with host hash prefix (schema >= 24)', () => {
  const key = deriveKey('secret-from-keychain', 1003);
  assert.equal(decryptValue(encrypt('abc123', key, { hostHash: true }), { v10: key }, true), 'abc123');
});

test('returns null for unknown cookie encryption formats', () => {
  assert.equal(decryptValue(Buffer.from('xyz-something'), { v10: deriveKey('x', 1) }, false), null);
  assert.equal(decryptValue(Buffer.alloc(0), {}, false), null);
});

test('extracts the upload token from React payloads and legacy markup', () => {
  assert.equal(extractUploadToken('{"foo":1,"uploadToken":"tok_React","bar":2}'), 'tok_React');
  assert.equal(
    extractUploadToken('<input type="hidden" value="tok_legacy" data-csrf="true" class="js-data-upload-policy-url-csrf" />'),
    'tok_legacy',
  );
  assert.equal(
    extractUploadToken('<input type="hidden" class="js-data-upload-policy-url-csrf" data-csrf="true" value="tok_rev" />'),
    'tok_rev',
  );
  assert.equal(extractUploadToken('<html>nothing</html>'), null);
});

test('detects logged-out pages and repository ids', () => {
  assert.equal(extractUserLogin('<meta name="user-login" content="">'), '');
  assert.equal(extractUserLogin('<meta name="user-login" content="octocat">'), 'octocat');
  assert.equal(extractUserLogin('<html></html>'), null);
  assert.equal(extractRepositoryId('<meta name="octolytics-dimension-repository_id" content="12345">'), '12345');
});

test('derives alt text from file names', () => {
  assert.equal(altFromFilename('01-dashboard_empty-state.png'), 'dashboard empty state');
  assert.equal(altFromFilename('login.png'), 'login');
  assert.equal(altFromFilename('2024.png'), '2024');
});

test('formats output per file kind', () => {
  const url = 'https://github.com/user-attachments/assets/uuid';
  assert.equal(formatResult(url, fileInfo('a/02-home.png')), `![home](${url})`);
  assert.equal(formatResult(url, fileInfo('demo.mp4')), url);
  assert.equal(formatResult(url, fileInfo('report.pdf')), `[report.pdf](${url})`);
  assert.equal(formatResult(url, fileInfo('x.png'), { format: 'url' }), url);
  assert.equal(formatResult(url, fileInfo('x.png'), { format: 'html', width: '600', alt: 'A "B"' }), `<img src="${url}" alt="A &quot;B&quot;" width="600" />`);
  assert.throws(() => fileInfo('virus.exe'), /Unsupported/);
});

test('parses repos and remotes', () => {
  assert.deepEqual(parseRepo('acme/web.app'), { owner: 'acme', repo: 'web.app' });
  assert.throws(() => parseRepo('nope'));
  assert.deepEqual(repoFromRemoteUrl('git@github.com:acme/web.git\n'), { owner: 'acme', repo: 'web' });
  assert.deepEqual(repoFromRemoteUrl('https://github.com/acme/web'), { owner: 'acme', repo: 'web' });
  assert.equal(repoFromRemoteUrl('https://gitlab.com/acme/web'), null);
});

test('normalizes manually pasted session values', async () => {
  const { normalizeToken } = await import('../src/store.js');
  const tok = 'AbCdEf0123456789_-AbCdEf0123456789';
  assert.equal(normalizeToken(`  ${tok}\n`), tok);
  assert.equal(normalizeToken(`"${tok}"`), tok);
  assert.equal(normalizeToken(`_octo=1; user_session=${tok}; logged_in=yes`), tok);
  assert.throws(() => normalizeToken('short'), /does not look like/);
  assert.throws(() => normalizeToken(`${tok}" ; rm -rf /`), /does not look like/);
});
