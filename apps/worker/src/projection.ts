import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MongoServerError } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { z } from 'zod';

export const PROJECTION_COLLECTIONS = {
  events: 'workflow_events',
  revisions: 'grade_revisions',
  heads: 'grade_revision_heads',
} as const;

const maximumEventBytes = 65536;
const maximumVersion = 2147483647;
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const digestPattern = '^[0-9a-f]{64}$';
const timestampPattern =
  '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$';
const uuid = z.string().regex(new RegExp(uuidPattern));
const timestamp = z.iso.datetime({ offset: true }).refine((value) => !/\.\d{7,}/.test(value));
const version = z.number().int().min(1).max(maximumVersion);
const gradePoints = z
  .string()
  .regex(/^\d{1,2}(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) >= 0 && Number(value) <= 10);

export class InvalidEventError extends Error {
  constructor() {
    super('Workflow event does not match the projection profile');
    this.name = 'InvalidEventError';
  }
}

export class ProjectionConflictError extends Error {
  constructor() {
    super('Projection identifier already contains different immutable data');
    this.name = 'ProjectionConflictError';
  }
}

export class ProjectionCollectionConfigurationError extends Error {
  constructor() {
    super('Projection collection is missing or has incompatible validation');
    this.name = 'ProjectionCollectionConfigurationError';
  }
}

/**
 * projection-json-v1: recursively sort object keys, retaining array order and
 * JavaScript JSON primitive encoding. This is a replay fingerprint, not an
 * RFC 8785 implementation or a signature/externally trusted commitment.
 */
export function stableJson(value: unknown): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  const add = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maximumEventBytes) throw new InvalidEventError();
    chunks.push(text);
  };
  const encode = (current: unknown, depth: number) => {
    if (depth > 32) throw new InvalidEventError();
    if (current === null) return add('null');
    if (typeof current === 'string' || typeof current === 'boolean')
      return add(JSON.stringify(current));
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new InvalidEventError();
      return add(JSON.stringify(current));
    }
    if (typeof current !== 'object' || ancestors.has(current)) throw new InvalidEventError();
    if (
      !Array.isArray(current) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(current))
    ) {
      throw new InvalidEventError();
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > 1000) throw new InvalidEventError();
        add('[');
        for (let index = 0; index < current.length; index++) {
          if (index) add(',');
          encode(current[index], depth + 1);
        }
        add(']');
      } else {
        const keys = Object.keys(current).sort();
        if (keys.length > 200 || Object.getOwnPropertySymbols(current).length)
          throw new InvalidEventError();
        add('{');
        keys.forEach((key, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new InvalidEventError();
          if (index) add(',');
          add(JSON.stringify(key));
          add(':');
          encode(descriptor.value, depth + 1);
        });
        add('}');
      }
    } finally {
      ancestors.delete(current);
    }
  };
  encode(value, 0);
  return chunks.join('');
}

export function digestPayload(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

// Preserve PostgreSQL microseconds when checking exact valid-time boundaries.
function micros(value: string): bigint {
  const parts = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts?.[1] || !parts[3]) throw new InvalidEventError();
  const milliseconds = Date.parse(parts[1] + parts[3]);
  if (!Number.isFinite(milliseconds)) throw new InvalidEventError();
  return BigInt(milliseconds) * 1000n + BigInt((parts[2] ?? '').padEnd(6, '0'));
}

const revisionSchema = z
  .object({
    versionNo: version,
    previousVersionNo: version.nullable(),
    gradePoints: gradePoints.nullable(),
    outcome: z.enum(['passed', 'failed', 'withdrawn', 'incomplete']),
    validFrom: timestamp,
    validUntil: timestamp.nullable(),
    recordedAt: timestamp,
    authorId: uuid,
    reason: z
      .string()
      .min(1)
      .refine((value) => Array.from(value).length <= 500 && value.trim().length > 0),
  })
  .passthrough()
  .superRefine((revision, context) => {
    if (revision.previousVersionNo !== (revision.versionNo === 1 ? null : revision.versionNo - 1)) {
      context.addIssue({ code: 'custom', message: 'Invalid predecessor' });
    }
    if ((revision.gradePoints !== null) !== ['passed', 'failed'].includes(revision.outcome)) {
      context.addIssue({ code: 'custom', message: 'Grade/outcome mismatch' });
    }
    if (revision.validUntil !== null && micros(revision.validUntil) <= micros(revision.validFrom)) {
      context.addIssue({ code: 'custom', message: 'Invalid validity interval' });
    }
  });

const eventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: uuid,
    kind: z.enum(['request.submitted', 'request.rejected', 'grade.accepted']),
    institutionId: uuid,
    recordId: uuid,
    requestId: uuid,
    actorId: uuid,
    occurredAt: timestamp,
    proposerId: uuid,
    evidence: z
      .object({
        evidenceId: uuid,
        digestSha256: z.string().regex(new RegExp(digestPattern)),
        sizeBytes: z.number().int().min(1).max(65536),
      })
      .passthrough(),
    revision: revisionSchema.nullable(),
  })
  .passthrough()
  .superRefine((event, context) => {
    if ((event.kind === 'grade.accepted') !== (event.revision !== null)) {
      context.addIssue({ code: 'custom', message: 'Event/revision mismatch' });
    }
  });

export type ProjectionEvent = z.infer<typeof eventSchema>;

export function parseProjectionEvent(value: unknown): ProjectionEvent {
  try {
    // Canonical cloning removes encoding aliases such as -0 before storage.
    const canonical: unknown = JSON.parse(stableJson(value));
    const result = eventSchema.safeParse(canonical);
    if (!result.success) throw new InvalidEventError();
    return result.data;
  } catch {
    throw new InvalidEventError();
  }
}

const uuidField = () => ({ bsonType: 'string', pattern: uuidPattern });
const digestField = () => ({ bsonType: 'string', pattern: digestPattern });
const intVersion = () => ({ bsonType: 'int', minimum: 1, maximum: maximumVersion });
const timeField = () => ({
  bsonType: 'string',
  minLength: 20,
  maxLength: 40,
  pattern: timestampPattern,
});
const revisionProperties = {
  versionNo: intVersion(),
  previousVersionNo: { bsonType: ['int', 'null'], minimum: 1, maximum: maximumVersion },
  gradePoints: { bsonType: ['string', 'null'], pattern: '^\\d{1,2}(?:\\.\\d{1,2})?$' },
  outcome: { bsonType: 'string', enum: ['passed', 'failed', 'withdrawn', 'incomplete'] },
  validFrom: timeField(),
  validUntil: { ...timeField(), bsonType: ['string', 'null'] },
  recordedAt: timeField(),
  authorId: uuidField(),
  reason: { bsonType: 'string', minLength: 1, maxLength: 500 },
};
const mongoRevision = {
  bsonType: 'object',
  required: Object.keys(revisionProperties),
  properties: revisionProperties,
};
const payloadProperties = {
  schemaVersion: { bsonType: 'int', enum: [1] },
  eventId: uuidField(),
  kind: { bsonType: 'string', enum: ['request.submitted', 'request.rejected', 'grade.accepted'] },
  institutionId: uuidField(),
  recordId: uuidField(),
  requestId: uuidField(),
  actorId: uuidField(),
  occurredAt: timeField(),
  proposerId: uuidField(),
  evidence: {
    bsonType: 'object',
    required: ['evidenceId', 'digestSha256', 'sizeBytes'],
    properties: {
      evidenceId: uuidField(),
      digestSha256: digestField(),
      sizeBytes: { bsonType: 'int', minimum: 1, maximum: 65536 },
    },
  },
  revision: {
    bsonType: ['object', 'null'],
    required: Object.keys(revisionProperties),
    properties: revisionProperties,
  },
};

export const PROJECTION_VALIDATORS: Record<string, Document> = {
  [PROJECTION_COLLECTIONS.events]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'digestSha256', 'payload'],
      properties: {
        _id: uuidField(),
        digestSha256: digestField(),
        payload: {
          bsonType: 'object',
          required: Object.keys(payloadProperties),
          properties: payloadProperties,
          oneOf: [
            {
              properties: { kind: { enum: ['grade.accepted'] }, revision: { bsonType: 'object' } },
            },
            {
              properties: {
                kind: { enum: ['request.submitted', 'request.rejected'] },
                revision: { bsonType: 'null' },
              },
            },
          ],
        },
      },
    },
  },
  [PROJECTION_COLLECTIONS.revisions]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'recordId',
        'institutionId',
        'eventId',
        'versionNo',
        'digestSha256',
        'revision',
      ],
      properties: {
        _id: { bsonType: 'string', pattern: uuidPattern.slice(0, -1) + ':[1-9][0-9]{0,9}$' },
        recordId: uuidField(),
        institutionId: uuidField(),
        eventId: uuidField(),
        versionNo: intVersion(),
        digestSha256: digestField(),
        revision: mongoRevision,
      },
    },
  },
  [PROJECTION_COLLECTIONS.heads]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'institutionId',
        'latestRecordedVersion',
        'eventId',
        'revisionDigestSha256',
      ],
      properties: {
        _id: uuidField(),
        institutionId: uuidField(),
        latestRecordedVersion: intVersion(),
        eventId: uuidField(),
        revisionDigestSha256: digestField(),
      },
    },
  },
};

type StoredDocument = Document & { _id: string };

async function insertImmutable(db: Db, name: string, expected: StoredDocument): Promise<void> {
  const collection = db.collection<StoredDocument>(name);
  try {
    await collection.insertOne(expected);
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    const existing = await collection.findOne({ _id: expected._id });
    if (!isDeepStrictEqual(existing, expected)) throw new ProjectionConflictError();
  }
}

export async function projectEvent(db: Db, payload: unknown): Promise<void> {
  const event = parseProjectionEvent(payload);
  await insertImmutable(db, PROJECTION_COLLECTIONS.events, {
    _id: event.eventId,
    digestSha256: digestPayload(event),
    payload: event,
  });
  if (event.revision === null) return;

  const revisionBase = {
    recordId: event.recordId,
    institutionId: event.institutionId,
    eventId: event.eventId,
    versionNo: event.revision.versionNo,
    revision: event.revision,
  };
  const revisionDigestSha256 = digestPayload(revisionBase);
  await insertImmutable(db, PROJECTION_COLLECTIONS.revisions, {
    _id: `${event.recordId}:${event.revision.versionNo}`,
    ...revisionBase,
    digestSha256: revisionDigestSha256,
  });

  // This pointer means latest RECORDED revision, never the current-effective grade.
  const head: StoredDocument = {
    _id: event.recordId,
    institutionId: event.institutionId,
    latestRecordedVersion: event.revision.versionNo,
    eventId: event.eventId,
    revisionDigestSha256,
  };
  // One document update decides monotonicity atomically. $literal prevents event
  // values from being interpreted as aggregation expressions. See MongoDB's
  // update-pipeline documentation; no read-then-unconditional-write race is used.
  const pipeline = [
    {
      $replaceWith: {
        $cond: [
          {
            $and: [
              { $eq: [{ $ifNull: ['$institutionId', event.institutionId] }, event.institutionId] },
              { $lt: [{ $ifNull: ['$latestRecordedVersion', 0] }, event.revision.versionNo] },
            ],
          },
          { $literal: head },
          '$$ROOT',
        ],
      },
    },
  ];
  const heads = db.collection<StoredDocument>(PROJECTION_COLLECTIONS.heads);
  try {
    await heads.updateOne({ _id: event.recordId }, pipeline, { upsert: true });
  } catch (error) {
    // Concurrent first deliveries can race to upsert the same _id. The loser
    // retries the same conditional update against the winner's existing row.
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    await heads.updateOne({ _id: event.recordId }, pipeline);
  }
  const stored = await heads.findOne({ _id: event.recordId });
  if (
    !stored ||
    stored.institutionId !== event.institutionId ||
    typeof stored.latestRecordedVersion !== 'number' ||
    stored.latestRecordedVersion < event.revision.versionNo ||
    (stored.latestRecordedVersion === event.revision.versionNo && !isDeepStrictEqual(stored, head))
  ) {
    throw new ProjectionConflictError();
  }
}

export async function initializeProjectionCollections(db: Db): Promise<void> {
  for (const [name, validator] of Object.entries(PROJECTION_VALIDATORS)) {
    const existing = await db.listCollections({ name }, { nameOnly: false }).next();
    if (!existing) {
      try {
        await db.createCollection(name, {
          validator,
          validationLevel: 'strict',
          validationAction: 'error',
        });
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
      }
    }
  }
  await verifyProjectionCollections(db);
}

export async function verifyProjectionCollections(db: Db): Promise<void> {
  for (const [name, validator] of Object.entries(PROJECTION_VALIDATORS)) {
    const existing = await db.listCollections({ name }, { nameOnly: false }).next();
    const options = existing?.options;
    if (
      existing?.type !== 'collection' ||
      !isDeepStrictEqual(options?.validator, validator) ||
      (options?.validationLevel ?? 'strict') !== 'strict' ||
      (options?.validationAction ?? 'error') !== 'error'
    ) {
      throw new ProjectionCollectionConfigurationError();
    }
  }
}
