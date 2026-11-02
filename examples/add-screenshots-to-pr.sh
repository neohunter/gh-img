#!/usr/bin/env bash
# Appends (or replaces) a "## Screenshots" section in a PR description.
#
#   examples/add-screenshots-to-pr.sh 123 shots/*.png
#   examples/add-screenshots-to-pr.sh 123 -R acme/web shots/*.png   # extra flags go to gh-img
set -euo pipefail

PR="${1:?usage: $0 <pr-number> [gh-img options] <files...>}"
shift

IMAGES=$(gh-img "$@")

REPO_ARGS=()
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == "-R" || "${!i}" == "--repo" ]]; then
    j=$((i + 1)); REPO_ARGS=(--repo "${!j}")
  fi
done

BODY=$(gh pr view "$PR" "${REPO_ARGS[@]}" --json body -q .body)
# Drop a previous Screenshots section (up to the next "## " heading or end of body).
BODY=$(printf '%s\n' "$BODY" | awk '/^## Screenshots$/{skip=1; next} /^## /{skip=0} !skip')

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '%s\n\n## Screenshots\n\n%s\n' "$BODY" "$IMAGES" > "$TMP"
gh pr edit "$PR" "${REPO_ARGS[@]}" --body-file "$TMP"
echo "Updated PR #$PR with $(printf '%s\n' "$IMAGES" | wc -l | tr -d ' ') file(s)."
