import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkpointKeyId, signCheckpoint } from '@academic-records/verification';
import { logConfig } from '../src/config.js';
import {
  ensureSigningKeys,
  readObservation,
  withObservationLock,
  writeObservation,
} from '../src/local-state.js';

test('local signing setup preserves existing key bytes and refuses mismatched pairs', () => {
  const base = resolve(tmpdir()),
    directory = mkdtempSync(join(base, 'academic-log-'));
  try {
    const first = ensureSigningKeys(directory),
      privateBytes = readFileSync(first.privatePath),
      publicBytes = readFileSync(first.publicPath);
    ensureSigningKeys(directory);
    assert.deepEqual(readFileSync(first.privatePath), privateBytes);
    assert.deepEqual(readFileSync(first.publicPath), publicBytes);
    const other = generateKeyPairSync('ed25519');
    writeFileSync(first.publicPath, other.publicKey.export({ type: 'spki', format: 'pem' }));
    assert.throws(() => ensureSigningKeys(directory), /differs/);
    assert.deepEqual(readFileSync(first.privatePath), privateBytes);
  } finally {
    assert.equal(dirname(directory), base);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retained observations reject rollback, conflict and concurrent publishers', async () => {
  const base = resolve(tmpdir()),
    directory = mkdtempSync(join(base, 'academic-log-'));
  try {
    const keys = ensureSigningKeys(directory),
      path = join(directory, 'observation.json');
    const body = {
      profile: 'academic-records-log-v1' as const,
      logId: '10000000-0000-0000-0000-000000000000',
      treeSize: 2,
      bootstrapSize: 0,
      rootHash: 'a'.repeat(64),
      issuedAt: '2026-11-25T00:00:00.000Z',
      keyId: checkpointKeyId(keys.publicKey),
    };
    const accepted = signCheckpoint(body, keys.privateKey);
    writeObservation(path, accepted, keys.publicKey);
    assert.deepEqual(readObservation(path), accepted);
    assert.throws(
      () =>
        writeObservation(
          path,
          signCheckpoint({ ...body, treeSize: 1 }, keys.privateKey),
          keys.publicKey,
        ),
      /regression/,
    );
    assert.throws(
      () =>
        writeObservation(
          path,
          signCheckpoint({ ...body, rootHash: 'b'.repeat(64) }, keys.privateKey),
          keys.publicKey,
        ),
      /conflict/,
    );
    assert.throws(
      () =>
        writeObservation(
          path,
          signCheckpoint({ ...body, bootstrapSize: 1 }, keys.privateKey),
          keys.publicKey,
        ),
      /regression or conflict/,
    );
    assert.throws(
      () =>
        writeObservation(
          path,
          signCheckpoint({ ...body, issuedAt: '2026-11-24T00:00:00.000Z' }, keys.privateKey),
          keys.publicKey,
        ),
      /regression or conflict/,
    );
    await withObservationLock(path, async () => {
      await assert.rejects(
        withObservationLock(path, async () => undefined),
        (error) => (error as NodeJS.ErrnoException).code === 'EEXIST',
      );
    });
    await withObservationLock(path, async () => assert.deepEqual(readObservation(path), accepted));
  } finally {
    assert.equal(dirname(directory), base);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operator configuration requires separate non-administrative service identities', () => {
  const env = {
    POSTGRES_DB: 'project_test',
    LOG_POSTGRES_USER: 'academic_log_local',
    LOG_POSTGRES_PASSWORD: 'secret',
    LOG_MONGO_USER: 'academic_log_local',
    LOG_MONGO_PASSWORD: 'other',
    LOG_MONGO_DB: 'project_evidence',
  };
  assert.equal(logConfig(env).user, 'academic_log_local');
  assert.throws(() => logConfig({ ...env, LOG_POSTGRES_USER: 'postgres' }));
  assert.throws(() => logConfig({ ...env, POSTGRES_DB: 'postgres' }));
  assert.throws(() => logConfig({ ...env, LOG_MONGO_DB: 'admin' }));
  assert.throws(() => logConfig({ ...env, POSTGRES_PORT: '55432suffix' }));
});
