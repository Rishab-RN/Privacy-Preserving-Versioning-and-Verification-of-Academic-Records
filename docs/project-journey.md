# Project journey

A dated record of meaningful milestones, decisions and evidence. This is not a list
of every edit. Completed work and future work are kept distinct.

## 2026-11-19 - Investigation and project direction

- Reviewed the initial academic-record project outline and reference repository.
- Identified record corrections, selective disclosure and verification freshness as
  the main engineering questions.
- Chose PostgreSQL as the proposed authority for structured academic state and
  MongoDB for flexible evidence/documents. Other stores remain optional.
- Established that Merkle trees and ZK credentials alone are not sufficient grounds
  for a novelty claim. Further comparison and measured results are required.

The reference repository was inspected statically; its reported runtime results
were not independently reproduced. Detailed research materials remain local and
are ignored by Git.

## 2026-11-20 - Repository foundation

- Cloned the empty GitHub repository into the existing project workspace and
  verified its `origin` and `main` branch.
- Added project documentation, contribution rules, Git workflow instructions and
  pull-request/issue templates.
- Excluded local research, planning drafts, temporary files and withdrawn diagram
  drafts through `.gitignore`.
- Recorded ER/DFD diagrams as owner-provided design inputs. Their review will
  precede database implementation.
- Kept staging, commits and pushes under the project owner's manual control.

No application, database migrations, deployment or performance results have been
implemented or claimed at this milestone.

## 2026-11-20 - Implementation workspace foundation

- Established API and shared contracts source workspaces, with a single root
  lockfile. Installed the React/React DOM 19.3.1, Vite 8 and Tailwind CSS 4 web
  toolchain and type-checked its Vite configuration; a UI entry remains pending.
  Worker and verification directories contain ownership notes only.
- Separated database migrations and synthetic seeds from local infrastructure,
  repository scripts and cross-boundary tests.
- Added development instructions and explicit ownership/dependency boundaries.
- Continued the manual Git workflow after the owner's first commit and push.
- Kept research and planning files local while preserving trackable source,
  configuration examples and curated technical documentation.

Verified setup evidence for this milestone:

- `npm run check` passed lint, formatting verification, type checking and six tests.
- `npm run build` succeeded.
- `npm run infra:config` passed static Compose configuration validation.
- PostgreSQL 18 and MongoDB 8.0 containers were running and healthy;
  `npm run infra:check` passed authenticated PostgreSQL `SELECT 1` and MongoDB ping
  checks with local network access.
- `npm audit` reported zero advisories for the installed lockfile at this check.

An ignored `.env` with generated local passwords is preserved for the initialized
database volumes. These are local verification results, not a claim that remote
GitHub CI has passed. Week 1 remains setup only: the API startup/liveness slice and
database client access are separate from academic application integration. No UI
flow, schema migration, background publication or credential proof capability is
claimed here.

## 2026-11-20 - Collaborator bootstrap and environment diagnostics

- Added `npm run setup` with generated local database passwords on first use and
  exact preservation of an existing `.env`. Repeated execution does not rotate
  initialized-volume credentials.
- Added a dependency-free environment doctor with an optional required-Docker
  profile and sanitized prerequisite/configuration output.
- Made database checks independent, bounded and service-specific so one failure
  cannot hide the other result. Connection details and arbitrary exception
  messages are not printed.
- Made local database startup wait for service health, and enabled CI on the
  documented topic-branch prefixes as well as pull requests.
- Verified all 19 reported tests, lint, formatting, type checks and build; Docker
  prerequisite checks, health-waiting startup and both authenticated service
  probes passed. The existing `.env` remained byte-for-byte unchanged.

These are local results. Remote CI results depend on the owner's next push/PR.
No academic schema, new diagrams or domain workflows were introduced.

## Next milestone

Review the Week 1 setup/readiness record with the owner. Begin the next weekly
stage only when requested; schema implementation additionally requires review of
the owner-provided diagrams and agreement on academic invariants.

## Entry format

For future milestones, record the date, concrete outcome, important decision and
verification evidence. Link the relevant PR/commit once it exists. Do not create
future-dated progress entries or mark planned work as complete.
