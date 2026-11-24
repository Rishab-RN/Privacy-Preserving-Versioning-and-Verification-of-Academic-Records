import { createHash } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import { canonicalBytes } from '@academic-records/verification';
import { journalCommitments } from './journal.js';
import type { JournalEntry, JournalSnapshot } from './journal.js';

export type AuditMongo = Pick<Db, 'collection'>;
export interface AuditIssue {
  code: string;
  eventId?: string;
  recordId?: string;
  evidenceId?: string;
}
export interface AuditReport {
  integrity: 'valid' | 'invalid' | 'unavailable';
  projection: 'complete' | 'pending' | 'unavailable';
  checkedEvents: number;
  checkedEvidence: number;
  coverage: JournalSnapshot['coverage'];
  issues: AuditIssue[];
}

class MongoUnavailable extends Error {}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function equal(left: unknown, right: unknown): boolean {
  try {
    return canonicalBytes(left).equals(canonicalBytes(right));
  } catch {
    return false;
  }
}

// Reproduce the existing projection-json-v1 replay fingerprint independently.
// It remains distinct from the salted academic-records-event-v1 commitment.
function projectionDigest(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    const fields = object(item);
    return fields
      ? Object.fromEntries(
          Object.keys(fields)
            .sort()
            .map((key) => [key, ordered(fields[key])]),
        )
      : item;
  };
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)), 'utf8')
    .digest('hex');
}

/** Read-only verification against the SQL observation represented by snapshot. */
export async function auditJournal(
  snapshot: JournalSnapshot,
  db: AuditMongo,
): Promise<AuditReport> {
  const report: AuditReport = {
    integrity: 'valid',
    projection: 'complete',
    checkedEvents: 0,
    checkedEvidence: 0,
    coverage: snapshot.coverage,
    issues: [],
  };
  const fail = (code: string, identity: Omit<AuditIssue, 'code'> = {}) => {
    report.integrity = 'invalid';
    report.issues.push({ code, ...identity });
  };
  const pending = (code: string, identity: Omit<AuditIssue, 'code'> = {}) => {
    if (report.projection !== 'unavailable') report.projection = 'pending';
    report.issues.push({ code, ...identity });
  };
  const find = async (collection: string, id: string) => {
    try {
      return await db.collection<Document & { _id: string }>(collection).findOne({ _id: id });
    } catch {
      throw new MongoUnavailable();
    }
  };
  try {
    journalCommitments(snapshot);
    for (const reference of snapshot.evidence) {
      const document = await find('evidence_documents', reference.evidenceId);
      report.checkedEvidence++;
      if (!document) {
        fail('EVIDENCE_MISSING', { evidenceId: reference.evidenceId });
        continue;
      }
      const raw = document.bodyUtf8;
      const expected = {
        _id: reference.evidenceId,
        schemaVersion: 1,
        institutionId: reference.institutionId,
        recordId: reference.recordId,
        submittedBy: reference.submittedBy,
        digestSha256: reference.digestSha256,
        sizeBytes: reference.sizeBytes,
        bodyUtf8: raw,
      };
      if (
        reference.state !== 'available' ||
        typeof raw !== 'string' ||
        Buffer.byteLength(raw, 'utf8') !== reference.sizeBytes ||
        createHash('sha256').update(raw, 'utf8').digest('hex') !== reference.digestSha256 ||
        !equal(document, expected)
      ) {
        fail('EVIDENCE_CONTENT_MISMATCH', { evidenceId: reference.evidenceId });
        continue;
      }
      try {
        const body = object(JSON.parse(raw));
        if (
          body?.schemaVersion !== 1 ||
          body.category !== reference.category ||
          !object(body.data)
        ) {
          fail('EVIDENCE_PROFILE_MISMATCH', { evidenceId: reference.evidenceId });
        }
      } catch {
        fail('EVIDENCE_PROFILE_MISMATCH', { evidenceId: reference.evidenceId });
      }
    }
    const heads = new Map<
      string,
      { entry: JournalEntry; base: Record<string, unknown>; digest: string }
    >();
    const expectedHeads = new Map<string, Record<string, unknown>>();
    for (const entry of snapshot.entries) {
      report.checkedEvents++;
      if (entry.sourceKind === 'credential') {
        if (!['credential.issued', 'credential.revoked'].includes(String(entry.payload.kind))) {
          fail('EVENT_SOURCE_MISMATCH', { eventId: entry.eventId });
        }
        continue;
      }
      if (
        entry.sourceKind !== 'workflow' ||
        !['request.submitted', 'request.rejected', 'grade.accepted'].includes(
          String(entry.payload.kind),
        )
      ) {
        fail('EVENT_SOURCE_MISMATCH', { eventId: entry.eventId });
        continue;
      }
      const receipt = await find('workflow_events', entry.eventId);
      const expectedReceipt = {
        _id: entry.eventId,
        digestSha256: projectionDigest(entry.payload),
        payload: entry.payload,
      };
      if (!receipt) {
        if (entry.delivered) fail('DELIVERED_EVENT_MISSING', { eventId: entry.eventId });
        else pending('EVENT_DELIVERY_PENDING', { eventId: entry.eventId });
      } else if (!equal(receipt, expectedReceipt)) {
        fail('EVENT_PROJECTION_MISMATCH', { eventId: entry.eventId });
      }
      const revision = object(entry.payload.revision);
      if (entry.payload.kind !== 'grade.accepted') continue;
      if (
        !revision ||
        typeof entry.payload.recordId !== 'string' ||
        typeof revision.versionNo !== 'number' ||
        !Number.isSafeInteger(revision.versionNo) ||
        revision.versionNo < 1
      ) {
        fail('INVALID_ACCEPTED_REVISION', { eventId: entry.eventId });
        continue;
      }
      const recordId = entry.payload.recordId;
      const base = {
        recordId,
        institutionId: entry.payload.institutionId,
        eventId: entry.eventId,
        versionNo: revision.versionNo,
        revision,
      };
      const digest = projectionDigest(base);
      expectedHeads.set(`${recordId}:${revision.versionNo}`, {
        _id: recordId,
        institutionId: base.institutionId,
        latestRecordedVersion: base.versionNo,
        eventId: entry.eventId,
        revisionDigestSha256: digest,
      });
      const projected = await find('grade_revisions', `${recordId}:${revision.versionNo}`);
      const expectedRevision = {
        _id: `${recordId}:${revision.versionNo}`,
        ...base,
        digestSha256: digest,
      };
      if (!projected) {
        if (entry.delivered)
          fail('DELIVERED_REVISION_MISSING', { eventId: entry.eventId, recordId });
        else pending('REVISION_DELIVERY_PENDING', { eventId: entry.eventId, recordId });
      } else if (!equal(projected, expectedRevision)) {
        fail('REVISION_PROJECTION_MISMATCH', { eventId: entry.eventId, recordId });
      }
      const previous = heads.get(recordId);
      if (!previous || (previous.base.versionNo as number) < revision.versionNo) {
        heads.set(recordId, { entry, base, digest });
      }
    }
    for (const [recordId, { entry, base, digest }] of heads) {
      const head = await find('grade_revision_heads', recordId);
      const expected = {
        _id: recordId,
        institutionId: base.institutionId,
        latestRecordedVersion: base.versionNo,
        eventId: entry.eventId,
        revisionDigestSha256: digest,
      };
      if (
        head &&
        (head._id !== recordId ||
          head.institutionId !== snapshot.logId ||
          typeof head.latestRecordedVersion !== 'number' ||
          !Number.isSafeInteger(head.latestRecordedVersion) ||
          head.latestRecordedVersion < 1)
      ) {
        fail('HEAD_PROJECTION_MISMATCH', { eventId: entry.eventId, recordId });
        continue;
      }
      if (
        head &&
        typeof head.latestRecordedVersion === 'number' &&
        head.latestRecordedVersion > (base.versionNo as number)
      ) {
        // A Mongo observation can race a newer committed SQL event. Never call
        // that newer version invalid or silently certify it from an older snapshot.
        report.projection = 'unavailable';
        if (report.integrity === 'valid') report.integrity = 'unavailable';
        report.issues.push({ code: 'HEAD_AHEAD_OF_SQL_SNAPSHOT', recordId });
      } else if (
        head &&
        !equal(head, expectedHeads.get(`${recordId}:${head.latestRecordedVersion}`))
      ) {
        fail('HEAD_PROJECTION_MISMATCH', { eventId: entry.eventId, recordId });
      } else if (!equal(head, expected)) {
        if (entry.delivered) fail('DELIVERED_HEAD_MISMATCH', { eventId: entry.eventId, recordId });
        else pending('HEAD_DELIVERY_PENDING', { eventId: entry.eventId, recordId });
      }
    }
  } catch (error) {
    if (error instanceof MongoUnavailable) {
      if (report.integrity !== 'invalid') report.integrity = 'unavailable';
      report.projection = 'unavailable';
      report.issues.push({ code: 'MONGO_UNAVAILABLE' });
    } else {
      fail('SQL_SNAPSHOT_INTEGRITY_FAILURE');
    }
  }
  return report;
}
