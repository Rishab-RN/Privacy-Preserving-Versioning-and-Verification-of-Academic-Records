# Privacy-Preserving Versioning and Verification of Academic Records

A DBMS project exploring how academic records can be corrected, audited and shared
with verifiers while limiting unnecessary disclosure of student information.

**Current phase: Week 1 - environment and repository setup.** The npm workspace,
API startup/liveness slice and shared contracts are in place. The frontend
toolchain is installed; product UI, academic workflows and database integration
are pending. The project owner will provide the ER and data-flow diagrams before
schema work begins.

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

These are proposed capabilities, not completed features. Zero-knowledge predicates,
anomaly detection and graph analysis are extensions to evaluate after the core
workflow is working. Publication and novelty claims will depend on evidence.

## Technology and implementation status

| Area                       | Direction                                                         |
| -------------------------- | ----------------------------------------------------------------- |
| Frontend toolchain         | React, TypeScript, Vite and Tailwind CSS installed; UI pending    |
| API                        | Node.js, Express and TypeScript; liveness endpoint implemented    |
| Academic authority         | PostgreSQL local service; drivers installed, schema pending       |
| Flexible evidence/packages | MongoDB local service; driver installed, integration pending      |
| Verification               | Signed credentials and Merkle proofs planned; no verifier yet     |
| Later research extensions  | Python ML, Neo4j and bounded ZK predicates, installed when needed |

Final schema and service choices will follow the reviewed design. A valid signature
does not prove that an entered grade is factually correct; historical inclusion alone
does not establish currentness.

## Repository guide

```text
apps/
  api/                      API startup, configuration and HTTP tests
  web/                      Installed frontend toolchain; product UI pending
  worker/                   Reserved durable-job boundary
packages/
  contracts/                Shared transport types
  verification/             Reserved independent verification boundary
db/                         Migration and synthetic-seed source
infra/                      Optional local database services
scripts/                    Repository maintenance utilities
tests/                      Future cross-service tests
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
npm run check
npm run build
npm run dev:api
```

`GET http://127.0.0.1:4000/health/live` checks API process liveness. It does not
claim database readiness or a working academic-record workflow. Stop the development
server with `Ctrl+C`. The web toolchain has no product entry page yet.

For optional databases, create a local `.env` from `.env.example` and replace its
example passwords. The current development workspace already has a generated,
Git-ignored `.env`; keep existing credentials when reusing its Docker volumes.

```powershell
npm run infra:config
npm run infra:up
npm run infra:status
# Stop services without deleting their data:
npm run infra:down
```

See [Local development](docs/development/local-development.md) for details.
The CI definition runs quality checks and builds on Windows and Linux after the
owner pushes it; a local run does not establish a successful GitHub Actions run.

If you are using the existing `PrivacyPreservingRecords` working folder, its
`origin` is already configured; do not clone a second repository inside it.

## Collaboration

Use short-lived `feat/`, `fix/`, `docs/`, `test/` or `chore/` branches and pull
requests into `main`. Keep commits focused, with short Conventional Commit messages.
See [Contributing](CONTRIBUTING.md) and the
[Git workflow](docs/development/git-workflow.md). Work is delivered in weekly slices;
each slice should pass its checks before the next feature stage begins.

The project owner runs staging, commits and pushes manually. Automated assistants
must not run `git add`, `git commit` or `git push` unless that instruction changes.

## Project records

- [Project journey](docs/project-journey.md)
- [Architecture status](docs/architecture/README.md)
- [Repository layout](docs/development/repository-layout.md)
- [Local development](docs/development/local-development.md)
- [Dependencies and phase boundaries](docs/development/dependencies.md)
- [Contribution guidelines](CONTRIBUTING.md)

## Reference and attribution

The initial investigation considered
[RohanCB18/DBMS](https://github.com/RohanCB18/DBMS). Reference code is not included
in this repository. Any future reuse must preserve attribution and have established
licensing terms. A licence for ScholarProof has not yet been selected.
