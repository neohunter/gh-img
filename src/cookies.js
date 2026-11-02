// Reads the github.com session cookie straight from a Chromium-based browser's
// cookie store. The value only lives in this process' memory: it is never
// printed, logged, written to disk or passed as a command-line argument.

import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCookieHeader, SessionError } from './util.js';

const MAC = join(homedir(), 'Library', 'Application Support');
const LINUX = join(homedir(), '.config');

export const BROWSERS = {
  chrome: {
    darwin: { dir: join(MAC, 'Google/Chrome'), service: 'Chrome Safe Storage' },
    linux: { dir: join(LINUX, 'google-chrome'), app: 'chrome' },
  },
  brave: {
    darwin: { dir: join(MAC, 'BraveSoftware/Brave-Browser'), service: 'Brave Safe Storage' },
    linux: { dir: join(LINUX, 'BraveSoftware/Brave-Browser'), app: 'brave' },
  },
  edge: {
    darwin: { dir: join(MAC, 'Microsoft Edge'), service: 'Microsoft Edge Safe Storage' },
    linux: { dir: join(LINUX, 'microsoft-edge'), app: 'chromium' },
  },
  arc: {
    darwin: { dir: join(MAC, 'Arc/User Data'), service: 'Arc Safe Storage' },
  },
  chromium: {
    darwin: { dir: join(MAC, 'Chromium'), service: 'Chromium Safe Storage' },
    linux: { dir: join(LINUX, 'chromium'), app: 'chromium' },
  },
};

const COOKIE_NAMES = ['user_session', '__Host-user_session_same_site', 'dotcom_user'];

// ---- crypto -------------------------------------------------------------

export function deriveKey(password, iterations) {
  return pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

// Chromium "v10"/"v11" format: AES-128-CBC, IV = 16 spaces. Since cookie DB
// schema v24 the plaintext is prefixed with SHA256(host_key) (32 bytes).
export function decryptValue(encrypted, keys, stripHostHash) {
  if (!encrypted || encrypted.length < 4) return null;
  const prefix = Buffer.from(encrypted.subarray(0, 3)).toString('latin1');
  const key = keys[prefix];
  if (!key) return null;
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let out = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  if (stripHostHash) out = out.subarray(32);
  return out.toString('utf8');
}

function loadKeys(platform, cfg) {
  if (platform === 'darwin') {
    let password;
    try {
      password = execFileSync('security', ['find-generic-password', '-w', '-s', cfg.service], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new SessionError(
        `Could not read "${cfg.service}" from the macOS Keychain. ` +
          'Approve the Keychain prompt (choose "Always Allow" so it does not ask again).',
      );
    }
    return { v10: deriveKey(password, 1003) };
  }
  // Linux: v10 uses a hardcoded password, v11 uses the desktop keyring.
  let v11pw = '';
  try {
    v11pw = execFileSync('secret-tool', ['lookup', 'application', cfg.app], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* no keyring available */
  }
  return { v10: deriveKey('peanuts', 1), v11: deriveKey(v11pw, 1) };
}

// ---- profiles -----------------------------------------------------------

function browserConfig(browser) {
  const entry = BROWSERS[browser];
  if (!entry) throw new SessionError(`Unknown browser "${browser}". Options: ${Object.keys(BROWSERS).join(', ')}`);
  const cfg = entry[process.platform];
  if (!cfg) {
    const why =
      process.platform === 'win32'
        ? 'Chromium browsers on Windows use app-bound cookie encryption that only the browser itself can decrypt.'
        : `Reading ${browser} cookies is not supported on ${process.platform}.`;
    throw new SessionError(`${why} Save your session once with "gh-img login" (see README).`);
  }
  return cfg;
}

function profileNames(root) {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'));
    return Object.fromEntries(Object.entries(state.profile?.info_cache ?? {}).map(([k, v]) => [k, v.name]));
  } catch {
    return {};
  }
}

export function listProfiles(browser) {
  const cfg = browserConfig(browser);
  if (!existsSync(cfg.dir)) return [];
  const names = profileNames(cfg.dir);
  return readdirSync(cfg.dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const db = [join(cfg.dir, d.name, 'Cookies'), join(cfg.dir, d.name, 'Network', 'Cookies')].find(existsSync);
      return db ? { dir: d.name, label: names[d.name] ?? d.name, db } : null;
    })
    .filter(Boolean);
}

// ---- reading ------------------------------------------------------------

async function readRawCookies(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  // Copy the DB: the browser keeps it locked/open while running.
  const tmp = mkdtempSync(join(tmpdir(), 'gh-img-'));
  try {
    const copy = join(tmp, 'Cookies');
    copyFileSync(dbPath, copy);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy);
    try {
      const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0);
      const rows = db
        .prepare(
          `SELECT name, value, encrypted_value FROM cookies
           WHERE host_key IN ('github.com', '.github.com')
             AND name IN (${COOKIE_NAMES.map(() => '?').join(',')})
             AND (expires_utc = 0 OR expires_utc > (strftime('%s','now') + 11644473600) * 1000000)`,
        )
        .all(...COOKIE_NAMES);
      return { version, rows };
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Finds a logged-in github.com session in the browser.
 * @returns {{ cookieHeader: string, login: string|null, profile: string, browser: string }}
 */
export async function getBrowserSession({ browser = 'chrome', profile, user, preferLogin, log = () => {} } = {}) {
  const cfg = browserConfig(browser);
  let profiles = listProfiles(browser);
  if (!profiles.length) throw new SessionError(`No ${browser} profiles found in ${cfg.dir}.`);
  if (profile) {
    profiles = profiles.filter((p) => p.dir === profile || p.label === profile);
    if (!profiles.length) throw new SessionError(`${browser} profile "${profile}" not found. Run "gh-img doctor" to list profiles.`);
  }

  let keys;
  const sessions = [];
  for (const p of profiles) {
    let raw;
    try {
      raw = await readRawCookies(p.db);
    } catch (e) {
      log(`skip profile "${p.label}": ${e.message}`);
      continue;
    }
    if (!raw.rows.some((r) => r.name === 'user_session')) continue;
    keys ??= loadKeys(process.platform, cfg);
    const values = {};
    for (const r of raw.rows) {
      values[r.name] = r.value || decryptValue(r.encrypted_value, keys, raw.version >= 24);
    }
    if (values.user_session) {
      sessions.push({ profile: p.label, dir: p.dir, login: values.dotcom_user ?? null, values });
    }
  }

  if (!sessions.length) {
    throw new SessionError(`No logged-in github.com session found in ${browser}. Log in to github.com in the browser and retry.`);
  }

  const wanted = user ?? preferLogin;
  let chosen = sessions.find((s) => wanted && s.login?.toLowerCase() === wanted.toLowerCase());
  if (!chosen && user) {
    throw new SessionError(
      `No ${browser} profile is logged into GitHub as "${user}". Found: ${sessions.map((s) => `${s.login} (${s.profile})`).join(', ')}`,
    );
  }
  chosen ??= sessions[0];
  if (new Set(sessions.map((s) => s.login)).size > 1) {
    log(`multiple GitHub sessions found, using ${chosen.login} (${chosen.profile}); use --user/--profile to choose`);
  }

  const v = chosen.values;
  const cookieHeader = buildCookieHeader(v.user_session, { sameSite: v['__Host-user_session_same_site'], login: chosen.login });
  return { cookieHeader, login: chosen.login, profile: chosen.profile, browser, all: sessions.map(({ login, profile }) => ({ login, profile })) };
}
