import { spawnSync } from 'node:child_process';
import { UserError, parseRepo, repoFromRemoteUrl } from './util.js';

// Thin wrapper around the gh CLI. gh handles its own auth; gh-img never sees that token.
export function gh(args, { input } = {}) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new UserError('gh CLI not found. Install it: https://cli.github.com');
    throw r.error;
  }
  if (r.status !== 0) {
    const err = new Error((r.stderr || r.stdout || `gh exited with ${r.status}`).trim());
    err.notFound = /HTTP 404/.test(r.stderr);
    throw err;
  }
  return r.stdout;
}

export function ghApi(path, { method, body } = {}) {
  const args = ['api', path];
  if (method) args.push('-X', method);
  if (body !== undefined) args.push('--input', '-');
  const out = gh(args, { input: body !== undefined ? JSON.stringify(body) : undefined });
  return out.trim() ? JSON.parse(out) : null;
}

export function ghLogin() {
  try {
    return gh(['api', 'user', '--jq', '.login']).trim() || null;
  } catch {
    return null;
  }
}

// --repo flag > GH_IMG_REPO > gh repo view (current dir) > git remote origin
export function resolveRepo(flag) {
  const explicit = flag || process.env.GH_IMG_REPO;
  if (explicit) return parseRepo(explicit);
  try {
    return parseRepo(gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim());
  } catch {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    const parsed = r.status === 0 ? repoFromRemoteUrl(r.stdout) : null;
    if (parsed) return parsed;
  }
  throw new UserError('Could not detect the repository. Run inside a GitHub repo or pass --repo owner/repo.');
}
