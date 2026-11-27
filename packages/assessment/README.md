# Assessment policy and result calculator

`@academic-records/assessment` turns published RVCE assessment rules into versioned,
testable policy data and computes a course result from component marks. It has no runtime
dependency, database, network access or clock, so an auditor can recompute any result from the
same inputs and policy version.

The policies come from public RVCE documents and are **prototype design inputs**. RVCE staff
have not confirmed how they apply, so every policy has status
`pending-institutional-confirmation`. Fixtures and examples use synthetic marks only.

## What it computes

```ts
import {
  RVCE_2022_ITL_S1,
  calculateResult,
  resolvePaperViewing,
} from '@academic-records/assessment';

const result = calculateResult(RVCE_2022_ITL_S1, {
  attendance: { eligible: true, percent: '91.5' },
  marks: { quiz1: '8', quiz2: '9', test1: '38', test2: '41.5' /* …every component… */ },
});
// result.status 'graded' | 'not-eligible' | 'see-absent' | 'transitional'
// result.letter, result.gradePoints, result.outcome, result.reasons, part scores
```

- `evaluateCie` computes CIE theory and lab scores and SEE eligibility.
- `calculateResult` computes the full course result: grade, points, outcome, reasons and
  `roundingSensitive`.
- `resolvePaperViewing` applies a Paper Viewing Process revaluation using the better-of rule;
  call `calculateResult` again afterwards.
- `assertPolicy` validates a policy object before use; `getPolicy(id)` returns a shipped policy.

Marks are decimal strings with at most two fractional digits. Arithmetic is exact (rational
`bigint`), and decisions never use rounded display values. For example, 119.99 / 300 displays
as `40.00` but fails the 40% aggregate, and `total.exactPercent` reports `11999/300`.

Output is a plain object in a fixed key order. Identical policy and input give identical JSON,
regardless of the order of input keys.

## Shipped policies

| Policy                | Basis                                                                                                                                            | Status                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `rvce-2022-itl-s1`    | CD252IA-style integrated course, rubric from the AIML 2022-scheme syllabus (S1 p.15); passing, grades and PVP from the 2022-scheme handbook (S2) | Pending confirmation; pilot default                                          |
| `rvce-acy2026-itl-s3` | Integrated course rubric from the handbook effective AY 2026-27 (S3 §4.2.2 p.37)                                                                 | Pending confirmation; candidate if S3 governs 2022-scheme students (plan C4) |

Both total CIE 100 + 50 and SEE 100 + 50, matching the CD252IA scheme (S1 p.7). Given equal
part totals they produce the same result. They differ in components, in S3's optional improvement
test, and in the ineligible letter: `NE` under S2, `DX` under S3.

The 2022-scheme handbook's integrated-course table (S2 §4.2.2 p.29, CIE 40 + 30 + 30 = 100) is
**not encoded**. Its split of SEE between theory and lab is not legible from the published table,
and guessing it would invent policy. Add it once RVCE confirms the structure.

## Rules and sources

| Rule                  | Value                                                                                        | Source                                     |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| CIE rubric            | Quizzes 2×10 = 20; tests 2×50 reduced to 40; experiential learning 40; lab 50                | S1 PDF p.15 / S3 PDF p.37                  |
| SEE rubric            | Theory 100 (S1: part A 20 + part B 80); lab 50 (S1: 10 + 20 + 20; S3: one PBL component)     | S1 p.15; S3 p.35                           |
| SEE eligibility       | CIE ≥ 40% theory and ≥ 40% lab, and attendance eligible; otherwise NE/DX                     | S2 §4.4 p.32, §3.3 pp.20–21; S3 p.27, p.41 |
| Passing               | SEE ≥ 35% each part; aggregate ≥ 40% over the course total                                   | S2 Table 4.4 p.32; S3 Table 4.4 p.40       |
| Grades                | O ≥ 90 (10), A+ ≥ 80 (9), A ≥ 70 (8), B+ ≥ 60 (7), B ≥ 55 (6), C ≥ 50 (5), P ≥ 40 (4), F (0) | S2 Table 4.3 p.30; S3 p.38                 |
| Grade X               | Attendance ≥ 85% and CIE ≥ 90% with an SEE failure → transitional X                          | S2 p.32; S3 p.39                           |
| Paper Viewing Process | SEE theory only, never lab; better of original and revaluation; no negative evaluation       | S2 §4.7 pp.36–37; S3 §4.8 pp.42–43         |

Sources (accessed 27 November 2026; locators are PDF page numbers):

- S1: [AIML scheme and syllabus, V & VI semester, 2022 scheme](https://rvce.edu.in/wp-content/uploads/2025/10/AI-2022-3rd-year.pdf)
- S2: [UG handbook, 2022 scheme](https://rvce.edu.in/wp-content/uploads/2025/11/Final-Version-of-2022-Scheme-Hand-Book-compressed.pdf)
- S3: [UG guidelines, w.e.f. AY 2026-27](https://rvce.edu.in/wp-content/uploads/2026/08/dean-UG-hand-book-2025-scheme-ACY-2026-27.pdf)

## Prototype assumptions (cited as `PROP`)

| Assumption                                    | Why                                                            | Effect until confirmed                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official rounding is unknown                  | Sources give whole-number score ranges without a rounding rule | Exact evaluation. `roundingSensitive` is true when half-up whole-percent rounding would change status, letter or outcome; review those cases before publication |
| `AB` is accepted only for SEE                 | No published rule for absent CIE components                    | CIE absences must be entered as marks. SEE absence returns `see-absent` for the administrative I/Ab decision                                                    |
| "CIE rating ≥ 90%" means total CIE percentage | The X-grade text does not name the base                        | Uses theory + lab CIE over 150                                                                                                                                  |
| Improvement test selection is unpublished     | S3 names an optional third test without a rule                 | Supplying `test_improvement` raises `POLICY_UNCONFIRMED`                                                                                                        |
| Attendance eligibility is an input            | Condonation is an administrative decision                      | `attendance.eligible` decides NE/DX; `percent` is used only for grade X                                                                                         |

Transitional I and W grades, make-up results, MOOC rules and SGPA/CGPA are outside this package.
They belong to later case-handling and transcript work.

## Use in the pilot

- Marks batches (T3) validate entries against the offering's frozen policy with `calculateResult` and `evaluateCie`.
- Publication (T5) records the policy ID and version with each result.
- The log audit recomputes published grades with this package.
- Paper Viewing corrections (T6) go through `resolvePaperViewing` before the existing independent-approval workflow.

Storing policies in SQL needs a JSON parser in front of `assertPolicy`, which currently checks
typed objects.

```powershell
npm run test --workspace @academic-records/assessment
npx tsc --project packages/assessment/tsconfig.check.json
```
