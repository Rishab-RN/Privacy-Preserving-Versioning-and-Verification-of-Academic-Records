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

## 2026-11-20 - Provisional academic SQL foundation

At the owner's request to check Week 1 and continue to Week 2, implemented the
written academic model on `feat/academic-schema`. Owner diagrams and official
grading-policy review remain open; no new diagrams were generated. See the
[model assumptions](architecture/academic-model.md).

- Added thirteen academic tables with institution-scoped foreign keys, versioned
  illustrative grading policy, unique enrolments and immutable enrolment identity.
- Added append-only grade versions, expected-version conflict detection, and a
  derived valid-time/system-time projection. Retroactive, partial and future
  corrections preserve earlier known-at answers.
- Added a non-owner read-only database group, transactional checksummed migrations,
  an idempotent synthetic fixture and explicit administrative CLI commands. No
  dependency changes were needed.
- Defined a PostgreSQL 18 CI integration job alongside Windows/Linux quality jobs.
  Published CI results remain unverified until the owner pushes the branch.

Local verification:

- `npm run check` passed lint, formatting, type checks and all 22 tooling/API tests;
  `npm run build` passed.
- `npm run test:db` passed all 14 PostgreSQL integration tests. Two concurrent
  fresh migration runners applied each file exactly once, and the temporary test
  database was removed. Tests cover competing corrections, time boundaries,
  forbidden writes, scheme-specific policy, author institution, direct SQL guards,
  migration rollback and seed idempotency.
- Applied all three migrations to the local development database. A second run
  applied nothing. Loaded 25 synthetic students, 100 grade records and 102 versions;
  a second seed run changed nothing.
- `npm run db:plan` demonstrated `4.00 / failed` before correction and `8.00 / passed`
  afterward using the same effective date. It saved an actual query plan under
  ignored `.runtime/`; this small fixture is not a scalability benchmark.

This stage implements SQL correctness mechanisms, not cryptographic tamper
evidence or a privacy guarantee. Authenticated academic APIs, MongoDB evidence,
product UI and credential verification remain pending. The owner still performs
staging, commits and pushes manually.

## 2026-11-21 - Week 2 audit and scoped access/evidence

The owner merged PR #1 into `main` (`8afcee3`). Rechecked Week 2 locally: quality,
build, all 14 SQL integration tests and both service probes passed. A static audit
found no blocking temporal/schema defect, but identified unsafe role reuse through
inherited or column-level write privileges. Added forward hardening rather than
editing applied migration files. Diagram and official grading-policy review remain
open; this does not prevent independent scoped-read/evidence work.

Implemented Week 3 on the single working branch `feat/scoped-access`:

- Added administratively provisioned local accounts, scrypt password verification,
  hashed opaque sessions, one-hour expiry, logout, bounded login work and route
  limits. Current account/role state is rechecked on subsequent requests.
- Added student-self and institutional registrar/auditor transcript reads, preserving
  exact timestamp precision. Examiners receive no unmodelled institution-wide access.
- Added strict, bounded version 1 JSON evidence, immutable SQL references/digests,
  Mongo validation and restricted insert/read permissions. Pending reservations
  recover with the same idempotency key after injected Mongo or SQL failures.
- Separated migration credentials from restricted runtime SQL/Mongo identities,
  with explicit preserved local configuration and startup privilege-drift checks.
- Extended CI with Mongo and a compiled synthetic API demo, keeping Windows/Linux
  quality checks. Added an API walkthrough and the access/evidence policy.

Verified locally:

- `npm run check` passed lint, formatting, type checks and all 30 tooling/API tests.
- `npm run test:db` passed all 18 SQL tests; `npm run test:integration` passed all
  15 reported HTTP/SQL/Mongo tests, including forbidden scope, altered content,
  interrupted delivery and unsafe permission drift. Isolated resources were removed.
- `npm run build` passed. The compiled API completed liveness, login, own transcript,
  evidence upload/read and logout; its temporary server was stopped.
- The compiled demo exposed a UUID-contract mismatch with deterministic seed IDs.
  Fixed validation to accept canonical PostgreSQL UUID values, added a regression,
  rebuilt and repeated the integration/demo checks successfully. Seed checksums
  and historical migrations were preserved.
- Applied migrations `0004`/`0005` locally, provisioned restricted identities and
  three synthetic accounts. Repeated setup preserves existing credentials.

These are local results; the new branch's remote CI awaits manual publication.
No files were staged, committed or pushed by the assistant. Grades/evidence remain
plaintext; RLS, institutional SSO, approval/grade-write APIs and cryptographic
verification are not claimed.

## 2026-11-23 - Mandatory graph, ML and tamper-verification scope

- The owner confirmed cryptographic tamper verification, Neo4j provenance and
  Python ML anomaly detection as required deliverables. This supersedes earlier
  optional graph/ML descriptions; it does not retroactively claim implementation.
- Kept ZK predicates and vector search as separate use-case decisions, as the
  owner clarified. They cannot replace the required work.
- Defined graph workloads, rules/tabular/graph-feature ML comparisons and integrated
  integrity-versus-risk outcomes in the [capability contract](architecture/required-capabilities.md).
- Revised the local roadmap: Week 8 mandatory Neo4j, Week 9 mandatory ML/anomaly
  detection, Week 10 integrated tamper/witness/recovery evaluation. Week 4 captures
  the authoritative provenance/events needed by those consumers.
- Recorded formal normalization analysis as an open Week 2 deliverable to finish
  before Week 4; separated schema tests do not prove every table is in 3NF.

This change updates requirements and documentation only. Neo4j/ML services, model
training and the independent cryptographic verifier remain pending. No dependencies
were installed and no files were staged, committed or pushed.

## 2026-11-23 - Week 4 branch and incremental commit agreement

The owner merged Week 3 in PR #2 (`6da301b`) and authorised Week 4.
The new working branch is `feat/record-transitions`, based on the fetched merged
`origin/main`. The owner now permits assistant staging/committing only after
permission for each focused update; pushes/merges remain manual. Preserve checked
incremental commits rather than one week-sized implementation commit.

## 2026-11-23 - Formal normalization review

The [normalization review](architecture/normalization.md) is complete for the
sixteen tables in migrations `0001`-`0005`. It documents minimal/conditional keys,
FDs, partial dependencies, nullable/fixed-tag qualifications and lossless logical
decompositions. Physical tenant/predecessor/projection exceptions remain explicit;
this is not a blanket 3NF/BCNF certificate or an applied schema redesign. New Week 4
relations need their own FD review when introduced.

## 2026-11-23 - Atomic SQL workflow slice

The first Week 4 implementation slice adds SQL migrations `0006`/`0007`: immutable
requests/decisions/events, distinct-registrar approval, bound evidence and leased
outbox delivery. Atomic rollback, retries, scope, temporal semantics and worker
lease checks are covered in isolated PostgreSQL tests. Initial proposals also
freeze their offering's academic context before the first grade exists. The
[workflow contract](architecture/record-workflow.md) states the prototype policy
and trust limits; its API/worker integration is a separate update. Development
rollout has not yet been performed at this commit point.

Verified all 27 PostgreSQL tests, including concurrent fresh migrations and cleanup
of the generated test database. Formatting and diff checks passed. The runtime
API/worker updates remain outside this database commit.

## 2026-11-23 - Controlled HTTP workflow slice

The HTTP workflow slice adds validated/shared proposal/status contracts and
registrar proposal/approve/reject routes. SQL wrappers recheck sessions and scope;
there is no caller-supplied actor identity or direct grade-table write. Approval
returns 202 for committed SQL state and visible pending delivery. The API-only
integration entry point passed all 25 reported HTTP/SQL/Mongo tests, including
concurrent corrections and an unavailable document store after evidence staging.
Worker runtime/provisioning remains a separate update.

Shared contracts/API type checks and all 22 API tests passed. The API integration
entry point includes the new workflow tests without importing the worker package,
so this update is independently reviewable from worker provisioning/delivery.

## 2026-11-23 - Recoverable MongoDB projection worker

The worker now consumes committed workflow events using a separate restricted
SQL/Mongo identity. Immutable receipts/revisions support exact retries; the
latest-recorded-version pointer cannot regress under delayed delivery. Leases,
backoff and quarantine are durable SQL state. Replay rebuilds missing derived
documents from one journal snapshot without acknowledging another worker's leases.
The [worker guide](../apps/worker/README.md) documents bounds and operator limits.

All eight worker unit tests and 36 reported isolated integration tests passed,
including partial writes, expired/stale leases, disjoint concurrent claims, Mongo
outage/recovery, permission drift, Unicode reasons, interruption and journal
replay. Generated test resources were removed. Development provisioning and the
compiled full-workflow demonstration remain the next focused update.

## Next milestone

Complete development rollout and the compiled end-to-end demo as a focused
update. Owner diagrams and institutional grading/attempt rules
remain open review items; implementation assumptions must remain explicit.

## Entry format

For future milestones, record the date, concrete outcome, important decision and
verification evidence. Link the relevant PR/commit once it exists. Do not create
future-dated progress entries or mark planned work as complete.
