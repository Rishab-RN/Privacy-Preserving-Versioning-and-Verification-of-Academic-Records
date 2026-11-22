# Privacy-Preserving Versioning and Verification of Academic Records

A DBMS project exploring how academic records can be corrected, audited and shared
with verifiers while limiting unnecessary disclosure of student information.

**Current phase: Week 3 - scoped access and evidence.** The SQL foundation now has
authenticated transcript reads, revocable sessions and integrity-checked MongoDB
evidence forms. Grade writes, approval workflows and product UI remain later stages.
The academic model is provisional pending the owner's diagrams and policy review.

## Problem

Grades and transcripts change through revaluation and authorised corrections.
Verifiers need to distinguish an authentic historical record from the current
accepted version. Students should be able to share the information needed for a
verification request without routinely exposing an entire transcript.

## Intended capabilities

- Preserve academic record versions and explain authorised corrections.
- Enforce role-scoped access and approval workflows.
- Detect changes to committed records using hashes, signatures and Merkle proofs.
- Share selected claims with consent and holder-bound presentations.
- Report authenticity, supersession, revocation and evidence freshness separately.
- Recover asynchronous document and provenance updates without changing the
  authoritative academic state.
- Model correction, actor, approval and evidence relationships in Neo4j.
- Detect unusual correction behaviour using transparent rules, Python ML and
  graph-derived features, with reviewable risk explanations.

Tamper verification, Neo4j provenance and ML anomaly detection are **mandatory
project deliverables**. They are scheduled later than the current API foundation;
they are not optional extensions or completed features. ZK predicates and vector
search will be assessed separately by use case. Publication and novelty claims
will depend on measured evidence.

## Technology and implementation status

| Area                       | Direction                                                           |
| -------------------------- | ------------------------------------------------------------------- |
| Frontend toolchain         | React, TypeScript, Vite and Tailwind CSS installed; UI pending      |
| API                        | Node.js/Express/TypeScript; local sessions and scoped reads         |
| Academic authority         | PostgreSQL 18; migrations, version history and temporal queries     |
| Flexible evidence/packages | MongoDB; bounded validated evidence, SQL references and digests     |
| Verification               | Signed credentials and Merkle proofs planned; no verifier yet       |
| Required graph provenance  | Neo4j and Cypher queries; implementation pending                    |
| Required anomaly detection | Python ML, rules and graph-derived features; implementation pending |
| Use-case decisions         | Bounded ZK predicates and vector search assessed separately         |

See the [academic model](docs/architecture/academic-model.md) for assumptions and
limits. Final policy choices will follow owner review. A valid signature
does not prove that an entered grade is factually correct; historical inclusion alone
does not establish currentness.

See [required capabilities](docs/architecture/required-capabilities.md) for the
mandatory responsibilities and acceptance criteria. Deterministic tamper checks
and ML anomaly scores answer different questions: an integrity failure cannot be
overridden by a low risk score, and an unusual authorised correction is a review
signal rather than proof of fraud.

## Repository guide

```text
apps/
  api/                      API startup, configuration and HTTP tests
  web/                      Installed frontend toolchain; product UI pending
  worker/                   Reserved durable-job boundary
packages/
  contracts/                Shared transport types
  verification/             Reserved independent verification boundary
db/                         SQL migrations, synthetic seeds and transcript query
infra/                      Optional local database services
scripts/                    Repository maintenance utilities
tests/                      PostgreSQL and real HTTP/SQL/Mongo integration checks
.github/                    CI, issue and pull-request templates
docs/
  architecture/             Reviewed diagrams and design documentation
  development/              Contributor and Git workflow documentation
  project-journey.md         Dated milestones and decisions
CONTRIBUTING.md              Collaboration and review conventions
```

Research downloads, planning drafts, local reports and temporary files are excluded
through `.gitignore`. Curated architecture documentation is maintained in `docs/`.

## Getting started

```powershell
git clone https://github.com/Rishab-RN/Privacy-Preserving-Versioning-and-Verification-of-Academic-Records.git
Set-Location Privacy-Preserving-Versioning-and-Verification-of-Academic-Records
```

Use **Node.js 24 and npm 11**. From the repository root:

```powershell
npm ci
npm run setup
npm run doctor
npm run check
npm run build
npm run dev:api
```

`GET http://127.0.0.1:4000/health/live` checks API process liveness. It does not
claim database readiness or a working academic-record workflow. Stop the development
server with `Ctrl+C`. The web toolchain has no product entry page yet.

`npm run setup` creates a Git-ignored `.env` with generated local database passwords
only when the file is missing. Existing configuration is preserved. Keep its
credentials when reusing initialized Docker volumes. `npm run doctor` checks
prerequisites without displaying secret values; add `-- --require-docker` when
Docker is required for the work at hand.

```powershell
npm run infra:config
npm run infra:up
npm run infra:status
npm run infra:check
# Stop services without deleting their data:
npm run infra:down
```

See [Local development](docs/development/local-development.md) for details.
`infra:up` waits up to 120 seconds for service health. `infra:check` reports
authenticated PostgreSQL and MongoDB access independently. Apply the SQL model
explicitly after the services are ready:

```powershell
npm run db:status
npm run db:migrate
npm run db:seed
npm run db:demo
npm run test:db
# Save an actual query plan under ignored .runtime/:
npm run db:plan
```

The demo shows the same synthetic course changing from `4.00 / failed` to
`8.00 / passed` when the known-at time changes. Earlier knowledge remains queryable.
The seed creates 25 synthetic students, 100 grade records and 102 versions; a
second seed run leaves them unchanged. Database tests create and remove their own
temporary database, without resetting the development database. See the
[database guide](db/README.md) for privileges and migration recovery.

For the authenticated API and synthetic evidence walkthrough:

```powershell
npm run access:setup
npm run access:demo
npm run test:integration
npm run dev:api
```

`access:setup` creates restricted runtime identities and preserves their passwords
in ignored `.env.api`. `access:demo` provisions three synthetic logins with random
passwords in ignored `.runtime/demo-accounts.json`; credentials are never printed.
See the [API walkthrough](docs/development/api.md) and
[access/evidence design](docs/architecture/access-and-evidence.md). These routes
do not issue or correct grades, and stored data is currently plaintext.

The CI definition runs quality checks and builds on Windows and Linux, plus a
PostgreSQL 18/MongoDB 8 integration job on Linux, for topic-branch pushes and pull requests.
A local run does not establish a successful GitHub Actions run.

If you are using the existing `PrivacyPreservingRecords` working folder, its
`origin` is already configured; do not clone a second repository inside it.

## Collaboration

Use short-lived `feat/`, `fix/`, `docs/`, `test/` or `chore/` branches and pull
requests into `main`. Keep commits focused, with short Conventional Commit messages.
See [Contributing](CONTRIBUTING.md) and the
[Git workflow](docs/development/git-workflow.md). Work is delivered in weekly slices;
each slice should pass its checks before the next feature stage begins.

Assistants may stage/commit each focused, verified update only after the owner
approves its exact files and commit message. Keep commits incremental throughout
the week. Pushes and merges remain manual owner actions unless separately authorised.

## Project records

- [Project journey](docs/project-journey.md)
- [Architecture status](docs/architecture/README.md)
- [Repository layout](docs/development/repository-layout.md)
- [Local development](docs/development/local-development.md)
- [Dependencies and phase boundaries](docs/development/dependencies.md)
- [Contribution guidelines](CONTRIBUTING.md)
