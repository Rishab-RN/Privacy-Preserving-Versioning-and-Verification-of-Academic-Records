import type { Action, Basis, Grant, Scope, Separation, Via } from './model.js';

const S2_CIE: Basis = { source: 'S2', locator: '§4.1(a)(i) PDF p.26: CIE by the course teacher' };
const S4_SEE: Basis = {
  source: 'S4',
  locator: '§2.5.3 PDF p.51: internal examiners evaluate SEE scripts; marks entry in SLcM',
};
const HOD_REVIEW: Basis = {
  source: 'PROP',
  locator: 'Pilot plan §2 and Q2/Q3: department review of CIE marks is a hypothesis',
};
const DELEGATED: Basis = {
  source: 'PROP',
  locator: 'Pilot plan §2 and Q4: exam-section tasks are delegated, never review or publish',
};
const PUBLISH: Basis = {
  source: 'PROP',
  locator: 'Pilot plan Q5; S2 §4.1(a)(ii) p.26 places SEE with the CoE, Dean Academics and BoE',
};
const STUDENT_VIEW: Basis = {
  source: 'PROP',
  locator: 'Pilot plan §2: students see only their own published results',
};
const TEACHER_VIEW: Basis = {
  source: 'PROP',
  locator: 'Pilot plan §2: course teachers see results for their assigned section',
};
const OVERSIGHT: Basis = {
  source: 'PROP',
  locator: 'Pilot plan §2: oversight roles read; Dean Academics sees aggregates only',
};
const EXISTING_ACCESS: Basis = {
  source: 'REPO',
  locator: 'docs/architecture/access-and-evidence.md: institutional registrar/auditor reads',
};
const EXISTING_WORKFLOW: Basis = {
  source: 'REPO',
  locator: 'docs/architecture/record-workflow.md: one registrar proposes, another decides',
};
const EXISTING_PROOFS: Basis = {
  source: 'REPO',
  locator: 'docs/architecture/zero-knowledge-proofs.md: student-held threshold proofs',
};

const role = (name: Extract<Via, { kind: 'role' }>['role']): Via => ({ kind: 'role', role: name });
const teacher: Via = { kind: 'offering', duty: 'course_teacher', stage: 'cie' };
const examiner: Via = { kind: 'offering', duty: 'see_examiner', stage: 'see' };
const anyTeacher: Via = { kind: 'offering', duty: 'course_teacher' };
const anyExaminer: Via = { kind: 'offering', duty: 'see_examiner' };
const hod: Via = { kind: 'department', duty: 'hod' };
const delegate: Via = { kind: 'department', duty: 'hod_delegate' };
const cieHod: Via = { kind: 'department', duty: 'hod', stage: 'cie' };
const cieDelegate: Via = { kind: 'department', duty: 'hod_delegate', stage: 'cie' };

function grants(action: Action, scope: Scope, basis: Basis, ...vias: Via[]): Grant[] {
  return vias.map((via) => ({ action, via, scope, basis }));
}

/**
 * Every permission in the pilot. Anything not granted here is denied. A grant names the
 * membership, duty or delegation that confers it and the scope it covers.
 */
export const GRANTS: readonly Grant[] = [
  ...grants('roster.read', 'assigned', S2_CIE, anyTeacher),
  ...grants('roster.read', 'assigned', S4_SEE, anyExaminer),
  ...grants('roster.read', 'department', HOD_REVIEW, hod, delegate),
  ...grants('roster.read', 'institution', PUBLISH, role('exam_approver')),
  ...grants('roster.read', 'delegated', DELEGATED, {
    kind: 'delegation',
    task: 'reconcile_roster',
  }),

  ...grants('batch.create', 'assigned', S2_CIE, teacher),
  ...grants('batch.create', 'assigned', S4_SEE, examiner),
  ...grants('batch.submit', 'authored', S2_CIE, teacher),
  ...grants('batch.submit', 'authored', S4_SEE, examiner),
  ...grants('batch.revise', 'assigned', S2_CIE, teacher),
  ...grants('batch.revise', 'assigned', S4_SEE, examiner),
  ...grants('batch.validate', 'delegated', DELEGATED, {
    kind: 'delegation',
    task: 'validate_import',
  }),
  ...grants('batch.review', 'department', HOD_REVIEW, cieHod, cieDelegate),
  ...grants('results.publish', 'institution', PUBLISH, role('exam_approver')),

  ...grants('result.read', 'own-published', STUDENT_VIEW, role('student')),
  ...grants('result.read', 'assigned', TEACHER_VIEW, anyTeacher),
  ...grants('result.read', 'department', HOD_REVIEW, hod, delegate),
  ...grants('result.read', 'institution', PUBLISH, role('exam_approver')),
  ...grants('result.read', 'institution', EXISTING_ACCESS, role('registrar'), role('auditor')),
  ...grants(
    'cie.acknowledge',
    'own',
    {
      source: 'S2',
      locator: '§4.1(c) PDF p.27: students sign to confirm displayed CIE marks',
    },
    role('student'),
  ),

  ...grants('correction.propose', 'institution', EXISTING_WORKFLOW, role('registrar')),
  ...grants('correction.propose', 'institution', PUBLISH, role('exam_approver')),
  ...grants('correction.approve', 'institution', EXISTING_WORKFLOW, role('registrar')),
  ...grants('correction.approve', 'institution', PUBLISH, role('exam_approver')),

  ...grants('dashboard.read', 'institution', OVERSIGHT, role('dean_academics')),
  ...grants('dashboard.read', 'institution', PUBLISH, role('exam_approver')),
  ...grants('dashboard.read', 'department', HOD_REVIEW, hod, delegate),
  ...grants('integrity.review', 'institution', EXISTING_ACCESS, role('registrar'), role('auditor')),
  ...grants('delegation.grant', 'institution', DELEGATED, role('exam_approver')),

  ...grants('proof.issue', 'own-published', EXISTING_PROOFS, role('student')),
];

const SOD: Basis = {
  source: 'PROP',
  locator: 'Pilot plan §2: entry, validation, review and publication are held by different people',
};

/** Checked in order after authority and scope pass; the first match denies. */
export const SEPARATIONS: readonly Separation[] = [
  { action: 'batch.review', when: 'batch-author', code: 'SELF_REVIEW', basis: SOD },
  { action: 'batch.review', when: 'batch-validator', code: 'SOD_CONFLICT', basis: SOD },
  { action: 'batch.validate', when: 'batch-author', code: 'SOD_CONFLICT', basis: SOD },
  { action: 'batch.validate', when: 'batch-reviewer', code: 'SOD_CONFLICT', basis: SOD },
  { action: 'results.publish', when: 'offering-participant', code: 'SOD_CONFLICT', basis: SOD },
  {
    action: 'correction.approve',
    when: 'correction-proposer',
    code: 'SELF_APPROVAL',
    basis: EXISTING_WORKFLOW,
  },
  { action: 'correction.approve', when: 'record-author', code: 'SOD_CONFLICT', basis: SOD },
];

/** Actions that make or confirm an academic decision. Each needs at least one separation rule. */
export const DECISIONS: readonly Action[] = [
  'batch.validate',
  'batch.review',
  'results.publish',
  'correction.approve',
];

/** The only actions a delegation may ever confer. */
export const DELEGABLE: readonly Action[] = ['batch.validate', 'roster.read'];
