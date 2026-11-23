# Normalization review of the academic record schema

Reviewed on 23 November 2026 against migrations `0001` through `0005`: thirteen
`academic` tables, two `access_control` tables and `evidence.reference`. Migration
runner metadata and future workflow/outbox tables are outside this review.

The normalization analysis is complete for this schema snapshot, with the
exceptions below documented. **The physical schema is not uniformly in 3NF or
BCNF.** It combines separated business entities with deliberate tenant-key copies,
an explicit predecessor and derived temporal/head state. This is not a strict 3NF
certification or approval of institutional grading rules. No applied migration
was edited and no decomposition described here has been applied to the database.

## Definitions and analysis boundary

For `X → Y`, equal `X` values in legal rows require equal `Y` values. A superkey
identifies a row; a candidate key is a superkey with no removable attribute. A
prime attribute appears in a candidate key.

- **1NF:** one value per cell in the chosen domain, without repeating groups.
- **2NF:** no non-prime attribute depends on only part of a candidate key.
- **3NF:** every nontrivial `X → A` has a superkey determinant or a prime `A`.
- **BCNF:** every nontrivial determinant is a superkey.

These definitions and the distinction between lossless and dependency-preserving
decomposition follow the authors' [Database System Concepts normalization slides](https://www.db-book.com/slides-dir/PDF-dir/ch7.pdf).

The analysis concerns committed states satisfying the keys, foreign keys, checks
and relevant triggers. It includes FDs implied by global referenced identifiers;
looking only at a table's primary key would miss tenant redundancy. It does not
infer new FDs from a small synthetic fixture or a presumed official grading policy.

PostgreSQL ranges are treated as single typed interval values here. Each grade
version/role/enrolment occupies its own row; no student row contains a repeating
list of courses or versions. Splitting interval bounds into scalar columns would
not remove the tenant/predecessor dependencies discussed below.

Three SQL qualifications matter:

1. `student.user_id` is nullable. Its `UNIQUE (institution_id, user_id)` restricts
   linked accounts, but is not an unconditional candidate key: ordinary PostgreSQL
   uniqueness permits several NULL values. In contrast, the other alternate keys
   listed as declared keys have non-null attributes. See [PostgreSQL 18 constraints](https://www.postgresql.org/docs/18/ddl-constraints.html).
2. `password_credential.profile` and `evidence.reference.document_schema_version`
   are presently constrained to one literal value. The table below classifies
   variable business fields, with these fixed protocol tags set aside. In a strict
   FD model including constants, `∅ → profile` and `∅ → document_schema_version`
   are additional non-key dependencies; the qualified business-field result must
   not be presented as an unconditional physical BCNF result.
3. Defaults, approximate uniqueness and cryptographic assumptions are not FDs.
   Session defaults use a one-hour lifetime, but the CHECK permits shorter ones,
   so `created_at → expires_at` is not assumed. Salt/digest fields are not candidate
   keys. Neither `max_points → pass_points` nor `grade_points → outcome` holds
   globally merely because the demo uses one grading scheme.

## Keys and functional dependencies

In the table, `K → row` means every listed key determines the remaining variable
business attributes. A declared key is a minimal non-null primary/unique key.
An implied key follows from other enforced dependencies even if it has no separate
UNIQUE declaration. These are the keys used for this review; conditional account
identifiers and trigger-derived temporal identifiers are distinguished explicitly.

| Table                                | Declared minimal keys                                   | Additional implied keys / relevant FDs                                                                                             | Business-FD assessment                                                                       |
| ------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `academic.institution`               | `institution_id`; `institution_code`                    | Each key → row                                                                                                                     | BCNF                                                                                         |
| `academic.app_user`                  | `user_id`; `auth_subject`                               | Each key → row                                                                                                                     | BCNF; local subject namespace is an authentication assumption                                |
| `academic.role_assignment`           | `assignment_id`; `(institution_id, user_id, role_code)` | Each key → row; a global user may have roles in several institutions                                                               | BCNF                                                                                         |
| `academic.programme`                 | `programme_id`; `(institution_id, programme_code)`      | Each key → row                                                                                                                     | BCNF                                                                                         |
| `academic.student`                   | `student_id`; `(institution_id, student_code)`          | Implied `(programme_id, student_code)`; `programme_id → institution_id`                                                            | 3NF, not BCNF: `programme_id` is not a superkey, but `institution_id` is prime               |
| `academic.academic_term`             | `term_id`; `(institution_id, term_code)`                | Each key → row                                                                                                                     | BCNF                                                                                         |
| `academic.grading_scheme`            | `scheme_id`; `(institution_id, scheme_code, version)`   | Each key → row; policy bounds are not extra uniqueness rules                                                                       | BCNF                                                                                         |
| `academic.course`                    | `course_id`; `(institution_id, course_code)`            | Each key → row                                                                                                                     | BCNF                                                                                         |
| `academic.course_offering`           | `offering_id`                                           | Implied `(course_id, term_id, section_code)`; each of `course_id`, `term_id`, `scheme_id` → `institution_id`                       | 1NF, not 2NF: tenant depends on a proper part of an implied candidate key                    |
| `academic.enrolment`                 | `enrolment_id`; `(student_id, offering_id)`             | `student_id → institution_id`; `offering_id → institution_id`                                                                      | 1NF, not 2NF: partial tenant dependencies                                                    |
| `academic.grade_record`              | `record_id`; `enrolment_id`                             | Each key → row; `enrolment_id → institution_id` has a key determinant                                                              | BCNF under local FDs; cached head is a separate consistency concern                          |
| `academic.grade_version`             | `(record_id, version_no)`                               | `record_id → institution_id`; predecessor is determined by `version_no`; triggers also imply `(record_id, recorded_at)` uniqueness | 1NF, not 2NF: tenant/predecessor copies have partial dependencies                            |
| `academic.grade_temporal_segment`    | `segment_id`                                            | Exclusion and tenant FKs imply `(record_id, valid_during, system_during)` uniqueness; `record_id → institution_id`                 | Derived projection, not 3NF/BCNF; including that implied natural key exposes a 2NF violation |
| `access_control.password_credential` | `user_id`                                               | Key → salt, derived key and creation time                                                                                          | BCNF for variable business fields; fixed-profile qualification above applies                 |
| `access_control.api_session`         | `token_digest`                                          | Key → user, lifetime and revocation; one user may have many sessions                                                               | BCNF                                                                                         |
| `evidence.reference`                 | `evidence_id`; `(submitted_by, request_key)`            | `record_id → institution_id`; neither `record_id` nor its tenant is part of a minimal key                                          | 2NF, not 3NF, for variable business fields; fixed-version qualification above applies        |

All sixteen tables satisfy the stated domain-level 1NF interpretation. The 3NF
exceptions are not made normal by adding a surrogate UUID primary key: alternate
keys and non-key determinants still matter.

### Why some UNIQUE declarations are not candidate keys

Declarations such as `UNIQUE (institution_id, programme_id)` retain the global
primary key inside a larger set, so they are non-minimal superkeys. They support
composite foreign keys rather than create a new minimal identity. The same applies
to analogous tenant/global-ID declarations on student, term, scheme, course,
offering, enrolment, record and version tables.

For offerings, the declared `(institution_id, course_id, term_id, section_code)`
UNIQUE set is also non-minimal. A course UUID already fixes its institution, so
`(course_id, term_id, section_code)` determines that UNIQUE set and hence the row.
None of these three attributes alone, or their pairs, is constrained to identify
an offering. Removing institution from the candidate key exposes the partial
`course_id → institution_id` dependency rather than hiding it in an oversized key.

For students, `(programme_id, student_code)` similarly determines institution via
programme and then the declared institutional student key. Institution remains
prime because `(institution_id, student_code)` is itself minimal. Consequently
the programme-to-institution FD violates BCNF but is permitted by 3NF. The nullable
linked-user uniqueness is only a conditional identifier and does not change this
unconditional-key analysis.

For grade versions, per-record locking and the insert trigger make recorded time
strictly increasing within a record. `(record_id, recorded_at)` is therefore an
operationally implied identifier, not a declared UNIQUE constraint. Do not use
`(record_id, previous_version_no)` as an unconditional SQL candidate key: the first
revision has a NULL predecessor. The tenant partial dependency alone establishes
the normal-form exception without relying on NULL-sensitive predecessor theory.

The temporal projection's exclusion constraint rejects two nonempty segments for
one record that overlap in both time dimensions. Identical valid/system intervals
would overlap, so the exact interval tuple is unique. This does not imply that
`(record_id, version_no)` is unique: one version may legitimately be represented
by several carried-forward valid-time segments.

## Logical decomposition and lossless reconstruction

The following are logical alternatives showing how repeated tenant facts can be
removed. They are not new physical tables or migration instructions. Each tenant
mapping already exists as a projection of an authoritative parent relation.

For a binary decomposition, the shared attributes determining one component are
sufficient for lossless reconstruction under the relevant FDs. Dependency
preservation is a different requirement; a lossless join does not automatically
preserve every foreign-key, business uniqueness or cross-entity scope constraint.
See the [normalization chapter's decomposition discussion](https://www.db-book.com/slides-dir/PDF-dir/ch7.pdf).

### Course offering

```text
O(offering_id, course_id, term_id, scheme_id, section_code, credits)
CourseTenant(course_id, institution_id)
```

`O` retains every original offering attribute except tenant; `CourseTenant` is the
`(course_id, institution_id)` projection of `academic.course`. Their shared
`course_id` determines `CourseTenant`, and each offering has a referenced course.
Joining therefore reconstructs exactly the original institution value without
spurious offering rows. Under the listed FDs, `O` has keys `offering_id` and
`(course_id, term_id, section_code)` and reaches BCNF; the tenant map also does.

This decomposition preserves `course_id → institution_id` and the identifying
offering FDs across its components. It does **not** by itself ensure that term and
scheme belong to that same institution. Removing tenant copies would require a
reviewed replacement for today's composite FKs, such as controlled transactional
validation; simply deleting the column would weaken integrity.

### Enrolment

```text
E(enrolment_id, student_id, offering_id, created_at)
StudentTenant(student_id, institution_id)
```

The tenant map is a projection of `academic.student`. The shared `student_id` is
its key, and the student FK gives each enrolment a matching parent, so the join is
lossless. `E` retains the enrolment identity, student/offering pair and timestamp;
its keys are `enrolment_id` and `(student_id, offering_id)`. Both components are
BCNF under their projected business FDs.

The original agreement between student tenant and offering tenant remains a
cross-entity constraint. It cannot be replaced by this join proof alone. Keeping
the current tenant field permits the two composite FKs to enforce that agreement
declaratively.

### Grade version

```text
V(record_id, version_no, grade_points, outcome, valid_during,
  recorded_at, author_id, reason)
RecordTenant(record_id, institution_id)
previous_version_no = CASE WHEN version_no = 1 THEN NULL ELSE version_no - 1 END
```

`RecordTenant` is a projection of `academic.grade_record`; shared `record_id`
determines that map. The join restores institution, while the defined expression
restores the stored predecessor, including the first-version NULL case. All
original attributes are therefore reconstructible; no historical grade value is
discarded. The deterministic predecessor is represented by a computation rather
than a table of integer pairs.

Removing these copies eliminates the identified partial dependencies in the
logical grade fact relation. Other temporal/outcome policy constraints still need
the stated interpretation: the optional grade and predecessor values are not
classical non-null keys, and policy checks must not be invented from demo values.
The present stored predecessor additionally supports an explicit self-FK; a
physical redesign would need to preserve the intended contiguous-history checks.

The same tenant-map pattern can remove institution from `evidence.reference` or
the temporal projection through `RecordTenant`. For evidence, the resulting
variable-field relation has the existing two candidate keys and no identified
non-key determinant. Fixed version tags retain the qualification already stated.
The temporal relation remains a derived, constrained history projection even if
its tenant copy is removed.

These alternatives demonstrate attribute reconstruction and the relevant
lossless joins. They do not claim a dependency-preserving implementation of the
entire schema, or replace current permission, author-scope, time-range and
cross-institution checks.

## Controlled redundancy and anomaly protection

| Stored redundancy                                  | Potential inconsistency                                                   | Current protection and limitation                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child `institution_id` copies                      | A student/offering/version/evidence row could claim the wrong institution | Composite FKs require agreement with the referenced global identity; they deliberately retain the copy for declarative scope enforcement                                         |
| `grade_version.previous_version_no`                | A revision could skip or claim an incorrect predecessor                   | CHECK, self-FK, insert trigger and record lock enforce the chain; immutable payloads prevent ordinary rewrites                                                                   |
| `grade_record.latest_version_no`                   | Cached head could lag or point at a non-latest revision                   | Head/insert triggers, deferred FK and the append transaction keep it synchronized; latest recorded revision is not necessarily current-effective grade                           |
| `grade_temporal_segment`                           | Query history could overlap, regress or lose a carried-forward interval   | Same-transaction projection, range checks, exclusion constraint and restricted runtime grants; an owner can still alter/rebuild it                                               |
| Evidence identity/digest metadata in SQL and Mongo | Stores could disagree or only one write could complete                    | Immutable SQL metadata, strict Mongo validation, restricted insert/read role, digest verification and explicit pending-to-available retry; no distributed transaction is claimed |

The cached head is an aggregate over a different relation. Its presence does not
by itself violate a local FD normal form when both `record_id` and `enrolment_id`
are keys. It nevertheless creates a synchronization responsibility. Conversely,
tenant copies in enrolments/versions have actual local non-key/partial FDs even
when constraints successfully prevent contradictory values. Constraint safety and
normal form are different properties.

Separating catalogue and policy entities already avoids common anomalies:
institutions/courses/schemes can be created before enrolment; removing the last
enrolment does not remove course definitions; catalogue titles are maintained in
one place rather than rewritten into every grade version. Programme/course/term
display labels are current metadata, not a fully bitemporal catalogue. Used
offering academic policy/credits are frozen and grading-scheme rows are immutable.

No presently demonstrated mismatch requires rewriting applied migrations before
Week 4. The existing tenant/predecessor/projection exceptions are an explicit
physical-design tradeoff with enforced consistency checks, not a claim of complete
normalization. If the assessment requires every physical business table to be at
least 3NF, a forward schema redesign and constraint/API migration must be reviewed
as separate work; this document alone does not satisfy that stricter requirement.
Future workflow, audit and outbox relations need their own key/FD review when added.

Runtime roles and triggers protect ordinary application paths. Owners/superusers
can bypass them, and neither normalization nor FK checks provide cryptographic
tamper evidence, factual-grade truth or institutional-policy approval.
