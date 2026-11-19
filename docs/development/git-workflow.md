# Git workflow

The local repository is already cloned and `origin` points to:

```text
https://github.com/Rishab-RN/Privacy-Preserving-Versioning-and-Verification-of-Academic-Records.git
```

The repository was empty when cloned. The commands below are for the project owner
to run manually after reviewing the files. Assistants must not stage, commit or push
under the current working agreement.

## First commit for the empty repository

Bootstrap `main` once so subsequent branches can open pull requests against it.

```powershell
Set-Location "C:\Users\Rishab Nayak\Desktop\Om\Codes\PrivacyPreservingRecords"
git status --short
git add README.md CONTRIBUTING.md .gitignore .editorconfig .gitattributes .github docs
git diff --cached --stat
git diff --cached --check
git diff --cached
git commit -m "docs: initialize project documentation"
git push -u origin main
```

Review the complete staged diff before committing. The ignore rules keep research,
planning inputs, the local draft archive and temporary files out of this commit.
Configure your own Git name/email if Git requests them; do not use another
contributor's identity.

## Daily branch workflow

Start from an up-to-date `main` with a clean working tree. For example, when adding
the reviewed diagrams:

```powershell
git switch main
git pull --ff-only origin main
git switch -c docs/academic-model
```

After making and checking the change, stage only its intended files:

```powershell
git status --short
git add docs/architecture
git diff --cached --stat
git diff --cached --check
git diff --cached
git commit -m "docs: add reviewed academic model"
git push -u origin docs/academic-model
```

Open a pull request into `main`, describe the change and report checks actually run.
Prefer a reviewed squash merge and remove the remote topic branch after merging.
Use `feat/`, `fix/`, `test/` and `chore/` branches for the corresponding work.

## GitHub settings after the first push

The repository owner should configure a branch rule for `main`: require pull
requests and a review where the team's permissions allow it, and block force pushes
and deletion. Add required CI checks only after the relevant workflows exist and
have been verified. Do not advertise branch protection or passing CI before they
are configured.

## Maintenance rules

- Use explicit staging paths; inspect every staged diff.
- Keep one coherent change per branch and commit.
- Keep short Conventional Commit subjects, with details in the body when needed.
- Do not commit secrets, student data, research downloads or local database files.
- Do not force-push shared branches or rewrite another person's commits.
- Update setup documentation when commands change, and the journey at meaningful
  milestones.

Useful read-only checks:

```powershell
git status --short
git diff
git diff --cached
git log --oneline --decorate -10
```

`git log` becomes useful after the first commit. No initial commit or remote push is
performed automatically by these documentation changes.
