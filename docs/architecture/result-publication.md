# Pilot result publication (T5)

An exam approver publishes an offering's provisional results once its marks are final:

- the latest CIE revision is approved by the department
- the latest SEE revision is submitted

Both heads are locked in those states, so they cannot change during publication. Migration
`0019` records the publication. In the same transaction it appends version 1 of every
enrolment's grade to the existing temporal grade store (`academic.append_grade_version`).
Students then see their own results labelled **Provisional**.

| API                                                   | Behaviour                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/v1/pilot/offerings/:offeringId/publish`    | Exam approver publishes with imported attendance. 201 when created, 200 for an exact retry |
| `GET /api/v1/pilot/offerings/:offeringId/publication` | Publication, inputs, every result and the recomputation audit                              |
| `GET /api/v1/pilot/my-results`                        | A student's own published results with the CIE/SEE breakdown                               |

## Publishing

1. `assessment.publication_inputs` checks the caller and returns the frozen policy, the roster and
   the marks of both input revisions.
2. The API validates the attendance list and computes each result with `calculateResult` from
   `packages/assessment`.
3. `assessment.publish_results` repeats every check under locks shared with marks entry. It then
   records the publication, its inputs and attendance, and appends the grade versions.

Rules:

- **Authority:** only an active exam approver may publish (403 otherwise), and only in their
  institution (404).
- **Separation of duties (403 `SOD_CONFLICT`):** the publisher must not have authored,
  validated or reviewed any revision of the offering.
- **Readiness (409):** `CIE_NOT_APPROVED` or `SEE_NOT_SUBMITTED`. One provisional publication per
  offering: the same publisher retrying with the same attendance gets the original, and anything
  else gets `ALREADY_PUBLISHED`.
- **Attendance (422):** the request lists every enrolled student once, with eligibility after
  condonation and an optional percentage (`ATTENDANCE_INCOMPLETE`, `DUPLICATE_ENROLMENT`,
  `UNKNOWN_ENROLMENT`, `INVALID_ATTENDANCE`).
- **Completeness (422):** a student who is eligible for SEE needs a SEE row (`AB` records
  absence): `SEE_ROWS_MISSING`. SEE marks for an ineligible student are
  `INELIGIBLE_HAS_SEE_MARKS`.
- **Stored grades:** graded results store grade points and `passed` or `failed`. Results without
  grade points (NE, X, SEE absent) store `incomplete`. The letter is always recomputed.

## Reading and audit

- **Staff view:**
  - Readers: course teachers of the offering, the reviewing HoD or delegate, and exam
    approvers, registrars and auditors in the institution.
  - Callers with none of those duties get 403 (SEE examiners, exam-section staff, the Dean and
    students). An offering outside their scope gets 404, and an unpublished one in scope gets
    404 `NOT_PUBLISHED`.
  - The view recomputes every result from the stored marks, attendance and policy, and reports
    `audit.mismatches` (student codes whose stored grade differs).
- **Student view:** only students may call it. It lists their own published results; another
  section's results never appear.
- **Matrix replay:** the integration test replays `results.publish` and `result.read` for every
  persona against `packages/access-matrix`. Its world uses the current time, the real batch
  history and the real publication state.

## Relations

| Physical relation                   | Candidate key and dependency                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `assessment.publication`            | Publication ID; also (offering, kind); each determines the publisher and time |
| `assessment.publication_input`      | (publication, batch); the batch determines its stage and revision             |
| `assessment.publication_attendance` | (publication, enrolment) determines eligibility and percentage                |
| `assessment.publication_grade`      | (record, version) determines the publication                                  |

All four are in BCNF and reject `UPDATE` and `DELETE`. The policy follows from the offering's
frozen policy, so it is not stored again. Triggers require inputs, attendance and grades to
belong to the published offering. The grade-version guard now also accepts exam approvers as
authors. The API role can execute only the four new allow-listed functions and cannot read the
tables.

## Limits

- Publication does not yet emit signed transparency-log events. That needs a new log event
  source and log-reader support.
- The audit recomputes on read; it is not yet a scheduled job or a log-audit report.
- Final publication after the paper-viewing window and proofs on published version 1 grades are
  later slices. Paper-viewing corrections are described in
  [paper-viewing corrections](pvp-corrections.md).
- The student and staff result screens belong to the pilot frontend slice.
