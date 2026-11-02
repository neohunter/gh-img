# gh-img

Upload screenshots (and videos, PDFs…) to GitHub and get markdown ready to paste
into a PR description, comment or issue, **without copying your `user_session`
from DevTools or handing it to an AI agent**.

```console
$ gh-img 01-dashboard.png 02-settings.png
![dashboard](https://github.com/user-attachments/assets/3f2a…)
![settings](https://github.com/user-attachments/assets/1c9d…)
```

## Why

GitHub has no public API for image attachments (`gh` can't do it either). The
only native path is the one the web UI uses when you drag & drop an image, and
it requires the browser session cookie. `gh-img`:

1. **Reads the cookie straight from Chrome's cookie store** (macOS and Linux),
   decrypting it with the OS keychain key. You never copy it, and your agent never
   sees it. Where that's not possible (Windows), you save it once with `gh-img login`
   and it is kept encrypted by the OS.
2. Replays the web upload flow (`/upload/policies/assets` → S3 → finalize) and
   returns `https://github.com/user-attachments/assets/…` URLs.
3. Prints **only** the resulting markdown.

### Does it create commits or add files to the repo?

**No, not in the default `session` mode.** Files are stored in GitHub's attachment
storage, exactly like drag & drop in the web UI. Your repo and its history are
untouched.

Only the opt-in modes `--mode branch` and `--mode auto` (the latter only when the
session path fails) create commits, and always on a separate orphan branch
(`gh-img-assets`) that shares no history with your code. They are never used
unless you ask for them.

## Platform support

| | macOS | Linux | Windows |
|---|---|---|---|
| Read session from Chrome/Brave/Edge/Chromium automatically | ✅ (+ Arc) | ✅ | ❌ ¹ |
| Manual session (`gh-img login`) storage | Keychain | Secret Service (`secret-tool`), else `0600` file | File encrypted with DPAPI (your Windows user only) |
| `gh-img login --clipboard` | `pbpaste` | `wl-paste`, `xclip` or `xsel` | PowerShell `Get-Clipboard` |
| Upload (`session` and `branch` modes) | ✅ | ✅ | ✅ |

¹ Since Chrome 127, Chromium browsers on Windows use *app-bound encryption*: only
the browser itself can decrypt its cookies. On Windows, run `gh-img login` once
(and again when the GitHub session expires, usually after weeks).

Tests run on all three OSes in CI, including a real round trip through each
OS secret store.

## Security

| | |
|---|---|
| The token is never printed | Not in `--verbose`, `doctor` or error messages |
| Never passed as a process argument | It travels as an HTTP header inside the Node process. Shell scripts that call `curl -H "Cookie: …"` expose it to `ps` |
| Not written to disk in clear text | The temporary copy of the cookie DB is deleted right away. The optional manual session lives in the OS secret store (Keychain / DPAPI / Secret Service). Only Linux without a keyring falls back to a `0600` file |
| Not sent to S3 | Cookies only go to `github.com` |
| Zero dependencies | Only Node ≥ 22.13 (`node:sqlite`, `fetch`, `crypto`): no supply chain to audit |

Recommended: stop your agents from reading the browser cookie DB. For Claude Code,
in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Read(~/Library/Application Support/Google/Chrome/**)",
      "Bash(security find-generic-password:*)"
    ]
  }
}
```

## Installation

Requirements: **Node ≥ 22.13**, an authenticated [`gh`](https://cli.github.com)
(`gh auth login`), and Chrome (or Brave, Edge, Arc, Chromium) logged into github.com.

### Option 1: as a `gh` extension (macOS / Linux)

```bash
gh extension install neohunter/gh-img
gh img --version    # same CLI, invoked as `gh img`
```

### Option 2: from source with npm link (macOS / Linux / Windows)

```bash
git clone https://github.com/neohunter/gh-img.git
cd gh-img
npm link            # puts `gh-img` on your PATH (gh-img.cmd on Windows)
gh-img --version
```

To update later: `git pull` inside the folder (no need to link again).

> Using asdf? Run `asdf reshim nodejs` after `npm link` (and again after switching
> Node versions).

### Windows: save your session once

```powershell
gh-img login --clipboard    # after copying user_session from Chrome DevTools
gh-img doctor -R owner/repo
```

See [Manual fallback](#manual-fallback-saving-your-user_session) for details.

### First run on macOS: Keychain permission

```bash
gh-img doctor -R owner/repo
```

macOS will show a dialog asking for access to **"Chrome Safe Storage"**. Choose
**"Always Allow"** so it doesn't ask again. `doctor` uploads nothing. It checks Node,
`gh`, browser profiles, the session, and that it can obtain the repo's upload token.

```console
$ gh-img doctor -R acme/web
✓ Node 24.4.1
✓ gh authenticated as octocat
✓ repo acme/web
✓ chrome: 3 profile(s): Personal [Default], Work [Profile 2], Client [Profile 3]
  GitHub session: octocat in profile "Work"
✓ browser session of octocat (profile "Work") — read in memory, not shown
  no saved session (optional fallback: "gh-img login")
✓ upload token obtained for acme/web using chrome profile "Work" (octocat) — ready to upload
```

### For agents (Cursor / Claude Code)

The repo ships a skill in [`skill/SKILL.md`](skill/SKILL.md). Link it:

```bash
ln -s "$PWD/skill" ~/.cursor/skills/gh-img
ln -s "$PWD/skill" ~/.claude/skills/gh-img
```

## Usage

```
gh-img [options] <file...>     upload files, one result line per file
gh-img doctor [options]        diagnose without uploading anything
gh-img login [--clipboard]     save a user_session manually (fallback)
gh-img logout                  delete the saved session
```

| Option | Description |
|---|---|
| `-R, --repo owner/repo` | Target repo. Defaults to the repo of the current directory |
| `-m, --mode session\|auto\|branch` | `session` (default): user-attachments. `auto`: orphan branch if the session fails. `branch`: orphan branch only |
| `-f, --format markdown\|html\|url` | Output format (default `markdown`) |
| `--alt <text>` | Alt text (single file only). Defaults to the file name: `01-login-error.png` → `login error` |
| `--width <px>` | Image width, with `--format html` |
| `-b, --browser` | `chrome` (default), `brave`, `edge`, `arc`, `chromium` |
| `-p, --profile` | Browser profile (folder or display name). Auto-detected by default |
| `-u, --user <login>` | Use the profile logged into that GitHub user |
| `-s, --source auto\|browser\|stored` | Where to get the session. `auto` (default): browser, then the saved session |
| `--branch <name>` | Branch for `branch`/`auto` (default `gh-img-assets`) |
| `-v, --verbose` | Progress on stderr (never secrets) |

Every option has an environment variable: `GH_IMG_REPO`, `GH_IMG_MODE`,
`GH_IMG_BROWSER`, `GH_IMG_PROFILE`, `GH_IMG_USER`, `GH_IMG_SOURCE`, `GH_IMG_BRANCH`.

**Output:** stdout contains only results, one line per file, in input order.
Warnings and errors go to stderr. The exit code is non-zero if any file fails.

**Supported types:** `png jpg jpeg gif webp svg` (image), `mp4 mov webm` (video;
the bare URL is printed so GitHub renders a player), and `pdf zip gz txt log md csv json` (link).

**Profile selection:** if several profiles are logged into GitHub, the one matching
your `gh` user wins. Override it with `--user` or `--profile`.

## Examples

### Upload and copy to the clipboard

```bash
gh-img screenshot.png | pbcopy
```

### Comment on a PR

```bash
gh pr comment 123 --body "$(gh-img after.png)"

gh pr comment 123 --body "Done, here's how it looks:

$(gh-img shots/*.png)"
```

### Add a "Screenshots" section to the PR description

```bash
examples/add-screenshots-to-pr.sh 123 shots/*.png
```

Or by hand:

```bash
IMAGES=$(gh-img shots/*.png) || exit 1
BODY=$(gh pr view 123 --json body -q .body)
printf '%s\n\n## Screenshots\n\n%s\n' "$BODY" "$IMAGES" > /tmp/pr-body.md
gh pr edit 123 --body-file /tmp/pr-body.md
```

### Before / after table

```bash
examples/before-after-comment.sh 123 before.png after.png
```

Produces:

```markdown
| Before | After |
| --- | --- |
| <img src="https://github.com/user-attachments/assets/…" alt="Before" width="400" /> | <img … alt="After" width="400" /> |
```

### Issues, another repo, videos

```bash
gh issue comment 45 -R acme/api --body "Repro:
$(gh-img -R acme/api bug-repro.mp4)"
```

### Windows PowerShell

```powershell
gh-img shot.png | Set-Clipboard
gh pr comment 123 --body (gh-img after.png | Out-String)

# Screenshots section in the PR description
$images = gh-img shots\*.png | Out-String
$body = gh pr view 123 --json body -q .body | Out-String
"$body`n## Screenshots`n`n$images" | Set-Content -Encoding utf8 $env:TEMP\pr-body.md
gh pr edit 123 --body-file $env:TEMP\pr-body.md
```

### URLs only (for scripts)

```bash
for url in $(gh-img --format url shots/*.png); do echo "$url"; done
```

### Specific profile or browser

```bash
gh-img --user octocat shot.png
gh-img --profile "Work" shot.png
gh-img --browser brave shot.png
```

### No browser session: orphan branch (official API)

```bash
gh-img --mode branch shot.png
# ![shot](https://github.com/owner/repo/blob/gh-img-assets/assets/2026-11-02/3fa1c2d4e5b6-shot.png?raw=true)
```

Files are named by content hash, so uploading the same file twice reuses the URL.
The URL renders in PRs for anyone with read access to the repo.

## Manual fallback: saving your `user_session`

Required on **Windows**. Also useful on macOS/Linux if the browser cookie can't be
read (an unsupported browser, a Chrome encryption change, etc.). Save it once by hand. **Run this yourself
in your terminal, never through an agent.** That way the value never lands in
shell history or agent logs.

1. In Chrome: DevTools → **Application** → **Cookies** → `https://github.com` →
   copy the value of `user_session`.
2. Save it either way (same commands in bash, zsh, PowerShell or cmd):

   ```bash
   gh-img login               # paste the value; input is hidden
   gh-img login --clipboard   # read it from the clipboard, then clear the clipboard
   ```

   `--clipboard` is the same as pasting, minus the paste: it reads the copied value
   and then empties the clipboard so the token isn't left there to be pasted by
   accident (into a chat, Slack…). On Windows consoles where Ctrl+V doesn't paste
   into hidden input, right-click or use `--clipboard`.

   `login` validates the session against GitHub before saving it:

   ```console
   $ gh-img login --clipboard
   ✓ Valid session for octocat, saved in macOS Keychain.
   ```

3. Done. With `--source auto` (the default), `gh-img` tries the browser first and
   falls back to the saved session. To use only the saved one: `--source stored`.

Where it's stored:

- **macOS:** Keychain, service `gh-img`.
- **Windows:** `%APPDATA%\gh-img\session.dpapi`, encrypted with DPAPI. Only your
  Windows user account can decrypt it.
- **Linux:** Secret Service (`secret-tool`). Without a keyring, it falls back to
  `~/.config/gh-img/session` with `0600` permissions.

The value never appears in a process' arguments. Delete it with `gh-img logout`.

GitHub sessions expire. If `doctor` says the saved one is no longer valid, run
`gh-img login` again.

> For CI there's `GH_IMG_SESSION=<value>`, which takes precedence over everything
> else. Avoid it with agents, since environment variables end up in logs.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Could not read "Chrome Safe Storage" from the macOS Keychain` | You denied the dialog. Run again and choose "Always Allow" |
| `No logged-in github.com session found` | Log in to github.com in Chrome, or use `gh-img login` |
| `The browser session is expired` | Open github.com in Chrome (log in again) and retry |
| `is not visible with the browser session (404)` | The chosen profile has no access to the repo. Use `--user`/`--profile` |
| `Upload token not found` | No write access to the repo, or GitHub changed its HTML. Try `--mode auto` |
| `GitHub rejected the upload (HTTP 422)` | File too large (images ≤ 10 MB, videos ≤ 100 MB) or type not allowed |
| Windows: `app-bound cookie encryption` message | Expected: run `gh-img login --clipboard` once |
| Windows: `Could not save the session with DPAPI` | PowerShell is blocked by policy on that machine. Run `gh-img login` from a normal PowerShell window |

## How it works

1. **Cookie:** copies `<profile>/Cookies` (SQLite) to a temp dir, reads
   `user_session` for `github.com` and decrypts it (AES-128-CBC, PBKDF2 key from
   "Chrome Safe Storage"; from schema v24 on, it strips the SHA-256 host prefix).
2. **Upload token:** `GET github.com/<owner>/<repo>` with the cookie and extracts
   `uploadToken`. The `repository_id` comes from `gh api`.
3. **Policy:** `POST /upload/policies/assets` (name, size, type, repo).
4. **Upload:** multipart `POST` to S3 with the policy fields. No cookies are sent there.
5. **Finalize:** `PUT asset_upload_url`, which yields `asset.href`.

Steps 2–5 use internal GitHub endpoints. If they change, `doctor` will tell you,
and `--mode auto` keeps things working through the official API.

## Development

```bash
npm test                         # unit tests (node:test, no dependencies)
node bin/gh-img.js doctor -v     # run without installing
```

## License

MIT
