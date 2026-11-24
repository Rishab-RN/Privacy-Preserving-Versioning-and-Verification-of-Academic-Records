import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  checkpointKeyId,
  merkleRoot,
  signCheckpoint,
  verifyCheckpoint,
  verifyEventProof,
} from '@academic-records/verification';
import type { SignedCheckpoint } from '@academic-records/verification';
import {
  exportEventProof,
  journalCommitments,
  publishCheckpoint,
  readJournal,
} from '../src/journal.js';
import type { JournalSql } from '../src/journal.js';

const logId = '00000000-0000-0000-0000-000000000001';
const eventId = (index: number) =>
  `00000000-0000-0000-0000-${String(index + 10).padStart(12, '0')}`;
const evidenceId = '00000000-0000-0000-0000-000000000002';
const recordId = '00000000-0000-0000-0000-000000000003';
const actorId = '00000000-0000-0000-0000-000000000004';
const keys = generateKeyPairSync('ed25519');

function fixture(size = 2) {
  const rows: Record<string, unknown>[] = Array.from({ length: size }, (_, index) => {
    const payload = {
      schemaVersion: 1,
      eventId: eventId(index),
      institutionId: logId,
      recordId,
      kind: 'request.submitted',
      revision: null,
    };
    return {
      event_id: eventId(index),
      source_kind: 'workflow',
      institution_id: logId,
      leaf_index: String(index),
      salt: Buffer.alloc(32, index + 1),
      payload,
      expected_payload: structuredClone(payload),
      delivered: false,
      delivery_event_id: eventId(index),
      evidence_id: evidenceId,
      record_id: recordId,
      submitted_by: actorId,
      category: 'supporting_note',
      digest_sha256: 'a'.repeat(64),
      size_bytes: 30,
      state: 'available',
    };
  });
  const commands: string[] = [];
  const checkpoints: Record<string, unknown>[] = [];
  let pending: Record<string, unknown> | undefined;
  let headSize = size;
  let missing = 0;
  let missingHead = false;
  let institutionExists = true;
  let invalidExpected = false;
  let inconsistentHeads = false;
  let failWriteCommit = false;
  const query = async (text: string, values?: unknown[]) => {
    commands.push(text);
    if (text.startsWith('BEGIN')) return { rows: [] };
    if (text === 'ROLLBACK') {
      pending = undefined;
      return { rows: [] };
    }
    if (text === 'COMMIT') {
      if (pending && failWriteCommit) throw new Error('simulated durable commit failure');
      if (pending) checkpoints.push(pending);
      pending = undefined;
      return { rows: [] };
    }
    if (text.includes('FROM transparency.record_checkpoint')) {
      pending = {
        tree_size: String(values![1]),
        root_hash: values![2],
        issued_at: values![3],
        key_id: values![4],
        signature: values![5],
      };
      return { rows: [pending] };
    }
    if (text.includes('FROM transparency.log_state'))
      return { rows: missingHead ? [] : [{ tree_size: String(headSize), bootstrap_size: '0' }] };
    if (text.includes('FROM academic.institution'))
      return { rows: institutionExists ? [{ institution_id: logId }] : [] };
    if (text.includes('FROM transparency.event_position p')) {
      if (invalidExpected) throw Object.assign(new Error('Corrupt SQL binding'), { code: '23514' });
      return { rows };
    }
    if (text.includes('AS missing')) return { rows: [{ missing: String(missing) }] };
    if (text.includes('AS inconsistent_heads'))
      return { rows: [{ inconsistent_heads: inconsistentHeads ? '1' : '0' }] };
    if (text.includes('AS uncovered')) return { rows: [{ uncovered: '3' }] };
    if (text.includes('FROM transparency.checkpoint')) return { rows: checkpoints };
    throw new Error('Unexpected fixture SQL');
  };
  const store = (checkpoint: SignedCheckpoint) =>
    checkpoints.push({
      tree_size: String(checkpoint.body.treeSize),
      root_hash: Buffer.from(checkpoint.body.rootHash, 'hex'),
      issued_at: checkpoint.body.issuedAt,
      key_id: checkpoint.body.keyId,
      signature: Buffer.from(checkpoint.signature, 'base64url'),
    });
  return {
    client: { query } as unknown as JournalSql,
    rows,
    commands,
    checkpoints,
    store,
    setSize: (value: number) => {
      headSize = value;
    },
    setMissing: () => {
      missing = 1;
    },
    omitHead: (exists = true) => {
      missingHead = true;
      institutionExists = exists;
    },
    corruptExpected: () => {
      invalidExpected = true;
    },
    corruptHead: () => {
      inconsistentHeads = true;
    },
    failCommit: () => {
      failWriteCommit = true;
    },
  };
}

test('readonly snapshot checks actual SQL facts and releases its transaction', async () => {
  const source = fixture();
  const snapshot = await readJournal(source.client, logId);
  assert.equal(snapshot.treeSize, 2);
  assert.equal(snapshot.evidence.length, 1);
  assert.equal(snapshot.coverage.uncoveredGradeVersions, 3);
  assert.match(source.commands[0]!, /REPEATABLE READ READ ONLY/);
  assert.equal(source.commands.at(-1), 'COMMIT');
  assert.equal(snapshot.entries[0]!.salt, '01'.repeat(32));
});

test('actual payload tampering, missing positions and invalid salt fail closed', async () => {
  for (const mutate of [
    (source: ReturnType<typeof fixture>) => {
      source.rows[0]!.payload = { changed: true };
    },
    (source: ReturnType<typeof fixture>) => {
      source.rows[1]!.leaf_index = '0';
    },
    (source: ReturnType<typeof fixture>) => {
      source.rows[0]!.salt = Buffer.alloc(31);
    },
    (source: ReturnType<typeof fixture>) => {
      source.rows[0]!.delivery_event_id = null;
    },
    (source: ReturnType<typeof fixture>) => {
      source.setMissing();
    },
    (source: ReturnType<typeof fixture>) => {
      source.setSize(3);
    },
  ]) {
    const source = fixture();
    mutate(source);
    await assert.rejects(readJournal(source.client, logId), { code: 'JOURNAL_INTEGRITY' });
    assert.equal(source.commands.at(-1), 'ROLLBACK');
  }
});

test('bounded reader refuses oversized logs without certifying a truncated prefix', async () => {
  const source = fixture();
  source.setSize(100_001);
  await assert.rejects(readJournal(source.client, logId), { code: 'JOURNAL_LIMIT' });
  assert.equal(source.commands.length, 3);
});

test('mixed-source logs preserve the workflow prefix and exclude credential events from grade delivery', async () => {
  const original = await readJournal(fixture(1).client, logId);
  const source = fixture(2);
  const row = source.rows[1]!;
  row.source_kind = 'credential';
  row.payload = {
    schemaVersion: 1,
    eventId: eventId(1),
    institutionId: logId,
    kind: 'credential.issued',
    credentialId: actorId,
    artifactDigest: 'b'.repeat(64),
  };
  row.expected_payload = structuredClone(row.payload);
  for (const field of [
    'delivery_event_id',
    'evidence_id',
    'record_id',
    'submitted_by',
    'category',
    'digest_sha256',
    'size_bytes',
    'state',
  ])
    row[field] = null;
  const snapshot = await readJournal(source.client, logId);
  assert.equal(snapshot.entries[1]!.sourceKind, 'credential');
  assert.equal(snapshot.entries[1]!.delivered, false);
  assert.equal(snapshot.evidence.length, 1);
  assert.deepEqual(journalCommitments(snapshot).slice(0, 1), journalCommitments(original));
  row.delivery_event_id = eventId(1);
  await assert.rejects(readJournal(source.client, logId), { code: 'JOURNAL_INTEGRITY' });
  row.delivery_event_id = null;
  row.source_kind = 'workflow';
  await assert.rejects(readJournal(source.client, logId), { code: 'JOURNAL_INTEGRITY' });
});

test('SQL reconstruction integrity exceptions retain their invalid classification', async () => {
  const source = fixture();
  source.corruptExpected();
  await assert.rejects(readJournal(source.client, logId), { code: 'JOURNAL_INTEGRITY' });
  assert.equal(source.commands.at(-1), 'ROLLBACK');
});

test('a stale or cleared SQL head fails structural consistency without claiming it is committed', async () => {
  const source = fixture();
  source.corruptHead();
  await assert.rejects(readJournal(source.client, logId), /SQL record head does not match/);
  assert.equal(source.commands.at(-1), 'ROLLBACK');
  const healthy = await readJournal(fixture().client, logId);
  assert.match(healthy.coverage.description, /heads are checked structurally/);
  assert.match(
    healthy.coverage.description,
    /SQL temporal projection cache are not cryptographically covered/,
  );
});

test('a known institution without events or log state can publish its empty checkpoint', async () => {
  const source = fixture(0);
  source.omitHead();
  const snapshot = await readJournal(source.client, logId);
  assert.equal(snapshot.treeSize, 0);
  assert.equal(snapshot.bootstrapSize, 0);
  assert.deepEqual(snapshot.entries, []);
  const checkpoint = await publishCheckpoint(source.client, logId, keys.privateKey, keys.publicKey);
  assert.equal(checkpoint.body.treeSize, 0);
  assert.equal(checkpoint.body.rootHash, merkleRoot([]));
  assert(verifyCheckpoint(checkpoint, keys.publicKey));
  assert.equal(source.checkpoints.length, 1);
  const unknown = fixture(0);
  unknown.omitHead(false);
  await assert.rejects(readJournal(unknown.client, logId), { code: 'LOG_NOT_FOUND' });
  assert.equal(unknown.commands.at(-1), 'ROLLBACK');
});

test('publishing closes readonly snapshot before signing and durably commits exact checkpoint', async () => {
  const source = fixture();
  const checkpoint = await publishCheckpoint(source.client, logId, keys.privateKey, keys.publicKey);
  assert(verifyCheckpoint(checkpoint, keys.publicKey));
  assert.equal(source.checkpoints.length, 1);
  const begin = source.commands.indexOf('BEGIN');
  assert.equal(source.commands[begin - 1], 'COMMIT');
  assert.equal(source.commands.at(-1), 'COMMIT');
  await assert.rejects(publishCheckpoint(source.client, logId, keys.privateKey, keys.publicKey), {
    code: 'RETAINED_CHECKPOINT_REQUIRED',
  });
  const retried = await publishCheckpoint(
    source.client,
    logId,
    keys.privateKey,
    keys.publicKey,
    checkpoint,
  );
  assert.deepEqual(retried, checkpoint);
  assert.equal(source.checkpoints.length, 1);
});

test('retained external prefix detects rewritten or rolled-back databases before publication', async () => {
  const source = fixture();
  const original = await publishCheckpoint(source.client, logId, keys.privateKey, keys.publicKey);
  source.checkpoints.length = 0;
  source.rows[0]!.salt = Buffer.alloc(32, 99);
  await assert.rejects(
    publishCheckpoint(source.client, logId, keys.privateKey, keys.publicKey, original),
    { code: 'CHECKPOINT_CONFLICT' },
  );
  const rolledBack = fixture(1);
  await assert.rejects(
    publishCheckpoint(rolledBack.client, logId, keys.privateKey, keys.publicKey, original),
    { code: 'CHECKPOINT_CONFLICT' },
  );
  assert(!rolledBack.commands.includes('BEGIN'));
});

test('commit failure never returns or reports an unpersisted checkpoint', async () => {
  const source = fixture();
  source.failCommit();
  await assert.rejects(
    publishCheckpoint(source.client, logId, keys.privateKey, keys.publicKey),
    /commit failure/,
  );
  assert.equal(source.checkpoints.length, 0);
  assert.equal(source.commands.at(-1), 'ROLLBACK');
});

test('private export proves an older signed prefix even after newer events append', async () => {
  const source = fixture(3);
  const snapshot = await readJournal(source.client, logId);
  const checkpoint = signCheckpoint(
    {
      profile: 'academic-records-log-v1',
      logId,
      treeSize: 2,
      bootstrapSize: 0,
      rootHash: merkleRoot(journalCommitments(snapshot).slice(0, 2)),
      keyId: checkpointKeyId(keys.publicKey),
      issuedAt: '2026-11-25T00:00:00.000Z',
    },
    keys.privateKey,
  );
  const bundle = exportEventProof(snapshot, checkpoint, eventId(1));
  assert.deepEqual(verifyEventProof(bundle, keys.publicKey, { logId, eventId: eventId(1) }), {
    valid: true,
    code: 'valid',
  });
  assert(!Object.hasOwn(bundle.entry, 'delivered'));
  assert(!Object.hasOwn(bundle.entry, 'commitment'));
  assert.throws(() => exportEventProof(snapshot, checkpoint, eventId(2)), {
    code: 'EVENT_NOT_COMMITTED',
  });
});
