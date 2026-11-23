# Git workflow

The repository is already initialized, and the project owner has created and pushed
the first commit on `main`. Its `origin` is:

```text
https://github.com/Rishab-RN/Privacy-Preserving-Versioning-and-Verification-of-Academic-Records.git
```

The commands below describe the contributor workflow. Assistants may prepare and
verify authorised changes, then stage/commit a specific update only after the
owner approves its file list and commit message. Obtain permission for each commit.
Pushes and merges remain manual owner actions unless separately authorised.

## Start a focused branch

With a clean working tree, start from current `main`:

```powershell
git switch main
git pull --ff-only origin main
git switch -c chore/repository-foundation
```

If you have already made the intended changes on `main`, create the topic branch
first to carry those uncommitted changes with you:

```powershell
git status --short
git switch -c chore/repository-foundation
```

Do not pull, discard or overwrite uncommitted work just to follow the clean-checkout
example. Resolve unrelated working-tree changes separately with their owner.

Use `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `test/<topic>` or `chore/<topic>`.
Keep the branch focused; a permanent `develop` branch is not required.

For this team, keep `main` plus one active working branch by default. Finish its
review/merge before starting the next feature branch. A branch may contain several
focused commits; creating one for every commit or calendar week is unnecessary.

## Review, commit and publish manually

Stage explicit paths belonging to the change. For a documentation-only change,
for example:

```powershell
git status --short
git --no-pager diff
git add docs/development/git-workflow.md
git --no-pager diff --cached --stat
git diff --cached --check
git --no-pager diff --cached
git commit -m "docs: clarify contributor workflow"
git push -u origin chore/repository-foundation
```

For code changes, run `npm run check`, `npm run build` and any relevant behavioural
checks before committing. Adjust the staging paths and commit subject to the actual
change. Confirm that local research, plans, secrets and runtime data are absent.

`--no-pager` prints a diff directly. If a command opens Git's pager, press `q` to
return to the terminal.

## Pull requests and integration

Open a pull request into `main`. Describe the problem, resulting behaviour and
checks actually run. Include UI evidence or migration/recovery details when
relevant. Request review from the component owner and resolve feedback on the topic
branch.

Prefer a reviewed squash merge with a short Conventional Commit PR title. After
the merge, update local `main` before starting the next topic. Do not force-push a
shared branch or rewrite another contributor's commits.

Create the PR once a coherent change is committed/pushed and local checks pass.
Merge after its diff is reviewed and the published GitHub checks pass. At each
assistant handoff, distinguish **ready for PR** from **ready to merge**; a local
pass alone does not establish the latter. An assistant can stage/commit an approved
update; pushes and merges stay under the owner's manual control.

## GitHub repository settings

The repository owner should configure a rule for `main`: require pull requests and
reviews where the team's permissions allow them, and block force pushes and
deletion. Add required CI checks only after the workflows exist and their results
have been verified. Repository documentation must not claim these settings are
enabled before they are configured.

## Maintenance conventions

- Keep one coherent change per branch and commit.
- Prepare focused commits as updates pass their checks; do not wait to bundle a
  whole week. Include relevant tests/migrations/docs with the behaviour they verify.
- Ask for commit permission only after the change is concrete and reviewable.
  Name the exact files, checks and short message; stage only that approved set.
- Keep Conventional Commit subjects short; explain non-obvious reasons in the body.
- Commit the npm lockfile with intentional dependency changes.
- Update setup documentation when commands change and the journey at meaningful
  milestones.
- Never use broad staging as a substitute for reviewing the diff.

Useful read-only checks:

```powershell
git status --short --branch
git --no-pager diff
git --no-pager diff --cached
git log --oneline --decorate -10
```
