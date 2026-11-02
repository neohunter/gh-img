// Uploads files the same way github.com does when you drag & drop an image into
// a comment box. Result: https://github.com/user-attachments/assets/<uuid>
// (nothing is committed to the repository).
//
// Flow:
//   1. GET the repo page with the session cookie -> scrape the upload CSRF token
//   2. POST /upload/policies/assets                -> S3 policy + finalize token
//   3. POST file to S3 (no GitHub cookies sent there)
//   4. PUT  asset_upload_url                       -> marks the asset as uploaded

import { readFileSync } from 'node:fs';
import { SessionError } from './util.js';

const GITHUB = 'https://github.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const TOKEN_PATTERNS = [
  /"uploadToken":"([^"]+)"/,
  /class="[^"]*js-data-upload-policy-url-csrf[^"]*"[^>]*?value="([^"]+)"/,
  /value="([^"]+)"[^>]*?class="[^"]*js-data-upload-policy-url-csrf/,
];

export function extractUploadToken(html) {
  for (const re of TOKEN_PATTERNS) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

// '' -> logged out; null -> tag not present
export function extractUserLogin(html) {
  const m = /<meta name="user-login" content="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

export function extractRepositoryId(html) {
  const m = /name="octolytics-dimension-repository_id" content="(\d+)"/.exec(html) ?? /"repository_id":(\d+)/.exec(html);
  return m ? m[1] : null;
}

// Never include response bodies from github.com in errors (could echo page data);
// short S3/JSON error bodies are fine.
function snippet(text) {
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

// Returns the GitHub login the cookie belongs to, or throws if it is not valid.
export async function validateSession(cookieHeader) {
  const res = await fetch(`${GITHUB}/settings/profile`, {
    headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) throw new SessionError('GitHub rejected that session (expired or invalid).');
  if (!res.ok) throw new SessionError(`Could not validate the session (HTTP ${res.status}).`);
  const login = extractUserLogin(await res.text());
  if (!login) throw new SessionError('GitHub rejected that session (expired or invalid).');
  return login;
}

export async function createSessionUploader({ owner, repo, cookieHeader, repoId, log = () => {} }) {
  const referer = `${GITHUB}/${owner}/${repo}`;
  const base = { Cookie: cookieHeader, 'User-Agent': UA };

  let token = null;
  for (const path of ['', '/issues/new']) {
    const res = await fetch(referer + path, { headers: { ...base, Accept: 'text/html' }, redirect: 'manual' });
    log(`GET ${owner}/${repo}${path} -> ${res.status}`);
    if (res.status >= 300 && res.status < 400) {
      if (/\/login/.test(res.headers.get('location') ?? '')) {
        throw new SessionError('The browser session is expired. Open github.com in the browser (log in again) and retry.');
      }
      continue;
    }
    if (res.status === 404) {
      throw new SessionError(`${owner}/${repo} is not visible with the browser session (404). Is that browser profile logged into an account with access?`);
    }
    if (!res.ok) continue;
    const html = await res.text();
    if (extractUserLogin(html) === '') {
      throw new SessionError('github.com treats the browser session as logged out. Log in again in the browser and retry.');
    }
    repoId ??= extractRepositoryId(html);
    token = extractUploadToken(html);
    if (token) break;
  }
  if (!token) {
    throw new SessionError(`Upload token not found for ${owner}/${repo}. You need write access (or GitHub changed its page markup).`);
  }
  if (!repoId) throw new SessionError(`Could not determine the repository id of ${owner}/${repo}.`);

  const xhr = {
    ...base,
    Accept: 'application/json',
    Origin: GITHUB,
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
    'GitHub-Verified-Fetch': 'true',
  };

  return async function upload(file) {
    const bytes = readFileSync(file.path);

    // 1. policy
    const policyForm = new FormData();
    policyForm.set('name', file.name);
    policyForm.set('size', String(bytes.length));
    policyForm.set('content_type', file.type);
    policyForm.set('authenticity_token', token);
    policyForm.set('repository_id', String(repoId));
    const policyRes = await fetch(`${GITHUB}/upload/policies/assets`, { method: 'POST', headers: xhr, body: policyForm });
    log(`policy ${file.name} -> ${policyRes.status}`);
    if (!policyRes.ok) {
      const body = await policyRes.text();
      const detail = policyRes.headers.get('content-type')?.includes('json') ? `: ${snippet(body)}` : '';
      throw new SessionError(`GitHub rejected the upload of ${file.name} (HTTP ${policyRes.status})${detail}`);
    }
    const policy = await policyRes.json();

    // 2. S3 (fields first, file last)
    const s3Form = new FormData();
    for (const [k, v] of Object.entries(policy.form ?? {})) s3Form.set(k, v);
    s3Form.set('file', new Blob([bytes], { type: file.type }), file.name);
    const s3Res = await fetch(policy.upload_url, { method: 'POST', headers: { ...(policy.header ?? {}) }, body: s3Form });
    log(`storage ${file.name} -> ${s3Res.status}`);
    if (!s3Res.ok) throw new SessionError(`Storage upload failed for ${file.name} (HTTP ${s3Res.status}): ${snippet(await s3Res.text())}`);

    // 3. finalize
    const finForm = new FormData();
    finForm.set('authenticity_token', policy.asset_upload_authenticity_token);
    const finRes = await fetch(new URL(policy.asset_upload_url, GITHUB), { method: 'PUT', headers: xhr, body: finForm });
    log(`finalize ${file.name} -> ${finRes.status}`);
    if (!finRes.ok) throw new SessionError(`Could not finalize ${file.name} (HTTP ${finRes.status})`);

    return policy.asset.href;
  };
}
