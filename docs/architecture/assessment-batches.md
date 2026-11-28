# Pilot marks batches (T3)

Faculty and SEE examiners enter marks for a pilot offering as immutable **revisions**. Course
teachers enter CIE, and SEE examiners enter SEE, for the offerings they are assigned in migration
`0016`. A revision is never edited: a correction is a new revision that names the one it replaces.
Submission is a separate immutable fact. Department review (T4) and publication (T5) build on
these revisions.

| API                                                | Behaviour                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/v1/pilot/offerings/:offeringId/batches`  | Revisions the caller may read, with author and submission time                          |
| `POST /api/v1/pilot/offerings/:offeringId/batches` | Creates a revision (`Idempotency-Key` header). 201 when created, 200 for an exact retry |
| `GET /api/v1/pilot/batches/:batchId`               | One revision in column form: components, then one value per student                     |
| `POST /api/v1/pilot/batches/:batchId/submit`       | The author submits the latest revision. A repeated submission returns the original time |

## Rules

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
  - A new revision while the head is submitted gets `BATCH_UNDER_REVIEW`; T4 will add the
    return that reopens entry.
  - Only the latest revision can be submitted.
- **Reads:** the stage's assigned author, the HoD or delegate of the offering's reviewing
  department and term, and exam approvers in the institution. Exam-section staff, the Dean and
  students have no marks access.
- **Digest:** each created revision returns a SHA-256 content digest over its canonical rows,
  for signing and comparison in later slices.

## Relations

| Physical relation             | Candidate key and dependency                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `assessment.offering_policy`  | Offering ID determines the policy ID and version; frozen once a batch exists                      |
| `assessment.batch`            | Batch ID; also (offering, stage, revision) and (author, idempotency key); each determines the row |
| `assessment.mark`             | (batch, enrolment, component) determines the points; `NULL` records an absence                    |
| `assessment.batch_submission` | Batch ID determines the submission time                                                           |

All four are in BCNF. The predecessor revision is `revision_no - 1` and the review state is
derived, so neither is stored. Batches, marks and submissions reject `UPDATE` and `DELETE`. A trigger
requires each mark's enrolment to belong to the batch's offering. A dedicated non-login role,
`academic_assessment_owner`, owns the five SECURITY DEFINER functions. The API role can execute
only those functions and cannot read the tables, and the runtime privilege check enforces both.

## Limits

- Submission is not yet a signed-log event. Publication (T5) records signed facts.
- Attendance eligibility and the CIE minimum for SEE are applied at publication, not at SEE
  entry.
- Exam-section validation reports, HoD review and return, and the marks-entry screens are the
  next slices.
