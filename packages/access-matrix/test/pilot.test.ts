import assert from 'node:assert/strict';
import test from 'node:test';
import { PILOT_WORLD, decide } from '../src/index.js';
import type { Action, Batch, Outcome, World } from '../src/index.js';

type Expected = [string | null, Action, string, Outcome['status'], Outcome['code']?];

const DEFAULT_CODES = {
  200: 'ALLOWED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

function check(world: World, cases: readonly Expected[]) {
  for (const [principal, action, resource, status, code] of cases) {
    const { outcome } = decide(world, principal, action, resource);
    assert.deepEqual(
      outcome,
      { status, code: code ?? DEFAULT_CODES[status] },
      `${principal ?? 'anonymous'} ${action} ${resource}`,
    );
  }
}

test('faculty and examiners act only on their assigned offering and stage', () => {
  check(PILOT_WORLD, [
    ['F1', 'roster.read', 'ai-a', 200],
    ['F1', 'roster.read', 'ai-b', 404],
    ['F1', 'roster.read', 'is-a', 404],
    ['F1', 'batch.create', 'ai-a:cie', 200],
    ['F1', 'batch.create', 'ai-a:see', 404],
    ['F1', 'batch.create', 'is-a:cie', 404],
    ['F1', 'batch.submit', 'ai-a/cie', 200],
    ['E1', 'batch.create', 'ai-a:see', 200],
    ['E1', 'batch.create', 'ai-a:cie', 404],
    ['E1', 'batch.submit', 'ai-a/see', 200],
    ['E1', 'result.read', 'ST1/ai-a', 403],
    ['F1', 'result.read', 'ST2/ai-b', 404],
    ['F1', 'correction.approve', 'corr-ST1', 403],
  ]);
});

test('department review is scoped, CIE-only and never self-review', () => {
  check(PILOT_WORLD, [
    ['H1', 'batch.review', 'ai-b/cie', 403, 'SELF_REVIEW'],
    ['H2', 'batch.review', 'ai-b/cie', 200],
    ['H1', 'batch.review', 'ai-a/cie', 200],
    ['H1', 'batch.review', 'ai-a/see', 404],
    ['H1', 'batch.review', 'is-a/cie', 404],
    ['H3', 'batch.review', 'is-a/cie', 200],
    ['H1', 'result.read', 'ST1/ai-a', 200],
    ['H1', 'dashboard.read', 'dept-AI', 200],
    ['H1', 'dashboard.read', 'dept-IS', 404],
    ['H1', 'dashboard.read', 'institution', 404],
    ['H1', 'delegation.grant', 'institution', 403],
  ]);
});

test('exam-section staff validate within an active delegation and cannot edit, review or publish', () => {
  check(PILOT_WORLD, [
    ['S1', 'batch.validate', 'ai-a/cie', 200],
    ['S1', 'batch.validate', 'is-a/cie', 404],
    ['S1', 'roster.read', 'ai-a', 200],
    ['S1', 'roster.read', 'is-a', 404],
    ['S1', 'batch.revise', 'ai-a/cie', 403],
    ['S1', 'batch.review', 'ai-a/cie', 403],
    ['S1', 'results.publish', 'ai-a', 403],
    ['S1', 'result.read', 'ST1/ai-a', 403],
    ['S2', 'batch.validate', 'ai-a/cie', 403],
    ['S2', 'batch.validate', 'is-a/cie', 403],
  ]);
});

test('publication and correction approval are separated from earlier participation', () => {
  check(PILOT_WORLD, [
    ['P1', 'results.publish', 'ai-a', 200],
    ['P1', 'results.publish', 'is-a', 200],
    ['P2', 'results.publish', 'is-a', 403, 'SOD_CONFLICT'],
    ['P2', 'results.publish', 'ai-a', 200],
    ['P1', 'delegation.grant', 'institution', 200],
    ['R1', 'correction.approve', 'corr-ST1', 403, 'SELF_APPROVAL'],
    ['R2', 'correction.approve', 'corr-ST1', 200],
    ['P1', 'correction.approve', 'corr-ST1', 200],
  ]);
});

test('students see only their own published results; CIE acknowledgement precedes publication', () => {
  check(PILOT_WORLD, [
    ['ST1', 'result.read', 'ST1/ai-a', 200],
    ['ST1', 'result.read', 'ST2/ai-b', 404],
    ['ST2', 'result.read', 'ST2/ai-b', 404],
    ['ST3', 'result.read', 'ST3/is-a', 404],
    ['ST2', 'cie.acknowledge', 'ST2/ai-b', 200],
    ['ST1', 'cie.acknowledge', 'ST2/ai-b', 404],
    ['ST1', 'proof.issue', 'ST1/ai-a', 200],
    ['ST2', 'proof.issue', 'ST2/ai-b', 404],
    ['ST1', 'batch.create', 'ai-a:cie', 403],
  ]);
});

test('oversight roles read without writing; anonymous callers reach only the verifier', () => {
  check(PILOT_WORLD, [
    ['D1', 'roster.read', 'ai-a', 403],
    ['D1', 'result.read', 'ST1/ai-a', 403],
    ['D1', 'dashboard.read', 'institution', 200],
    ['D1', 'dashboard.read', 'dept-IS', 200],
    ['A1', 'result.read', 'ST1/ai-a', 200],
    ['A1', 'integrity.review', 'institution', 200],
    ['A1', 'batch.review', 'ai-a/cie', 403],
    ['A1', 'correction.approve', 'corr-ST1', 403],
    [null, 'result.read', 'ST1/ai-a', 401],
    [null, 'results.publish', 'ai-a', 401],
    [null, 'proof.verify', 'public', 200],
    ['ST3', 'proof.verify', 'public', 200],
  ]);
});

function withBatch(key: string, batch: Batch): World {
  return { ...PILOT_WORLD, batches: { ...PILOT_WORLD.batches, [key]: batch } };
}

test('each separation rule denies the conflicting participant', () => {
  check(withBatch('ai-b/cie', { ...PILOT_WORLD.batches['ai-b/cie']!, validators: ['H2'] }), [
    ['H2', 'batch.review', 'ai-b/cie', 403, 'SOD_CONFLICT'],
  ]);
  check(withBatch('ai-a/see', { ...PILOT_WORLD.batches['ai-a/see']!, reviewer: 'S1' }), [
    ['S1', 'batch.validate', 'ai-a/see', 403, 'SOD_CONFLICT'],
  ]);
  const authoredByS1 = withBatch('ai-a/see', { ...PILOT_WORLD.batches['ai-a/see']!, author: 'S1' });
  check(authoredByS1, [['S1', 'batch.validate', 'ai-a/see', 403, 'SOD_CONFLICT']]);
  const authoredByP1 = withBatch('ai-a/see', { ...PILOT_WORLD.batches['ai-a/see']!, author: 'P1' });
  check(authoredByP1, [
    ['P1', 'correction.approve', 'corr-ST1', 403, 'SOD_CONFLICT'],
    ['P1', 'results.publish', 'ai-a', 403, 'SOD_CONFLICT'],
  ]);
});

test('delegation validity is half-open: active at validFrom, inactive at validUntil', () => {
  const s1 = PILOT_WORLD.principals.S1!;
  const delegation = s1.delegations![0]!;
  check({ ...PILOT_WORLD, now: delegation.validFrom }, [['S1', 'batch.validate', 'ai-a/cie', 200]]);
  check({ ...PILOT_WORLD, now: delegation.validUntil }, [
    ['S1', 'batch.validate', 'ai-a/cie', 403],
  ]);
  check({ ...PILOT_WORLD, now: '2026-10-31T23:59:59Z' }, [['S1', 'roster.read', 'ai-a', 403]]);
});

test('unknown fixture keys are programming errors, not denials', () => {
  assert.throws(() => decide(PILOT_WORLD, 'F1', 'roster.read', 'cs-a'), /Unknown offering/);
  assert.throws(() => decide(PILOT_WORLD, 'Z9', 'roster.read', 'ai-a'), /Unknown principal/);
  assert.throws(
    () => decide(PILOT_WORLD, 'F1', 'batch.create', 'ai-a:lab'),
    /Unknown offering stage/,
  );
});
