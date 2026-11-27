# Pilot access matrix

`@academic-records/access-matrix` is the executable specification of who may do what in the
CD252IA marks-to-results pilot. It holds the permission matrix as typed data, a reference
evaluator that returns the expected HTTP outcome for any persona, action and resource, and a
synthetic fixture with every persona from the planning pass.

It is a **test oracle, not the enforcement layer.** PostgreSQL functions and API routes remain the
authority. Integration tests replay `enumerateCases(PILOT_WORLD)` against the real system and
compare each status and code. The generated [MATRIX.md](MATRIX.md) is the review copy for
Rishab, Codex and RVCE staff.

## Evaluation order

`decide(world, principal, action, resource)` follows the existing API convention in
[access and evidence](../../docs/architecture/access-and-evidence.md):

| Step | Condition                                                                                  | Outcome                                              |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 1    | Public action (`proof.verify`)                                                             | 200 `ALLOWED`                                        |
| 2    | No session                                                                                 | 401 `UNAUTHENTICATED`                                |
| 3    | The caller holds no current membership, duty or delegation that grants the action anywhere | 403 `FORBIDDEN`                                      |
| 4    | The caller can perform the action, but none of their scopes covers this resource           | 404 `NOT_FOUND`, so existence is not revealed        |
| 5    | A separation-of-duties rule matches                                                        | 403 `SELF_REVIEW`, `SELF_APPROVAL` or `SOD_CONFLICT` |
| 6    | Otherwise                                                                                  | 200 `ALLOWED`                                        |

State checks (a stale revision, an already reviewed batch, a closed window) come after
authority and are not part of this matrix. Department, CoE office, registrar and auditor reads
include results that are not yet published. This is a pre-publication staff preview and is
itself a proposal (`PROP`). Students see only their own published results.

## Model

- **Memberships** (`role_assignment` today) say what someone is: student, faculty, examiner,
  registrar, auditor, exam staff, exam approver or Dean Academics. Faculty, examiner and exam-staff
  memberships grant nothing on their own.
- **Offering duties** (`course_teacher`, `see_examiner`) scope marks entry to one offering and stage.
- **Department duties** (`hod`, `hod_delegate`) scope CIE review, rosters, results and dashboards
  to one department and term.
- **Delegations** come from an exam approver, with a task allowlist, departments, a term and a
  half-open validity window. They can confer only `batch.validate` and `roster.read`.
- **Separation of duties**, checked after scope:
  - A reviewer is neither the batch author nor its validator.
  - A validator is neither the author nor the reviewer.
  - A publisher took no part in any input batch of the offering.
  - A correction approver is neither the proposer nor an author of the record's marks.

Each grant cites its basis: an RVCE source from the pilot plan (`S2`, `S4`), an existing
repository policy (`REPO`), or a prototype proposal awaiting confirmation (`PROP`, pilot plan
questions Q2–Q5).

## Fixture

`PILOT_WORLD` uses one synthetic term, `2026-27-ODD`. CD252IA sections AI-A (published) and AI-B
belong to the AI department, and IS-A to the IS department for isolation checks.

- H1 is the multi-role case: AI HoD and teacher of AI-B.
- S1 holds an active AI delegation; S2's delegation has expired.
- P2 is both an exam approver and an IS HoD delegate, to exercise publication conflicts.

Keys such as `F1` and `ai-a` are fixture handles, not identifiers.

## Using it in integration tests (T1–T6)

```ts
import { PILOT_WORLD, enumerateCases } from '@academic-records/access-matrix';

for (const c of enumerateCases(PILOT_WORLD)) {
  const response = await requestFor(c.action, c.resource, sessionFor(c.principal));
  assert.equal(response.status, c.expected.status, `${c.principal} ${c.action} ${c.resource}`);
  if (c.expected.status !== 200) assert.equal(response.body.code, c.expected.code);
}
```

The pilot fixture script (T1) should seed the same personas, offerings, batches and corrections.
`requestFor` maps each action to its route once T3–T6 exist. Until then, filter the cases to
implemented actions. A mismatch means either the system or this matrix is wrong, and the fix
must be a deliberate change to one of them.

```powershell
npm run test --workspace @academic-records/access-matrix
npm run render --workspace @academic-records/access-matrix
```

Run `render` after changing `src/policy.ts` or `src/fixture.ts`. A test fails if `MATRIX.md` is out
of date.
