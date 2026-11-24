# Academic data model

The implemented model separates academic identity, catalogue, enrolment, grade
history, authenticated access, evidence and approval/delivery facts. The owner
requires BCNF physical storage; forward migrations `0008`/`0009` decompose the
earlier twenty-table design into 21 academic/access/workflow relations without
rewriting applied history. Migration `0010` adds three BCNF transparency relations,
giving **24 domain tables plus two metadata tables**. Actual migration/runtime
validation is recorded in the [project journey](../project-journey.md).

All demonstration fixtures are synthetic. The model's selected grade bounds and
approval rules are explicit application assumptions, not an assertion of official
institutional regulations.

## Authority and relation groups

PostgreSQL is authoritative for:

- Academic identity/catalogue: `institution`, `app_user`, `role_assignment`,
  `programme`, `student`, `student_programme`, `academic_term`, `grading_scheme`,
  `course` and `course_offering`.
- Enrolment/history: `enrolment`, `grade_record`, `grade_version` and
  `grade_temporal_segment`.
- Authentication: `access_control.password_credential` and `api_session`.
- Evidence manifest: `evidence.reference`.
- Controlled changes: `workflow.change_request`, `decision`, `domain_event` and
  `outbox_delivery`.

MongoDB holds evidence content and rebuildable receipts, revisions and a
latest-recorded-version pointer. It does not become a second transcript authority.
Academic/evidence data remains plaintext under access restrictions.

## BCNF storage and scoped integrity

The [normalization analysis](normalization.md) lists every physical relation's
candidate keys, FDs and 1NF/2NF/3NF/BCNF result. Student programme membership is a
separate keyed relation. Offering and enrolment do not store institution copies;
grade versions and temporal segments do not store tenant copies; versions compute
their predecessor; evidence/requests/events reconstruct parent-derived identities.
Fixed credential/schema/consumer tags and the reconstructible approved/rejected
decision label are computed read values.

`grade_record` retains institution because enrolment ID is a candidate key. The
normal-form argument considers determinants rather than removing every repeated
identifier indiscriminately. Physical facts are BCNF under the identified FDs;
read views and immutable JSON transport artifacts are analyzed at their declared
domain boundary, not claimed as normalized mutable relations.

Primary/unique/foreign keys preserve row identity and referenced existence. Locked
scope guards preserve the cross-institution agreement previously represented by
composite tenant copies. Referenced institution identities are immutable, preventing
parent changes from racing or bypassing child-side checks. Every committed student
must have a same-institution programme link. `academic.register_student` creates
student identity and membership transactionally; it is an administrative interface,
not a newly public API permission.

The `*_context` views reconstruct older read shapes where useful. They may show a
derived institution, predecessor or protocol tag without storing those attributes
again. API/worker identities do not receive write access to these projections.

## Academic assumptions

- A student/offering pair has one enrolment; an enrolment has at most one grade
  record. Enrolment identity is immutable. A retake can use a new offering.
- Offering credits are positive, at most 30 and represented to two decimal places.
  Credits, course, term and selected scheme are frozen when referenced by a proposal
  or accepted grade.
- Schemes are immutable versions with a declared maximum and pass threshold.
  Grade points are between zero and the selected maximum, capped at 10. The append
  interface rejects excess precision.
- `passed`/`failed` require points and agree with the selected threshold;
  `withdrawn`/`incomplete` have no points. No stored GPA or official rounding,
  degree-eligibility or attempt-replacement policy is inferred from demo values.
- One active registrar proposes; a different active registrar in the same
  institution approves/applies or rejects. Students retain own transcript/evidence
  access; auditors have institutional reads; examiner-only accounts have no granted
  academic data operations.
- Grade values are historical facts. Course titles and other display metadata are
  current catalogue labels, not a fully bitemporal university catalogue.

## Two time dimensions

`grade_version` is append-only and stores record/version identity, grade, outcome,
validity, author, reason and database-assigned `recorded_at`. Ranges are half-open
`[start,end)`, with finite lower and optional unbounded upper limits.

`grade_temporal_segment` is a derived query projection. A correction closes old
belief intervals in system time, keeps their historical rows, and carries forward
unaffected valid-time pieces. A record-based GiST exclusion prevents contradictory
overlap across valid and system ranges. Version payloads are never rewritten to
close a historical interval.

For example, a correction valid only during April-June changes a later known-at
answer in that range while preserving the prior grade outside it. An earlier
known-at query still returns the old belief. `grade_record.latest_version_no`
means latest recorded revision, which can differ from the grade effective today.
The `current_transcript` view filters the temporal projection accordingly.

Recorded time is monotonic per record and asserted by PostgreSQL, not externally
attested or a global commit order. Preserve microseconds when comparing exact
boundaries; JavaScript `Date` alone loses that precision.

## Read and controlled write boundaries

```sql
SELECT * FROM academic.transcript_as_of(student_id, known_at, effective_at);
SELECT * FROM academic.current_transcript;
```

The API uses authenticated workflow wrappers for proposal, approval, rejection and
status. It cannot directly append grades. Internally,
`academic.append_grade_version(record_id,expected_version,grade_points,outcome,
valid_from,valid_until,author_id,reason)` takes a record lock, validates policy and
creates the next contiguous revision. Expected version 0 issues the first result;
stale expectations raise `40001`. Immutable guards reject UPDATE/DELETE (`55000`).
The head/projection effects share the acceptance transaction.

Session/account/role scope is rechecked on HTTP operations and inside controlled
transitions. Runtime groups remain non-owners with narrow privileges. The original
`scholarproof_runtime` group is a database demonstration reader, not the API login;
its existence does not establish per-student RLS. Administrative migrations require
permission to install `btree_gist` and provision/harden roles.

## Verification and trust

Upgrade checks must retain existing student IDs, memberships, grade history,
temporal answers, credentials and event envelopes. Existing synthetic seed checksums
remain immutable; normalized seeding carries the existing fixture forward instead
of replaying inserts or resetting history. Fresh fixture creation uses normalized
columns and the administrative registration operation.

Constraints and wrappers protect ordinary runtime identities. An administrative
database owner can replace logic, and a compromised API credential can manage
sessions. Evidence digest checking therefore does not establish resistance to a
malicious database administrator or cryptographic individual non-repudiation.

## Implementation references

- [PostgreSQL 18 constraints](https://www.postgresql.org/docs/18/ddl-constraints.html)
- [PostgreSQL 18 ranges and exclusion constraints](https://www.postgresql.org/docs/18/rangetypes.html)
- [PostgreSQL 18 explicit locks](https://www.postgresql.org/docs/18/explicit-locking.html)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
