// Fallback that only uses the official GitHub API (via gh): stores files in an
// orphan branch of the repo and returns a URL that renders in PRs/issues for
// anyone who can read the repo. Nothing touches your working branches.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ghApi } from './gh.js';

export const DEFAULT_BRANCH = 'gh-img-assets';

const README = `# gh-img assets

This orphan branch stores images referenced from pull requests and issues.
It was created by gh-img and shares no history with the main code.
`;

function sanitize(name) {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
}

function ensureBranch(owner, repo, branch, log) {
  try {
    ghApi(`repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    return;
  } catch (e) {
    if (!e.notFound) throw e;
  }
  log(`creating orphan branch ${branch}`);
  const tree = ghApi(`repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: README }] },
  });
  const commit = ghApi(`repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message: 'gh-img: init assets branch', tree: tree.sha, parents: [] },
  });
  ghApi(`repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
}

export function createBranchUploader({ owner, repo, branch = DEFAULT_BRANCH, log = () => {} }) {
  let ready = false;
  return async function upload(file) {
    if (!ready) {
      ensureBranch(owner, repo, branch, log);
      ready = true;
    }
    const bytes = readFileSync(file.path);
    // Content-addressed: re-uploading the same file reuses the same path.
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const day = new Date().toISOString().slice(0, 10);
    const path = `assets/${day}/${hash}-${sanitize(file.name)}`;
    const url = `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${path}?raw=true`;

    try {
      ghApi(`repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
      log(`already uploaded: ${path}`);
      return url;
    } catch (e) {
      if (!e.notFound) throw e;
    }
    ghApi(`repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      body: { message: `gh-img: add ${file.name}`, content: bytes.toString('base64'), branch },
    });
    log(`committed ${path} to ${branch}`);
    return url;
  };
}
