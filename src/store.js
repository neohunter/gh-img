// Manually saved session (fallback when the browser cookie can't be read).
// macOS: Keychain. Linux: Secret Service (secret-tool), else a 0600 file.
// The token is passed to the OS tools through stdin, never via argv (argv is
// visible to other processes through `ps`).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { UserError } from './util.js';

const SERVICE = 'gh-img';
const ACCOUNT = 'user_session';
const FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gh-img', 'session');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

export function normalizeToken(input) {
  // Accept the bare value or a pasted "user_session=XXXX; ..." fragment.
  let t = (input ?? '').trim().replace(/^["']|["']$/g, '');
  const m = /(?:^|[;\s])user_session=([^;\s]+)/.exec(t);
  if (m) t = m[1];
  if (!TOKEN_RE.test(t)) throw new UserError('That does not look like a GitHub user_session value.');
  return t;
}

function run(cmd, args, input) {
  return spawnSync(cmd, args, { input, encoding: 'utf8' });
}

function hasCmd(cmd) {
  return !run('which', [cmd]).status;
}

export function saveStoredSession(token) {
  token = normalizeToken(token);
  if (process.platform === 'darwin') {
    // `security -i` reads commands from stdin, keeping the secret out of argv.
    const r = run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "gh-img GitHub session" -w "${token}"\n`);
    if (r.status !== 0) throw new UserError(`Could not save to the Keychain: ${r.stderr.trim()}`);
    return 'macOS Keychain';
  }
  if (process.platform === 'linux' && hasCmd('secret-tool')) {
    const r = run('secret-tool', ['store', '--label=gh-img GitHub session', 'service', SERVICE, 'account', ACCOUNT], token);
    if (r.status === 0) return 'Secret Service keyring';
  }
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, token, { mode: 0o600 });
  chmodSync(FILE, 0o600);
  return FILE;
}

export function readStoredSession() {
  if (process.platform === 'darwin') {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    if (r.status === 0 && r.stdout.trim()) return { token: r.stdout.trim(), where: 'macOS Keychain' };
  } else if (process.platform === 'linux' && hasCmd('secret-tool')) {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    if (r.status === 0 && r.stdout.trim()) return { token: r.stdout.trim(), where: 'Secret Service keyring' };
  }
  if (existsSync(FILE)) return { token: readFileSync(FILE, 'utf8').trim(), where: FILE };
  return null;
}

export function deleteStoredSession() {
  let removed = false;
  if (process.platform === 'darwin') {
    removed = run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]).status === 0 || removed;
  } else if (process.platform === 'linux' && hasCmd('secret-tool')) {
    removed = run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]).status === 0 || removed;
  }
  if (existsSync(FILE)) {
    rmSync(FILE);
    removed = true;
  }
  return removed;
}

// Reads a secret from the terminal without echoing it.
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return reject(new UserError('No terminal available. Use --clipboard or pipe the value via stdin.'));
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          cleanup();
          stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          cleanup();
          stderr.write('\n');
          return reject(new UserError('Cancelled.'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export function readClipboard({ clear = true } = {}) {
  const [get, set] =
    process.platform === 'darwin'
      ? [['pbpaste', []], ['pbcopy', []]]
      : [['xclip', ['-selection', 'clipboard', '-o']], ['xclip', ['-selection', 'clipboard']]];
  const r = run(get[0], get[1]);
  if (r.status !== 0) throw new UserError(`Could not read the clipboard (${get[0]}).`);
  if (clear) run(set[0], set[1], ''); // don't leave the secret sitting in the clipboard
  return r.stdout;
}
