import { CaseError } from './errors.js';

export const CASE_TYPES = ['paper-viewing', 'make-up', 'i-grade', 'drop', 'withdrawal'] as const;
export type CaseType = (typeof CASE_TYPES)[number];

/** Who acts at each step. Parents and committees are participants, not system accounts. */
export type Actor =
  | 'student'
  | 'parent'
  | 'counsellor'
  | 'hod'
  | 'dean_academics'
  | 'chief_superintendent'
  | 'exam_staff'
  | 'exam_approver'
  | 'expert_team'
  | 'grading_advisory_committee';

export interface Citation {
  /** `S2`/`S3`: RVCE handbooks (pilot plan); `PROP`: prototype proposal awaiting confirmation. */
  readonly source: 'S2' | 'S3' | 'PROP';
  readonly locator: string;
}

export interface RouteStep {
  readonly actor: Actor;
  readonly step: string;
}

export interface CaseRule {
  readonly route: readonly RouteStep[];
  readonly effects: readonly string[];
  readonly citations: readonly Citation[];
}

export interface CasePolicy {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly status: 'pending-institutional-confirmation' | 'confirmed';
  readonly sources: Readonly<Record<string, { readonly title: string; readonly url: string }>>;
  /** Programme semesters in which dropping and withdrawal are unavailable. */
  readonly firstYearSemesters: readonly number[];
  /** Registered credits may not fall below this after a drop or withdrawal. */
  readonly minimumRegisteredCredits: string;
  readonly makeUpLetters: readonly string[];
  /** Days after the examination for I-grade documents, capped by the last examination day. */
  readonly documentDays: number;
  /** A drop window may open no earlier than this many months after the semester starts. */
  readonly dropOpensAfterMonths: number;
  readonly rules: Readonly<Record<CaseType, CaseRule>>;
}

const S2 = {
  title: 'RVCE UG Handbook of General Information, 2022 Scheme (w.e.f. 2022-23)',
  url: 'https://rvce.edu.in/wp-content/uploads/2025/11/Final-Version-of-2022-Scheme-Hand-Book-compressed.pdf',
};
const S3 = {
  title: 'RVCE UG Guidelines and Information (w.e.f. Academic Year 2026-27)',
  url: 'https://rvce.edu.in/wp-content/uploads/2026/08/dean-UG-hand-book-2025-scheme-ACY-2026-27.pdf',
};
const cite = (source: Citation['source'], locator: string): Citation => ({ source, locator });

const PAPER_VIEWING_ROUTE: readonly RouteStep[] = [
  { actor: 'student', step: 'Register for the course within the window the CoE announces' },
  {
    actor: 'exam_staff',
    step: 'Schedule the viewing; provide the script with marks, scheme of valuation, solution and grievance form',
  },
  { actor: 'student', step: 'View the script in person and file question-wise grievances' },
  { actor: 'expert_team', step: 'Re-evaluate the script and keep the better of the two marks' },
  {
    actor: 'exam_approver',
    step: 'Approve any change through the independent correction workflow',
  },
];
const PAPER_VIEWING_EFFECTS = [
  'Only the SEE theory paper is reviewed; laboratory examinations are excluded',
  'The better of the original and revised marks is kept; there is no negative evaluation',
  'The outcome is final and replaces photocopy, revaluation and challenge valuation',
];

const MAKE_UP_ROUTE: readonly RouteStep[] = [
  { actor: 'student', step: 'Register (and pay any notified fee) within the CoE window' },
  { actor: 'exam_staff', step: 'Confirm the I or X grade and schedule the make-up examination' },
  { actor: 'exam_approver', step: 'Publish the make-up result' },
];
const MAKE_UP_EFFECTS = [
  'Held about 10 days after results, to the same standard as the regular SEE',
  'Missing the make-up turns X into F and I into Ab',
  'Not available for fast-track semesters or online MOOC courses',
];

const I_GRADE_ROUTE: readonly RouteStep[] = [
  {
    actor: 'student',
    step: 'Inform the Chief Superintendent of Examinations (or have a parent do so) before the examination starts',
  },
  { actor: 'chief_superintendent', step: 'Record the intimation' },
  { actor: 'student', step: 'Submit supporting documents to the CoE before the deadline' },
  { actor: 'grading_advisory_committee', step: 'Decide on the I grade; the decision is final' },
];
const I_GRADE_EFFECTS = [
  'If granted, the student may take the make-up examination',
  'Missing the make-up turns I into Ab',
];

const DROP_ROUTE: readonly RouteStep[] = [
  {
    actor: 'counsellor',
    step: 'Advise the student; counsellor and parent agree the student cannot cope',
  },
  { actor: 'parent', step: 'Concur with the drop' },
  { actor: 'hod', step: 'Forward the drop to the Dean Academics' },
  { actor: 'dean_academics', step: 'Record the drop before the dropping date in the calendar' },
];
const DROP_EFFECTS = [
  'Not treated as an attempt and not recorded on the grade card',
  'Re-register after semester 8, in a regular semester (not fast-track)',
];

const WITHDRAWAL_ROUTE: readonly RouteStep[] = [
  { actor: 'student', step: 'Apply after consulting the counsellor, a parent and the HoD' },
  { actor: 'hod', step: 'Forward the application to the Dean Academics' },
  { actor: 'dean_academics', step: 'Approve the withdrawal' },
];
const WITHDRAWAL_EFFECTS = [
  'Recorded on the grade card as W and treated as an attempt',
  'Re-register in a supplementary semester, earn attendance and CIE, and clear the SEE',
];

const CORRECTION_NOTE = cite(
  'PROP',
  'final approval routed through the existing independent correction workflow',
);
const I_GRADE_NOTE = cite(
  'PROP',
  'intimation before the examination and the document deadline apply to every reason (representation needs prior permission instead); the deadline is the earlier of examination + 7 days and the last examination day',
);
const WRITTEN_NOTE = cite(
  'PROP',
  'project and MOOC assessments have no institutional SEE script to view',
);

/** RVCE 2022-scheme UG handbook. */
export const RVCE_2022_CASES_S2: CasePolicy = assertCasePolicy({
  id: 'rvce-2022-cases-s2',
  version: 1,
  title: 'RVCE 2022 scheme student case intake (UG handbook)',
  status: 'pending-institutional-confirmation',
  sources: { S2 },
  firstYearSemesters: [1, 2],
  minimumRegisteredCredits: '16',
  makeUpLetters: ['I', 'X'],
  documentDays: 7,
  dropOpensAfterMonths: 1,
  rules: {
    'paper-viewing': {
      route: PAPER_VIEWING_ROUTE,
      effects: PAPER_VIEWING_EFFECTS,
      citations: [cite('S2', 'PDF pp.36-37, §4.7'), CORRECTION_NOTE, WRITTEN_NOTE],
    },
    'make-up': {
      route: MAKE_UP_ROUTE,
      effects: MAKE_UP_EFFECTS,
      citations: [cite('S2', 'PDF p.34, §4.4(c)')],
    },
    'i-grade': {
      route: I_GRADE_ROUTE,
      effects: I_GRADE_EFFECTS,
      citations: [cite('S2', 'PDF pp.31-32, §4.3(e)-(g)'), I_GRADE_NOTE],
    },
    drop: {
      route: DROP_ROUTE,
      effects: DROP_EFFECTS,
      citations: [cite('S2', 'PDF p.20, §3.2(d)')],
    },
    withdrawal: {
      route: WITHDRAWAL_ROUTE,
      effects: WITHDRAWAL_EFFECTS,
      citations: [cite('S2', 'PDF p.20, §3.2(e); p.32, Grade W')],
    },
  },
});

/** Handbook effective from academic year 2026-27. Adds the I-grade attempt rule in §4.3(h). */
export const RVCE_ACY2026_CASES_S3: CasePolicy = assertCasePolicy({
  id: 'rvce-acy2026-cases-s3',
  version: 1,
  title: 'RVCE AY 2026-27 student case intake (UG handbook)',
  status: 'pending-institutional-confirmation',
  sources: { S3 },
  firstYearSemesters: [1, 2],
  minimumRegisteredCredits: '16',
  makeUpLetters: ['I', 'X'],
  documentDays: 7,
  dropOpensAfterMonths: 1,
  rules: {
    'paper-viewing': {
      route: PAPER_VIEWING_ROUTE,
      effects: PAPER_VIEWING_EFFECTS,
      citations: [cite('S3', 'PDF pp.42-43, §4.8'), CORRECTION_NOTE, WRITTEN_NOTE],
    },
    'make-up': {
      route: MAKE_UP_ROUTE,
      effects: MAKE_UP_EFFECTS,
      citations: [cite('S3', 'PDF pp.41-42, §4.5(C)')],
    },
    'i-grade': {
      route: I_GRADE_ROUTE,
      effects: [
        ...I_GRADE_EFFECTS,
        'Clearing an I grade in the make-up counts as an attempt, except for students representing the institution',
      ],
      citations: [cite('S3', 'PDF pp.38-39, §4.3(e)-(h)'), I_GRADE_NOTE],
    },
    drop: {
      route: DROP_ROUTE,
      effects: DROP_EFFECTS,
      citations: [cite('S3', 'PDF p.29, §3.2(d)')],
    },
    withdrawal: {
      route: WITHDRAWAL_ROUTE,
      effects: WITHDRAWAL_EFFECTS,
      citations: [cite('S3', 'PDF p.29, §3.2(e); p.39, Grade W')],
    },
  },
});

function invalid(policy: string, message: string): never {
  throw new CaseError('POLICY_INVALID', `${policy}: ${message}`);
}

/** Checks a case policy's structure and returns it unchanged. */
export function assertCasePolicy(policy: CasePolicy): CasePolicy {
  const id = policy.id;
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(id)) invalid(id, 'id must be a lowercase slug');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) invalid(id, 'bad version');
  if (!/^(0|[1-9]\d?)(\.\d{1,2})?$/.test(policy.minimumRegisteredCredits)) {
    invalid(id, 'minimum registered credits must be a decimal below 100');
  }
  if (!Number.isInteger(policy.documentDays) || policy.documentDays < 1) {
    invalid(id, 'document days must be a positive integer');
  }
  if (!Number.isInteger(policy.dropOpensAfterMonths) || policy.dropOpensAfterMonths < 0) {
    invalid(id, 'drop opening months must be a non-negative integer');
  }
  if (policy.firstYearSemesters.some((s) => !Number.isInteger(s) || s < 1 || s > 8)) {
    invalid(id, 'first-year semesters must be programme semesters 1-8');
  }
  if (policy.makeUpLetters.length === 0) invalid(id, 'make-up letters are required');
  for (const type of CASE_TYPES) {
    const rule = policy.rules[type];
    if (!rule || rule.route.length === 0 || rule.effects.length === 0) {
      invalid(id, `${type} needs a route and effects`);
    }
    if (!rule.citations.some((c) => c.source !== 'PROP'))
      invalid(id, `${type} needs a source citation`);
    for (const citation of rule.citations) {
      if (citation.source !== 'PROP' && !policy.sources[citation.source]) {
        invalid(id, `${type} cites unknown source ${citation.source}`);
      }
    }
  }
  return policy;
}

const REGISTRY: ReadonlyMap<string, CasePolicy> = new Map(
  [RVCE_2022_CASES_S2, RVCE_ACY2026_CASES_S3].map((policy) => [policy.id, policy]),
);

export const CASE_POLICY_IDS: readonly string[] = [...REGISTRY.keys()];

export function getCasePolicy(id: string): CasePolicy {
  const policy = REGISTRY.get(id);
  if (!policy) throw new CaseError('UNKNOWN_POLICY', `Unknown case policy ${id}`);
  return policy;
}
