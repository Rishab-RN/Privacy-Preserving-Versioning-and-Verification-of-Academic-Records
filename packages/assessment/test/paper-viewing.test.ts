import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssessmentError,
  RVCE_2022_ITL_S1 as S1,
  calculateResult,
  resolvePaperViewing,
} from '../src/index.js';
import type { AssessmentErrorCode } from '../src/index.js';
import { ATTENDING, marksFor } from './fixtures.js';

const rejects = (code: AssessmentErrorCode, action: () => unknown) =>
  assert.throws(
    action,
    (error: unknown) => error instanceof AssessmentError && error.code === code,
  );

// SEE theory 34.5 fails the 35% minimum: part A 20, part B 14.5.
const original = marksFor(S1, { cieTheory: '80', cieLab: '40', seeTheory: '34.5', seeLab: '40' });

test('a higher SEE theory revaluation is kept and can change the result', () => {
  assert.equal(calculateResult(S1, { attendance: ATTENDING, marks: original }).letter, 'F');
  const resolution = resolvePaperViewing(S1, original, { see_part_b: '18' });
  assert.deepEqual(resolution.increased, ['see_part_b']);
  assert.deepEqual(resolution.ignoredDecreases, []);
  assert.equal(resolution.changed, true);
  assert.equal(resolution.marks.see_part_b, '18');
  assert.equal(original.see_part_b, '14.50', 'the original marks are not mutated');
  const revised = calculateResult(S1, { attendance: ATTENDING, marks: resolution.marks });
  assert.equal(revised.outcome, 'passed');
  assert.equal(revised.letter, 'B+', '80 + 40 + 38 + 40 = 198 / 300 = 66%');
});

test('lower revaluations never reduce marks (better of, no negative evaluation)', () => {
  const resolution = resolvePaperViewing(S1, original, { see_part_a: '12', see_part_b: '14.5' });
  assert.equal(resolution.marks.see_part_a, original.see_part_a);
  assert.deepEqual(resolution.ignoredDecreases, ['see_part_a']);
  assert.deepEqual(resolution.increased, []);
  assert.equal(resolution.changed, false);
});

test('lab SEE and all CIE components are excluded from paper viewing', () => {
  rejects('PVP_LAB_EXCLUDED', () => resolvePaperViewing(S1, original, { see_lab_viva: '20' }));
  rejects('PVP_SEE_ONLY', () => resolvePaperViewing(S1, original, { quiz1: '10' }));
  rejects('UNKNOWN_COMPONENT', () => resolvePaperViewing(S1, original, { see_part_c: '10' }));
});

test('revaluations must be valid marks for an evaluated script', () => {
  rejects('MARKS_ABOVE_MAXIMUM', () => resolvePaperViewing(S1, original, { see_part_a: '21' }));
  rejects('INVALID_MARKS', () => resolvePaperViewing(S1, original, { see_part_a: 'AB' }));
  rejects('PVP_NOT_APPLICABLE', () =>
    resolvePaperViewing(S1, { ...original, see_part_b: 'AB' }, { see_part_b: '30' }),
  );
});
