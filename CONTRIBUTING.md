# Contributing

## Working agreement

Keep changes small enough to review and explain their purpose. Agree on academic
invariants before extending the model; explicitly label any owner-requested
provisional implementation and its unresolved assumptions. Update documentation
in the same change as the behaviour it describes.

The owner authorises assistants to edit, verify, stage and commit focused updates
without requesting approval for each commit. Review explicit file lists and run
the relevant checks first; keep private drafts, credentials and runtime data out
of Git. Normal topic-branch pushes are also authorised. PR review and merging
remain owner actions; this does not authorise force pushes or history rewrites.

Commit coherent, checked updates throughout each stage instead of accumulating a
whole week's implementation into one commit. Keep a change's meaningful tests and
required migration/docs together so every commit is reviewable.

## Branches

- `main`: reviewed, working project state.
- `feat/<topic>`: a new capability, such as `feat/record-versioning`.
- `fix/<topic>`: a correction, such as `fix/status-freshness`.
- `docs/<topic>`: documentation, such as `docs/academic-model`.
- `test/<topic>` or `chore/<topic>`: tests or maintenance.

Use a short-lived branch and a pull request for each meaningful change. A permanent
`develop` branch is not required. Rebase or merge current `main` before review; do
not rewrite another contributor's branch. See the
[Git workflow](docs/development/git-workflow.md) for clean-checkout and
already-edited working-tree cases.

## Commit messages

Use `type: short description`, in imperative form. Aim for a subject under 72
characters. Add a body when the reason or migration impact needs explanation.

```text
docs: initialize project documentation
feat: add immutable record versions
fix: reject stale credential status
test: cover concurrent corrections
chore: configure local development
```

Use an optional scope when it improves clarity, for example
`fix(verification): reject expired challenges`. Do not combine unrelated changes
just to reduce the commit count.

## Pull requests and checks

Describe the problem, resulting behaviour and verification performed. State checks
that were not run. Include screenshots for UI changes and migration/recovery notes
for database changes when applicable. Request review from the relevant component
owner; prefer squash merging with a clear Conventional Commit PR title.

Before requesting review:

- Inspect the diff and confirm the change is within scope.
- Check that research drafts, secrets, database dumps and generated scratch files
  are absent from the staged changes.
- Run checks appropriate to the affected code. Record actual results.
- Update the README or journey only when setup, status or a meaningful milestone
  changes.

From the repository root, use the committed lockfile and run the foundation checks:

```powershell
npm ci
npm run check
npm run build
```

Run additional checks appropriate to the changed behaviour and record actual
results. A passing tooling gate does not establish that the planned academic
workflows or research mechanisms are complete. Setup and current implementation
boundaries are documented in [Local development](docs/development/local-development.md).

Use npm workspaces and the single root lockfile. Follow the ownership boundaries in
[Repository layout](docs/development/repository-layout.md), and update package
manifests, the lockfile and setup instructions together when dependencies change.

For infrastructure/configuration changes, also run `npm run infra:config`. When
the local database services are available, `npm run infra:check` verifies
authenticated PostgreSQL/MongoDB access. Record configuration validation and live
service checks separately. Preserve an existing ignored `.env` and its database
volume credentials; do not overwrite it during a routine install.

## Data and research

Use synthetic academic records in development. Keep signing secrets, private keys
and credentials outside Git. Cite external work and check reuse terms before copying
code, diagrams or assets. Do not report planned features, synthetic benchmark results
or research novelty as established facts.

## Documentation ownership

The project owner will supply the ER and DFD diagrams. Record their reviewed versions
in `docs/architecture/` and reconcile the provisional Week 2 schema with them before
extending workflows. Maintain factual milestones in `docs/project-journey.md`;
keep personal research and planning drafts local.
