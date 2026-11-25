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

## 2026-11-23 - Week 4 local rollout and operator demonstration

Applied migrations `0006`/`0007` to the existing development database without
rewriting historical migrations or resetting data. Provisioned the restricted
worker and two separate synthetic registrars/record. Repeated provisioning
preserved `.env`, `.env.api`, `.env.worker` and both demo account files byte for
byte; credentials and fixture metadata remain ignored.

Added a live, institutionally scoped registrar `change-context` endpoint so
proposals can use the latest recorded version even when a future-effective
revision differs from the transcript. SQL still rechecks the precondition.
HTTP/SQL/Mongo reasons now consistently support 500 Unicode codepoints.

`npm run check` passed lint, formatting, types and all 39 reported tooling/API/
worker tests. All 27 isolated SQL tests and 37 reported integration checks passed;
generated resources were removed. `npm run build`, compiled access smoke and the
compiled API proposal/independent approval/worker projection smoke passed. Both
temporary API processes were stopped. The initial sandboxed quality attempt
could not connect to its loopback HTTP servers; the permitted service-access run
passed. CI now defines worker provisioning and the full workflow smoke, but remote
CI has not run for these unpublished commits.

The local worker CLI also completed an empty one-shot batch and replayed both
committed demo events idempotently. Migration status confirms `0001`-`0007` applied.

The technical Week 4 slice is locally verified. This does not approve the
institutional grading policy, provide administrator-resistant proofs or complete
the product UI. Those boundaries remain explicit in the architecture documents.

## 2026-11-24 - BCNF physical storage and lab evidence

The owner confirmed that every physical application table must reach BCNF.
Forward migrations `0008`/`0009` decompose the existing storage into 21 domain
relations, including a separate student/programme assignment. Two repository
metadata relations also satisfy the identified BCNF dependencies. The
[normalization analysis](architecture/normalization.md) lists the candidate keys,
FDs, normal forms and lossless reconstruction argument. Range/JSON values retain
their declared domain boundary; computed context views are not physical tables.

Removed tenant, predecessor, fixed protocol and derived decision-status copies
are reconstructed by read views. Normalized foreign keys, locked scope guards,
immutable parent ownership and deferred programme participation preserve the
integrity rules. Event identity checks explicitly reject JSON null. API and worker
permissions retain their separate controlled boundaries.

All 34 isolated PostgreSQL tests and 37 reported integration checks passed. These
include a populated legacy-schema upgrade preserving every prior row through
reconstruction, immutable credentials/history/events, accepted and rejected
decisions, and queued delivery state. Concurrent fresh migration and repeatable
seed checks passed. Lint, formatting, types, all 39 tooling/API/worker tests and
the build passed. The compiled access and complete workflow demonstrations passed
against the migrated development services.

Applied both forward migrations to the backed-up local database. Historical
migrations and the original seed remain unchanged. Provisioning verified existing
accounts and restricted runtimes; six local environment/account/fixture files
remained byte-for-byte unchanged. No data reset or credential rotation occurred.

Generated an ignored catalogue register for all 23 physical relations and four
fresh screenshots from a local API demonstration interface using synthetic data.
The capture passed 16 HTTP checks, appended version 7 from version 6, retained the
version-6 historical answer and confirmed MongoDB delivery at version 7. The lab
reports and capture tools remain ignored. This interface presents the implemented
API; it does not complete the product React UI or later tamper/graph/ML milestones.

## 2026-11-25 - Week 5 signed workflow history

Verified remote Week 4 merge PR #3 (`fabcabe`) and started the single active branch
`codex/signed-transparency-log`. With owner approval, committed the BCNF follow-up
as `5222037` and `d5caf69`; no report, secret, dump or planning file was included.

Migration `0010` adds three BCNF relations for institutional log state, private
salted event positions and immutable checkpoints. Transactional row locking orders
new appends and rollback leaves no gap. Existing events have an explicitly signed
bootstrap boundary: their import order is deterministic, their original SQL commit
order is unknown. The schema now has 24 domain and two metadata relations.

The independent verification package implements bounded canonical JSON, salted
domain-separated commitments, SHA-256 Merkle inclusion/consistency and Ed25519
checkpoints. Its offline CLI pins a supplied trusted public key plus expected
log/event identity. It verifies retained-observation consistency without database
credentials. Independent fixed vectors and every leaf/prefix for sizes 0-65 cover
the tree implementation; larger safe integer tests avoid 32-bit truncation.

The restricted log operator validates actual SQL event/grade/request/decision
facts, SQL head consistency, raw Mongo evidence bytes and derived projections.
Publication checks retained history before signing and returns only after SQL
commit. Local observation locking, identity inheritance checks, exact function
grants, key preservation and actual restricted-password authentication are tested
or verified by provisioning. Invalid integrity, pending delivery and unavailable
observations remain distinct.

All 42 isolated SQL tests and 46 reported integration checks passed. These include
actual grade/evidence mutation, position deletion/reordering, source reconstruction,
offline proof verification and inherited privilege drift. The shorter-observation
case models rollback with a retained checkpoint; it is not a complete SQL/Mongo
backup-restore experiment. Quality/build checks passed all 74 reported tooling,
API, worker, verification and log tests. Temporary test resources were removed.

Backed up the development database and applied `0010`. The live demo extended the
signed log from 14 to 16 events with bootstrap size 14. Offline inclusion and
consistency passed; payload/path/signature changes, signed rollback and conflicting
roots were rejected. The live audit checked 16 events and eight evidence documents
with valid integrity and complete projection. Repeat setup preserved all previous
environment/account/fixture files, `.env.log` and signing keys byte for byte.

Audit coverage explicitly reports 102 seeded/admin grade versions without workflow
events. Catalogue metadata and the SQL temporal cache are not cryptographically
committed; heads receive a structural check. Same-host retained files demonstrate
the observation protocol, not independent witness control. Historical inclusion
does not prove factual correctness or current credential status. Remote CI has
not run at the local acceptance point; inspect the published GitHub run before
merging.

## Next milestone

The owner merged Week 5 in PR #4 (`c2aaea6`), after its remote CI passed. Week 6
continues on `feat/credential-profile`; future branches use standard feature/fix/docs
prefixes at the owner's request. Week 6 adds exact signed
credential artifacts, selective disclosure and explicit status/freshness semantics.
Institutional grading/attempt rules remain open review items. Neo4j provenance,
Python ML/anomaly detection and later integrated witness/recovery experiments
remain mandatory scheduled milestones.

## 2026-11-25 - Week 6 event-source compatibility slice

Migration `0011` introduces a BCNF unary event registry and a shared computed
event context. Workflow events still own their facts and atomic Mongo delivery;
existing salts, event payloads, positions, bootstrap state and checkpoints remain
unchanged. Deferred participation checks reject orphan identities. The API and
worker remain unable to read the registry, and the log reader cannot write it.

The log reader uses the common interface and checks each source/kind pairing.
Source classification stays outside commitment bytes and exported event entries.
Unit fixtures prepare the distinction between workflow projection work and future
credential-only events; SQL currently accepts only workflow sources. No credential
issuance, holder disclosure, status or replay-protection endpoint is complete yet.

Quality checks and build passed, including 76 tooling/unit tests. All 45 isolated
SQL checks and 46 integration checks passed. A populated `0010` upgrade preserves
a genuine signed checkpoint byte for byte, then validates its historical proof
after another append. Orphan/immutability, rollback and restricted-read tests pass.
The schema target has 25 domain plus two metadata tables; development migration
rollout has not occurred. Unfinished service scaffolding is preserved in ignored
local runtime drafts and is excluded from the reviewable slice. Nothing has been
staged or committed at that validation point. The owner subsequently approved
commit `52c538f` (`refactor: introduce shared event source registry`); the reviewed
15-file slice was committed on `feat/credential-profile` without pushing.

## 2026-11-25 - Week 6 credential cryptography slice

Added the private `@academic-records/credentials` library with pinned JOSE
dependency `jose@6.2.18`. It issues a compact issuer-signed artifact and six private
flat claim disclosures. Holder presentation verifies the trusted issuer and the
complete private disclosure set before signing only selected claims. Verifier
checks exact consent, pinned issuer, immutable version identity, exact artifact
digest, holder signature, audience/nonce and bounded proof age.

The optional log-evidence verifier binds a pinned-key inclusion proof to that same
credential/artifact/version/holder. It rejects validly signed evidence about
another artifact. Hidden values remain absent from the returned presentation;
visible identifiers and holder keys remain linkable. This is a narrow RFC 9901
application profile, not full SD-JWT VC or wallet-standard compliance.

All 89 tooling/unit checks and the build passed, including 13 new credential
tests. New fixtures cover the RFC's published disclosure hash, independently
constructed Node Ed25519 JWTs, noncanonical valid JSON, exact consent, malformed
encoding, duplicate JSON names, private/wrong keys, wrong audiences/nonces, stale
proofs, modified disclosures and mismatched valid log evidence. SQL and integration
checks were not rerun for this library-only slice; the preceding source-registry
slice passed 45 SQL and 46 integration checks. No database or private key changed.

Week 6 remains in progress. SQL persistence/approved-version authorization,
holder-key registration, exact issuance retry, durable challenge consumption,
revocation/supersession and signed current-status evidence are pending. Stateless
verification alone cannot prevent a repeated presentation from passing within its
validity window. The next slice must enforce these online boundaries atomically.

The credential library slice was committed as `21b2a88`. The owner then explicitly
waived per-commit approval for future work. Focused commits still require reviewed
paths and relevant passing checks. Earlier permission-per-commit entries describe
the agreement at that time and are superseded for future commits. Normal topic
pushes retain the owner's earlier authorisation; PR review and merging remain
owner-controlled.

## 2026-11-25 - Scoped frontend directory

The owner prioritised the working UI before advancing to the next week. Added a
bounded, authenticated student directory containing only student ID/code and
institution ID. It rechecks live role/account scope: students see their own linked
subject, institutional registrars/auditors see scoped subjects, and examiners gain
no directory visibility. No schema or runtime grants changed. Shared frontend
session/transcript types preserve existing response shapes.

All 47 isolated integration checks passed, including the new directory scope and
unauthenticated checks. The 89 tooling/unit checks passed. React browser entry and
screens are being implemented separately on the same active feature branch; this
directory update does not claim the UI is complete.

## 2026-11-25 - Working academic records frontend

Completed the current HTTP-backed React/Vite/Tailwind workspace before advancing
the weekly plan. Separate page modules cover sign-in, a scoped overview/student
selector, course search, known/effective-time transcript filters, supporting-note
submission/retrieval, registrar proposals and independent decisions. Delivery
history remains distinct from academic acceptance. No credential, graph or ML
success is simulated for an unimplemented endpoint.

Tokens and retry state remain in memory. A 401 or expiry clears the workspace;
refresh requires sign-in. Role-specific controls supplement server enforcement.
Exact retries retain the original version/body/key even after a committed response
is lost. Transcript request generations reject stale responses. Explicit control
labels/descriptions, a skip link, focus indicators, contained keyboard-scrollable
tables, reduced motion and a mobile layout are included. Pages/controls are
separate modules, not a single application component.

The production bundle, formatting, lint, all types and 89 tooling/unit checks
passed. All 47 isolated integration checks passed for the directory/API update.
One complete live Playwright scenario passed after the final modular split; it
covers student/auditor/registrar roles, invalid login, historical empty/search
states, network recovery, a committed-but-lost proposal response with exact retry,
blocked self-review, approval cancellation/confirmation by another registrar,
revised-version rendering, 401 cleanup and refresh/memory semantics. Desktop and
390-pixel mobile screenshots were rendered and inspected locally. Repeated browser
runs append synthetic evidence/corrections; they do not reset development history.
CI now builds the frontend and defines the same browser scenario with Chromium.

Saved a PostgreSQL custom-format backup before deploying the already-tested
`0011` registry migration locally. All nine existing environment/account/fixture/
key files checked remained byte-for-byte unchanged. Drained eight synthetic
projection events in two restricted worker batches, with zero failures. The log
operator preserved the retained prefix and published size 24 (bootstrap 14).
Final audit checked 24 events and 12 evidence documents: valid integrity,
complete projection, no issues. The 102 seed/admin uncovered grade versions and
currentness limits remain explicit. Backups, captures and local material stay ignored.

The frontend for current HTTP workflows is ready for review. Week 6 still needs
credential storage/authorisation, holder registration, one-use challenges and
status/revocation services, followed by their live UI. The owner requires frontend
work as an acceptance gate before advancing to another week. Published CI must
pass and the owner must review before merging.

## 2026-11-25 - Mandatory ZK proof and approved-version service

The owner made zero-knowledge proofs a major mandatory capability before Week 7.
Selected a bounded course-grade threshold: knowledge of the hidden approved grade,
salt and holder secret opening an issuer-signed commitment, with exact integer
hundredths and circuit-constrained ranges. This is separate from the stateless
SD-JWT library and does not claim GPA or anonymous credentials. The core circuit,
proof library and hash-pinned setup tooling were committed as `407075e`.

Added forward migration `0012`, with six immutable BCNF relations for credential,
issuance/revocation events, revocation, challenge and one-use acceptance. Approved
decision references reconstruct dependent record/version/tenant/student context.
Exact concurrent issuance retains the first artifact; issuance cannot silently
race a newer approved version. The restricted API has seven explicit RPC grants
and no raw private-proof table access. Worker/signer startup guards also protect
the new schema. The separate Ed25519 issuer attests the SQL-derived commitment.
The holder secret remains client-side and is proved by the circuit.

Acceptance independently verifies the actual proof and issuer binding, then locks
the record head and rechecks database-clock expiry and live revocation/currentness
while inserting the unique consumed-challenge fact. Concurrent copies have one
winner. A signed as-of receipt is returned only after consumption commits. A lost
success response requires a new challenge rather than replay recovery.

Issuance/revocation append to the existing institutional signed-history sequence
without rewriting earlier commitments/checkpoints. They do not enter Mongo grade
delivery; the operator reads minimal public event facts, not private witnesses.
Online ZK acceptance does not itself validate a published inclusion sidecar.
SD-JWT service deployment, independent verifier trust distribution and wider proof
packaging remain distinct integration boundaries.

The real circuit suite passed all five reported checks, including raw invalid
witnesses rather than only host prechecks. All 55 isolated SQL/Mongo integration
checks passed, including concurrent issuance/acceptance, both expiry clocks,
revocation, supersession and source-log compatibility. The 45 SQL regression checks
passed before development rollout. Quality checks passed 91 tooling/unit checks;
the production build and both live browser journeys passed. Frontend evidence and
final rollout/CI observations are recorded in the following delivery entry.

Setup preserves a single-operator development ceremony and distinct issuer keys,
with source/R1CS/WASM/proving-key/verification-key manifest checks. It is not an
independently contributed production setup or a security audit. Public identifiers
remain linkable; repeated consented thresholds can narrow a grade. Host side-channel
resistance is not claimed. Dependency overrides resolve high/moderate findings;
15 low advisories remain through unused circomlibjs signing dependencies, as
documented in the dependency guide. No breaking audit-fix downgrade was applied.

## 2026-11-25 - Connected private-proof browser demo

Added student Private proofs, an unauthenticated `/verify` workspace and an
institutional registrar Credential status screen. A browser-local worker verifies
proving-artifact hashes, generates the actual Groth16 proof and terminates. Public
proof downloads omit the exact grade, salt and secret. Private wallet download and
restore are explicit; navigation/reload clears in-memory wallet material. The UI
states the development ceremony, linkable metadata and latest-recorded-version
semantics. It verifies the signed acceptance receipt's challenge, credential,
version, threshold and nullifier rather than displaying unbound response fields.

Both production-browser scenarios passed, including malformed holder inputs,
actual local proving, modified proof rejection without consumption, one acceptance,
replay failure, registrar UI revocation and rejection of a second unconsumed valid
proof. Desktop and 390-pixel verifier screenshots were rendered and inspected;
mobile overflow checks passed. The production build splits the proof tools into
a lazy page/worker instead of importing Node wallet dependencies into the main UI.
The [demo guide](development/zero-knowledge-demo.md) gives setup, a short explanation,
positive/negative cases and safe code/table views.

CI now prepares and verifies a fresh development ceremony, runs actual circuit
tests and exercises both browser journeys against disposable services. Quality
checks remain Windows/Linux; integration and browser checks run on Linux. Remote
CI results will be recorded after publication, rather than inferred from local
success. Week 7 has not started.

Before applying `0012` locally, saved a custom-format PostgreSQL backup under
ignored runtime storage. All 12 existing environment/account/fixture/log-key/
issuer-key files checked after implementation remained byte-for-byte unchanged.
No history reset or silent key rotation was used. The six new relations bring
the physical model to 31 domain and two metadata tables.

## 2026-11-25 - ZK rollout and acceptance evidence

The service was committed as `035c4aa`, and its connected UI/demo/CI as `f7c7812`.
[The published CI run for that implementation](https://github.com/Rishab-RN/Privacy-Preserving-Versioning-and-Verification-of-Academic-Records/actions/runs/45559008606)
passed Windows/Linux quality builds and the Linux PostgreSQL/Mongo integration,
fresh native-compiler ceremony, real proof tests and both Chromium journeys.
This includes independent clean setup, not only reuse of the developer's keys.

Strengthened raw range tests to recompute matching commitments for invalid grades:
they must fail from the below-threshold/above-maximum constraints, rather than
only from a mismatched opening. Oversized salts/secrets and a maximum above 9999
likewise use matching hashes and fail inside the circuit. All five reported real
proof checks passed. The browser also proves a new issuance gets a fresh credential
after successful issuance, while lost-response retries retain the pending identity.
Both final browser scenarios passed. Added typechecking for the real-circuit test
project; lint, formatting, types and diff checks passed.

Docker Desktop stopped during the final local-service check. Restarted the installed
Desktop and the existing containers without recreating volumes; migrations
`0001`-`0012` remained applied. Restarted the API with `.env.zk`; the live API's
public ZK configuration and web page both returned 200. The twelve preserved
environment/account/fixture/signing-key files still matched their saved hashes.

Delivered eight pending synthetic projection events across bounded worker batches,
with zero failures. The separate signer preserved the retained prefix and published
a final size-40 checkpoint (bootstrap 14). Its audit checked 40 events and 16
evidence documents: valid integrity, complete projection, zero issues, zero
unanchored events. The 102 seed/admin uncovered versions remain explicitly outside
workflow-log coverage; historical anchoring does not establish currentness.

The bounded ZK implementation and connected UI meet this prototype's acceptance
gate. Week 7 has not started. The single-operator development setup, unaudited
browser helper, linkable identifiers, independent verifier trust distribution,
Merkle-sidecar packaging and separate SD-JWT service boundaries remain explicit.
Neo4j/ML remain mandatory later milestones, not work completed by this slice.

## 2026-11-26 — Week 7 student, registrar and verifier flows

Students and scoped staff can inspect recorded revisions without changing the
effective-time transcript view. Each page contains up to 20 immutable grade
versions with recording times and effective intervals. The query uses existing
PostgreSQL access and tenant boundaries. No schema migration was needed.

The student preview shows the minimum grade, credential and record identifiers,
version and verification data before consent. The operator can export an
issuance proof by credential ID. The public verifier checks the issuer signature
and exact artifact binding, then verifies the signed checkpoint and Merkle path
using the configured log public key. Signed issuance and live status are displayed
separately. The live result identifies its check time, and proof-only history
checks leave the challenge unused. A revoked credential can still have signed
historical issuance. Independent log publication remains an operator action.

Quality checks and the build passed. The 56 isolated integration checks include
scope denial, cursor behavior, exact artifact binding, wrong signing key and
invalid inclusion. Both real browser journeys passed, covering independent grade
correction, keyboard revision navigation, local proof generation and disclosure,
altered issuance evidence, service unavailability, online acceptance, replay and
revocation. The verifier was rendered at desktop and 390-pixel widths.

Week 7 was developed on the active credential branch, which already held the
unmerged Week 6 portal work. Neo4j provenance is the Week 8 milestone.

## 2026-11-26 — Week 7 proof picker follow-up

Private proofs now lists only the signed-in student's latest independently
approved passed versions. The list contains course code, record ID and version.
It avoids presenting seed-only or historical transcript results as eligible.
The form sends the selected version with the issuance request. If a newer
approval changes the selection, the UI reloads the list and asks the student
to choose again. Exact retries keep their original credential.

Migration `0013` adds a restricted read function without adding tables. It was
applied locally after saving and checking a custom-format PostgreSQL backup.
The quality gate, 45 SQL checks, 57 integration checks and both browser journeys
passed. Tests cover an empty list before approval, scope denial, stale-version
conflicts and the selected version in the browser request.

## 2026-11-26 — Week 8 Neo4j provenance

The merged Week 7 revision was the base for `feat/provenance-graph`. Migration
`0014` adds restricted outbox and review functions with no new SQL tables. It was
applied locally after validating a PostgreSQL custom-format backup. Neo4j 5.26.33
and the 6.3.2 JavaScript driver were pinned. The local service uses loopback Bolt
and generated ignored credentials.

The projection reads committed positions and writes each batch with its Neo4j
cursor in one transaction. The portal traces revisions to their approval actors
and evidence, groups repeated pairs and upward corrections, shows evidence reuse,
and labels lag against the SQL high-water mark. Time-bounded prior pairing and
evidence counts use both timestamp and committed order for the Week 9 feature
inputs. Rebuild and the worker's retry path preserve authoritative SQL grades.

The synthetic measurement used 21 approvals at 65 committed positions and
matched every SQL and Cypher result. The 15-run median and p95 are in milliseconds.

| Workload                     | PostgreSQL median / p95 | Neo4j median / p95 | Matching rows |
| ---------------------------- | ----------------------: | -----------------: | ------------: |
| Version ancestry             |           10.73 / 14.74 |      13.87 / 18.06 |            21 |
| Repeated approval pairings   |           36.75 / 60.04 |      11.90 / 13.93 |             1 |
| Upward corrections by course |           26.46 / 35.66 |      11.66 / 13.42 |             1 |
| Evidence digest reuse        |           35.35 / 53.46 |      11.80 / 16.89 |             4 |

The graph held 74 scoped nodes and 151 relationships. The local Neo4j store used
1,276 KiB and its preallocated transaction directory used 263,172 KiB. The seven
selected PostgreSQL tables, including indexes, used 540,672 bytes across all
local scopes. These are different storage boundaries. EXPLAIN and PROFILE output
is retained locally with the measurement. The small synthetic workload does not
predict comparative performance at campus scale.

All 45 SQL checks and 61 integration checks passed, including SQL parity, scoped
access, concurrent workers, duplicate delivery, reversed rebuild input, lag and
recovery after an unreachable graph. Both browser journeys passed, including
the registrar's approval-to-provenance path, keyboard use and 390-pixel overflow
checks. See the [provenance demo](development/provenance-demo.md).

## Entry format

For future milestones, record the date, concrete outcome, important decision and
verification evidence. Link the relevant PR/commit once it exists. Do not create
future-dated progress entries or mark planned work as complete.
