import { createPublicKey } from 'node:crypto';
import type { Client } from 'pg';
import {
  canonicalBytes,
  checkpointKeyId,
  commitEvent,
  consistencyProof,
  inclusionProof,
  merkleRoot,
  signCheckpoint,
  verifyCheckpoint,
} from '@academic-records/verification';
import type {
  EventEntry,
  EventProofBundle,
  KeyInput,
  SignedCheckpoint,
} from '@academic-records/verification';

export type JournalSql = Pick<Client, 'query'>;
const maximumJournalEntries = 100_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class JournalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}

export interface JournalEntry extends EventEntry {
  eventId: string;
  sourceKind: 'workflow' | 'credential';
  commitment: string;
  delivered: boolean;
}
export interface JournalEvidence {
  evidenceId: string;
  recordId: string;
  institutionId: string;
  submittedBy: string;
  category: string;
  digestSha256: string;
  sizeBytes: number;
  state: string;
}
export interface JournalSnapshot {
  logId: string;
  treeSize: number;
  bootstrapSize: number;
  entries: JournalEntry[];
  checkpoints: SignedCheckpoint[];
  evidence: JournalEvidence[];
  coverage: {
    uncoveredGradeVersions: number;
    description: string;
  };
}

function invalid(message: string): never {
  throw new JournalError('JOURNAL_INTEGRITY', message);
}

function count(value: unknown): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalid('Journal contains an invalid integer');
  }
  return value;
}

function bytes(value: unknown, length: number): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    return invalid('Journal contains invalid cryptographic bytes');
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  try {
    return canonicalBytes(left).equals(canonicalBytes(right));
  } catch {
    return false;
  }
}

function checkpointRow(
  row: Record<string, unknown>,
  logId: string,
  bootstrapSize: number,
): SignedCheckpoint {
  if (typeof row.issued_at !== 'string' || typeof row.key_id !== 'string') {
    return invalid('Checkpoint has invalid metadata');
  }
  return {
    body: {
      profile: 'academic-records-log-v1',
      logId,
      treeSize: count(row.tree_size),
      bootstrapSize,
      rootHash: bytes(row.root_hash, 32).toString('hex'),
      issuedAt: row.issued_at,
      keyId: row.key_id,
    },
    signature: bytes(row.signature, 64).toString('base64url'),
  };
}

/** Own this client exclusively; the function opens and closes its read transaction. */
export async function readJournal(client: JournalSql, logId: string): Promise<JournalSnapshot> {
  if (!uuid.test(logId))
    throw new JournalError('INVALID_LOG', 'Expected canonical institution log ID');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const head = await client.query<{ tree_size: unknown; bootstrap_size: unknown }>(
      'SELECT tree_size,bootstrap_size FROM transparency.log_state WHERE institution_id=$1',
      [logId],
    );
    if (head.rows.length > 1) invalid('Institution log has multiple heads');
    if (!head.rows.length) {
      const institution = await client.query(
        'SELECT institution_id FROM academic.institution WHERE institution_id=$1',
        [logId],
      );
      if (institution.rows.length !== 1)
        throw new JournalError('LOG_NOT_FOUND', 'Institution log not found');
    }
    const treeSize = count(head.rows[0]?.tree_size ?? 0);
    const bootstrapSize = count(head.rows[0]?.bootstrap_size ?? 0);
    if (treeSize > maximumJournalEntries) {
      throw new JournalError('JOURNAL_LIMIT', 'Journal exceeds the bounded prototype audit limit');
    }
    if (bootstrapSize > treeSize) invalid('Bootstrap boundary exceeds the journal');
    const rows = await client.query<Record<string, unknown>>(
      `
      SELECT p.event_id,p.institution_id,p.leaf_index,p.salt,e.payload,e.source_kind,
        transparency.read_expected_event(p.event_id) AS expected_payload,
        d.event_id AS delivery_event_id,d.delivered_at IS NOT NULL AS delivered,
        er.evidence_id,er.record_id,er.submitted_by,er.category,er.digest_sha256,
        er.size_bytes,er.state
      FROM transparency.event_position p
      LEFT JOIN transparency.event_context e USING(event_id)
      LEFT JOIN workflow.outbox_delivery d USING(event_id)
      LEFT JOIN workflow.change_request q ON q.request_id=e.request_id
      LEFT JOIN evidence.reference er ON er.evidence_id=q.evidence_id
      WHERE p.institution_id=$1 ORDER BY p.leaf_index LIMIT 100001`,
      [logId],
    );
    if (rows.rows.length !== treeSize) invalid('Journal entries do not match its committed size');
    const evidence = new Map<string, JournalEvidence>();
    const seen = new Set<string>();
    const entries = rows.rows.map((row, index): JournalEntry => {
      if (row.source_kind !== 'workflow' && row.source_kind !== 'credential') {
        return invalid('Journal event has an unknown authoritative source');
      }
      if (
        count(row.leaf_index) !== index ||
        row.institution_id !== logId ||
        typeof row.event_id !== 'string' ||
        !uuid.test(row.event_id) ||
        seen.has(row.event_id)
      ) {
        return invalid('Journal positions or identities are inconsistent');
      }
      seen.add(row.event_id);
      if (!equal(row.payload, row.expected_payload) || row.expected_payload === null) {
        return invalid('Event differs from authoritative SQL facts');
      }
      const payload = row.payload as EventEntry['payload'];
      if (payload.eventId !== row.event_id || payload.institutionId !== logId) {
        return invalid('Event does not match its position scope');
      }
      const expectedKinds =
        row.source_kind === 'workflow'
          ? ['request.submitted', 'request.rejected', 'grade.accepted']
          : ['credential.issued', 'credential.revoked'];
      if (!expectedKinds.includes(String(payload.kind))) {
        return invalid('Event kind does not match its authoritative source');
      }
      if (row.source_kind === 'workflow') {
        if (
          row.delivery_event_id !== row.event_id ||
          typeof row.delivered !== 'boolean' ||
          typeof row.evidence_id !== 'string' ||
          typeof row.record_id !== 'string' ||
          typeof row.submitted_by !== 'string' ||
          typeof row.category !== 'string' ||
          typeof row.digest_sha256 !== 'string' ||
          typeof row.state !== 'string'
        )
          invalid('Event reference facts are incomplete');
        const reference: JournalEvidence = {
          evidenceId: row.evidence_id,
          recordId: row.record_id,
          institutionId: logId,
          submittedBy: row.submitted_by,
          category: row.category,
          digestSha256: row.digest_sha256,
          sizeBytes: count(row.size_bytes),
          state: row.state,
        };
        if (
          evidence.has(reference.evidenceId) &&
          !equal(evidence.get(reference.evidenceId), reference)
        ) {
          invalid('Evidence references disagree');
        }
        evidence.set(reference.evidenceId, reference);
      } else if (row.delivery_event_id !== null || row.evidence_id !== null) {
        invalid('Credential events must not use the grade projection queue');
      }
      const entry: EventEntry = {
        logId,
        index,
        salt: bytes(row.salt, 32).toString('hex'),
        payload,
      };
      return {
        ...entry,
        eventId: row.event_id,
        sourceKind: row.source_kind,
        delivered: row.source_kind === 'workflow' && row.delivered === true,
        commitment: commitEvent(entry),
      };
    });
    const missing = await client.query<{ missing: unknown }>(
      `
      SELECT count(*) AS missing FROM transparency.event_context e
      LEFT JOIN transparency.event_position p USING(event_id)
      WHERE e.institution_id=$1 AND p.event_id IS NULL`,
      [logId],
    );
    if (count(missing.rows[0]?.missing) !== 0) invalid('Committed events lack journal positions');
    // The head is mutable derived state, not part of the immutable event
    // commitment. Check its structural agreement with the observed SQL history.
    const heads = await client.query<{ inconsistent_heads: unknown }>(
      `SELECT count(*) AS inconsistent_heads FROM academic.grade_record g
       LEFT JOIN LATERAL (SELECT max(version_no) AS latest FROM academic.grade_version v
         WHERE v.record_id=g.record_id) v ON true
       WHERE g.institution_id=$1 AND g.latest_version_no IS DISTINCT FROM v.latest`,
      [logId],
    );
    if (count(heads.rows[0]?.inconsistent_heads) !== 0)
      invalid('SQL record head does not match the latest stored revision');
    const uncovered = await client.query<{ uncovered: unknown }>(
      `
      SELECT count(*) AS uncovered FROM academic.grade_version v
      JOIN academic.grade_record g USING(record_id)
      WHERE g.institution_id=$1 AND NOT EXISTS (
        SELECT 1 FROM workflow.decision d WHERE d.record_id=v.record_id AND d.version_no=v.version_no
        AND EXISTS (SELECT 1 FROM workflow.domain_event e
          WHERE e.request_id=d.request_id AND e.kind='grade.accepted'))`,
      [logId],
    );
    const checkpoints = await client.query<Record<string, unknown>>(
      `
      SELECT tree_size,root_hash,to_char(issued_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,key_id,signature
      FROM transparency.checkpoint WHERE institution_id=$1 ORDER BY tree_size`,
      [logId],
    );
    const snapshot: JournalSnapshot = {
      logId,
      treeSize,
      bootstrapSize,
      entries,
      evidence: [...evidence.values()],
      checkpoints: checkpoints.rows.map((row) => checkpointRow(row, logId, bootstrapSize)),
      coverage: {
        uncoveredGradeVersions: count(uncovered.rows[0]?.uncovered),
        description:
          'Committed workflow and credential events, their authoritative SQL facts, exact signed credential artifact digests, bound workflow evidence and Mongo grade projections. Credential disclosure material stays private and has no Mongo grade delivery. Academic catalogue metadata and the SQL temporal projection cache are not cryptographically covered. SQL record heads are checked structurally against maximum stored versions.',
      },
    };
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const code =
      error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (['23514', '23503', '22P02', '22023'].includes(String(code))) {
      invalid('Authoritative SQL facts violate the committed event profile');
    }
    throw error;
  }
}

export function journalCommitments(snapshot: JournalSnapshot): string[] {
  if (snapshot.entries.length !== snapshot.treeSize || snapshot.bootstrapSize > snapshot.treeSize) {
    return invalid('Snapshot does not contain its complete prefix');
  }
  return snapshot.entries.map((entry, index) => {
    if (
      entry.index !== index ||
      entry.logId !== snapshot.logId ||
      entry.payload.eventId !== entry.eventId
    ) {
      return invalid('Snapshot entries have inconsistent positions');
    }
    const hash = commitEvent({
      logId: entry.logId,
      index,
      salt: entry.salt,
      payload: entry.payload,
    });
    if (hash !== entry.commitment) invalid('Snapshot commitment differs from actual event data');
    return hash;
  });
}

function checkPrefix(
  snapshot: JournalSnapshot,
  checkpoint: SignedCheckpoint,
  hashes: readonly string[],
) {
  const body = checkpoint.body;
  if (
    body.logId !== snapshot.logId ||
    body.bootstrapSize !== snapshot.bootstrapSize ||
    body.treeSize > snapshot.treeSize ||
    merkleRoot(hashes.slice(0, body.treeSize)) !== body.rootHash
  ) {
    throw new JournalError(
      'CHECKPOINT_CONFLICT',
      'Checkpoint does not match the observed journal prefix',
    );
  }
}

/** No signing occurs until the readonly snapshot and retained-prefix checks finish. */
export async function publishCheckpoint(
  client: JournalSql,
  logId: string,
  privateKey: KeyInput,
  trustedPublicKey: KeyInput,
  retained?: SignedCheckpoint,
): Promise<SignedCheckpoint> {
  const snapshot = await readJournal(client, logId);
  const hashes = journalCommitments(snapshot);
  const keyId = checkpointKeyId(trustedPublicKey);
  if (snapshot.checkpoints.length && !retained) {
    throw new JournalError(
      'RETAINED_CHECKPOINT_REQUIRED',
      'Retained checkpoint is required for an already signed log',
    );
  }
  if (retained) {
    if (!verifyCheckpoint(retained, trustedPublicKey))
      throw new JournalError('INVALID_CHECKPOINT', 'Retained checkpoint is not trusted');
    checkPrefix(snapshot, retained, hashes);
  }
  for (const previous of snapshot.checkpoints) {
    if (!verifyCheckpoint(previous, trustedPublicKey))
      throw new JournalError('INVALID_CHECKPOINT', 'Stored checkpoint is not trusted');
    checkPrefix(snapshot, previous, hashes);
  }
  const existing = snapshot.checkpoints.find(({ body }) => body.treeSize === snapshot.treeSize);
  if (existing) return existing;
  const latestTime = Math.max(
    0,
    ...snapshot.checkpoints.map(({ body }) => Date.parse(body.issuedAt)),
    retained ? Date.parse(retained.body.issuedAt) : 0,
  );
  const now = new Date().getTime();
  if (now < latestTime)
    throw new JournalError('CLOCK_REGRESSION', 'Checkpoint clock precedes a trusted observation');
  // Confirm configured keys match before invoking the signing operation.
  const signingPublicKey = createPublicKey(privateKey);
  if (checkpointKeyId(signingPublicKey) !== keyId)
    throw new JournalError(
      'SIGNING_KEY_MISMATCH',
      'Signing key does not match the trusted public key',
    );
  const checkpoint =
    retained?.body.treeSize === snapshot.treeSize
      ? retained
      : signCheckpoint(
          {
            profile: 'academic-records-log-v1',
            logId,
            treeSize: snapshot.treeSize,
            bootstrapSize: snapshot.bootstrapSize,
            rootHash: merkleRoot(hashes),
            issuedAt: new Date(now).toISOString(),
            keyId,
          },
          privateKey,
        );
  await client.query('BEGIN');
  try {
    const saved = await client.query<Record<string, unknown>>(
      `
      SELECT tree_size,root_hash,to_char(issued_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,key_id,signature
      FROM transparency.record_checkpoint($1,$2,$3,$4,$5,$6)`,
      [
        logId,
        checkpoint.body.treeSize,
        Buffer.from(checkpoint.body.rootHash, 'hex'),
        checkpoint.body.issuedAt,
        checkpoint.body.keyId,
        Buffer.from(checkpoint.signature, 'base64url'),
      ],
    );
    if (
      saved.rows.length !== 1 ||
      !equal(checkpointRow(saved.rows[0]!, logId, snapshot.bootstrapSize), checkpoint)
    ) {
      invalid('Database did not persist the exact signed checkpoint');
    }
    await client.query('COMMIT');
    return checkpoint;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export function exportEventProof(
  snapshot: JournalSnapshot,
  checkpoint: SignedCheckpoint,
  eventId: string,
): EventProofBundle {
  const hashes = journalCommitments(snapshot);
  checkPrefix(snapshot, checkpoint, hashes);
  const entry = snapshot.entries.find((candidate) => candidate.eventId === eventId);
  if (!entry || entry.index >= checkpoint.body.treeSize)
    throw new JournalError(
      'EVENT_NOT_COMMITTED',
      'Event is not included in the selected signed prefix',
    );
  return {
    checkpoint,
    entry: { logId: entry.logId, index: entry.index, salt: entry.salt, payload: entry.payload },
    inclusionProof: inclusionProof(hashes.slice(0, checkpoint.body.treeSize), entry.index),
  };
}

export function exportConsistencyProof(snapshot: JournalSnapshot, oldSize: number): string[] {
  return consistencyProof(journalCommitments(snapshot), oldSize);
}
