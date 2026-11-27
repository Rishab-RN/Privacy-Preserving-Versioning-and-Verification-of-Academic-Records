import { AssessmentError } from './errors.js';
import { assertPolicy } from './policy.js';
import type { AssessmentPolicy, Citation, GradeBand, SourceDocument } from './policy.js';

/**
 * Public RVCE documents, accessed 27 November 2026. Locators use PDF page numbers. These are
 * design inputs for a synthetic prototype; RVCE staff have not confirmed how they apply.
 */
export const RVCE_SOURCES = {
  S1: {
    title: 'RVCE AIML Scheme and Syllabus, V & VI Semester, 2022 Scheme (updated syllabus book)',
    url: 'https://rvce.edu.in/wp-content/uploads/2025/10/AI-2022-3rd-year.pdf',
  },
  S2: {
    title: 'RVCE UG Handbook of General Information, 2022 Scheme (w.e.f. 2022-23)',
    url: 'https://rvce.edu.in/wp-content/uploads/2025/11/Final-Version-of-2022-Scheme-Hand-Book-compressed.pdf',
  },
  S3: {
    title: 'RVCE UG Guidelines and Information (w.e.f. Academic Year 2026-27)',
    url: 'https://rvce.edu.in/wp-content/uploads/2026/08/dean-UG-hand-book-2025-scheme-ACY-2026-27.pdf',
  },
} as const satisfies Record<string, SourceDocument>;

const cite = (source: 'S1' | 'S2' | 'S3' | 'PROP', locator: string): Citation => ({
  source,
  locator,
});

/** Table 4.3: identical in S2 p.30 and S3 p.38. */
const RVCE_GRADE_BANDS: readonly GradeBand[] = [
  { letter: 'O', minimumPercent: '90', points: 10 },
  { letter: 'A+', minimumPercent: '80', points: 9 },
  { letter: 'A', minimumPercent: '70', points: 8 },
  { letter: 'B+', minimumPercent: '60', points: 7 },
  { letter: 'B', minimumPercent: '55', points: 6 },
  { letter: 'C', minimumPercent: '50', points: 5 },
  { letter: 'P', minimumPercent: '40', points: 4 },
  { letter: 'F', minimumPercent: '0', points: 0 },
];

const MINIMUMS = { theory: '40', lab: '40' } as const;
const SEE_MINIMUMS = { theory: '35', lab: '35' } as const;
const CIE_ABSENCE_NOTE = cite(
  'PROP',
  'AB accepted only for SEE components; CIE absences are entered as marks',
);

/**
 * CD252IA-style integrated theory + lab course, using the course rubric in the AIML 2022-scheme
 * syllabus book. CIE 100 + 50 and SEE 100 + 50.
 */
export const RVCE_2022_ITL_S1: AssessmentPolicy = assertPolicy({
  id: 'rvce-2022-itl-s1',
  version: 1,
  title: 'RVCE 2022 scheme integrated theory + lab course (AIML syllabus rubric)',
  scheme: '2022',
  courseType: 'integrated-theory-lab',
  status: 'pending-institutional-confirmation',
  sources: { S1: RVCE_SOURCES.S1, S2: RVCE_SOURCES.S2 },
  groups: [
    {
      code: 'cie.quiz',
      label: 'Quizzes',
      part: 'cie',
      kind: 'theory',
      components: [
        { code: 'quiz1', label: 'Quiz I', maximum: '10' },
        { code: 'quiz2', label: 'Quiz II', maximum: '10' },
      ],
      weight: '20',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.15, CIE rubric item 1'),
    },
    {
      code: 'cie.test',
      label: 'Tests',
      part: 'cie',
      kind: 'theory',
      components: [
        { code: 'test1', label: 'Test I', maximum: '50' },
        { code: 'test2', label: 'Test II', maximum: '50' },
      ],
      weight: '40',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.15, CIE rubric item 2 (100 reduced to 40)'),
    },
    {
      code: 'cie.el',
      label: 'Experiential learning',
      part: 'cie',
      kind: 'theory',
      components: [
        { code: 'el_case_study', label: 'Case study based teaching learning', maximum: '10' },
        { code: 'el_program', label: 'Program specific requirements', maximum: '10' },
        {
          code: 'el_seminar',
          label: 'Video based seminar/presentation/demonstration',
          maximum: '10',
        },
        { code: 'el_design', label: 'Designing and modeling', maximum: '10' },
      ],
      weight: '40',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.15, CIE rubric item 3'),
    },
    {
      code: 'cie.lab',
      label: 'Laboratory',
      part: 'cie',
      kind: 'lab',
      components: [
        {
          code: 'lab_conduct',
          label: 'Conduction, report, observation and analysis',
          maximum: '20',
        },
        { code: 'lab_test', label: 'Lab test', maximum: '10' },
        { code: 'lab_innovation', label: 'Innovative experiment / concept design', maximum: '20' },
      ],
      weight: '50',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.15, CIE rubric item 4'),
    },
    {
      code: 'see.theory',
      label: 'SEE theory',
      part: 'see',
      kind: 'theory',
      components: [
        { code: 'see_part_a', label: 'Part A objective questions', maximum: '20' },
        { code: 'see_part_b', label: 'Part B (five questions of 16)', maximum: '80' },
      ],
      weight: '100',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.15, SEE theory rubric'),
    },
    {
      code: 'see.lab',
      label: 'SEE laboratory',
      part: 'see',
      kind: 'lab',
      components: [
        { code: 'see_lab_writeup', label: 'Write-up', maximum: '10' },
        { code: 'see_lab_conduct', label: 'Conduction of the experiments', maximum: '20' },
        { code: 'see_lab_viva', label: 'Viva', maximum: '20' },
      ],
      weight: '50',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.15, SEE lab rubric'),
    },
  ],
  minimumPercent: {
    cie: MINIMUMS,
    see: SEE_MINIMUMS,
    aggregate: '40',
    citations: [cite('S2', 'PDF p.32, §4.4 Table 4.4')],
  },
  grades: { bands: RVCE_GRADE_BANDS, citations: [cite('S2', 'PDF p.30, §4.3 Table 4.3')] },
  eligibility: {
    ineligibleLetter: 'NE',
    citations: [cite('S2', 'PDF pp.20-21 §3.3 and pp.33-35 §4.4-4.6')],
  },
  transitionalX: {
    minimumAttendancePercent: '85',
    minimumCiePercent: '90',
    citations: [
      cite('S2', 'PDF p.32, §4.3 Grade X'),
      cite('PROP', 'CIE rating read as total CIE percentage'),
    ],
  },
  paperViewing: {
    parts: ['see'],
    kinds: ['theory'],
    rule: 'better-of',
    citations: [cite('S2', 'PDF pp.36-37, §4.7')],
  },
  rounding: { mode: 'exact', confirmed: false },
  absence: { parts: ['see'], citations: [CIE_ABSENCE_NOTE] },
});

/**
 * Integrated course rubric from the handbook effective in academic year 2026-27. Totals match
 * S1 (CIE 150, SEE 150); component splits, the optional improvement test and DX differ.
 */
export const RVCE_ACY2026_ITL_S3: AssessmentPolicy = assertPolicy({
  id: 'rvce-acy2026-itl-s3',
  version: 1,
  title: 'RVCE AY 2026-27 integrated theory + lab course (handbook rubric)',
  scheme: '2025',
  courseType: 'integrated-theory-lab',
  status: 'pending-institutional-confirmation',
  sources: { S1: RVCE_SOURCES.S1, S3: RVCE_SOURCES.S3 },
  groups: [
    {
      code: 'cie.quiz',
      label: 'Quizzes',
      part: 'cie',
      kind: 'theory',
      components: [
        { code: 'quiz1', label: 'Quiz I', maximum: '10' },
        { code: 'quiz2', label: 'Quiz II', maximum: '10' },
      ],
      weight: '20',
      selection: { rule: 'sum-required' },
      citation: cite('S3', 'PDF p.37, §4.2.2 item 1'),
    },
    {
      code: 'cie.test',
      label: 'Tests',
      part: 'cie',
      kind: 'theory',
      components: [
        { code: 'test1', label: 'Test I', maximum: '50' },
        { code: 'test2', label: 'Test II', maximum: '50' },
        {
          code: 'test_improvement',
          label: 'Optional improvement test',
          maximum: '50',
          optional: true,
        },
      ],
      weight: '40',
      selection: {
        rule: 'unconfirmed',
        question: 'How does the optional improvement test replace or combine with Tests I and II?',
      },
      citation: cite('S3', 'PDF p.37, §4.2.2 item 2'),
    },
    {
      code: 'cie.el',
      label: 'Experiential learning',
      part: 'cie',
      kind: 'theory',
      components: [
        { code: 'el_phase1', label: 'Experiential learning phase I', maximum: '20' },
        { code: 'el_phase2', label: 'Experiential learning phase II', maximum: '20' },
      ],
      weight: '40',
      selection: { rule: 'sum-required' },
      citation: cite('S3', 'PDF p.37, §4.2.2 item 3'),
    },
    {
      code: 'cie.lab',
      label: 'Laboratory',
      part: 'cie',
      kind: 'lab',
      components: [
        {
          code: 'lab_conduct',
          label: 'Conduction, report, observation and analysis',
          maximum: '30',
        },
        { code: 'lab_test', label: 'Lab test', maximum: '10' },
        { code: 'lab_pbl_review', label: 'Problem-based learning review I and II', maximum: '10' },
      ],
      weight: '50',
      selection: { rule: 'sum-required' },
      citation: cite('S3', 'PDF p.37, §4.2.2 item 4'),
    },
    {
      code: 'see.theory',
      label: 'SEE theory',
      part: 'see',
      kind: 'theory',
      components: [{ code: 'see_theory', label: 'SEE theory paper', maximum: '100' }],
      weight: '100',
      selection: { rule: 'sum-required' },
      citation: cite('S1', 'PDF p.7, SEE 100 + 50 for CD252IA'),
    },
    {
      code: 'see.lab',
      label: 'SEE laboratory',
      part: 'see',
      kind: 'lab',
      components: [
        { code: 'see_lab', label: 'Problem/project-based laboratory SEE', maximum: '50' },
      ],
      weight: '50',
      selection: { rule: 'sum-required' },
      citation: cite('S3', 'PDF p.35, §4.1(b)'),
    },
  ],
  minimumPercent: {
    cie: MINIMUMS,
    see: SEE_MINIMUMS,
    aggregate: '40',
    citations: [cite('S3', 'PDF p.40, §4.4 Table 4.4')],
  },
  grades: { bands: RVCE_GRADE_BANDS, citations: [cite('S3', 'PDF p.38, §4.3 Table 4.3')] },
  eligibility: {
    ineligibleLetter: 'DX',
    citations: [cite('S3', 'PDF p.27 §3.1(k) and p.41 §4.5(B)')],
  },
  transitionalX: {
    minimumAttendancePercent: '85',
    minimumCiePercent: '90',
    citations: [
      cite('S3', 'PDF p.39, Grade X'),
      cite('PROP', 'CIE marks read as total CIE percentage'),
    ],
  },
  paperViewing: {
    parts: ['see'],
    kinds: ['theory'],
    rule: 'better-of',
    citations: [cite('S3', 'PDF pp.42-43, §4.8')],
  },
  rounding: { mode: 'exact', confirmed: false },
  absence: { parts: ['see'], citations: [CIE_ABSENCE_NOTE] },
});

const REGISTRY: ReadonlyMap<string, AssessmentPolicy> = new Map(
  [RVCE_2022_ITL_S1, RVCE_ACY2026_ITL_S3].map((policy) => [policy.id, policy]),
);

export const POLICY_IDS: readonly string[] = [...REGISTRY.keys()];

export function getPolicy(id: string): AssessmentPolicy {
  const policy = REGISTRY.get(id);
  if (!policy) throw new AssessmentError('UNKNOWN_POLICY', `Unknown assessment policy ${id}`);
  return policy;
}
