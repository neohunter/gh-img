import { basename, extname } from 'node:path';

// File types GitHub accepts as attachments, grouped by how they render in markdown.
const TYPES = {
  '.png': ['image/png', 'image'],
  '.jpg': ['image/jpeg', 'image'],
  '.jpeg': ['image/jpeg', 'image'],
  '.gif': ['image/gif', 'image'],
  '.webp': ['image/webp', 'image'],
  '.svg': ['image/svg+xml', 'image'],
  '.mp4': ['video/mp4', 'video'],
  '.mov': ['video/quicktime', 'video'],
  '.webm': ['video/webm', 'video'],
  '.pdf': ['application/pdf', 'file'],
  '.zip': ['application/zip', 'file'],
  '.gz': ['application/gzip', 'file'],
  '.txt': ['text/plain', 'file'],
  '.log': ['text/plain', 'file'],
  '.md': ['text/markdown', 'file'],
  '.csv': ['text/csv', 'file'],
  '.json': ['application/json', 'file'],
};

export function fileInfo(path) {
  const name = basename(path);
  const entry = TYPES[extname(name).toLowerCase()];
  if (!entry) {
    throw new UserError(`Unsupported file type: ${name} (supported: ${Object.keys(TYPES).join(' ')})`);
  }
  return { path, name, type: entry[0], kind: entry[1] };
}

// "01-dashboard_empty-state.png" -> "dashboard empty state"
export function altFromFilename(name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const text = stem.replace(/^\d+[-_.\s]+/, '').replace(/[-_]+/g, ' ').trim();
  return text || stem;
}

export function formatResult(url, file, { format = 'markdown', alt, width } = {}) {
  const label = alt ?? altFromFilename(file.name);
  if (format === 'url') return url;
  if (format === 'html') {
    if (file.kind === 'image') {
      const w = width ? ` width="${width}"` : '';
      return `<img src="${url}" alt="${escapeHtml(label)}"${w} />`;
    }
    if (file.kind === 'video') return url;
    return `<a href="${url}">${escapeHtml(file.name)}</a>`;
  }
  // markdown
  if (file.kind === 'image') return `![${label.replace(/[[\]]/g, '')}](${url})`;
  if (file.kind === 'video') return url; // a bare URL on its own line renders a player
  return `[${file.name}](${url})`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseRepo(value) {
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value ?? '');
  if (!m) throw new UserError(`Invalid repo "${value}". Expected owner/repo.`);
  return { owner: m[1], repo: m[2] };
}

export function repoFromRemoteUrl(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function buildCookieHeader(userSession, { sameSite, login } = {}) {
  const parts = [`user_session=${userSession}`, `__Host-user_session_same_site=${sameSite ?? userSession}`, 'logged_in=yes'];
  if (login) parts.push(`dotcom_user=${login}`);
  return parts.join('; ');
}

// Errors meant to be shown to the user as-is (no stack trace).
export class UserError extends Error {}

// The browser-session path failed; in --mode auto we fall back to the branch strategy.
export class SessionError extends UserError {}
