# Academic data model - Week 2 provisional implementation

This is a provisional implementation of the existing written project specification.
The owner will supply the ER/DFD diagrams; this change does not generate replacements
or claim that those diagrams have been reviewed. Reconcile their differences before
extending the model. All fixtures must be synthetic.

## Scope and ownership

PostgreSQL owns the academic catalogue, institutional references, enrolments and
grade history. The first three migrations create thirteen tables in `academic`:

- Identity/catalogue: `institution`, `app_user`, `role_assignment`, `programme`,
  `student`, `academic_term`, `grading_scheme`, `course`, `course_offering`.
- Academic facts: `enrolment`, `grade_record`, `grade_version`.
- Derived history: `grade_temporal_segment`.

Institution identifiers are carried through composite foreign keys so a student,
offering or record cannot silently reference another institution's entity. User
accounts are global; role assignments supply institutional scope. A revision author
must be an active registrar/examiner in the record's institution. This database
check is not a replacement for future authenticated API access and approval policy.

Catalogue, policy, enrolment and grade facts are separated to avoid copying course
or student details into every revision. Repeated institution keys deliberately
support composite foreign-key isolation; the temporal segment is an explicitly
derived projection. This is controlled redundancy, not a claim that every table
is in third normal form. No stored GPA is maintained; official aggregation rules
remain undecided.

There is no MongoDB academic authority, approval workflow, credential format,
Merkle log, encryption, erasure operation, or cryptographic proof in this migration.
They remain later stages. Grade facts are currently plaintext under database access
controls; deleting a future document key would not erase these facts.

## Explicit assumptions

- One enrolment is unique per student/offering; one final-grade record per enrolment.
  Enrolment rows cannot be updated and cannot reassign existing grade history to
  another student or offering. Retakes can use a new offering. Institutional
  attempt/replacement and withdrawal rules still need owner review.
- Credits are positive, at most 30 per offering and represented to two decimal
  places. This is a prototype bound, not an official academic regulation.
- Grade points are between zero and the selected scheme maximum, capped at 10 in
  this prototype. Schemes are immutable versions with a declared pass threshold.
- `passed`/`failed` require points and must agree with that scheme's threshold;
  `withdrawn`/`incomplete` have no grade points. No official GPA/rounding or degree
  eligibility policy is asserted. The append function rejects excess precision.
- Historical grade values and grade-used offering credits/policy/identity are
  protected. Course titles and other catalogue display metadata are current labels,
  not a fully bitemporal university catalogue.

## Two time dimensions

`grade_version` is append-only and stores immutable grade facts, validity range,
author, reason and database-assigned `recorded_at`. All ranges are half-open
`[start,end)`, with a finite lower bound and an optional unbounded upper end.

`grade_temporal_segment` is a controlled derived query projection. A correction
closes overlapping old belief intervals in system time, retains their historical
rows, and carries forward any unaffected valid-time pieces. A GiST exclusion
constraint prevents overlap on institution + record + both validity dimensions.
The version payload is never rewritten just to close a history interval.

For example, an original grade valid from January can be corrected only for
April-June. A later known-at query sees the corrected grade during that range and
the original grade outside it; an earlier known-at query still sees the old belief.

`grade_record.latest_version_no` means the latest recorded revision. It is not
necessarily the grade effective today: a future-effective correction must not be
reported as already active. `current_transcript` filters the valid-time projection.

Recorded time uses a monotonic database clock per record, not an externally
attested timestamp or exact commit timestamp. Preserve PostgreSQL timestamp
precision when comparing exact event boundaries; JavaScript `Date` loses
microseconds, so tests can use `recorded_at::text` for round trips.

## Write and read interfaces

```sql
SELECT academic.append_grade_version(
  record_id, expected_version, grade_points, outcome,
  valid_from, valid_until, author_id, reason
);

SELECT * FROM academic.transcript_as_of(student_id, known_at, effective_at);
SELECT * FROM academic.current_transcript;
```

Expected version `0` creates the first revision. A record lock serializes revision
attempts; an outdated expected version raises SQLSTATE `40001`. Immutable-version
triggers reject UPDATE/DELETE (`55000`). The insert trigger validates contiguous
predecessors, author scope and grading policy, then the projection/head update
occurs in the same transaction. Direct normal SQL inserts cannot skip that trigger.

## Permissions and limits

`scholarproof_runtime` is a NOLOGIN, non-owner read-only group. It has schema/table
read access and the as-of query function, with no grant to append grades or mutate
base tables. A login/password and API authorization remain later work. These grants
allow database-level read demonstrations, not per-student or tenant RLS isolation.

Migrations need an administrative database connection, including permission to
install `btree_gist` and provision the read-only group. An already-existing unsafe
role causes migration failure rather than silently changing that role.

Triggers and permissions protect ordinary application roles. A database owner or
superuser can disable/replace them; external checkpoints and cryptographic auditing
will be separate future mechanisms. Do not describe this stage as tamper-proof.

## Implementation references

- [PostgreSQL 18 ranges, multiranges and exclusion constraints](https://www.postgresql.org/docs/18/rangetypes.html)
- [PostgreSQL 18 explicit locks](https://www.postgresql.org/docs/18/explicit-locking.html)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
