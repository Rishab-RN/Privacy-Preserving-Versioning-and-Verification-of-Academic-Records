# Pilot marks batches (T3) and review (T4)

Faculty and SEE examiners enter marks for a pilot offering as immutable **revisions**. Course
teachers enter CIE, and SEE examiners enter SEE, for the offerings they are assigned in migration
`0016`. A revision is never edited: a correction is a new revision that names the one it replaces.
Submission is a separate immutable fact.

After submission, exam-section staff may record a **validation report** under a time-bound
delegation (migration `0018`), and the HoD or a delegate **reviews** CIE revisions: they approve
them or return them with a reason. Publication (T5) builds on approved revisions.

| API                                                | Behaviour                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/v1/pilot/offerings/:offeringId/batches`  | Revisions the caller may read, with author, submission, review and validation           |
| `POST /api/v1/pilot/offerings/:offeringId/batches` | Creates a revision (`Idempotency-Key` header). 201 when created, 200 for an exact retry |
| `GET /api/v1/pilot/batches/:batchId`               | One revision in column form, with its review and validation                             |
| `POST /api/v1/pilot/batches/:batchId/submit`       | The author submits the latest revision. A repeated submission returns the original time |
| `POST /api/v1/pilot/batches/:batchId/validate`     | Delegated exam-section staff record a validation report, with an optional note          |
| `POST /api/v1/pilot/batches/:batchId/review`       | HoD or delegate: `approved`, or `returned` with a reason                                |
| `GET /api/v1/pilot/validation-queue`               | Submitted, unvalidated head revisions in the caller's delegated departments             |
| `GET /api/v1/pilot/review-queue`                   | Submitted, unreviewed CIE heads in the caller's department, excluding their own         |

## Entry rules (T3)

- **Authority:** a caller with no marks-entry duty anywhere gets 403. A caller whose duty does
  not cover the offering and stage gets 404. Only the author may submit. These outcomes are
  replayed for every persona against `packages/access-matrix` (`batch.create`, `batch.submit`).
- **Validation (422):** the API checks each row with `validateStageMarks` from
  `packages/assessment`, using the offering's frozen policy. That covers known components for the
  stage, every required component, valid values within maxima, and `AB` only where the policy
  allows absence (SEE). It rejects duplicate and foreign enrolments. A CIE revision must include
  every enrolled student. A SEE revision may cover a subset, since eligibility follows the
  approved CIE.
- **Revisions (409):**
  - `expectedRevision` must equal the current head, or the request gets `STALE_REVISION`.
  - The same idempotency key with different content gets `IDEMPOTENCY_CONFLICT`.
  - A new revision while the head awaits review gets `BATCH_UNDER_REVIEW`.
  - A returned head reopens entry.
  - An approved head is locked (`BATCH_APPROVED`).
  - Only the latest revision can be submitted.
- **Reads:** the stage's assigned author, the HoD or delegate of the offering's reviewing
  department and term, and exam approvers in the institution. Exam-section staff, the Dean and
  students have no marks access.
- **Digest:** each created revision returns a SHA-256 content digest over its canonical rows,
  for signing and comparison in later slices.

## Validation and review rules (T4)

- **Validation:**
  - It needs an active validation delegation: inside its half-open window, granted by someone
    who is still an active exam approver in the institution.
  - A caller without one anywhere gets 403. A batch outside the delegated department and term
    gets 404.
  - Only the submitted head can be validated (`BATCH_NOT_SUBMITTED`, `STALE_REVISION`).
  - The report records how many enrolled students had no row at that moment. It is one report
    per revision: the same validator retrying gets the original, and anyone else gets
    `ALREADY_VALIDATED`.
- **Review:**
  - It needs a HoD or delegate duty for the offering's reviewing department and term, and covers
    CIE revisions only. Without a department duty the caller gets 403; outside scope or for SEE, 404.
  - A return requires a reason.
  - Only the submitted head can be reviewed.
  - It is one review per revision: the same reviewer with the same verdict retrying gets the
    original, and anyone else gets `ALREADY_REVIEWED`.
- **Separation of duties (403):** an author cannot review their own revision (`SELF_REVIEW`), and
  the same person cannot both validate and review a revision, or validate their own
  (`SOD_CONFLICT`).
- **Matrix replay:** the integration test replays `batch.validate` and `batch.review` for every
  persona against the access matrix evaluated at the current time. Its world records which
  people actually validated and reviewed each batch.
- **Proposal:** validation is recorded but not required before review (`PROP`, pilot plan Q3/Q4).

## Relations

| Physical relation                  | Candidate key and dependency                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `assessment.offering_policy`       | Offering ID determines the policy ID and version; frozen once a batch exists                                  |
| `assessment.batch`                 | Batch ID; also (offering, stage, revision) and (author, idempotency key); each determines the row             |
| `assessment.mark`                  | (batch, enrolment, component) determines the points; `NULL` records an absence                                |
| `assessment.batch_submission`      | Batch ID determines the submission time                                                                       |
| `assessment.validation_delegation` | Delegation ID determines department, term, grantor, grantee and validity window                               |
| `assessment.validation_report`     | Batch ID determines the delegation, missing-row count, note and time; the delegation determines the validator |
| `assessment.batch_review`          | Batch ID determines the reviewer, verdict, reason and time                                                    |

All seven are in BCNF. Some values are derived rather than stored:

- the predecessor revision (`revision_no - 1`)
- the head's review state
- the validator (through the delegation)

All tables except the frozen offering policy reject `UPDATE` and `DELETE`. Triggers require each
mark's enrolment to belong to the batch's offering, and each delegation's department and term to
share an institution. A dedicated non-login role, `academic_assessment_owner`, owns the SECURITY
DEFINER functions. The API role can execute only the allow-listed functions and cannot read the
tables, and the runtime privilege check enforces both.

## Limits

- Submission and review are not yet signed-log events. Publication (T5) records signed facts.
- Attendance eligibility and the CIE minimum for SEE are applied at publication, not at SEE
  entry. SEE revisions have no department review; once submitted, they wait for publication.
- Delegation windows use stored dates; there is no early revocation yet.
- The marks-entry, review and validation screens are a following slice.
