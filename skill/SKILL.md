---
name: gh-img
description: >-
  Upload screenshots/images/videos to GitHub (user-attachments, no repo commit)
  and embed them in PR descriptions, PR comments or issues. Use whenever you
  need to attach an image to a GitHub PR or issue. Never ask the user for a
  session token or cookie: gh-img reads it from the browser by itself.
---

# gh-img — attach images to GitHub PRs/issues

`gh-img` uploads files exactly like drag & drop in github.com and prints
ready-to-paste markdown, one line per file, on stdout. Warnings go to stderr.

## Rules

- **Never** ask the user for `user_session`, cookies or tokens, and never try to
  read browser cookie files or the Keychain yourself. `gh-img` handles that.
- Do not commit screenshots to the repo. Do not use `--mode branch`/`auto`
  unless the user asks for it.
- If `gh-img` fails, show its error message to the user and stop. Typical fix:
  the user logs in to github.com in Chrome again; then retry.

## Usage

```bash
gh-img --version                         # check it is installed
gh-img doctor -R owner/repo              # diagnose (no upload)
gh-img -R owner/repo shots/*.png         # -> ![alt](https://github.com/user-attachments/assets/…)
```

Name files `NN-short-description.png` (e.g. `01-dashboard-empty.png`): the alt
text becomes "dashboard empty". Use `--format html --width 600` to size images.

## Add a Screenshots section to the PR description

```bash
PR=123
IMAGES=$(gh-img shots/*.png) || exit 1
BODY=$(gh pr view "$PR" --json body -q .body)
printf '%s\n\n## Screenshots\n\n%s\n' "$BODY" "$IMAGES" > /tmp/pr-body.md
gh pr edit "$PR" --body-file /tmp/pr-body.md
```

## Comment on a PR or issue

```bash
gh pr comment 123 --body "$(gh-img after.png)"
gh issue comment 45 --body "Repro:
$(gh-img bug.mp4)"
```

## Verify

`gh pr view <n> --json body -q .body` must contain
`https://github.com/user-attachments/assets/…` URLs.
