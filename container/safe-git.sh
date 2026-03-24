#!/bin/bash
# Safe git wrapper for NanoClaw agent containers.
# Blocks destructive operations: force push, direct push to default branches,
# hard reset, and remote branch deletion.
# Checks subcommand first ($1), then iterates quoted args to avoid false positives.

set -euo pipefail

REAL_GIT=/usr/bin/git
PROTECTED_BRANCHES="${NANOCLAW_PROTECTED_BRANCHES:-main|master|develop}"

case "${1:-}" in
  push)
    for arg in "$@"; do
      case "$arg" in
        --force|--force-with-lease)
          echo "error: force push is blocked in NanoClaw containers." >&2
          echo "hint: work on a dedicated branch and create a pull request instead." >&2
          exit 1 ;;
        --delete)
          echo "error: remote branch deletion is blocked in NanoClaw containers." >&2
          exit 1 ;;
      esac
      # Block push :ref (refspec deletion syntax)
      if echo "$arg" | grep -qE '^:[^:]'; then
        echo "error: remote branch deletion (push :ref) is blocked in NanoClaw containers." >&2
        exit 1
      fi
    done

    # Block push to protected branches (explicit refspec like `git push origin main`)
    for arg in "$@"; do
      if echo "$arg" | grep -qE "^($PROTECTED_BRANCHES)$"; then
        echo "error: direct push to protected branch '$arg' is blocked in NanoClaw containers." >&2
        echo "hint: create a dedicated branch and open a pull request." >&2
        exit 1
      fi
    done

    # Block bare push while on a protected branch
    CURRENT_BRANCH=$($REAL_GIT symbolic-ref --short HEAD 2>/dev/null || echo "")
    if echo "$CURRENT_BRANCH" | grep -qE "^($PROTECTED_BRANCHES)$"; then
      echo "error: you are on '$CURRENT_BRANCH'. Direct push to protected branches is blocked." >&2
      echo "hint: create a dedicated branch first: git checkout -b your-branch-name" >&2
      exit 1
    fi
    ;;

  reset)
    for arg in "$@"; do
      if [ "$arg" = "--hard" ]; then
        echo "error: git reset --hard is blocked in NanoClaw containers." >&2
        exit 1
      fi
    done
    ;;

  branch)
    for arg in "$@"; do
      if [ "$arg" = "-D" ]; then
        echo "error: force branch deletion (branch -D) is blocked in NanoClaw containers." >&2
        echo "hint: use 'git branch -d' for safe deletion of merged branches." >&2
        exit 1
      fi
    done
    ;;
esac

exec "$REAL_GIT" "$@"
