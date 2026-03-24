---
name: github-pr
description: Create GitHub pull requests using gh CLI. Use when asked to open a PR, submit code for review, or push changes to GitHub. Always work on a dedicated branch — never push directly to main.
---

# GitHub Pull Requests

Create and manage GitHub pull requests from within the container.

## Rules

1. **Always work on a dedicated branch** — never commit or push directly to `main`, `master`, or `develop`.
2. **Always create a pull request** — do not merge directly. The PR is the deliverable.
3. **Never force push** — if your push is rejected, investigate and fix the issue.
4. **Never run destructive git commands** — no `reset --hard`, no `branch -D`, no `push --delete`.

These rules are enforced by a git wrapper. Violations are blocked with an error.

## Prerequisites

Verify GitHub auth is configured:

```bash
gh auth status
```

If not authenticated, tell the user to add `GITHUB_TOKEN` to their `.env` file and rebuild the container.

## Workflow

### 1. Clone the repo to a writable location

The project at `/workspace/project` is read-only. Clone it first:

```bash
git clone /workspace/project /tmp/work
cd /tmp/work
# Ensure remote points to GitHub (not the local mount)
git remote set-url origin "$(cd /workspace/project && git remote get-url origin)"
```

### 2. Create a dedicated branch

```bash
git checkout -b <descriptive-branch-name>
```

Use a clear branch name like `fix/login-validation` or `feat/add-export-csv`.

### 3. Make changes and commit

```bash
# ... make changes ...
git add <specific-files>
git commit -m "concise description of what changed and why"
```

### 4. Push and create PR

```bash
git push -u origin <branch-name>
gh pr create --title "Short title" --body "Description of changes"
```

## Tips

- Use `gh pr create --fill` to auto-fill title/body from commit messages
- Use `gh pr list` to see existing PRs
- Use `gh pr view <number>` to check PR status
- Always create PRs against the default branch unless told otherwise
- If you need to update a PR, push more commits to the same branch — do not force push

## Token setup (for the user)

For maximum safety, use a **fine-grained personal access token** scoped to specific repositories:

1. GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens
2. Select only the repositories the agent should access
3. Set permissions:
   - **Contents**: Write (push branches)
   - **Pull requests**: Write (create/update PRs)
   - **Metadata**: Read (required baseline)
4. Add the token to `.env`:
   ```
   GITHUB_TOKEN=github_pat_...
   GIT_USER_NAME=Your Name
   GIT_USER_EMAIL=you@example.com
   ```

Additionally, enable **branch protection rules** on your repos for server-side enforcement:
- Settings > Branches > Add rule for `main`
- Check "Do not allow force pushes"
- Optionally require PR reviews before merge
