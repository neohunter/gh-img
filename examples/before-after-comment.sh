#!/usr/bin/env bash
# Posts a before/after comparison table as a PR comment.
#
#   examples/before-after-comment.sh 123 before.png after.png
set -euo pipefail

PR="${1:?usage: $0 <pr-number> <before.png> <after.png>}"
BEFORE=$(gh-img --format html --width 400 --alt "Before" "$2")
AFTER=$(gh-img --format html --width 400 --alt "After" "$3")

gh pr comment "$PR" --body "| Before | After |
| --- | --- |
| $BEFORE | $AFTER |"
