# Paper-viewing corrections (T6)

After provisional publication, a student may take part in the Paper Viewing Process (PVP). An
expert team then revalues the SEE theory script. RVCE's rule (R12, S2 §4.7) has three parts:

- lab examinations are excluded
- the better of the two marks is kept
- there is no negative evaluation

Migration `0020` records the revalued marks and routes the grade change through the existing
correction workflow. The approved correction becomes grade version 2, and the existing private
proof flow can use it.

| API                                               | Behaviour                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /api/v1/pilot/records/:recordId/pvp`        | Registrar submits revalued marks (`Idempotency-Key`). 201 with the pending change request |
| `POST /api/v1/change-requests/:requestId/approve` | Existing route: a different registrar approves, creating the new version                  |

## Proposing

1. `assessment.pvp_context` checks that the caller is a registrar of the record's institution.
   It also checks that the record has a pilot publication. It returns the published marks,
   attendance and any earlier approved revisions.
2. The API applies `resolvePaperViewing` from `packages/assessment`, then recomputes the result
   with `calculateResult`.
3. The API stores the revaluation through the existing evidence store as `revaluation_request`
   evidence. The evidence records the process, policy, raised components, and original and
   revised marks.
4. `assessment.propose_pvp` records the raised marks and calls `workflow.propose_change` with
   the recomputed grade. The correction is effective over the same period as the published
   version.

Rules:

- **Authority:** only registrars (403), and only for published pilot records in their
  institution (404).
- **R12 (422):**
  - lab components are excluded (`PVP_LAB_EXCLUDED`)
  - only SEE marks can be revised (`PVP_SEE_ONLY`)
  - a component recorded as absent has no script to revisit (`PVP_NOT_APPLICABLE`)
  - a lower mark is refused (`NO_NEGATIVE_EVALUATION`) and so is a revaluation that raises
    nothing (`NO_CHANGE`)
  - marks cannot exceed the component maximum (`MARKS_ABOVE_MAXIMUM`)
- **Equal marks:** a component revalued to the same mark is allowed, but it is not stored.
- **Workflow rules unchanged:**
  - the proposer cannot approve (403)
  - a stale expected version is `STALE_REVISION`
  - retries with the same key return the same request
- **Guard:** a trigger on `workflow.change_request` rejects any correction to a published pilot
  grade unless its evidence carries PVP revised marks, so the generic correction route returns
  400 `INVALID_CHANGE` for those records.

## After approval

- The staff publication view and the student view show the current version. They recompute it
  from the published inputs with approved revisions applied (later versions win), and flag
  `revisedAfterPvp`.
- The audit checks both the published version and the current version against recomputation.
- `privacy.eligible_records` lists the corrected record because version 2 has an approved
  workflow decision. A student can therefore request a private grade-threshold credential for
  it with the existing proof flow.

## Relations

| Physical relation     | Candidate key and dependency                        |
| --------------------- | --------------------------------------------------- |
| `assessment.pvp_mark` | (evidence, component) determines the revised points |

The evidence reference determines the record and the proposer, so neither is stored again. The
relation is in BCNF and rejects `UPDATE` and `DELETE`. The API role can execute only
`pvp_context` and `propose_pvp` and cannot read the table.

## Limits

- The access matrix also lets exam approvers propose and approve corrections. The existing
  workflow allows only registrars, so that rule is not implemented yet.
- Question-wise grievances and PVP registration (case intake) are not linked to the correction
  yet. The evidence records component-level marks only.
- Published version 1 grades are not proof-eligible, so there is no earlier credential to
  supersede. Extending eligibility to publication-authorized versions is a separate change to
  `privacy.*`.
- Final publication after the PVP window, the browser journey and the demo script follow with
  the pilot frontend.
