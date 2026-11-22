import { isDeepStrictEqual } from 'node:util';
import { MongoServerError } from 'mongodb';
import type { Collection, Db } from 'mongodb';

export interface EvidenceDocument {
  _id: string;
  schemaVersion: 1;
  institutionId: string;
  recordId: string;
  submittedBy: string;
  digestSha256: string;
  sizeBytes: number;
  bodyUtf8: string;
}

export interface EvidenceStore {
  put(document: EvidenceDocument): Promise<void>;
  get(id: string): Promise<EvidenceDocument | null>;
}

export const EVIDENCE_COLLECTION = 'evidence_documents';

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const uuidString = () => ({ bsonType: 'string', pattern: uuidPattern });

export const EVIDENCE_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'schemaVersion',
      'institutionId',
      'recordId',
      'submittedBy',
      'digestSha256',
      'sizeBytes',
      'bodyUtf8',
    ],
    properties: {
      _id: uuidString(),
      schemaVersion: { bsonType: 'int', enum: [1] },
      institutionId: uuidString(),
      recordId: uuidString(),
      submittedBy: uuidString(),
      digestSha256: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      sizeBytes: { bsonType: 'int', minimum: 1, maximum: 65536 },
      bodyUtf8: { bsonType: 'string', minLength: 1, maxLength: 65536 },
    },
  },
};

export class EvidenceConflictError extends Error {
  constructor() {
    super('Evidence identifier already contains a different immutable document');
    this.name = 'EvidenceConflictError';
  }
}

export class EvidenceCollectionConfigurationError extends Error {
  constructor() {
    super('Evidence collection has incompatible validation; review its configuration explicitly');
    this.name = 'EvidenceCollectionConfigurationError';
  }
}

export class MongoEvidenceStore implements EvidenceStore {
  private readonly collection: Collection<EvidenceDocument>;

  constructor(db: Db) {
    this.collection = db.collection<EvidenceDocument>(EVIDENCE_COLLECTION);
  }

  async put(document: EvidenceDocument): Promise<void> {
    try {
      await this.collection.insertOne(document);
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await this.get(document._id);
      if (!isDeepStrictEqual(existing, document)) throw new EvidenceConflictError();
    }
  }

  async get(id: string): Promise<EvidenceDocument | null> {
    return this.collection.findOne({ _id: id });
  }
}

export async function initializeEvidenceCollection(db: Db): Promise<void> {
  const inspect = () =>
    db.listCollections({ name: EVIDENCE_COLLECTION }, { nameOnly: false }).next();
  const existing = await inspect();
  if (!existing) {
    try {
      await db.createCollection<EvidenceDocument>(EVIDENCE_COLLECTION, {
        validator: EVIDENCE_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } catch (error) {
      // Another administrative initializer may have created the collection.
      // Inspect it rather than assuming that its validator is compatible.
      if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
    }
  }
  await verifyEvidenceCollection(db);
}

export async function verifyEvidenceCollection(db: Db): Promise<void> {
  const existing = await db
    .listCollections({ name: EVIDENCE_COLLECTION }, { nameOnly: false })
    .next();
  const options = existing?.options;
  if (
    existing?.type !== 'collection' ||
    !isDeepStrictEqual(options?.validator, EVIDENCE_VALIDATOR) ||
    (options?.validationLevel ?? 'strict') !== 'strict' ||
    (options?.validationAction ?? 'error') !== 'error'
  ) {
    throw new EvidenceCollectionConfigurationError();
  }
}
