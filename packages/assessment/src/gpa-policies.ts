import { AssessmentError } from './errors.js';
import { assertGpaPolicy } from './gpa.js';
import type { GpaPolicy } from './gpa.js';
import { RVCE_GRADE_BANDS, RVCE_SOURCES } from './policies.js';
import type { Citation } from './policy.js';

const cite = (source: 'S2' | 'S3' | 'PROP', locator: string): Citation => ({ source, locator });

const GRADE_POINTS = RVCE_GRADE_BANDS.map(({ letter, points }) => ({ letter, points }));
const TRANSITIONAL = ['I', 'W', 'X'];
const NO_POINTS_NOTE = cite('PROP', 'grades without grade points (not eligible) are excluded');
const UNCONFIRMED = [
  {
    letter: 'MP',
    question:
      'Malpractice is "awarded with a credit of 0" for SGPA (S2 p.37 says grade MP; S3 p.43 says ' +
      'grade NE). Does an MP course drop out of SGPA, or count as zero points with its credits?',
  },
  {
    letter: 'Ab',
    question:
      'A student who misses the make-up after an I grade receives Ab (S2 p.34, S3 p.42). How does ' +
      'Ab count in SGPA and CGPA?',
  },
];

/** RVCE 2022-scheme rules (UG handbook, w.e.f. 2022-23). */
export const RVCE_2022_GPA_S2: GpaPolicy = assertGpaPolicy({
  id: 'rvce-2022-gpa-s2',
  version: 1,
  title: 'RVCE 2022 scheme SGPA, CGPA and class (UG handbook)',
  status: 'pending-institutional-confirmation',
  sources: { S2: RVCE_SOURCES.S2 },
  gradePoints: GRADE_POINTS,
  failLetter: 'F',
  transitional: TRANSITIONAL,
  notEligible: ['NE', 'NSAR', 'NSSR'],
  unconfirmed: UNCONFIRMED,
  degreeMinimumCgpa: '5.00',
  classes: [
    { label: 'First Class with Distinction', minimumCgpa: '7.00' },
    { label: 'First Class', minimumCgpa: '6.00' },
    { label: 'Second Class', minimumCgpa: '5.00' },
  ],
  citations: {
    sgpa: [cite('S2', 'PDF p.31, §4.3(d)(i): all registered courses except transitional grades')],
    cgpa: [cite('S2', 'PDF p.31, §4.3(d)(ii): all registered courses except F grades')],
    counted: [
      cite('S2', 'PDF p.37, §4.10: credit courses with grade points; audit excluded'),
      NO_POINTS_NOTE,
    ],
    earned: [cite('S2', 'PDF p.32, §4.3 earning credit: not NSAR, NSSR, NE, I, W, X or F')],
    degree: [cite('S2', 'PDF p.35, §4.6 summary: maintain >= 5.00 CGPA before the award')],
    classes: [cite('S2', 'PDF p.38, §4.12(c): distinction 7, first 6, second 5')],
    percent: [cite('S2', 'PDF pp.37-38, §4.11: percentage = CGPA x 10')],
    unconfirmed: [cite('S2', 'PDF p.37 §4.8 and p.34 §4.4(c)')],
  },
});

/** Rules in the UG handbook effective from academic year 2026-27. */
export const RVCE_ACY2026_GPA_S3: GpaPolicy = assertGpaPolicy({
  id: 'rvce-acy2026-gpa-s3',
  version: 1,
  title: 'RVCE AY 2026-27 SGPA, CGPA and class (UG handbook)',
  status: 'pending-institutional-confirmation',
  sources: { S3: RVCE_SOURCES.S3 },
  gradePoints: GRADE_POINTS,
  failLetter: 'F',
  transitional: TRANSITIONAL,
  notEligible: ['DX', 'NE', 'NSAR', 'NSSR'],
  unconfirmed: UNCONFIRMED,
  degreeMinimumCgpa: '4.00',
  classes: [
    { label: 'First Class with Distinction', minimumCgpa: '7.00' },
    { label: 'First Class', minimumCgpa: '6.00' },
    { label: 'Second Class', minimumCgpa: '5.00' },
    { label: 'Pass Class', minimumCgpa: '4.00' },
  ],
  citations: {
    sgpa: [cite('S3', 'PDF p.38, §4.3(d)(i)')],
    cgpa: [cite('S3', 'PDF p.38, §4.3(d)')],
    counted: [
      cite('S3', 'PDF p.44, §4.11: credit courses with grade points; audit excluded'),
      NO_POINTS_NOTE,
    ],
    earned: [cite('S3', 'PDF p.39, earning credit')],
    degree: [
      cite('S3', 'PDF p.45, §4.14(c)(iv): Pass Class from 4 CGPA'),
      cite('PROP', 'degree minimum read as the Pass Class floor; no separate 5.00 rule found'),
    ],
    classes: [cite('S3', 'PDF p.45, §4.14(c): distinction 7, first 6, second 5, pass 4')],
    percent: [cite('S3', 'PDF p.44, §4.12: percentage = CGPA x 10')],
    unconfirmed: [cite('S3', 'PDF p.43 §4.9 and p.42 §4.5(C)(c)')],
  },
});

const GPA_REGISTRY: ReadonlyMap<string, GpaPolicy> = new Map(
  [RVCE_2022_GPA_S2, RVCE_ACY2026_GPA_S3].map((policy) => [policy.id, policy]),
);

export const GPA_POLICY_IDS: readonly string[] = [...GPA_REGISTRY.keys()];

export function getGpaPolicy(id: string): GpaPolicy {
  const policy = GPA_REGISTRY.get(id);
  if (!policy) throw new AssessmentError('UNKNOWN_POLICY', `Unknown GPA policy ${id}`);
  return policy;
}
