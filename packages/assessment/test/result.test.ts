import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssessmentError,
  POLICY_IDS,
  RVCE_2022_ITL_S1 as S1,
  RVCE_ACY2026_ITL_S3 as S3,
  calculateResult,
  evaluateCie,
  getPolicy,
} from '../src/index.js';
import type { AssessmentErrorCode, StudentAssessment } from '../src/index.js';
import { ATTENDING, marksFor, student } from './fixtures.js';

const rejects = (code: AssessmentErrorCode, action: () => unknown) =>
  assert.throws(
    action,
    (error: unknown) => error instanceof AssessmentError && error.code === code,
  );

const representative: StudentAssessment = {
  attendance: ATTENDING,
  marks: {
    quiz1: '8',
    quiz2: '9',
    test1: '38',
    test2: '41.5',
    el_case_study: '8',
    el_program: '7',
    el_seminar: '9',
    el_design: '6',
    lab_conduct: '18',
    lab_test: '9',
    lab_innovation: '17',
    see_part_a: '15',
    see_part_b: '58.5',
    see_lab_writeup: '8',
    see_lab_conduct: '17',
    see_lab_viva: '16',
  },
};

test('registry exposes the validated RVCE policies', () => {
  assert.deepEqual(POLICY_IDS, ['rvce-2022-itl-s1', 'rvce-acy2026-itl-s3']);
  assert.equal(getPolicy('rvce-2022-itl-s1'), S1);
  rejects('UNKNOWN_POLICY', () => getPolicy('rvce-2018-theory'));
});

test('a representative student matches the hand-computed golden result byte for byte', () => {
  // CIE theory: 17 + 79.5 * 0.4 + 30 = 78.8; total 122.8 + 73.5 + 41 = 237.3 / 300 = 79.1% -> A.
  assert.equal(
    JSON.stringify(calculateResult(S1, representative)),
    '{"policy":{"id":"rvce-2022-itl-s1","version":1,"status":"pending-institutional-confirmation"},' +
      '"status":"graded","letter":"A","gradePoints":8,"outcome":"passed","reasons":[],' +
      '"cie":{"theory":{"marks":"78.80","maximum":"100.00","percent":"78.80"},' +
      '"lab":{"marks":"44.00","maximum":"50.00","percent":"88.00"},' +
      '"total":{"marks":"122.80","maximum":"150.00","percent":"81.87"}},' +
      '"see":{"theory":{"marks":"73.50","maximum":"100.00","percent":"73.50"},' +
      '"lab":{"marks":"41.00","maximum":"50.00","percent":"82.00"}},' +
      '"total":{"marks":"237.30","maximum":"300.00","percent":"79.10","exactPercent":"791/10"},' +
      '"roundingSensitive":false}',
  );
});

test('every grade band edge and the half mark below it follow Table 4.3', () => {
  const edges = [
    ['O', 10, ['80', '40', '100', '50'], 'A+', 9, '49.5'],
    ['A+', 9, ['80', '40', '80', '40'], 'A', 8, '39.5'],
    ['A', 8, ['70', '35', '70', '35'], 'B+', 7, '34.5'],
    ['B+', 7, ['60', '30', '60', '30'], 'B', 6, '29.5'],
    ['B', 6, ['55', '27.5', '55', '27.5'], 'C', 5, '27'],
    ['C', 5, ['50', '25', '50', '25'], 'P', 4, '24.5'],
    ['P', 4, ['40', '20', '40', '20'], 'F', 0, '19.5'],
  ] as const;
  for (const [
    letter,
    points,
    [cieTheory, cieLab, seeTheory, seeLab],
    lower,
    lowerPoints,
    lowered,
  ] of edges) {
    const atEdge = calculateResult(S1, student(S1, { cieTheory, cieLab, seeTheory, seeLab }));
    assert.equal(atEdge.letter, letter);
    assert.equal(atEdge.gradePoints, points);
    assert.equal(atEdge.roundingSensitive, false, `${letter} edge is exact`);

    const below = calculateResult(
      S1,
      student(S1, { cieTheory, cieLab, seeTheory, seeLab: lowered }),
    );
    assert.equal(below.letter, lower, `half a mark below ${letter}`);
    assert.equal(below.gradePoints, lowerPoints);
    assert.equal(below.roundingSensitive, true, `rounding would lift ${lower} to ${letter}`);
  }
  const failed = calculateResult(
    S1,
    student(S1, { cieTheory: '40', cieLab: '20', seeTheory: '40', seeLab: '19.5' }),
  );
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.reasons, ['AGGREGATE_BELOW_MINIMUM']);
});

test('decisions use exact values even when the display rounds up to a threshold', () => {
  const input = student(S1, { cieTheory: '40', cieLab: '20', seeTheory: '40' });
  const result = calculateResult(S1, {
    ...input,
    marks: { ...input.marks, see_lab_writeup: '9.99', see_lab_conduct: '10', see_lab_viva: '0' },
  });
  assert.equal(result.total?.percent, '40.00');
  assert.equal(result.total?.exactPercent, '11999/300');
  assert.equal(result.letter, 'F');
  assert.deepEqual(result.reasons, ['AGGREGATE_BELOW_MINIMUM']);
});

test('CIE minimums decide SEE eligibility (40% theory, 40% lab)', () => {
  const eligible = evaluateCie(S1, student(S1, { cieTheory: '40', cieLab: '20' }));
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.theory.percent, '40.00');

  const reduced: StudentAssessment = {
    attendance: ATTENDING,
    marks: {
      ...marksFor(S1, { cieTheory: '0', cieLab: '20' }),
      quiz1: '8',
      quiz2: '8',
      test1: '30',
      test2: '29',
    },
  };
  const theory = calculateResult(S1, reduced);
  assert.equal(theory.status, 'not-eligible');
  assert.equal(theory.letter, 'NE');
  assert.deepEqual(theory.reasons, ['CIE_THEORY_BELOW_MINIMUM']);
  assert.equal(theory.cie.theory.marks, '39.60');
  assert.equal(theory.roundingSensitive, true, '39.6% would round to 40%');
  assert.equal(evaluateCie(S1, reduced).eligible, false);

  const lab = calculateResult(S1, student(S1, { cieTheory: '60', cieLab: '19.5' }));
  assert.deepEqual(lab.reasons, ['CIE_LAB_BELOW_MINIMUM']);
  assert.equal(lab.see, null);
  assert.equal(lab.total, null);
});

test('SEE minimums are 35% per part and fail the course without blocking the result', () => {
  const base = { cieTheory: '80', cieLab: '40' };
  const theoryPass = calculateResult(S1, student(S1, { ...base, seeTheory: '35', seeLab: '40' }));
  assert.equal(theoryPass.outcome, 'passed');
  const theoryFail = calculateResult(S1, student(S1, { ...base, seeTheory: '34.5', seeLab: '40' }));
  assert.equal(theoryFail.letter, 'F');
  assert.equal(theoryFail.gradePoints, 0);
  assert.deepEqual(theoryFail.reasons, ['SEE_THEORY_BELOW_MINIMUM']);
  assert.equal(theoryFail.roundingSensitive, true);

  const labPass = calculateResult(S1, student(S1, { ...base, seeTheory: '60', seeLab: '17.5' }));
  assert.equal(labPass.outcome, 'passed');
  const labFail = calculateResult(S1, student(S1, { ...base, seeTheory: '60', seeLab: '17' }));
  assert.deepEqual(labFail.reasons, ['SEE_LAB_BELOW_MINIMUM']);
  assert.equal(labFail.roundingSensitive, false, '34% stays below 35% when rounded');
});

test('grade X needs 85% attendance and 90% CIE when SEE fails', () => {
  const totals = { cieTheory: '95', cieLab: '45', seeTheory: '30', seeLab: '40' };
  const x = calculateResult(S1, student(S1, totals, { eligible: true, percent: '90' }));
  assert.equal(x.status, 'transitional');
  assert.equal(x.letter, 'X');
  assert.equal(x.gradePoints, null);
  assert.deepEqual(x.reasons, ['SEE_THEORY_BELOW_MINIMUM', 'X_GRADE_CRITERIA_MET']);

  const lowAttendance = calculateResult(S1, student(S1, totals, { eligible: true, percent: '84' }));
  assert.equal(lowAttendance.letter, 'F');
  const unknownAttendance = calculateResult(S1, student(S1, totals, { eligible: true }));
  assert.equal(unknownAttendance.letter, 'F');
  const lowCie = calculateResult(
    S1,
    student(S1, { ...totals, cieTheory: '89', cieLab: '45' }, { eligible: true, percent: '90' }),
  );
  assert.equal(lowCie.letter, 'F', '134 / 150 = 89.33% CIE');
});

test('attendance shortfall is NE and SEE marks are refused for an ineligible student', () => {
  const short = { eligible: false, percent: '70' } as const;
  const result = calculateResult(S1, student(S1, { cieTheory: '90', cieLab: '45' }, short));
  assert.equal(result.letter, 'NE');
  assert.deepEqual(result.reasons, ['ATTENDANCE_NOT_SATISFIED']);
  assert.equal(result.roundingSensitive, false);
  rejects('INELIGIBLE_HAS_SEE_MARKS', () =>
    calculateResult(
      S1,
      student(S1, { cieTheory: '90', cieLab: '45', seeTheory: '90', seeLab: '45' }, short),
    ),
  );
  const dx = calculateResult(S3, student(S3, { cieTheory: '90', cieLab: '45' }, short));
  assert.equal(dx.letter, 'DX', 'the AY 2026-27 handbook uses DX');
});

test('SEE absence is reported for administrative handling; CIE absence is refused', () => {
  const input = student(S1, { cieTheory: '80', cieLab: '40', seeTheory: '60', seeLab: '40' });
  const absent = calculateResult(S1, { ...input, marks: { ...input.marks, see_part_b: 'AB' } });
  assert.equal(absent.status, 'see-absent');
  assert.equal(absent.letter, null);
  assert.deepEqual(absent.reasons, ['SEE_ABSENT']);
  rejects('ABSENCE_NOT_ALLOWED', () =>
    calculateResult(S1, { ...input, marks: { ...input.marks, test1: 'AB' } }),
  );
});

test('malformed, missing, unknown and out-of-range entries are rejected', () => {
  const input = student(S1, { cieTheory: '80', cieLab: '40', seeTheory: '60', seeLab: '40' });
  const withMark = (code: string, value: string) => ({
    ...input,
    marks: { ...input.marks, [code]: value },
  });
  for (const value of ['7.125', '-1', '1e1', ' 5', '05', '', '+5', '5.']) {
    rejects('INVALID_MARKS', () => calculateResult(S1, withMark('quiz1', value)));
  }
  rejects('INVALID_MARKS', () => calculateResult(S1, withMark('quiz1', 5 as unknown as string)));
  rejects('MARKS_ABOVE_MAXIMUM', () => calculateResult(S1, withMark('quiz1', '10.5')));
  rejects('UNKNOWN_COMPONENT', () => calculateResult(S1, withMark('quiz3', '5')));
  const missing: Record<string, string> = { ...input.marks };
  delete missing.lab_test;
  rejects('MISSING_COMPONENT', () => calculateResult(S1, { ...input, marks: missing }));
  for (const percent of ['100.5', 'ninety']) {
    rejects('INVALID_ATTENDANCE', () =>
      calculateResult(S1, { ...input, attendance: { eligible: true, percent } }),
    );
  }
});

test('the S1 and S3 rubrics agree on equal part totals and differ only in components', () => {
  const totals = { cieTheory: '78.5', cieLab: '44', seeTheory: '73.5', seeLab: '41' };
  const syllabus = calculateResult(S1, student(S1, totals));
  const handbook = calculateResult(S3, student(S3, totals));
  for (const key of [
    'status',
    'letter',
    'gradePoints',
    'outcome',
    'total',
    'cie',
    'see',
  ] as const) {
    assert.deepEqual(handbook[key], syllabus[key], key);
  }
  const s3 = student(S3, totals);
  rejects('POLICY_UNCONFIRMED', () =>
    calculateResult(S3, { ...s3, marks: { ...s3.marks, test_improvement: '45' } }),
  );
  rejects('UNKNOWN_COMPONENT', () =>
    calculateResult(S1, { ...s3, marks: { ...student(S1, totals).marks, test_improvement: '45' } }),
  );
  rejects('UNKNOWN_COMPONENT', () => calculateResult(S1, s3));
});

test('results are deterministic and independent of input key order', () => {
  const reversed: StudentAssessment = {
    attendance: representative.attendance,
    marks: Object.fromEntries(Object.entries(representative.marks).reverse()),
  };
  const first = JSON.stringify(calculateResult(S1, representative));
  assert.equal(JSON.stringify(calculateResult(S1, representative)), first);
  assert.equal(JSON.stringify(calculateResult(S1, reversed)), first);
});
