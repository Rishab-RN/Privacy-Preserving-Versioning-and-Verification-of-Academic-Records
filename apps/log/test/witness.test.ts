import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkpointKeyId,
  consistencyProof,
  merkleRoot,
  signCheckpoint,
} from '@academic-records/verification';
import { observationPath, readObservation, withObservationLock } from '../src/local-state.js';
import { observeCheckpoint } from '../src/witness.js';

const logId = '11111111-1111-1111-1111-111111111111';
const leaves = ['initial event', 'approved correction', 'later event'].map((value) =>
  createHash('sha256').update(value).digest('hex'),
);

test('public-key witness accepts an extension and preserves its checkpoint across faults', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'records-witness-'));
  const path = observationPath(directory, logId);
  t.after(() => {
    rmSync(path, { force: true });
    rmdirSync(directory);
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  function sign(history: string[], issuedAt: string) {
    return signCheckpoint(
      {
        profile: 'academic-records-log-v1',
        logId,
        treeSize: history.length,
        bootstrapSize: 0,
        rootHash: merkleRoot(history),
        issuedAt,
        keyId: checkpointKeyId(publicKey),
      },
      privateKey,
    );
  }
  const before = sign(leaves.slice(0, 1), '2026-01-01T00:00:00.000Z');
  const after = sign(leaves.slice(0, 2), '2026-01-02T00:00:00.000Z');
  const accept = (checkpoint: typeof before, proof: string[] = [], retain = true) =>
    observeCheckpoint(path, logId, publicKey, { checkpoint, consistencyProof: proof }, retain);

  assert.deepEqual(await accept(before), { code: 'initial', treeSize: 1 });
  assert.deepEqual(await accept(after, consistencyProof(leaves.slice(0, 2), 1), false), {
    code: 'valid',
    treeSize: 2,
  });
  assert.deepEqual(readObservation(path), before);
  assert.equal((await accept(after)).code, 'invalid');
  assert.deepEqual(await accept(after, consistencyProof(leaves.slice(0, 2), 1)), {
    code: 'valid',
    treeSize: 2,
  });
  assert.equal((await accept(after)).code, 'unchanged');
  const retained = readFileSync(path);
  assert.equal((await accept(before)).code, 'rollback');
  const split = sign([leaves[2]!, leaves[1]!], '2026-01-03T00:00:00.000Z');
  assert.equal((await accept(split)).code, 'conflict');
  assert.equal((await accept({ ...after, signature: 'A'.repeat(86) })).code, 'invalid');
  const foreignKey = generateKeyPairSync('ed25519').publicKey;
  assert.equal(
    (
      await observeCheckpoint(
        path,
        logId,
        foreignKey,
        {
          checkpoint: after,
          consistencyProof: [],
        },
        true,
      )
    ).code,
    'invalid',
  );
  await withObservationLock(path, async () => {
    await assert.rejects(accept(after), { code: 'EEXIST' });
  });
  assert.deepEqual(readFileSync(path), retained);
});
