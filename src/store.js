// Manually saved session (fallback when the browser cookie can't be read).
//
//   macOS    Keychain (security CLI)
//   Windows  file encrypted with DPAPI for the current Windows user (PowerShell)
//   Linux    Secret Service (secret-tool), else a 0600 file
//
// The token is handed to OS tools via stdin or a child-only environment
// variable, never via argv (argv is visible to other users through `ps`).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { UserError } from './util.js';

// Overridable so tests never touch the real saved session.
const NAME = process.env.GH_IMG_STORE_NAME || 'gh-img';
const ACCOUNT = 'user_session';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

function storeFile() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), NAME, 'session.dpapi');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), NAME, 'session');
}

export function normalizeToken(input) {
  let t = (input ?? '')
    .replace(/\x1b\[20[01]~/g, '') // bracketed-paste markers
    .replace(/[\x00-\x1f\x7f]/g, '') // stray control characters
    .trim()
    .replace(/^["']|["']$/g, '');
  // Accept the bare value or a pasted "user_session=XXXX; ..." fragment.
  const m = /(?:^|[;\s])user_session=([^;\s]+)/.exec(t);
  if (m) t = m[1];
  if (!TOKEN_RE.test(t)) throw new UserError('That does not look like a GitHub user_session value.');
  return t;
}

function run(cmd, args, { input, env } = {}) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
}

function hasCmd(cmd) {
  return run(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
}

// Windows PowerShell 5.1 is always present. Inheriting PSModulePath from a
// PowerShell 7 parent breaks module loading in 5.1, so it is dropped, and the
// scripts below only use .NET types (no cmdlets/modules at all).
function powershell(script, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', env, windowsHide: true },
  );
}

// ---- Windows DPAPI -------------------------------------------------------
// The file holds base64(DPAPI(token)), decryptable only by the same Windows user.

const DPAPI = `[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
$entropy = [Text.Encoding]::UTF8.GetBytes('gh-img')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser`;

function winSave(token, file) {
  const r = powershell(
    `${DPAPI}
     $plain = [Text.Encoding]::UTF8.GetBytes($env:GH_IMG_SECRET)
     [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($plain, $entropy, $scope)))`,
    { GH_IMG_SECRET: token },
  );
  const blob = r.stdout?.trim();
  if (r.status !== 0 || !blob) throw new UserError(`Could not encrypt the session with DPAPI: ${(r.stderr || '').trim().slice(0, 300)}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, blob);
}

function winRead(file) {
  const r = powershell(
    `${DPAPI}
     $blob = [Convert]::FromBase64String($env:GH_IMG_BLOB)
     [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, $scope)))`,
    { GH_IMG_BLOB: readFileSync(file, 'utf8').trim() },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---- public API ------------------------------------------------------------

export function saveStoredSession(token) {
  token = normalizeToken(token);
  if (process.platform === 'darwin') {
    // `security -i` reads commands from stdin, keeping the secret out of argv.
    const r = run('security', ['-i'], {
      input: `add-generic-password -U -s ${NAME} -a ${ACCOUNT} -l "${NAME} GitHub session" -w "${token}"\n`,
    });
    if (r.status !== 0) throw new UserError(`Could not save to the Keychain: ${r.stderr.trim()}`);
    return 'macOS Keychain';
  }
  const file = storeFile();
  if (process.platform === 'win32') {
    winSave(token, file);
    return `${file} (encrypted with Windows DPAPI)`;
  }
  if (hasCmd('secret-tool')) {
    const r = run('secret-tool', ['store', `--label=${NAME} GitHub session`, 'service', NAME, 'account', ACCOUNT], { input: token });
    if (r.status === 0) return 'Secret Service keyring';
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function readStoredSession() {
  const file = storeFile();
  if (process.platform === 'darwin') {
    const r = run('security', ['find-generic-password', '-s', NAME, '-a', ACCOUNT, '-w']);
    return r.status === 0 && r.stdout.trim() ? { token: r.stdout.trim(), where: 'macOS Keychain' } : null;
  }
  if (process.platform === 'win32') {
    if (!existsSync(file)) return null;
    const token = winRead(file);
    return token ? { token, where: `${file} (DPAPI)` } : null;
  }
  if (hasCmd('secret-tool')) {
    const r = run('secret-tool', ['lookup', 'service', NAME, 'account', ACCOUNT]);
    if (r.status === 0 && r.stdout.trim()) return { token: r.stdout.trim(), where: 'Secret Service keyring' };
  }
  return existsSync(file) ? { token: readFileSync(file, 'utf8').trim(), where: file } : null;
}

export function deleteStoredSession() {
  let removed = false;
  if (process.platform === 'darwin') {
    removed = run('security', ['delete-generic-password', '-s', NAME, '-a', ACCOUNT]).status === 0;
  } else if (process.platform === 'linux' && hasCmd('secret-tool')) {
    removed = run('secret-tool', ['clear', 'service', NAME, 'account', ACCOUNT]).status === 0;
  }
  const file = storeFile();
  if (existsSync(file)) {
    rmSync(file);
    removed = true;
  }
  return removed;
}

// ---- input helpers ---------------------------------------------------------

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

function clipboardTools() {
  if (process.platform === 'darwin') {
    return { read: () => run('pbpaste', []), clear: () => run('pbcopy', [], { input: '' }) };
  }
  if (process.platform === 'win32') {
    const forms = "[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')";
    return {
      read: () => powershell(`${forms}; [Console]::Out.Write([Windows.Forms.Clipboard]::GetText())`),
      clear: () => powershell(`${forms}; [Windows.Forms.Clipboard]::Clear()`),
    };
  }
  if (hasCmd('wl-paste')) {
    return { read: () => run('wl-paste', ['--no-newline']), clear: () => run('wl-copy', ['--clear']) };
  }
  if (hasCmd('xclip')) {
    return {
      read: () => run('xclip', ['-selection', 'clipboard', '-o']),
      clear: () => run('xclip', ['-selection', 'clipboard'], { input: '' }),
    };
  }
  if (hasCmd('xsel')) {
    return { read: () => run('xsel', ['--clipboard', '--output']), clear: () => run('xsel', ['--clipboard', '--clear']) };
  }
  throw new UserError('No clipboard tool found (install wl-clipboard, xclip or xsel), or run "gh-img login" and paste the value.');
}

export function readClipboard({ clear = true } = {}) {
  const tools = clipboardTools();
  const r = tools.read();
  if (r.status !== 0) throw new UserError('Could not read the clipboard.');
  if (clear) tools.clear(); // don't leave the secret sitting in the clipboard
  return r.stdout;
}
