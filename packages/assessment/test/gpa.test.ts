import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssessmentError,
  GPA_POLICY_IDS,
  RVCE_2022_GPA_S2 as S2,
  RVCE_ACY2026_GPA_S3 as S3,
  assertGpaPolicy,
  getGpaPolicy,
  summarizeTranscript,
} from '../src/index.js';
import type { AssessmentErrorCode, GpaCourse, GpaPolicy } from '../src/index.js';

const rejects = (code: AssessmentErrorCode, action: () => unknown) =>
  assert.throws(
    action,
    (error: unknown) => error instanceof AssessmentError && error.code === code,
  );

const ODD = '2026-27-ODD';
const EVEN = '2026-27-EVEN';
const SUPP = '2027-SUPP';

// AIML 2022 scheme, Semester V: 20 credits (S1 p.7). Synthetic grades.
const semesterV = (overrides: Record<string, string> = {}): GpaCourse[] =>
  (
    [
      ['HS251TA', '3', 'A'],
      ['CD252IA', '4', 'A+'],
      ['AI253IA', '4', 'B+'],
      ['AI254TA', '4', 'O'],
      ['AI255TBA', '3', 'B'],
      ['AI256TCA', '2', 'C'],
    ] as const
  ).map(([course, credits, letter]) => ({
    course,
    term: ODD,
    credits,
    letter: overrides[course] ?? letter,
  }));

// Semester VI: 24 credits (S1 p.9).
const semesterVI: GpaCourse[] = (
  [
    ['HS361TA', '3', 'B+'],
    ['AI362IA', '4', 'A'],
    ['AI363IA', '4', 'A+'],
    ['AI364TA', '4', 'A'],
    ['AI365TDA', '3', 'B'],
    ['XX366TEA', '3', 'O'],
    ['AI367P', '3', 'A+'],
  ] as const
).map(([course, credits, letter]) => ({ course, term: EVEN, credits, letter }));

const one = (policy: GpaPolicy, courses: GpaCourse[]) =>
  summarizeTranscript(policy, [ODD], courses);
const pair = (a: [string, string], b: [string, string]): GpaCourse[] => [
  { course: 'C1', term: ODD, credits: a[0], letter: a[1] },
  { course: 'C2', term: ODD, credits: b[0], letter: b[1] },
];

test('registry exposes the validated GPA policies', () => {
  assert.deepEqual(GPA_POLICY_IDS, ['rvce-2022-gpa-s2', 'rvce-acy2026-gpa-s3']);
  assert.equal(getGpaPolicy('rvce-2022-gpa-s2'), S2);
  rejects('UNKNOWN_POLICY', () => getGpaPolicy('rvce-2018-gpa'));
});

test('SGPA weights grade points by credits (156 / 20 = 7.80)', () => {
  // 3x8 + 4x9 + 4x7 + 4x10 + 3x6 + 2x5 = 156
  const summary = one(S2, semesterV());
  assert.deepEqual(summary.terms[0]?.sgpa, { value: '7.80', exact: '39/5', credits: '20.00' });
  assert.deepEqual(summary.cgpa, { value: '7.80', exact: '39/5', credits: '20.00' });
  assert.equal(summary.percentEquivalent, '78.00');
  assert.deepEqual(summary.standing, {
    meetsDegreeMinimum: true,
    classIfAllPassed: 'First Class with Distinction',
    roundingSensitive: false,
  });
});

test('an F counts in SGPA but not CGPA, and a later pass replaces it (golden)', () => {
  const courses = [
    ...semesterV({ AI253IA: 'F' }),
    { course: 'AI253IA', term: SUPP, credits: '4', letter: 'B' },
  ];
  assert.deepEqual(summarizeTranscript(S2, [ODD, SUPP], courses), {
    policy: { id: 'rvce-2022-gpa-s2', version: 1, status: 'pending-institutional-confirmation' },
    terms: [
      {
        term: ODD,
        sgpa: { value: '6.40', exact: '32/5', credits: '20.00' },
        cgpa: { value: '8.00', exact: '8', credits: '16.00' },
        creditsRegistered: '20.00',
        creditsEarned: '16.00',
        excluded: [],
      },
      {
        term: SUPP,
        sgpa: { value: '6.00', exact: '6', credits: '4.00' },
        cgpa: { value: '7.60', exact: '38/5', credits: '20.00' },
        creditsRegistered: '4.00',
        creditsEarned: '4.00',
        excluded: [],
      },
    ],
    cgpa: { value: '7.60', exact: '38/5', credits: '20.00' },
    creditsEarned: '20.00',
    percentEquivalent: '76.00',
    standing: {
      meetsDegreeMinimum: true,
      classIfAllPassed: 'First Class with Distinction',
      roundingSensitive: false,
    },
    outstanding: [],
  });
  const afterFirst = summarizeTranscript(S2, [ODD], semesterV({ AI253IA: 'F' }));
  assert.deepEqual(afterFirst.outstanding, [{ course: 'AI253IA', letter: 'F', term: ODD }]);
});

test('transitional and not-eligible grades drop out of both averages', () => {
  const x = one(S2, semesterV({ AI253IA: 'X' })).terms[0];
  assert.equal(x?.sgpa.value, '8.00', '128 / 16');
  assert.equal(x?.creditsRegistered, '20.00');
  assert.equal(x?.creditsEarned, '16.00');
  assert.deepEqual(x?.excluded, [{ course: 'AI253IA', letter: 'X', reason: 'transitional' }]);

  const ne = one(S2, semesterV({ AI253IA: 'NE' }));
  assert.deepEqual(ne.terms[0]?.excluded, [
    { course: 'AI253IA', letter: 'NE', reason: 'not-eligible' },
  ]);
  assert.deepEqual(ne.outstanding, [{ course: 'AI253IA', letter: 'NE', term: ODD }]);
  rejects('UNKNOWN_GRADE', () => one(S2, semesterV({ AI253IA: 'DX' })));
  assert.equal(one(S3, semesterV({ AI253IA: 'DX' })).terms[0]?.sgpa.value, '8.00');
});

test('CGPA accumulates across semesters (352 / 44 = 8.00)', () => {
  const summary = summarizeTranscript(S2, [ODD, EVEN], [...semesterV(), ...semesterVI]);
  // Semester VI: 21 + 32 + 36 + 32 + 18 + 30 + 27 = 196 / 24
  assert.deepEqual(summary.terms[1]?.sgpa, { value: '8.17', exact: '49/6', credits: '24.00' });
  assert.deepEqual(summary.terms[1]?.cgpa, { value: '8.00', exact: '8', credits: '44.00' });
  assert.equal(summary.creditsEarned, '44.00');
});

test('MP and Ab are refused until RVCE confirms how they count', () => {
  rejects('POLICY_UNCONFIRMED', () => one(S2, semesterV({ AI253IA: 'MP' })));
  rejects('POLICY_UNCONFIRMED', () => one(S3, semesterV({ AI253IA: 'Ab' })));
  rejects('UNKNOWN_GRADE', () => one(S2, semesterV({ AI253IA: 'Z' })));
});

test('non-credit mandatory courses never count but must still be passed', () => {
  const mandatory = (letter: string): GpaCourse => ({
    course: 'HS-MANDATORY',
    term: ODD,
    credits: '0',
    letter,
    kind: 'non-credit',
  });
  const passed = one(S2, [...semesterV(), mandatory('P')]);
  assert.equal(passed.cgpa.value, '7.80');
  assert.deepEqual(passed.terms[0]?.excluded, [
    { course: 'HS-MANDATORY', letter: 'P', reason: 'non-credit' },
  ]);
  assert.deepEqual(passed.outstanding, []);
  const failed = one(S2, [...semesterV(), mandatory('F')]);
  assert.equal(failed.cgpa.value, '7.80');
  assert.deepEqual(failed.outstanding, [{ course: 'HS-MANDATORY', letter: 'F', term: ODD }]);
  rejects('INVALID_CREDITS', () => one(S2, [{ ...mandatory('P'), credits: '2' }]));
});

test('credits, terms and attempts are validated', () => {
  const course = (credits: string): GpaCourse => ({
    course: 'C1',
    term: ODD,
    credits,
    letter: 'A',
  });
  for (const credits of ['0', '30.5', '4.125', '-1', '']) {
    rejects('INVALID_CREDITS', () => one(S2, [course(credits)]));
  }
  rejects('UNKNOWN_TERM', () => summarizeTranscript(S2, [EVEN], [course('4')]));
  rejects('INVALID_TERMS', () => summarizeTranscript(S2, [ODD, ODD], [course('4')]));
  rejects('DUPLICATE_ATTEMPT', () => one(S2, [course('4'), course('3')]));
  rejects('DUPLICATE_PASS', () =>
    summarizeTranscript(S2, [ODD, EVEN], [course('4'), { ...course('4'), term: EVEN }]),
  );
});

test('class and degree thresholds use the exact CGPA and flag rounding-sensitive cases', () => {
  const distinction = one(S2, pair(['4', 'A'], ['4', 'B']));
  assert.equal(distinction.cgpa.exact, '7');
  assert.equal(distinction.standing.classIfAllPassed, 'First Class with Distinction');

  const first = one(S2, pair(['3', 'A'], ['4', 'B']));
  assert.equal(first.cgpa.value, '6.86');
  assert.deepEqual(first.standing, {
    meetsDegreeMinimum: true,
    classIfAllPassed: 'First Class',
    roundingSensitive: false,
  });

  const nearSeven = one(S2, pair(['1.99', 'B+'], ['0.01', 'B']));
  assert.equal(nearSeven.cgpa.exact, '1399/200', '6.995');
  assert.equal(nearSeven.cgpa.value, '7.00', 'display rounds up');
  assert.equal(nearSeven.standing.classIfAllPassed, 'First Class');
  assert.equal(nearSeven.standing.roundingSensitive, true);

  const nearFive = one(S2, pair(['1.99', 'C'], ['0.01', 'P']));
  assert.equal(nearFive.cgpa.exact, '999/200', '4.995');
  assert.equal(nearFive.standing.meetsDegreeMinimum, false);
  assert.equal(nearFive.standing.classIfAllPassed, null);
  assert.equal(nearFive.standing.roundingSensitive, true);
});

test('the AY 2026-27 rules add a Pass Class from CGPA 4', () => {
  const courses = pair(['4', 'C'], ['4', 'P']);
  assert.deepEqual(one(S3, courses).standing, {
    meetsDegreeMinimum: true,
    classIfAllPassed: 'Pass Class',
    roundingSensitive: false,
  });
  assert.deepEqual(one(S2, courses).standing, {
    meetsDegreeMinimum: false,
    classIfAllPassed: null,
    roundingSensitive: false,
  });
});

test('the percentage equivalent multiplies the two-decimal CGPA by 10', () => {
  const summary = one(S2, pair(['3', 'O'], ['4', 'B']));
  assert.equal(summary.cgpa.exact, '54/7');
  assert.equal(summary.cgpa.value, '7.71');
  assert.equal(summary.percentEquivalent, '77.10');
});

test('a term with nothing countable reports null averages', () => {
  const summary = one(S2, [{ course: 'C1', term: ODD, credits: '4', letter: 'I' }]);
  assert.deepEqual(summary.cgpa, { value: null, exact: null, credits: '0.00' });
  assert.equal(summary.percentEquivalent, null);
  assert.deepEqual(summary.standing, {
    meetsDegreeMinimum: null,
    classIfAllPassed: null,
    roundingSensitive: false,
  });
});

test('summaries are deterministic and independent of course order', () => {
  const courses = [...semesterV({ AI253IA: 'F' }), ...semesterVI];
  const first = JSON.stringify(summarizeTranscript(S2, [ODD, EVEN], courses));
  assert.equal(JSON.stringify(summarizeTranscript(S2, [ODD, EVEN], [...courses].reverse())), first);
});

test('malformed GPA policies are rejected', () => {
  const invalid = (policy: GpaPolicy) =>
    assert.throws(
      () => assertGpaPolicy(policy),
      (error: unknown) => error instanceof AssessmentError && error.code === 'POLICY_INVALID',
    );
  assert.equal(assertGpaPolicy(S3), S3);
  invalid({ ...S2, transitional: ['I', 'W', 'NE'] });
  invalid({ ...S2, classes: [...S2.classes].reverse() });
  invalid({ ...S2, degreeMinimumCgpa: '4.00' });
  invalid({ ...S2, failLetter: 'P' });
  invalid({ ...S2, gradePoints: [...S2.gradePoints].reverse() });
  invalid({ ...S2, citations: { ...S2.citations, sgpa: [{ source: 'S9', locator: 'p.1' }] } });
  invalid({ ...S2, unconfirmed: [{ letter: 'MP', question: ' ' }] });
});
