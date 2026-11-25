import assert from 'node:assert/strict';
import test from 'node:test';
import { field, fixedPoints, SCALAR_FIELD, publicInputs } from '../src/index.js';
test('grade encoding uses exact hundredths and rejects rounding, negatives and field aliases', () => {
  assert.equal(fixedPoints('8.50'), '850');
  assert.equal(fixedPoints('0.1'), '10');
  for (const value of ['8.501', '1e1', '-1', '100', '01', 'Infinity'])
    assert.throws(() => fixedPoints(value));
  for (const value of [SCALAR_FIELD.toString(), '-1', '01', '1.0'])
    assert.throws(() => field(value));
});
test('public statement has a fixed order and bounded threshold policy', () => {
  const statement = {
    commitment: '1',
    context: '2',
    holder: '3',
    maximum: '1000',
    threshold: '800',
    challenge: '4',
  };
  assert.deepEqual(publicInputs(statement), ['1', '2', '3', '1000', '800', '4']);
  for (const override of [{ maximum: '10000' }, { maximum: '0' }, { threshold: '1001' }])
    assert.throws(() => publicInputs({ ...statement, ...override }));
});
