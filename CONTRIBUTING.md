# Contributing

## Working agreement

Keep changes small enough to review and explain their purpose. Agree on the academic
model before implementing its schema. Update relevant documentation in the same
change as the behaviour it describes.

Staging, commits and pushes are performed manually by the project owner. Assistants
may edit and verify authorised work but must not run `git add`, `git commit` or
`git push` under the current project instructions.

## Branches

- `main`: reviewed, working project state.
- `feat/<topic>`: a new capability, such as `feat/record-versioning`.
- `fix/<topic>`: a correction, such as `fix/status-freshness`.
- `docs/<topic>`: documentation, such as `docs/academic-model`.
- `test/<topic>` or `chore/<topic>`: tests or maintenance.

After the initial repository bootstrap, use a short-lived branch and a pull request
for each meaningful change. A permanent `develop` branch is not required. Rebase or
merge current `main` before review; do not rewrite another contributor's branch.

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

The repository currently contains documentation only. Application lint, test and CI
commands will be introduced with the application tooling.

## Data and research

Use synthetic academic records in development. Keep signing secrets, private keys
and credentials outside Git. Cite external work and check reuse terms before copying
code, diagrams or assets. Do not report planned features, synthetic benchmark results
or research novelty as established facts.

## Documentation ownership

The project owner will supply the ER and DFD diagrams. Record their reviewed versions
in `docs/architecture/` before implementing the schema. Maintain factual milestones
in `docs/project-journey.md`; keep personal research and planning drafts local.
