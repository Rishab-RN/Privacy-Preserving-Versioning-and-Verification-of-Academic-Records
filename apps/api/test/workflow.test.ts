import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowFailure } from '../src/workflow.js';
import { ApiFailure } from '../src/errors.js';

test('workflow database failures become stable public results without exception text', () => {
  for (const [code, status] of [
    ['28000', 401],
    ['42501', 403],
    ['P0002', 404],
    ['40001', 409],
    ['23505', 409],
    ['55000', 409],
    ['23514', 400],
  ] as const) {
    assert.throws(
      () => workflowFailure({ code, message: 'private SQL or connection data' }),
      (error: unknown) =>
        error instanceof ApiFailure &&
        error.status === status &&
        !error.message.includes('private'),
    );
  }
  const outage = new Error('private connection details');
  assert.throws(
    () => workflowFailure(outage),
    (error: unknown) => error === outage,
  );
});
