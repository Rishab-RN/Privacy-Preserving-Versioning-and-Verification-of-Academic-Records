# Synthetic pilot data

`@academic-records/pilot-data` generates the synthetic institution for the CD252IA
marks-to-results pilot, deterministically from a seed:

- one AIML 2022-scheme Semester V term with sections AI-A, AI-B and IS-A
- the staff personas of the [access matrix](../access-matrix/README.md)
- synthetic students
- CIE/SEE component marks
- the computed course results
- Semester V transcripts with SGPA

Every result comes from [`@academic-records/assessment`](../assessment/README.md), so the data
can never disagree with the policy code.

**All people, USNs and marks are synthetic.** USNs use the `SYN` prefix (`SYN24AI001`), so they
cannot match a real RVCE USN (`1RV…`). Names are a common first name with an initial. Course
codes, titles, credits and assessment rules come from public RVCE sources (pilot plan S1–S3).
The dataset contains no passwords; seeding scripts generate their own.

## Contents (default seed 20261127)

| Section | Students                        | Department | Published | Persona            |
| ------- | ------------------------------- | ---------- | --------- | ------------------ |
| AI-A    | 12, including 8 named scenarios | AI         | yes       | ST1 = `SYN24AI001` |
| AI-B    | 10                              | AI         | no        | ST2 = `SYN24AI013` |
| IS-A    | 6 (isolation)                   | IS         | no        | ST3 = `SYN24IS001` |

Staff keys, subjects (`pilot:f1`, …), duties and delegations mirror `PILOT_WORLD`, so the
expected outcomes in the access matrix apply to seeded accounts unchanged.

The named AI-A students have fixed marks, so demos always show every outcome:

| USN        | Scenario              | Outcome                                                                     |
| ---------- | --------------------- | --------------------------------------------------------------------------- |
| SYN24AI001 | `demo-student` (ST1)  | A, 79.10%; SGPA 8.35; the private-proof demo student                        |
| SYN24AI002 | `distinction`         | O, 97.53%                                                                   |
| SYN24AI003 | `pvp-candidate`       | F on SEE theory (34%). A Paper Viewing revaluation lifts it to B+ at 63.27% |
| SYN24AI004 | `x-grade`             | Transitional X: CIE 96.67%, attendance 92%, SEE theory 30%                  |
| SYN24AI005 | `see-absent`          | SEE absent; the result is pending an administrative I/Ab decision           |
| SYN24AI006 | `rounding-sensitive`  | F at 39.83%, which would round to 40%: flagged for review                   |
| SYN24AI007 | `attendance-shortage` | NE (attendance 68.5%), no SEE marks                                         |
| SYN24AI008 | `cie-shortfall`       | NE (CIE theory 32.2%), no SEE marks                                         |

The other students draw an ability score from three seeded uniforms. Component marks fall near
that ability in half-mark steps, and SEE runs slightly lower than CIE. A student who misses the
CIE minimum gets no SEE marks. Names, marks and other-course grades use independent seeded
streams. A test pins the default dataset's SHA-256 fingerprint, so any change to the generator,
scenarios or policies is deliberate.

## Use

```ts
import { generatePilotData } from '@academic-records/pilot-data';

const data = generatePilotData(); // or { seed, sections: { 'ai-a': 240, 'ai-b': 120, 'is-a': 60 } }
data.students; // USN, name, programme, offering, login subject, persona
data.assessments; // attendance, component marks and the computed CourseResult
data.paperViewing; // the revaluation and recomputed result for SYN24AI003
data.transcripts; // Semester V courses and the SGPA/CGPA summary for AIML students
```

```powershell
npm run export --workspace @academic-records/pilot-data
npm run export --workspace @academic-records/pilot-data -- --ai-a 240 --ai-b 120 --is-a 60
```

`export` writes JSON to the ignored `.runtime/pilot-data/` folder and prints counts by status
and letter.

**Planned consumers:**

- the T1 fixture script seeds accounts, offerings and enrolments from `staff`, `students` and `offerings`
- T3 creates CIE and SEE batches from `assessments`
- T5 publishes results and checks them against `result`
- T6 demonstrates the correction from `paperViewing`
- measurement M5 uses the scaled sections (60/120/240 students)

Transcripts cover AIML students only. The IS curriculum is not part of the public sources used.
