import assert from 'node:assert/strict';
import test from 'node:test';
import { AIML_SEMESTER_V, TERM, generatePilotData } from '@academic-records/pilot-data';
import {
  CASE_POLICY_IDS,
  CaseError,
  RVCE_2022_CASES_S2 as S2,
  RVCE_ACY2026_CASES_S3 as S3,
  assertCasePolicy,
  evaluateCase,
  getCasePolicy,
} from '../src/index.js';
import type {
  CaseCourse,
  CaseErrorCode,
  CasePolicy,
  CaseReason,
  CaseRequest,
  ExamStanding,
  StudentContext,
  TermCalendar,
} from '../src/index.js';

/** Synthetic AY 2026-27 odd-semester calendar; real dates come from CoE circulars. */
const CALENDAR: TermCalendar = {
  term: TERM.code,
  semesterStart: '2026-08-17',
  dropWindow: { opens: '2026-09-17', closes: '2026-10-05' },
  withdrawalDeadline: '2026-11-13',
  lastExamDay: '2026-12-24',
  provisionalResults: '2027-01-08',
  paperViewingRegistration: { opens: '2027-01-09', closes: '2027-01-13' },
  makeUpRegistration: { opens: '2027-01-11', closes: '2027-01-15' },
};

const data = generatePilotData();

const without = (key: keyof TermCalendar): TermCalendar =>
  Object.fromEntries(
    Object.entries(CALENDAR).filter(([name]) => name !== key),
  ) as unknown as TermCalendar;

function context(
  usn: string,
  options: { results?: boolean; semester?: number; standing?: ExamStanding } = {},
): StudentContext {
  const assessment = data.assessments.find((candidate) => candidate.usn === usn);
  if (!assessment) throw new Error(`no pilot student ${usn}`);
  const withResults = options.results ?? true;
  return {
    usn,
    semester: options.semester ?? TERM.semester,
    term: TERM.code,
    semesterKind: 'regular',
    courses: AIML_SEMESTER_V.map((course): CaseCourse => {
      if (course.code !== 'CD252IA') {
        return {
          course: course.code,
          credits: course.credits,
          kind: 'theory',
          attendanceSatisfied: true,
        };
      }
      const standing = options.standing ?? assessment.result;
      return {
        course: course.code,
        credits: course.credits,
        kind: 'integrated',
        attendanceSatisfied: assessment.attendance.eligible,
        ...(withResults ? { standing } : {}),
      };
    }),
  };
}

const simple = (
  type: 'paper-viewing' | 'make-up' | 'drop' | 'withdrawal',
  submittedOn: string,
): CaseRequest => ({
  type,
  course: 'CD252IA',
  submittedOn,
});

const iGrade = (
  overrides: Partial<Extract<CaseRequest, { type: 'i-grade' }>> = {},
): CaseRequest => ({
  type: 'i-grade',
  course: 'CD252IA',
  submittedOn: '2026-12-18',
  reason: 'medical',
  examDate: '2026-12-14',
  intimatedOn: '2026-12-14',
  ...overrides,
});

function expect(
  student: StudentContext,
  request: CaseRequest,
  reasons: readonly CaseReason[],
  options: { policy?: CasePolicy; calendar?: TermCalendar } = {},
) {
  const decision = evaluateCase(
    options.policy ?? S2,
    options.calendar ?? CALENDAR,
    student,
    request,
  );
  assert.deepEqual(decision.reasons, reasons, `${student.usn} ${request.type}`);
  assert.equal(decision.eligible, reasons.length === 0);
  return decision;
}

const rejects = (code: CaseErrorCode, action: () => unknown) =>
  assert.throws(action, (error: unknown) => error instanceof CaseError && error.code === code);

test('registry exposes the validated case policies', () => {
  assert.deepEqual(CASE_POLICY_IDS, ['rvce-2022-cases-s2', 'rvce-acy2026-cases-s3']);
  assert.equal(getCasePolicy('rvce-2022-cases-s2'), S2);
  rejects('UNKNOWN_POLICY', () => getCasePolicy('rvce-2018-cases'));
});

test('paper viewing needs an evaluated SEE script, provisional results and an open window', () => {
  const pvp = expect(context('SYN24AI003'), simple('paper-viewing', '2027-01-10'), []);
  assert.equal(pvp.deadline, '2027-01-13');
  assert.deepEqual(
    pvp.route.map((step) => step.actor),
    ['student', 'exam_staff', 'student', 'expert_team', 'exam_approver'],
  );
  expect(context('SYN24AI001'), simple('paper-viewing', '2027-01-09'), []);
  expect(context('SYN24AI004'), simple('paper-viewing', '2027-01-13'), [], {}); // X: SEE was written
  expect(context('SYN24AI005'), simple('paper-viewing', '2027-01-10'), ['NO_EVALUATED_SCRIPT']);
  expect(context('SYN24AI007'), simple('paper-viewing', '2027-01-10'), ['NO_EVALUATED_SCRIPT']);
  expect(context('SYN24AI003'), simple('paper-viewing', '2027-01-07'), [
    'BEFORE_PROVISIONAL_RESULTS',
    'OUTSIDE_WINDOW',
  ]);
  expect(context('SYN24AI003'), simple('paper-viewing', '2027-01-14'), ['OUTSIDE_WINDOW']);
  expect(context('SYN24AI003', { results: false }), simple('paper-viewing', '2027-01-10'), [
    'RESULT_NOT_AVAILABLE',
  ]);
  expect(context('SYN24AI003'), simple('paper-viewing', '2027-01-10'), ['WINDOW_NOT_ANNOUNCED'], {
    calendar: without('paperViewingRegistration'),
  });
});

test('laboratory, project and MOOC assessments are outside paper viewing', () => {
  const graded = context('SYN24AI001');
  for (const [kind, reason] of [
    ['lab', 'LAB_EXCLUDED'],
    ['project', 'NOT_A_WRITTEN_SEE'],
    ['mooc', 'NOT_A_WRITTEN_SEE'],
  ] as const) {
    const student = {
      ...graded,
      courses: graded.courses.map((c) => (c.course === 'CD252IA' ? { ...c, kind } : c)),
    };
    expect(student, simple('paper-viewing', '2027-01-10'), [reason]);
  }
});

test('make-up registration is limited to I and X grades in a regular semester', () => {
  const x = expect(context('SYN24AI004'), simple('make-up', '2027-01-12'), []);
  assert.equal(x.deadline, '2027-01-15');
  const grantedI = context('SYN24AI005', { standing: { status: 'transitional', letter: 'I' } });
  expect(grantedI, simple('make-up', '2027-01-15'), []);
  expect(grantedI, simple('paper-viewing', '2027-01-10'), ['NO_EVALUATED_SCRIPT']);
  expect(context('SYN24AI003'), simple('make-up', '2027-01-12'), ['NOT_I_OR_X']);
  expect(context('SYN24AI005'), simple('make-up', '2027-01-12'), ['NOT_I_OR_X']);
  expect(
    { ...context('SYN24AI004'), semesterKind: 'fast-track' },
    simple('make-up', '2027-01-12'),
    ['FAST_TRACK_EXCLUDED'],
  );
  expect(context('SYN24AI004'), simple('make-up', '2027-01-16'), ['OUTSIDE_WINDOW']);
});

test('an I-grade request needs eligibility, timely intimation and documents', () => {
  const absent = context('SYN24AI005');
  const granted = expect(absent, iGrade(), []);
  assert.equal(granted.deadline, '2026-12-21', 'examination + 7 days');
  assert.equal(granted.route.at(-1)?.actor, 'grading_advisory_committee');

  const lastPaper = expect(
    absent,
    iGrade({ examDate: '2026-12-22', intimatedOn: '2026-12-21' }),
    [],
  );
  assert.equal(lastPaper.deadline, '2026-12-24', 'capped by the last examination day');
  expect(absent, iGrade({ submittedOn: '2026-12-22' }), ['DOCUMENTS_LATE']);
  expect(absent, iGrade({ intimatedOn: null }), ['NO_INTIMATION']);
  expect(absent, iGrade({ intimatedOn: '2026-12-15' }), ['LATE_INTIMATION']);
  expect(absent, iGrade({ reason: 'family-calamity' }), []);
  expect(absent, iGrade({ reason: 'institution-representation', intimatedOn: null }), [
    'PRIOR_PERMISSION_MISSING',
  ]);
  expect(
    absent,
    iGrade({ reason: 'institution-representation', intimatedOn: null, priorPermission: true }),
    [],
  );
  expect(absent, iGrade({ examDate: '2027-01-02', intimatedOn: '2027-01-01' }), [
    'EXAM_DATE_OUTSIDE_TERM',
  ]);
  expect(context('SYN24AI007'), iGrade(), ['ATTENDANCE_NOT_SATISFIED']);
  expect(context('SYN24AI008'), iGrade(), ['CIE_NOT_SATISFIED']);
  expect(context('SYN24AI001'), iGrade(), ['NOT_ABSENT_FROM_SEE']);

  rejects('INVALID_CALENDAR', () => evaluateCase(S2, without('lastExamDay'), absent, iGrade()));
});

test('the AY 2026-27 rules add the I-grade attempt note', () => {
  const absent = context('SYN24AI005');
  const s2 = evaluateCase(S2, CALENDAR, absent, iGrade());
  const s3 = evaluateCase(S3, CALENDAR, absent, iGrade());
  assert.equal(s3.effects.length, s2.effects.length + 1);
  assert.match(s3.effects.at(-1) ?? '', /counts as an attempt, except for students representing/);
  assert.equal(s3.policy.id, 'rvce-acy2026-cases-s3');
});

test('dropping keeps 16 credits, follows the calendar window and excludes first year', () => {
  const before = context('SYN24AI001', { results: false });
  const drop = expect(before, simple('drop', '2026-09-20'), []);
  assert.equal(drop.deadline, '2026-10-05');
  assert.deepEqual(
    drop.route.map((step) => step.actor),
    ['counsellor', 'parent', 'hod', 'dean_academics'],
  );
  assert.match(drop.effects[0] ?? '', /Not treated as an attempt/);

  const lighter = { ...before, courses: before.courses.filter((c) => c.course !== 'AI256TCA') };
  expect(lighter, simple('drop', '2026-09-20'), ['CREDITS_BELOW_MINIMUM'], {}); // 18 - 4 = 14
  expect(context('SYN24AI001', { results: false, semester: 2 }), simple('drop', '2026-09-20'), [
    'FIRST_YEAR',
  ]);
  expect(before, simple('drop', '2026-09-10'), ['OUTSIDE_WINDOW']);
  expect(context('SYN24AI001'), simple('drop', '2026-09-20'), ['RESULT_DECLARED']);
  expect(before, simple('drop', '2026-09-20'), ['WINDOW_NOT_ANNOUNCED'], {
    calendar: without('dropWindow'),
  });
});

test('withdrawal needs attendance, the calendar deadline and 16 remaining credits', () => {
  const before = context('SYN24AI001', { results: false });
  const withdrawal = expect(before, simple('withdrawal', '2026-11-13'), []);
  assert.equal(withdrawal.deadline, '2026-11-13');
  assert.match(withdrawal.effects[0] ?? '', /W and treated as an attempt/);
  expect(before, simple('withdrawal', '2026-11-14'), ['OUTSIDE_WINDOW']);
  expect(context('SYN24AI007', { results: false }), simple('withdrawal', '2026-11-01'), [
    'ATTENDANCE_NOT_SATISFIED',
  ]);
  expect(
    context('SYN24AI001', { results: false, semester: 1 }),
    simple('withdrawal', '2026-11-01'),
    ['FIRST_YEAR'],
  );
});

test('an unregistered course is a decision, not an error', () => {
  const decision = evaluateCase(S2, CALENDAR, context('SYN24AI001'), {
    type: 'paper-viewing',
    course: 'CS999',
    submittedOn: '2027-01-10',
  });
  assert.deepEqual(decision.reasons, ['COURSE_NOT_REGISTERED']);
  assert.equal(decision.deadline, null);
});

test('malformed calendars, students and dates are rejected', () => {
  const student = context('SYN24AI001');
  const evaluate = (calendar: TermCalendar, who: StudentContext = student, on = '2027-01-10') =>
    evaluateCase(S2, calendar, who, simple('paper-viewing', on));
  rejects('TERM_MISMATCH', () => evaluate({ ...CALENDAR, term: '2027-28-ODD' }));
  for (const date of ['2027-02-30', '2027/01/10', '10-01-2027']) {
    rejects('INVALID_DATE', () => evaluate(CALENDAR, student, date));
  }
  rejects('INVALID_CALENDAR', () =>
    evaluate({ ...CALENDAR, dropWindow: { opens: '2026-09-16', closes: '2026-10-05' } }),
  );
  rejects('INVALID_CALENDAR', () =>
    evaluate({
      ...CALENDAR,
      paperViewingRegistration: { opens: '2027-01-05', closes: '2027-01-13' },
    }),
  );
  rejects('INVALID_CALENDAR', () =>
    evaluate({ ...CALENDAR, makeUpRegistration: { opens: '2027-01-15', closes: '2027-01-11' } }),
  );
  rejects('INVALID_CALENDAR', () => evaluate({ ...CALENDAR, withdrawalDeadline: '2026-08-01' }));
  rejects('INVALID_STUDENT', () => evaluate(CALENDAR, { ...student, semester: 9 }));
  rejects('INVALID_STUDENT', () =>
    evaluate(CALENDAR, { ...student, courses: [...student.courses, student.courses[0]!] }),
  );
  rejects('INVALID_CREDITS', () =>
    evaluate(CALENDAR, { ...student, courses: [{ ...student.courses[0]!, credits: 'four' }] }),
  );
});

test('the drop window opens a calendar month after the start, clamped at month end', () => {
  const january: TermCalendar = { term: TERM.code, semesterStart: '2027-01-31' };
  const student = context('SYN24AI001', { results: false });
  const ok = { ...january, dropWindow: { opens: '2027-02-28', closes: '2027-03-10' } };
  expect(student, simple('drop', '2027-03-01'), [], { calendar: ok });
  rejects('INVALID_CALENDAR', () =>
    evaluateCase(
      S2,
      { ...january, dropWindow: { opens: '2027-02-27', closes: '2027-03-10' } },
      student,
      simple('drop', '2027-03-01'),
    ),
  );
});

test('malformed case policies are rejected', () => {
  const invalid = (policy: CasePolicy) =>
    assert.throws(
      () => assertCasePolicy(policy),
      (error: unknown) => error instanceof CaseError && error.code === 'POLICY_INVALID',
    );
  assert.equal(assertCasePolicy(S3), S3);
  invalid({ ...S2, minimumRegisteredCredits: 'sixteen' });
  invalid({ ...S2, firstYearSemesters: [9] });
  invalid({ ...S2, documentDays: 0 });
  invalid({ ...S2, rules: { ...S2.rules, drop: { ...S2.rules.drop, route: [] } } });
  invalid({
    ...S2,
    rules: {
      ...S2.rules,
      drop: { ...S2.rules.drop, citations: [{ source: 'PROP', locator: 'x' }] },
    },
  });
  invalid({
    ...S2,
    rules: {
      ...S2.rules,
      drop: { ...S2.rules.drop, citations: [{ source: 'S3', locator: 'p.29' }] },
    },
  });
});
