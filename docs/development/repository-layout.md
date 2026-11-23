# Repository layout

The repository uses npm workspaces to keep application code and shared packages in
one checkout, with one root lockfile. Run workspace commands from the repository
root unless a guide explicitly says otherwise.

```text
apps/
  api/                      HTTP API and backend composition
  web/                      React/Vite/Tailwind toolchain; UI entry pending
  worker/                   Restricted outbox consumer and MongoDB projections
packages/
  contracts/                Shared request/response types and data contracts
  verification/             Reserved verification boundary (README only)
db/
  migrations/               Reviewed, ordered PostgreSQL schema changes
  seeds/                    Deterministic synthetic development data
  queries/                  Parameterized SQL for query-plan inspection
infra/
  docker/                   Local database infrastructure
scripts/                    Safe local setup and prerequisite checks
tests/                      Checks that span application/package boundaries
docs/
  architecture/             Reviewed diagrams and design documentation
  development/              Setup, repository and collaboration guides
  project-journey.md         Meaningful milestones and their evidence
.github/                    Review templates and CI configuration
```

## Implemented code and reserved boundaries

The API startup slice and shared contracts package contain implemented source.
The web workspace has React/React DOM 19.3.1, Vite 8 and Tailwind CSS 4 dependencies
installed, plus a type-checked Vite configuration. It has no UI entry or runnable
frontend yet. The worker contains the implemented MongoDB projection consumer,
provisioning and journal replay. The verification directory remains reserved;
there is no independent cryptographic verifier yet.

Repository automation lives in `scripts/` and is exposed through root npm
commands. `setup` creates missing local configuration without replacing an
existing `.env`; `doctor` reports prerequisite/configuration availability without
printing secret values. These commands do not implement a domain model, start
database services or modify Git history. The CI definition runs the foundation
checks on feature-branch pushes and pull requests; results must be verified on the
actual published run.

Week 2 SQL source is implemented in `db/`, its administrative CLI in
`apps/api/scripts/db/`, and real PostgreSQL checks in `tests/database/`. These
scripts are separate from HTTP request handlers. No new dependency was required
for this slice. The owner-provided ER/DFD diagrams remain pending; the
[academic model](../architecture/academic-model.md) records provisional assumptions
to reconcile with them before broader workflows.

## Dependency boundaries

Week 3 runtime modules live in `apps/api/src/`: HTTP contracts/composition, local
password/session handling, scoped SQL queries, evidence protocol and Mongo adapter.
Administrative access provisioning/demo/test harnesses live in
`apps/api/scripts/access/`, separately from request handlers. Cross-store HTTP
checks are in `tests/integration/`. No new dependency was added for this slice.

- Runtime applications may use shared packages; they do not import another
  application's internal source files. Administrative demo and integration scripts
  may compose API/worker helpers to verify the full workflow. Those scripts stay
  outside the HTTP server's runtime dependency graph.
- `packages/contracts/` defines shared interfaces; it must not create a second
  source of academic truth or depend on a specific application's database client.
- `packages/verification/` will contain verification logic that can be checked
  independently of the issuer's mutable database. Do not add permissive placeholder
  verification that reports success.
- The API owns request handling and application composition. Background job
  processing belongs in the worker when a durable job workflow is introduced.
- Database migrations are the schema history. Application startup must not silently
  create or rewrite the production schema.

These boundaries can evolve through a reviewed change. Add a service or package
when it has a concrete responsibility; do not create additional deployments merely
to mirror every folder.

## What belongs in Git

Track application/package source, workspace manifests and the root lockfile,
configuration templates, migrations, synthetic seed generators, useful tests,
curated documentation and CI definitions. Future reviewed ER/DFD artifacts belong
in `docs/architecture/` and can be tracked deliberately.

The ignore rules keep the following local:

- Research downloads, planning folders and the existing outline/synopsis reports.
- Withdrawn drafts, temporary exports and intermediate PDF renders.
- Installed dependencies, build output, coverage, caches and virtual environments.
- Real environment files, private-key material, database volumes and backup files.
- Editor and operating-system metadata.

Keep an `.env.example` with safe example values trackable. Do not commit real
student records as fixtures. Do not use a blanket `*.sql` or `*.pdf` ignore rule:
reviewed migrations and intentional documentation may use those formats.

An ignore rule applies to untracked files; it does not remove material that was
already committed. Inspect the actual staged diff before every commit.

## Adding work

Choose the owning application/package, add only the required code and update its
setup instructions in the same change. Place focused tests near their code where
that workspace's tooling supports it; reserve `tests/` for cross-boundary checks.
Record a journey entry when a meaningful capability or architectural decision is
completed, with the checks actually run.
