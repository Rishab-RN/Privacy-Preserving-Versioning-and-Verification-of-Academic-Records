# Privacy-Preserving Versioning and Verification of Academic Records

A DBMS project exploring how academic records can be corrected, audited and shared
with verifiers while limiting unnecessary disclosure of student information.

**Current phase — Week 8 Neo4j provenance.**
Scoped record changes now feed a transactionally ordered institutional log.
Canonical salted commitments, signed checkpoints, inclusion/consistency proofs and
an offline verifier complement the recoverable MongoDB worker. A separate operator
audits actual workflow facts and evidence. Students can now prove an approved
course grade meets a consented threshold without disclosing the exact grade.
Browser-local Groth16 proving, issuer-bound commitments, SQL persistence,
revocation/supersession, one-use online acceptance and the public verifier are
connected. Setup uses a single-operator **local development ceremony**, requiring
independent review before adversarial deployment. The responsive React workspace
also connects sign-in, scoped transcripts, evidence and registrar reviews to the
live API. Record timelines show recorded and effective dates for each revision.
Students preview the fields in their grade proof. Verifiers can check a signed
issuance proof and see that result alongside the live status and check time.
Neo4j traces accepted revisions to approval actors and evidence and reports how
far the graph has caught up. ML anomaly detection is scheduled for Week 9.
See the [provenance demo](docs/development/provenance-demo.md).
The selected academic bounds and approval rules remain subject to institutional
policy review.

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
- Prove an approved course-grade threshold without sharing the exact grade.
- Report authenticity, supersession, revocation and evidence freshness separately.
- Recover asynchronous document and provenance updates without changing the
  authoritative academic state.
- Model correction, actor, approval and evidence relationships in Neo4j.
- Detect unusual correction behaviour using transparent rules, Python ML and
  graph-derived features, with reviewable risk explanations.

Tamper verification, zero-knowledge proofs, Neo4j provenance and ML anomaly
detection are **mandatory project deliverables**. Tamper verification and the
bounded ZK grade predicate and graph provenance are implemented. ML is scheduled later and
are not optional extensions. Vector search is assessed separately by use case.
Publication and novelty claims depend on measured evidence.

## Technology and implementation status

| Area                       | Direction                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Frontend                   | React, TypeScript, Vite and Tailwind CSS with role-specific dashboards and interactive history |
| API                        | Node.js/Express/TypeScript; scoped access and registrar approval                               |
| Academic authority         | PostgreSQL 18; immutable revisions, temporal queries and outbox                                |
| Flexible evidence/packages | MongoDB; validated evidence, immutable receipts and grade copies                               |
| Background delivery        | Restricted Node worker; leased retries and bounded journal replay                              |
| Verification               | Canonical commitments, signed checkpoints, Merkle proofs and offline verifier                  |
| Zero-knowledge predicate   | Circom/Groth16; approved course-grade threshold, local browser proving and live SQL acceptance |
| Required graph provenance  | Neo4j, committed SQL outbox replay, scoped Cypher review and review feature inputs             |
| Required anomaly detection | Python ML, rules and graph-derived features; implementation pending                            |
| Use-case decision          | Vector search; no engine added without a justified workload                                    |

See the [academic model](docs/architecture/academic-model.md) for assumptions and
limits. Final policy choices will follow owner review. A valid signature
does not prove that an entered grade is factually correct; historical inclusion alone
does not establish currentness.

The owner's physical BCNF requirement is addressed through forward migrations
`0008`/`0009`, with normalized transparency/private-proof relations in `0010`-`0012`.
The [normalization analysis](docs/architecture/normalization.md) covers 31 domain
tables and two metadata tables. Existing migrations, credential files and academic
history are preserved; actual validation/rollout evidence is in the journey.

See [required capabilities](docs/architecture/required-capabilities.md) for the
mandatory responsibilities and acceptance criteria. Deterministic tamper checks
and ML anomaly scores answer different questions: an integrity failure cannot be
overridden by a low risk score, and an unusual authorised correction is a review
signal rather than proof of fraud.

## Repository guide

```text
apps/
  api/                      API startup, configuration and HTTP tests
  web/                      Live React workspace for scoped records and review
  worker/                   Restricted outbox consumer and Mongo projections
  log/                      Separate signer, private proof export and source audit
packages/
  contracts/                Shared transport types
  verification/             Canonicalization, signatures and Merkle verification
  credentials/              Stateless selective-disclosure/holder-binding library
  zk/                       Course-grade predicate, commitments and real proofs
db/                         SQL migrations, synthetic seeds and transcript query
infra/                      Optional local database services
scripts/                    Repository maintenance utilities
tests/                      PostgreSQL and real HTTP/SQL/Mongo integration checks
.github/                    CI, issue and pull-request templates
docs/
  architecture/             Design contracts and schema reviews
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
server with `Ctrl+C`. Run `npm run dev:web` separately for the live React workspace.

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

For signed history, complete the normal database/API/worker setup, then run
`npm run log:setup`, `npm run build` and `npm run log:demo`. The
[operator guide](apps/log/README.md) explains private exports, pinned keys, retained
observations, audit coverage and historical integrity versus currentness.
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
[access/evidence design](docs/architecture/access-and-evidence.md). Stored academic
and evidence data is currently plaintext.

For approved academic changes, provision the separate worker identity after the
migrations above:

```powershell
npm run worker:setup
npm run worker:once
# Keep delivery running in a separate terminal:
npm run dev:worker
# Replay retained events into missing derived documents:
npm run worker:replay
```

The API accepts a proposal from one registrar and approval or rejection from a
different registrar in that institution. Approval returns 202 after the SQL
transition commits; request status tracks Mongo delivery separately. The worker
preserves immutable copies and advances a latest-recorded-version pointer;
effective-time transcript queries remain authoritative in SQL. Read the
[workflow contract](docs/architecture/record-workflow.md) and
[worker guide](apps/worker/README.md) for retry, replay and trust limits.
`.env.worker` contains generated worker credentials and stays Git-ignored.

For a repeatable local demonstration after `npm run build`, run `npm run
workflow:demo` then `npm run workflow:smoke`. This creates separate synthetic
registrars/record, approves a change and confirms its Mongo projection. Each smoke
run appends a synthetic version. Stop other local workers before this check; see
the API guide for the ignored demo account files.

The CI definition runs quality checks and builds on Windows and Linux, plus a
PostgreSQL 18/MongoDB 8 integration job on Linux, for topic-branch pushes and pull requests.
A local run does not establish a successful GitHub Actions run.

If you are using the existing `PrivacyPreservingRecords` working folder, its
`origin` is already configured; do not clone a second repository inside it.

## Collaboration

For the UI, run `npm run dev:api` and `npm run dev:web` in separate terminals, then
open `http://127.0.0.1:5173`. Use locally provisioned accounts; no demo passwords are
embedded in the application. See the [frontend walkthrough](docs/development/frontend.md)
for screenshots, role-specific steps, browser testing and remaining backend gates.

For zero-knowledge proofs, run `npm run db:migrate` and `npm run zk:setup`, then
restart the API. The [ZK demo](docs/development/zero-knowledge-demo.md) walks through
student issuance/local proving, the public `/verify` page, replay and revocation.
The [proof profile](docs/architecture/zero-knowledge-proofs.md) states the exact
predicate, public metadata, setup trust and online acceptance boundaries.

Use short-lived `feat/`, `fix/`, `docs/`, `test/` or `chore/` branches and pull
requests into `main`. Keep commits focused, with short Conventional Commit messages.
See [Contributing](CONTRIBUTING.md) and the
[Git workflow](docs/development/git-workflow.md). Work is delivered in weekly slices;
each slice should pass its checks before the next feature stage begins.

The owner authorises assistants to make focused, verified commits and normal
topic-branch pushes without requesting approval each time. Keep commits incremental
throughout the week. PR review and merging remain under the owner's control.

## Project records

- [Project journey](docs/project-journey.md)
- [Architecture status](docs/architecture/README.md)
- [Repository layout](docs/development/repository-layout.md)
- [Local development](docs/development/local-development.md)
- [Dependencies and phase boundaries](docs/development/dependencies.md)
- [Contribution guidelines](CONTRIBUTING.md)
