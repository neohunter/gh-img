import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createBranchUploader, DEFAULT_BRANCH } from './branch-upload.js';
import { BROWSERS, getBrowserSession, listProfiles } from './cookies.js';
import { ghApi, ghLogin, resolveRepo } from './gh.js';
import { createSessionUploader, validateSession } from './session-upload.js';
import { deleteStoredSession, normalizeToken, promptHidden, readClipboard, readStdin, readStoredSession, saveStoredSession } from './store.js';
import { buildCookieHeader, fileInfo, formatResult, SessionError, UserError } from './util.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `gh-img ${VERSION} — upload screenshots to GitHub and print ready-to-paste markdown

Usage
  gh-img [options] <file...>      upload files, one result line per file (stdout)
  gh-img doctor [options]         check setup without uploading anything
  gh-img login [--clipboard]      save a user_session manually (fallback when the
                                  browser cookie can't be read); run it yourself,
                                  never through an agent
  gh-img logout                   delete the saved session

Options
  -R, --repo <owner/repo>   target repo (default: repo of the current directory)
  -m, --mode <mode>         session | auto | branch            (default: session)
                              session  user-attachments via your browser session
                              auto     session, falls back to branch on failure
                              branch   commit to an orphan branch (official API only)
  -f, --format <fmt>        markdown | html | url              (default: markdown)
      --alt <text>          alt text (default: derived from the file name)
      --width <px>          image width, only with --format html
  -b, --browser <name>      ${Object.keys(BROWSERS).join(' | ')} (default: chrome)
  -p, --profile <name>      browser profile dir or display name (default: auto)
  -u, --user <login>        pick the browser profile logged into this GitHub user
  -s, --source <src>        auto | browser | stored  where to get the session
                              (default: auto = browser, then saved session)
      --clipboard           login: read the value from the clipboard (then clear it)
      --branch <name>       branch for --mode branch/auto      (default: ${DEFAULT_BRANCH})
  -v, --verbose             print progress to stderr (never secrets)
  -h, --help                show this help
  -V, --version             show version

Environment
  GH_IMG_REPO, GH_IMG_MODE, GH_IMG_BROWSER, GH_IMG_PROFILE, GH_IMG_USER, GH_IMG_BRANCH,
  GH_IMG_SOURCE
  GH_IMG_SESSION   user_session value (CI only; overrides everything — avoid with agents)

Examples
  gh-img screenshot.png
  gh-img -R acme/web shots/*.png
  gh pr comment 42 --body "$(gh-img before.png after.png)"
  gh-img --format html --width 600 dashboard.png`;

const OPTIONS = {
  repo: { type: 'string', short: 'R' },
  mode: { type: 'string', short: 'm' },
  format: { type: 'string', short: 'f', default: 'markdown' },
  alt: { type: 'string' },
  width: { type: 'string' },
  browser: { type: 'string', short: 'b' },
  profile: { type: 'string', short: 'p' },
  user: { type: 'string', short: 'u' },
  source: { type: 'string', short: 's' },
  clipboard: { type: 'boolean', default: false },
  branch: { type: 'string' },
  verbose: { type: 'boolean', short: 'v', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
};

export async function main(argv) {
  let opts;
  let positionals;
  try {
    ({ values: opts, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }));
  } catch (e) {
    console.error(`gh-img: ${e.message}\nRun "gh-img --help" for usage.`);
    return 2;
  }
  if (opts.help) return console.log(HELP), 0;
  if (opts.version) return console.log(VERSION), 0;

  const env = process.env;
  const cfg = {
    mode: opts.mode ?? env.GH_IMG_MODE ?? 'session',
    browser: opts.browser ?? env.GH_IMG_BROWSER ?? 'chrome',
    profile: opts.profile ?? env.GH_IMG_PROFILE,
    user: opts.user ?? env.GH_IMG_USER,
    source: opts.source ?? env.GH_IMG_SOURCE ?? 'auto',
    branch: opts.branch ?? env.GH_IMG_BRANCH ?? DEFAULT_BRANCH,
    format: opts.format,
    log: opts.verbose ? (msg) => console.error(`gh-img: ${msg}`) : () => {},
  };

  try {
    if (!['session', 'auto', 'branch'].includes(cfg.mode)) throw new UserError(`Invalid --mode "${cfg.mode}".`);
    if (!['markdown', 'html', 'url'].includes(cfg.format)) throw new UserError(`Invalid --format "${cfg.format}".`);
    if (!['auto', 'browser', 'stored'].includes(cfg.source)) throw new UserError(`Invalid --source "${cfg.source}".`);
    if (positionals[0] === 'doctor') return await doctor(opts, cfg);
    if (positionals[0] === 'login') return await login(opts);
    if (positionals[0] === 'logout') {
      console.log(deleteStoredSession() ? 'Saved session deleted.' : 'No saved session found.');
      return 0;
    }
    if (!positionals.length) {
      console.error(HELP);
      return 2;
    }
    return await upload(positionals, opts, cfg);
  } catch (e) {
    console.error(`gh-img: ${e instanceof UserError ? e.message : e.stack}`);
    return 1;
  }
}

async function upload(paths, opts, cfg) {
  const files = paths.map((p) => {
    if (!existsSync(p) || !statSync(p).isFile()) throw new UserError(`File not found: ${p}`);
    return fileInfo(p);
  });
  if (opts.alt && files.length > 1) throw new UserError('--alt can only be used with a single file.');

  const { owner, repo } = resolveRepo(opts.repo);
  cfg.log(`repo ${owner}/${repo}, mode ${cfg.mode}`);

  let sessionUpload = null;
  if (cfg.mode !== 'branch') {
    try {
      sessionUpload = await sessionUploader(owner, repo, cfg);
    } catch (e) {
      if (cfg.mode === 'session' || !(e instanceof SessionError)) {
        throw new UserError(`${e.message}\n  Tip: --mode auto falls back to an orphan branch (official API, no browser session).`);
      }
      console.error(`gh-img: warning: ${e.message}\ngh-img: falling back to branch "${cfg.branch}".`);
    }
  }
  let branchUpload = null;
  const getBranchUpload = () => (branchUpload ??= createBranchUploader({ owner, repo, branch: cfg.branch, log: cfg.log }));

  let failures = 0;
  for (const file of files) {
    let url;
    try {
      if (sessionUpload) {
        try {
          url = await sessionUpload(file);
        } catch (e) {
          if (cfg.mode !== 'auto' || !(e instanceof SessionError)) throw e;
          console.error(`gh-img: warning: ${e.message}; using branch fallback for ${file.name}`);
          url = await getBranchUpload()(file);
        }
      } else {
        url = await getBranchUpload()(file);
      }
      console.log(formatResult(url, file, { format: cfg.format, alt: opts.alt, width: opts.width }));
    } catch (e) {
      failures++;
      console.error(`gh-img: ${file.name}: ${e instanceof UserError ? e.message : e.stack}`);
    }
  }
  return failures ? 1 : 0;
}

// Candidate sessions in priority order. Each returns { label, cookieHeader } or null.
function sessionSources(cfg) {
  if (process.env.GH_IMG_SESSION) {
    return [() => ({ label: 'GH_IMG_SESSION', cookieHeader: buildCookieHeader(normalizeToken(process.env.GH_IMG_SESSION)) })];
  }
  const sources = [];
  if (cfg.source !== 'stored') {
    sources.push(async () => {
      const s = await getBrowserSession({
        browser: cfg.browser,
        profile: cfg.profile,
        user: cfg.user,
        preferLogin: cfg.user ? undefined : ghLogin(),
        log: cfg.log,
      });
      return { label: `${s.browser} profile "${s.profile}" (${s.login ?? 'unknown user'})`, cookieHeader: s.cookieHeader };
    });
  }
  if (cfg.source !== 'browser') {
    sources.push(() => {
      const stored = readStoredSession();
      if (!stored) throw new SessionError('No saved session (run "gh-img login" to save one).');
      return { label: `saved session (${stored.where})`, cookieHeader: buildCookieHeader(stored.token) };
    });
  }
  return sources;
}

function repoIdViaApi(owner, repo) {
  try {
    return ghApi(`repos/${owner}/${repo}`).id;
  } catch {
    return undefined; // scraped from the page instead
  }
}

// Tries each session source until one can obtain an upload token for the repo.
async function sessionUploader(owner, repo, cfg, report = () => {}) {
  const repoId = repoIdViaApi(owner, repo);
  const errors = [];
  for (const source of sessionSources(cfg)) {
    try {
      const s = await source();
      cfg.log(`trying ${s.label}`);
      const upload = await createSessionUploader({ owner, repo, cookieHeader: s.cookieHeader, repoId, log: cfg.log });
      report(s.label);
      return upload;
    } catch (e) {
      if (!(e instanceof SessionError)) throw e;
      cfg.log(e.message);
      errors.push(e.message);
    }
  }
  throw new SessionError(errors.join('\n  ') + '\n  Fix: log in to github.com in the browser, or save a session with "gh-img login".');
}

async function login(opts) {
  let raw;
  if (opts.clipboard) raw = readClipboard();
  else if (!process.stdin.isTTY) raw = await readStdin();
  else {
    console.error('Paste the value of the github.com "user_session" cookie');
    console.error('(Chrome DevTools > Application > Cookies > https://github.com). Input is hidden.');
    raw = await promptHidden('user_session: ');
  }
  const token = normalizeToken(raw);
  const login = await validateSession(buildCookieHeader(token));
  const where = saveStoredSession(token);
  console.error(`✓ Valid session for ${login}, saved in ${where}.`);
  return 0;
}

async function doctor(opts, cfg) {
  let ok = true;
  const pass = (m) => console.log(`✓ ${m}`);
  const fail = (m) => ((ok = false), console.log(`✗ ${m}`));
  const info = (m) => console.log(`  ${m}`);

  const [major, minor] = process.versions.node.split('.').map(Number);
  major > 22 || (major === 22 && minor >= 13) ? pass(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} (need >= 22.13)`);

  const login = ghLogin();
  login ? pass(`gh authenticated as ${login}`) : fail('gh not authenticated (run: gh auth login) — needed for repo lookup and --mode branch');

  let target = null;
  try {
    target = resolveRepo(opts.repo);
    pass(`repo ${target.owner}/${target.repo}`);
  } catch (e) {
    info(`no repo detected (${e.message.split('.')[0]}); pass --repo to test uploads`);
  }

  let anySession = false;
  if (cfg.source !== 'stored') {
    try {
      const profiles = listProfiles(cfg.browser);
      pass(`${cfg.browser}: ${profiles.length} profile(s): ${profiles.map((p) => `${p.label} [${p.dir}]`).join(', ')}`);
      const session = await getBrowserSession({ browser: cfg.browser, profile: cfg.profile, user: cfg.user, preferLogin: login, log: cfg.log });
      for (const s of session.all) info(`GitHub session: ${s.login ?? '?'} in profile "${s.profile}"`);
      anySession = true;
      pass(`browser session of ${session.login ?? 'unknown user'} (profile "${session.profile}") — read in memory, not shown`);
    } catch (e) {
      info(`browser session: ${e.message}`);
    }
  }
  const stored = readStoredSession();
  if (stored) {
    try {
      anySession = cfg.source !== 'browser' || anySession;
      pass(`saved session in ${stored.where} is valid for ${await validateSession(buildCookieHeader(stored.token))}`);
    } catch (e) {
      info(`saved session in ${stored.where}: ${e.message} Run "gh-img login" again.`);
    }
  } else {
    info('no saved session (optional fallback: "gh-img login")');
  }

  if (!anySession) fail('no usable GitHub session (log in to github.com in the browser, or run "gh-img login")');

  if (target) {
    try {
      await sessionUploader(target.owner, target.repo, cfg, (label) =>
        pass(`upload token obtained for ${target.owner}/${target.repo} using ${label} — ready to upload`),
      );
    } catch (e) {
      fail(e.message);
      info('You can still use --mode branch (official API, commits to an orphan branch).');
    }
  }
  return ok ? 0 : 1;
}
