# Student case intake rules

`@academic-records/cases` decides whether a student may file an academic case. It returns every
reason a request fails, the deadline, who acts on it and in what order, and its consequences. It
covers the five cases the RVCE handbooks define precisely:

| Case            | Eligible when                                                                                                                                                | Route                                                                           | Main source                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------ |
| `paper-viewing` | An evaluated SEE theory script exists (any grade, or X); provisional results are out; inside the CoE registration window. Not lab, project or MOOC           | Student → exam staff → student views script → expert team → exam approver       | S2 §4.7, S3 §4.8               |
| `make-up`       | Grade I or X; regular semester; not a MOOC; inside the CoE window                                                                                            | Student → exam staff → exam approver                                            | S2 §4.4(c), S3 §4.5(C)         |
| `i-grade`       | Attendance and CIE satisfied, absent from SEE; intimation before the exam (or prior permission when representing the institution); documents by the deadline | Student → Chief Superintendent → student documents → Grading Advisory Committee | S2 §4.3(e)–(g), S3 §4.3(e)–(h) |
| `drop`          | Not first year; no result yet; inside the calendar drop window; at least 16 credits remain                                                                   | Counsellor → parent → HoD → Dean Academics                                      | S2/S3 §3.2(d)                  |
| `withdrawal`    | Not first year; no result yet; on or before the calendar deadline; attendance satisfied for the course; at least 16 credits remain                           | Student → HoD → Dean Academics                                                  | S2/S3 §3.2(e)                  |

S2 is the 2022-scheme UG handbook and S3 the handbook effective AY 2026-27 (PDF pages are cited
in `src/policy.ts`). The two policies, `rvce-2022-cases-s2` and `rvce-acy2026-cases-s3`, differ in
one rule. S3 §4.3(h) makes clearing an I grade in the make-up count as an attempt, except for
students representing the institution. Both await RVCE confirmation.

## Use

```ts
import { RVCE_2022_CASES_S2, evaluateCase } from '@academic-records/cases';

const decision = evaluateCase(RVCE_2022_CASES_S2, calendar, student, {
  type: 'paper-viewing',
  course: 'CD252IA',
  submittedOn: '2027-01-10',
});
// { eligible, reasons: [...], deadline: '2027-01-13', route: [...], effects: [...] }
```

- **`calendar`** holds the term's dates from the academic calendar and CoE circulars: semester
  start, drop window, withdrawal deadline, last examination day, provisional results date, and the
  Paper Viewing and make-up registration windows. Leave out a window that has not been announced;
  the decision then reports `WINDOW_NOT_ANNOUNCED`. The calendar itself is validated: a drop window
  may not open less than a month after the start, and Paper Viewing registration may not open
  before provisional results.
- **`student`** lists the term's registered courses with credits, kind (`theory`, `integrated`,
  `lab`, `project`, `mooc`), attendance status and, once declared, the result. The result takes
  the shape of `@academic-records/assessment`'s `CourseResult`. An I grade granted by the Grading
  Advisory Committee is passed as `{ status: 'transitional', letter: 'I' }`.
- Ineligibility is a normal decision. Only malformed dates, calendars, students or policies
  throw `CaseError`.

## Interpretations awaiting confirmation (`PROP`)

- **I-grade timing:** the intimation and document rules apply to every reason. Students away
  representing the institution need prior permission instead of an intimation. The document
  deadline is the earlier of examination + 7 days and the last examination day.
- **Paper Viewing scope:** project and MOOC courses have no institutional written script to view.
- **Approval:** a Paper Viewing change is approved through the existing independent correction
  workflow.

Fees, rejection of a whole semester's results (S2 §4.9), malpractice cases and the access-matrix
actions for filing and handling cases come later. The tests run the rules against the synthetic
pilot students. For example, SYN24AI003 may register for Paper Viewing, SYN24AI004 (grade X) for
the make-up, and SYN24AI005 (absent) may request an I grade.

```powershell
npm run test --workspace @academic-records/cases
```
