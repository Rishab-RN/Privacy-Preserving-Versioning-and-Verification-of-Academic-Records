# Normalization of the physical relational schema

The owner requires every physical application relation to reach BCNF, and therefore
1NF, 2NF and 3NF. The forward decomposition in migrations `0008`/`0009` replaces the
earlier tenant/predecessor/protocol copies with normalized facts and computed read
views. Historical migrations `0001`-`0007` remain unchanged. The schema contains
**31 domain tables**, including `academic.student_programme`, the three
transparency relations added by `0010`, the unary event registry in `0011`, and
the six private-proof relations in `0012`.

This document reviews the normalized target implemented by those forward
migrations. Migration, upgrade, integrity and runtime validation are acceptance
gates; their actual results belong in the [project journey](../project-journey.md).
The earlier twenty-table snapshot had physical normal-form exceptions and is not
the schema assessed by this analysis.

## Definitions and scope

For a functional dependency `X -> Y`, equal values of `X` require equal values of
`Y` in every legal state. A superkey identifies a row. A candidate key is a superkey
with no removable attribute; a prime attribute belongs to a candidate key.

- **1NF:** one value per cell in the declared domain, without repeating groups.
- **2NF:** no non-prime attribute depends on only part of a candidate key.
- **3NF:** each nontrivial `X -> A` has a superkey determinant or a prime `A`.
- **BCNF:** every nontrivial determinant is a superkey.

These definitions and the lossless-decomposition criterion follow the authors'
[Database System Concepts normalization chapter](https://www.db-book.com/slides-dir/PDF-dir/ch7.pdf).
The claim concerns physical attributes and identified business FDs, not every
hypothetical university rule. Keys and FDs are justified from constraints and the
model, not inferred from sample rows or a zero-mismatch query.

PostgreSQL ranges are single `tstzrange` domain values. A retained event JSON payload
is a complete immutable transport artifact; nested properties are not additional
relational columns in this analysis. JSON properties and MongoDB collections are
not claimed to be normalized relations. Repeated information in read views or
transport artifacts does not add a dependency to a physical base relation.

## Relation by relation normal form matrix

`K -> row` means each listed candidate key determines the remaining attributes.
All four results apply **after the forward decomposition**, under the listed FDs.
Nullable uniqueness and nonminimal tenant superkeys are qualified below.

| Physical domain table                | Candidate keys and relevant dependencies                                                                   | 1NF | 2NF | 3NF | BCNF |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --- | --- | --- | ---- |
| `academic.institution`               | `institution_id`; `institution_code`; each K -> row                                                        | Yes | Yes | Yes | Yes  |
| `academic.app_user`                  | `user_id`; `auth_subject`; each K -> row                                                                   | Yes | Yes | Yes | Yes  |
| `academic.role_assignment`           | `assignment_id`; `(institution_id,user_id,role_code)`; each K -> row                                       | Yes | Yes | Yes | Yes  |
| `academic.programme`                 | `programme_id`; `(institution_id,programme_code)`; each K -> row                                           | Yes | Yes | Yes | Yes  |
| `academic.student`                   | `student_id`; `(institution_id,student_code)`; each K -> row; programme membership separate                | Yes | Yes | Yes | Yes  |
| `academic.student_programme`         | `student_id -> programme_id`; student ID is the key                                                        | Yes | Yes | Yes | Yes  |
| `academic.academic_term`             | `term_id`; `(institution_id,term_code)`; each K -> row                                                     | Yes | Yes | Yes | Yes  |
| `academic.grading_scheme`            | `scheme_id`; `(institution_id,scheme_code,version)`; each K -> row                                         | Yes | Yes | Yes | Yes  |
| `academic.course`                    | `course_id`; `(institution_id,course_code)`; each K -> row                                                 | Yes | Yes | Yes | Yes  |
| `academic.course_offering`           | `offering_id`; `(course_id,term_id,section_code)`; each K -> row; no institution copy                      | Yes | Yes | Yes | Yes  |
| `academic.enrolment`                 | `enrolment_id`; `(student_id,offering_id)`; each K -> row; no institution copy                             | Yes | Yes | Yes | Yes  |
| `academic.grade_record`              | `record_id`; `enrolment_id`; each K -> row                                                                 | Yes | Yes | Yes | Yes  |
| `academic.grade_version`             | `(record_id,version_no)`; per-record recorded time also identifies a revision; each K -> row               | Yes | Yes | Yes | Yes  |
| `academic.grade_temporal_segment`    | `segment_id`; exclusion also implies `(record_id,valid_during,system_during)` identifies a segment         | Yes | Yes | Yes | Yes  |
| `access_control.password_credential` | `user_id -> salt_hex,derived_key_hex,created_at`; no constant profile column                               | Yes | Yes | Yes | Yes  |
| `access_control.api_session`         | `token_digest -> user_id,created_at,expires_at,revoked_at`                                                 | Yes | Yes | Yes | Yes  |
| `evidence.reference`                 | `evidence_id`; `(submitted_by,request_key)`; each K -> row; institution/schema tag computed                | Yes | Yes | Yes | Yes  |
| `workflow.change_request`            | `request_id`; `(proposer_id,idempotency_key)`; each K -> row; record resolved from evidence                | Yes | Yes | Yes | Yes  |
| `workflow.decision`                  | `request_id -> record_id,decider_id,reason,version_no,decided_at`; decision label computed from result     | Yes | Yes | Yes | Yes  |
| `workflow.domain_event`              | `event_id`; `(request_id,kind)`; identity-bound complete `payload` also identifies the row; no record copy | Yes | Yes | Yes | Yes  |
| `workflow.outbox_delivery`           | `event_id -> delivery state`; no fixed consumer column                                                     | Yes | Yes | Yes | Yes  |
| `transparency.log_state`             | `institution_id -> tree_size,bootstrap_size`                                                               | Yes | Yes | Yes | Yes  |
| `transparency.event_position`        | `event_id`; `(institution_id,leaf_index)`; each K -> row                                                   | Yes | Yes | Yes | Yes  |
| `transparency.checkpoint`            | `(institution_id,tree_size) -> root_hash,issued_at,key_id,signature`                                       | Yes | Yes | Yes | Yes  |
| `transparency.event_source`          | `event_id` is the sole attribute and key; no nontrivial functional dependency                              | Yes | Yes | Yes | Yes  |
| `privacy.credential`                 | `credential_id -> request_id,holder,salt,artifact,issued_at`; record/version/tenant are derived            | Yes | Yes | Yes | Yes  |
| `privacy.issuance_event`             | `event_id`; `credential_id`; each K -> row                                                                 | Yes | Yes | Yes | Yes  |
| `privacy.revocation`                 | `credential_id -> actor_id,reason,revoked_at`                                                              | Yes | Yes | Yes | Yes  |
| `privacy.revocation_event`           | `event_id`; `credential_id`; each K -> row                                                                 | Yes | Yes | Yes | Yes  |
| `privacy.challenge`                  | `challenge_id`; `nonce`; each K -> credential_id,threshold,created_at and remaining identity               | Yes | Yes | Yes | Yes  |
| `privacy.challenge_use`              | `challenge_id -> verified_at`                                                                              | Yes | Yes | Yes | Yes  |

The repository's infrastructure tables are outside the 31-domain-table count but
are also considered. `scholarproof_meta.schema_migrations` has keys `version` and
`name`, each determining checksum/time. `scholarproof_meta.seed_runs` has key
`name`, determining checksum/time. Under these FDs both are BCNF and consequently
satisfy the preceding normal forms. PostgreSQL system catalogues are engine-owned
relations, not application tables redesigned by this project.

The current migration target therefore has **33 physical relations** including the two
metadata tables. Transparency storage has no copied payload, profile/algorithm
constant, public key or bootstrap boundary in each checkpoint row. The signed
artifact reconstructs bootstrap metadata from its keyed parent. A signing key may
serve several institutional logs; no key-to-institution dependency is assumed.
See [transparency invariants](transparency-log.md) for append/checkpoint guards.

The `0011` registry stores only event identity. Source kind and institutional scope
are computed through `transparency.event_context`; neither becomes a dependent
copy in the registry. The source-to-registry foreign key and deferred membership
trigger enforce participation in both directions. Existing event rows, positions,
salts and checkpoints remain unchanged. Migration `0012` adds private-proof issuance
and revocation subtypes without rewriting the workflow prefix.

The six privacy relations store only their keyed facts. A credential references
the approved decision; it does not copy that decision's record/version, tenant,
student, grade or scheme maximum into separate physical columns. Its signed JWS is
an immutable transport artifact, using the same atomic-artifact convention as
workflow payloads. A holder can have multiple credentials; holder is not a key.
Issuance/revocation event IDs and their unique credential references are alternate
keys. Revocation and use are separate immutable facts rather than mutable status
copies. Challenge nonce is an alternate key. Fixed audience/profile and the
120-second expiry are computed; storing both `created_at` and its fixed computed
expiry would introduce a non-key dependency. No uniqueness of salts or hashes is
assumed. RPCs enforce ownership, approved version, bounds, live institutional role,
expiry and currentness; the acceptance insert's key enforces single use.

## Keys and SQL qualifications

A declaration containing an existing key, such as `(institution_id,student_id)`,
is a nonminimal superkey, not another candidate key. Student's nullable
`UNIQUE(institution_id,user_id)` limits linked accounts but is not an unconditional
non-null candidate key. Decision's unique record/version pair applies to approved
results; rejected decisions have no version. See [PostgreSQL constraints](https://www.postgresql.org/docs/18/ddl-constraints.html).

Password profile, evidence schema version and the single outbox consumer are
computed read values, removing the earlier `empty-set -> constant-tag` physical
dependencies. Session creation does not functionally determine expiry: the CHECK
allows different valid lifetimes. Cryptographic uniqueness of digests/salts is not
assumed. A grade alone does not globally determine an outcome; scheme and nullable
withdrawn/incomplete semantics remain explicit domain constraints.

## Physical decompositions and lossless reconstruction

### Student and programme membership

The earlier student relation stored `programme_id` and `institution_id` together;
`programme_id -> institution_id` had a non-key determinant. It is decomposed into:

```text
Student(student_id, institution_id, user_id, student_code, admission_year, created_at)
StudentProgramme(student_id, programme_id)
```

Student ID is a key in both components, so the shared attributes determine one
component and the join is lossless. `StudentProgramme` contains a key-to-attribute
dependency. Student retains its institution-scoped code and optional account-link
uniqueness. Required programme membership and matching institution remain enforced;
`academic.register_student` creates both facts transactionally.

### Offering and enrolment

An offering stores course, term, scheme, section and credits, not their institution
copy. Institution is reconstructed through its course. Enrolment stores student,
offering and creation time, not the institution determined by student ID. Its keys
remain enrolment ID and the student/offering pair. Joining each relation to its
referenced keyed parent restores the earlier institution value without spurious
rows. Guards preserve agreement across course/term/scheme and student/offering.

`grade_record` retains institution because enrolment ID is a unique non-null
candidate key: `enrolment_id -> institution_id` has a key determinant. An institution
column is not automatically a violation; the determinant and candidate keys matter.

### Grade and temporal history

Grade versions no longer store institution or the deterministic predecessor.
Institution comes from the grade record; predecessor is `version_no - 1`, with NULL
for version 1. Locked append guards preserve a contiguous same-record chain.
Grade values, reasons, validity and recorded timestamps are preserved.

Temporal segments no longer copy institution. The record/version FK and
record-based GiST exclusion preserve temporal identity and prevent contradictory
overlap. No historical version is erased to normalize its storage. The current
transcript remains a derived view over retained history.

### Evidence request and event references

Evidence no longer copies institution from its record. Requests no longer copy
the record determined by evidence ID; events no longer copy the record determined
through a request. Joins reconstruct these values for scope, status and transport.
Each removed mapping has a key in its parent, giving lossless reconstruction.

The decision can retain record ID because request ID is its primary key. Its
relevant request-to-record determinant is therefore a key of that relation.
Conditional accepted-result uniqueness is not confused with an unconditional key.
The approved/rejected label is computed from whether a version result exists;
storing that label again would introduce a non-key dependency on the nullable
version result. The physical table keeps the facts, not the reconstructible label.

### Protocol constants

`scrypt-v1`, evidence schema version `1` and `mongo-records-v1` are supplied by
read/transport interfaces rather than physical per-row columns. The current
outbox physical key is event ID. Protocol compatibility does not require storing
the same fixed tag with every credential, evidence reference or delivery.

## Integrity constraints after decomposition

Normalization and integrity answer different questions. Removed composite tenant
copies require replacement enforcement of the original business constraints:

- PKs, alternate uniqueness, nullability, domain/precision checks and parent-row
  existence remain enforced on normalized facts.
- Student, programme, offering, enrolment and grade record must agree on
  institution. Scope validation locks referenced parents; their institution
  identities cannot be reassigned to race or bypass child checks.
- Every committed student has a required programme link. Administrative creation
  is transactional, and historical enrolment identity cannot be reassigned.
- Schemes, enrolments, grade versions and workflow facts retain their immutability
  rules. Submitted proposals freeze relevant offering academic context.
- Approval checks session, account, institutional role, distinct actors, available
  bound evidence and expected revision. Version, head, temporal projection,
  decision, event and delivery work commit or roll back together.
- Session revocation, evidence pending-to-available, lease/token validation,
  backoff and quarantine retain their controlled transitions.
- Runtime identities remain non-owners. API writes use controlled wrappers;
  workers cannot gain credential/academic access through context views.

These requirements need negative, concurrent and upgrade checks, not only row
counts. Migration must preserve the retained fact projection before/after
decomposition and roll back on a mismatch. The test results, deployment state and
remaining acceptance work are recorded separately in the project journey.

## Read views and transport compatibility

The student, offering, enrolment, grade-version, credential, evidence and workflow
`*_context` views reconstruct selected earlier read shapes. They are not physical
application tables and are not represented as BCNF storage. A predecessor, tenant,
profile, schema tag, decision label or consumer can appear in a result without
being stored again.

HTTP contracts and Mongo evidence/event schemas keep their identifiers, decimal
grade strings and microsecond timestamp text. Direct writers, fixtures and
administrative commands use normalized base columns. Forward migrations decompose
existing facts and update controlled interfaces; applied migration files remain
immutable. The normalized seed carries forward the old fixture marker/history
without resetting existing data.

## History and acceptance boundary

The earlier sixteen-table review and Week 4 appendix identified the constrained
copies at that time. The owner's 24 November 2026 requirement replaces that storage
tradeoff with a physical BCNF gate. Twenty-table screenshots/reports are historical
evidence until regenerated against the decomposed schema.

BCNF is justified by keys and FDs. Tests establish that decomposition and
replacement constraints preserve observed behavior; they do not discover every
possible semantic FD or approve official university policy. Fresh/upgrade
migrations, SQL integrity, HTTP, worker and compiled demonstrations must pass
before development rollout is described as complete.
