import assert from 'node:assert/strict';
import test from 'node:test';
import { AssessmentError, RVCE_2022_ITL_S1 as S1, validateStageMarks } from '../src/index.js';
import type { AssessmentErrorCode } from '../src/index.js';
import { marksFor } from './fixtures.js';

const rejects = (code: AssessmentErrorCode, action: () => unknown) =>
  assert.throws(
    action,
    (error: unknown) => error instanceof AssessmentError && error.code === code,
  );

const all = marksFor(S1, { cieTheory: '80', cieLab: '40', seeTheory: '60', seeLab: '40' });
const part = (prefix: 'see_' | 'cie') =>
  Object.fromEntries(
    Object.entries(all).filter(([code]) =>
      prefix === 'see_' ? code.startsWith('see_') : !code.startsWith('see_'),
    ),
  );

test('a complete CIE or SEE entry for one student is accepted', () => {
  validateStageMarks(S1, 'cie', part('cie'));
  validateStageMarks(S1, 'see', part('see_'));
  validateStageMarks(S1, 'see', { ...part('see_'), see_part_b: 'AB' });
});

test('a stage entry rejects other-stage, missing, unknown and invalid values', () => {
  rejects('UNKNOWN_COMPONENT', () => validateStageMarks(S1, 'cie', all));
  rejects('UNKNOWN_COMPONENT', () =>
    validateStageMarks(S1, 'see', { ...part('see_'), quiz1: '5' }),
  );
  const missing: Record<string, string> = part('cie');
  delete missing.lab_test;
  rejects('MISSING_COMPONENT', () => validateStageMarks(S1, 'cie', missing));
  rejects('MARKS_ABOVE_MAXIMUM', () =>
    validateStageMarks(S1, 'cie', { ...part('cie'), quiz1: '11' }),
  );
  rejects('ABSENCE_NOT_ALLOWED', () =>
    validateStageMarks(S1, 'cie', { ...part('cie'), test1: 'AB' }),
  );
  rejects('INVALID_MARKS', () =>
    validateStageMarks(S1, 'see', { ...part('see_'), see_lab_viva: 'x' }),
  );
});
