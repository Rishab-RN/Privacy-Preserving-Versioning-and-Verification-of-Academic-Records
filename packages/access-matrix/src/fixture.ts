import type { Delegation, World } from './model.js';

const TERM = '2026-27-ODD';

const aiExamOffice: Delegation = {
  grantor: 'P1',
  tasks: ['validate_import', 'reconcile_roster'],
  departments: ['AI'],
  term: TERM,
  validFrom: '2026-11-01T00:00:00Z',
  validUntil: '2027-02-01T00:00:00Z',
};

/**
 * Synthetic pilot institution from the planning pass: one AIML 2022-scheme Semester V term with
 * CD252IA sections AI-A (published) and AI-B, and an IS section used only for isolation checks.
 * All people are synthetic. Keys are short fixture handles, not real identifiers.
 */
export const PILOT_WORLD: World = {
  name: 'Academic Records demo college, CD252IA pilot',
  now: '2026-12-15T00:00:00Z',
  principals: {
    ST1: { persona: 'AIML student in AI-A', roles: ['student'], student: 'ST1' },
    ST2: { persona: 'AIML student in AI-B (unpublished)', roles: ['student'], student: 'ST2' },
    ST3: { persona: 'ISE student in IS-A (isolation)', roles: ['student'], student: 'ST3' },
    F1: {
      persona: 'Course teacher, AI-A',
      roles: ['faculty'],
      offeringDuties: [{ offering: 'ai-a', duty: 'course_teacher' }],
    },
    H1: {
      persona: 'AI HoD who also teaches AI-B (multi-role)',
      roles: ['faculty'],
      offeringDuties: [{ offering: 'ai-b', duty: 'course_teacher' }],
      departmentDuties: [{ department: 'AI', term: TERM, duty: 'hod' }],
    },
    H2: {
      persona: 'AI HoD delegate',
      roles: ['faculty'],
      departmentDuties: [{ department: 'AI', term: TERM, duty: 'hod_delegate' }],
    },
    E1: {
      persona: 'SEE examiner, AI-A',
      roles: ['examiner'],
      offeringDuties: [{ offering: 'ai-a', duty: 'see_examiner' }],
    },
    S1: {
      persona: 'Exam-section staff with an active AI delegation',
      roles: ['exam_staff'],
      delegations: [aiExamOffice],
    },
    S2: {
      persona: 'Exam-section staff whose delegation has expired',
      roles: ['exam_staff'],
      delegations: [
        {
          ...aiExamOffice,
          tasks: ['validate_import'],
          departments: ['AI', 'IS'],
          validFrom: '2026-08-01T00:00:00Z',
          validUntil: '2026-12-01T00:00:00Z',
        },
      ],
    },
    P1: { persona: 'CoE exam approver', roles: ['exam_approver'] },
    P2: {
      persona: 'Exam approver who is also an IS HoD delegate (separation fixture)',
      roles: ['exam_approver', 'faculty'],
      departmentDuties: [{ department: 'IS', term: TERM, duty: 'hod_delegate' }],
    },
    R1: { persona: 'Registrar who proposed the correction', roles: ['registrar'] },
    R2: { persona: 'Second registrar', roles: ['registrar'] },
    D1: { persona: 'Dean Academics', roles: ['dean_academics'] },
    A1: { persona: 'Auditor', roles: ['auditor'] },
    F3: {
      persona: 'Course teacher, IS-A (isolation)',
      roles: ['faculty'],
      offeringDuties: [{ offering: 'is-a', duty: 'course_teacher' }],
    },
    H3: {
      persona: 'IS HoD (isolation)',
      roles: ['faculty'],
      departmentDuties: [{ department: 'IS', term: TERM, duty: 'hod' }],
    },
  },
  offerings: {
    'ai-a': { course: 'CD252IA', department: 'AI', term: TERM, published: true },
    'ai-b': { course: 'CD252IA', department: 'AI', term: TERM, published: false },
    'is-a': { course: 'CD252IA', department: 'IS', term: TERM, published: false },
  },
  batches: {
    'ai-a/cie': {
      offering: 'ai-a',
      stage: 'cie',
      author: 'F1',
      validators: ['S1'],
      reviewer: 'H1',
    },
    'ai-a/see': {
      offering: 'ai-a',
      stage: 'see',
      author: 'E1',
      validators: ['S1'],
      reviewer: null,
    },
    'ai-b/cie': {
      offering: 'ai-b',
      stage: 'cie',
      author: 'H1',
      validators: ['S1'],
      reviewer: null,
    },
    'is-a/cie': { offering: 'is-a', stage: 'cie', author: 'F3', validators: [], reviewer: 'P2' },
  },
  results: {
    'ST1/ai-a': { student: 'ST1', offering: 'ai-a' },
    'ST2/ai-b': { student: 'ST2', offering: 'ai-b' },
    'ST3/is-a': { student: 'ST3', offering: 'is-a' },
  },
  corrections: {
    'corr-ST1': { result: 'ST1/ai-a', proposer: 'R1' },
  },
  dashboards: {
    institution: { department: null, term: TERM },
    'dept-AI': { department: 'AI', term: TERM },
    'dept-IS': { department: 'IS', term: TERM },
  },
};
