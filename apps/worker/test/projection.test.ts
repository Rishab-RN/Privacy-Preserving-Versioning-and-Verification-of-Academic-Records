import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from 'mongodb';
import {
  digestPayload,
  InvalidEventError,
  parseProjectionEvent,
  projectEvent,
  stableJson,
} from '../src/projection.js';

function event() {
  return {
    schemaVersion: 1,
    eventId: '11111111-2222-ffff-0123-abcdef123456',
    kind: 'grade.accepted',
    institutionId: '22222222-2222-ffff-0123-abcdef123456',
    recordId: '33333333-2222-ffff-0123-abcdef123456',
    requestId: '44444444-2222-ffff-0123-abcdef123456',
    actorId: '55555555-2222-ffff-0123-abcdef123456',
    occurredAt: '2026-11-23T00:00:00.123456Z',
    proposerId: '66666666-2222-ffff-0123-abcdef123456',
    evidence: {
      evidenceId: '77777777-2222-ffff-0123-abcdef123456',
      digestSha256: 'a'.repeat(64),
      sizeBytes: 100,
    },
    revision: {
      versionNo: 1,
      previousVersionNo: null,
      gradePoints: '8.00',
      outcome: 'passed',
      validFrom: '2026-01-01T00:00:00.000001Z',
      validUntil: '2026-01-01T00:00:00.000002Z',
      recordedAt: '2026-11-23T00:00:00.123455Z',
      authorId: '55555555-2222-ffff-0123-abcdef123456',
      reason: 'Synthetic test approval',
    },
  };
}

test('projection fingerprint sorts objects recursively while preserving array order and JSON encoding', () => {
  const first = { b: { z: '界\n"', a: -0 }, a: [1, 2, null] };
  const second = { a: [1, 2, null], b: { a: 0, z: '界\n"' } };
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(digestPayload(first), digestPayload(second));
  assert.notEqual(digestPayload(first), digestPayload({ ...second, a: [2, 1, null] }));
  assert.match(digestPayload(first), /^[a-f0-9]{64}$/);
});

test('SQL reason bounds count Unicode codepoints rather than UTF16 code units', () => {
  const input = event();
  input.revision.reason = '😀'.repeat(500);
  assert.equal(parseProjectionEvent(input).revision?.reason, input.revision.reason);
  input.revision.reason += '😀';
  assert.throws(() => parseProjectionEvent(input), InvalidEventError);
});

test('non-JSON, cyclic, excessively nested and oversized payloads fail instead of fingerprinting ambiguously', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let nested: unknown = null;
  for (let depth = 0; depth < 34; depth++) nested = [nested];
  for (const value of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    { value: undefined },
    cyclic,
    nested,
    '界'.repeat(30000),
  ]) {
    assert.throws(() => stableJson(value), InvalidEventError);
  }
});

test('event validation accepts opaque PostgreSQL UUIDs and valid microsecond-width ranges', () => {
  const parsed = parseProjectionEvent(event());
  assert.equal(parsed.eventId, event().eventId);
  assert.equal(parsed.revision?.validUntil, '2026-01-01T00:00:00.000002Z');
  const submitted = parseProjectionEvent({
    ...event(),
    kind: 'request.submitted',
    revision: null,
    proposal: { reason: 'Retained extra event metadata' },
  });
  assert.deepEqual(submitted.proposal, { reason: 'Retained extra event metadata' });
});

test('event profile rejects mismatched kinds, chain gaps, invalid outcomes and empty intervals', () => {
  const original = event();
  for (const invalid of [
    { ...original, schemaVersion: 2 },
    { ...original, kind: 'request.rejected' },
    { ...original, revision: null },
    { ...original, revision: { ...original.revision, versionNo: 3, previousVersionNo: 1 } },
    { ...original, revision: { ...original.revision, outcome: 'incomplete' } },
    { ...original, revision: { ...original.revision, validUntil: original.revision.validFrom } },
    { ...original, occurredAt: '2026-11-23T00:00:00.1234567Z' },
    { ...original, revision: { ...original.revision, gradePoints: '11.00' } },
  ])
    assert.throws(() => parseProjectionEvent(invalid), InvalidEventError);
});

test('invalid events are rejected before any Mongo operation', async () => {
  let touched = false;
  const db = {
    collection: () => {
      touched = true;
      throw new Error('Must not access storage');
    },
  } as unknown as Db;
  await assert.rejects(projectEvent(db, { schemaVersion: 99 }), InvalidEventError);
  assert.equal(touched, false);
});
