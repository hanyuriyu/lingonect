#!/usr/bin/env bash
#
# setup-backup-mirror.sh
#
# Configures this git clone so that a single `git push` sends your commits to
# BOTH GitHub (primary) and an independent backup host (GitLab by default).
#
# This is safe to run more than once — it resets the push URLs each time, so
# it won't create duplicates.
#
# Usage:
#   scripts/setup-backup-mirror.sh <MIRROR_GIT_URL>
#
# Example:
#   scripts/setup-backup-mirror.sh https://gitlab.com/yourname/lingonect.git
#
# After running this, `git push` (to origin) pushes to GitHub and the mirror
# together. Verify with:  git remote -v
#
set -euo pipefail

GITHUB_URL="https://github.com/hanyuriyu/lingonect.git"

MIRROR_URL="${1:-}"
if [[ -z "$MIRROR_URL" ]]; then
  echo "ERROR: pass your mirror repo URL." >&2
  echo "Usage: scripts/setup-backup-mirror.sh https://gitlab.com/yourname/lingonect.git" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: run this from inside the lingonect git clone." >&2
  exit 1
fi

echo "Primary (GitHub): $GITHUB_URL"
echo "Backup  (mirror): $MIRROR_URL"
echo

# 1) Keep a dedicated 'backup' remote so you can also push/pull it on its own.
if git remote | grep -qx "backup"; then
  git remote set-url backup "$MIRROR_URL"
else
  git remote add backup "$MIRROR_URL"
fi

# 2) Make `git push origin` fan out to BOTH hosts.
#    Fetch still comes only from GitHub (origin's fetch URL is unchanged).
#    We reset the push URL list to GitHub first, then add the mirror, so this
#    script stays idempotent.
git remote set-url --push origin "$GITHUB_URL"
git remote set-url --push --add origin "$MIRROR_URL"

echo "Done. Current remotes:"
echo "-----------------------------------------"
git remote -v
echo "-----------------------------------------"
echo
echo "Next: push everything (including all branches and tags) to the mirror once:"
echo "  git push backup --all"
echo "  git push backup --tags"
echo
echo "From now on, a normal 'git push' updates GitHub AND your backup together."
