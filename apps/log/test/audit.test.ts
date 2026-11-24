import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalBytes, commitEvent } from '@academic-records/verification';
import type { EventEntry, JsonValue } from '@academic-records/verification';
import { auditJournal } from '../src/audit.js';
import type { AuditMongo } from '../src/audit.js';
import type { JournalSnapshot } from '../src/journal.js';

const logId = '00000000-0000-0000-0000-000000000001';
const eventId = '00000000-0000-0000-0000-000000000002';
const recordId = '00000000-0000-0000-0000-000000000003';
const evidenceId = '00000000-0000-0000-0000-000000000004';
const actorId = '00000000-0000-0000-0000-000000000005';
const digest = (value: unknown) => createHash('sha256').update(canonicalBytes(value)).digest('hex');

function fixture(delivered = true) {
  const raw = JSON.stringify({
    schemaVersion: 1,
    category: 'supporting_note',
    data: { note: 'Synthetic evidence' },
  });
  const evidenceHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const reference = {
    evidenceId,
    institutionId: logId,
    recordId,
    submittedBy: actorId,
    category: 'supporting_note',
    digestSha256: evidenceHash,
    sizeBytes: Buffer.byteLength(raw),
    state: 'available',
  };
  const revision = {
    versionNo: 1,
    previousVersionNo: null,
    gradePoints: '8.00',
    outcome: 'passed',
    validFrom: '2026-11-25T00:00:00.000000Z',
    validUntil: null,
    recordedAt: '2026-11-25T00:01:00.000001Z',
    authorId: actorId,
    reason: 'Approved correction',
  };
  const payload: EventEntry['payload'] = {
    schemaVersion: 1,
    eventId,
    institutionId: logId,
    recordId,
    kind: 'grade.accepted',
    revision,
    evidence: { evidenceId, digestSha256: evidenceHash, sizeBytes: reference.sizeBytes },
  };
  const entry: EventEntry = { logId, index: 0, salt: '01'.repeat(32), payload };
  const snapshot: JournalSnapshot = {
    logId,
    treeSize: 1,
    bootstrapSize: 0,
    entries: [
      { ...entry, eventId, sourceKind: 'workflow', delivered, commitment: commitEvent(entry) },
    ],
    checkpoints: [],
    evidence: [reference],
    coverage: {
      uncoveredGradeVersions: 3,
      description: 'Workflow history only; catalogue metadata excluded.',
    },
  };
  const revisionBase = { recordId, institutionId: logId, eventId, versionNo: 1, revision };
  const revisionHash = digest(revisionBase);
  const documents = new Map<string, Map<string, Record<string, unknown>>>([
    [
      'evidence_documents',
      new Map([
        [
          evidenceId,
          {
            _id: evidenceId,
            schemaVersion: 1,
            institutionId: logId,
            recordId,
            submittedBy: actorId,
            digestSha256: evidenceHash,
            sizeBytes: reference.sizeBytes,
            bodyUtf8: raw,
          },
        ],
      ]),
    ],
    [
      'workflow_events',
      new Map([
        [
          eventId,
          { _id: eventId, digestSha256: digest(payload), payload: structuredClone(payload) },
        ],
      ]),
    ],
    [
      'grade_revisions',
      new Map([
        [
          `${recordId}:1`,
          { _id: `${recordId}:1`, ...structuredClone(revisionBase), digestSha256: revisionHash },
        ],
      ]),
    ],
    [
      'grade_revision_heads',
      new Map([
        [
          recordId,
          {
            _id: recordId,
            institutionId: logId,
            latestRecordedVersion: 1,
            eventId,
            revisionDigestSha256: revisionHash,
          },
        ],
      ]),
    ],
  ]);
  const calls: string[] = [];
  const db = {
    collection: (name: string) => ({
      findOne: async ({ _id }: { _id: string }) => {
        calls.push(name);
        return structuredClone(documents.get(name)?.get(_id) ?? null);
      },
    }),
  } as unknown as AuditMongo;
  return { snapshot, documents, db, calls };
}

test('readonly audit checks actual evidence and all three projections with honest coverage', async () => {
  const source = fixture();
  const result = await auditJournal(source.snapshot, source.db);
  assert.equal(result.integrity, 'valid');
  assert.equal(result.projection, 'complete');
  assert.equal(result.checkedEvidence, 1);
  assert.equal(result.checkedEvents, 1);
  assert.equal(result.coverage.uncoveredGradeVersions, 3);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(source.calls, [
    'evidence_documents',
    'workflow_events',
    'grade_revisions',
    'grade_revision_heads',
  ]);
});

test('changing actual evidence bytes fails even when its saved digest column is unchanged or rehashed', async () => {
  for (const rehash of [false, true]) {
    const source = fixture();
    const evidence = source.documents.get('evidence_documents')!.get(evidenceId)!;
    evidence.bodyUtf8 = (evidence.bodyUtf8 as string).replace('Synthetic', 'Malicious');
    if (rehash)
      evidence.digestSha256 = createHash('sha256')
        .update(evidence.bodyUtf8 as string)
        .digest('hex');
    const result = await auditJournal(source.snapshot, source.db);
    assert.equal(result.integrity, 'invalid');
    assert(result.issues.some(({ code }) => code === 'EVIDENCE_CONTENT_MISMATCH'));
  }
});

test('receipts and revision data are compared with committed facts rather than stored digest claims', async () => {
  for (const collection of ['workflow_events', 'grade_revisions']) {
    const source = fixture();
    const id = collection === 'workflow_events' ? eventId : `${recordId}:1`;
    const document = source.documents.get(collection)!.get(id)!;
    if (collection === 'workflow_events')
      (document.payload as Record<string, unknown>).recordId = actorId;
    else (document.revision as Record<string, unknown>).gradePoints = '10.00';
    const result = await auditJournal(source.snapshot, source.db);
    assert.equal(result.integrity, 'invalid');
    assert(result.issues.some(({ code }) => code.includes('PROJECTION_MISMATCH')));
  }
});

test('partial Mongo delivery before SQL acknowledgement is pending; after acknowledgement it is invalid', async () => {
  for (const delivered of [false, true]) {
    const source = fixture(delivered);
    source.documents.get('grade_revision_heads')!.clear();
    const result = await auditJournal(source.snapshot, source.db);
    assert.equal(result.integrity, delivered ? 'invalid' : 'valid');
    if (!delivered) assert.equal(result.projection, 'pending');
  }
});

test('credential source events are counted without requiring Mongo grade projections', async () => {
  const source = fixture();
  const payload: EventEntry['payload'] = {
    schemaVersion: 1,
    eventId: actorId,
    institutionId: logId,
    kind: 'credential.issued',
    credentialId: evidenceId,
    artifactDigest: 'a'.repeat(64),
  };
  const entry: EventEntry = { logId, index: 1, salt: '03'.repeat(32), payload };
  source.snapshot.entries.push({
    ...entry,
    eventId: actorId,
    sourceKind: 'credential',
    delivered: false,
    commitment: commitEvent(entry),
  });
  source.snapshot.treeSize++;
  const result = await auditJournal(source.snapshot, source.db);
  assert.equal(result.integrity, 'valid');
  assert.equal(result.projection, 'complete');
  assert.equal(result.checkedEvents, 2);
  source.snapshot.entries[1]!.sourceKind = 'workflow';
  const wrongSource = await auditJournal(source.snapshot, source.db);
  assert.equal(wrongSource.integrity, 'invalid');
  assert(wrongSource.issues.some(({ code }) => code === 'EVENT_SOURCE_MISMATCH'));
});

test('a pending correction permits an authentic older head but never a modified older head', async () => {
  const source = fixture();
  const original = source.snapshot.entries[0]!;
  const secondPayload = structuredClone(original.payload);
  secondPayload.eventId = actorId;
  const revision = secondPayload.revision as Record<string, JsonValue>;
  revision.versionNo = 2;
  revision.previousVersionNo = 1;
  const entry: EventEntry = { logId, index: 1, salt: '02'.repeat(32), payload: secondPayload };
  source.snapshot.entries.push({
    ...entry,
    eventId: actorId,
    sourceKind: 'workflow',
    delivered: false,
    commitment: commitEvent(entry),
  });
  source.snapshot.treeSize = 2;
  const pending = await auditJournal(source.snapshot, source.db);
  assert.equal(pending.integrity, 'valid');
  assert.equal(pending.projection, 'pending');
  source.documents.get('grade_revision_heads')!.get(recordId)!.revisionDigestSha256 = '0'.repeat(
    64,
  );
  const altered = await auditJournal(source.snapshot, source.db);
  assert.equal(altered.integrity, 'invalid');
  assert(altered.issues.some(({ code }) => code === 'HEAD_PROJECTION_MISMATCH'));
});

test('missing all not-yet-delivered projections remains pending without hiding missing evidence', async () => {
  const source = fixture(false);
  for (const collection of ['workflow_events', 'grade_revisions', 'grade_revision_heads'])
    source.documents.get(collection)!.clear();
  const result = await auditJournal(source.snapshot, source.db);
  assert.equal(result.integrity, 'valid');
  assert.equal(result.projection, 'pending');
  source.documents.get('evidence_documents')!.clear();
  assert.equal((await auditJournal(source.snapshot, source.db)).integrity, 'invalid');
});

test('unreachable Mongo is unavailable, not a corruption verdict', async () => {
  const source = fixture();
  const unavailable = {
    collection: () => ({
      findOne: async () => {
        throw new Error('Offline');
      },
    }),
  } as unknown as AuditMongo;
  const result = await auditJournal(source.snapshot, unavailable);
  assert.equal(result.integrity, 'unavailable');
  assert.equal(result.projection, 'unavailable');
  assert.deepEqual(result.issues, [{ code: 'MONGO_UNAVAILABLE' }]);
});

test('a newer Mongo head cannot be certified or called corrupt using an older SQL observation', async () => {
  const source = fixture();
  source.documents.get('grade_revision_heads')!.get(recordId)!.latestRecordedVersion = 2;
  const result = await auditJournal(source.snapshot, source.db);
  assert.equal(result.integrity, 'unavailable');
  assert.equal(result.projection, 'unavailable');
  assert(result.issues.some(({ code }) => code === 'HEAD_AHEAD_OF_SQL_SNAPSHOT'));
});

test('mutating event payload after the SQL observation fails its commitment before any Mongo read', async () => {
  const source = fixture();
  source.snapshot.entries[0]!.payload.recordId = actorId;
  const result = await auditJournal(source.snapshot, source.db);
  assert.equal(result.integrity, 'invalid');
  assert.equal(source.calls.length, 0);
  assert.deepEqual(result.issues, [{ code: 'SQL_SNAPSHOT_INTEGRITY_FAILURE' }]);
});
