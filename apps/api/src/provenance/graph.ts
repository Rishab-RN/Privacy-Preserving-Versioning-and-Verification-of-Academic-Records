import neo4j from 'neo4j-driver';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import type { Sql } from '../repository.js';
import { ancestry, evidenceReuse, features, pairings, upward, upsertFacts } from './queries.js';
import { graphId, readSource, timestamp } from './source.js';
import type { ApprovedFact } from './source.js';
import type { ProvenanceReview } from '@scholarproof/contracts';

const labels = [
  'ProvenanceHead',
  'Institution',
  'Student',
  'Course',
  'Offering',
  'GradeRecord',
  'GradeVersion',
  'Correction',
  'Actor',
  'Evidence',
  'EvidenceDigest',
] as const;
const queryLimit = { timeout: 8000 };
const lockHead = `
MERGE (h:ProvenanceHead {key:$scope}) ON CREATE SET h.cursor=0
SET h.lock=true RETURN h.cursor AS cursor`;
const readHead = `
OPTIONAL MATCH (h:ProvenanceHead {key:$scope})
RETURN coalesce(h.cursor,0) AS cursor,h.syncedAt AS syncedAt`;
const setHead = `MATCH (h:ProvenanceHead {key:$scope})
SET h.cursor=toInteger($cursor),h.syncedAt=$syncedAt`;

export function openGraph(env: NodeJS.ProcessEnv = process.env): Driver | undefined {
  const password = env.GRAPH_NEO4J_PASSWORD;
  if (!password) return undefined;
  const port = env.GRAPH_NEO4J_PORT ?? '57687';
  if (
    !/^\d{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    password.startsWith('replace-with-') ||
    password.length < 12
  )
    throw new Error('Invalid graph configuration');
  return neo4j.driver(`bolt://127.0.0.1:${port}`, neo4j.auth.basic('neo4j', password), {
    disableLosslessIntegers: true,
    connectionTimeout: 2000,
    connectionAcquisitionTimeout: 2500,
    maxTransactionRetryTime: 1000,
    maxConnectionPoolSize: 6,
  });
}

export async function setupSchema(driver: Driver) {
  await driver.verifyConnectivity();
  for (const label of labels) {
    await driver.executeQuery(
      `CREATE CONSTRAINT provenance_${label} IF NOT EXISTS FOR (n:${label}) REQUIRE n.key IS UNIQUE`,
    );
  }
  await driver.executeQuery(
    'CREATE INDEX provenance_window IF NOT EXISTS FOR (q:Correction) ON (q.scope,q.occurredAt)',
  );
  await driver.executeQuery('CALL db.awaitIndexes(30)');
}

export async function requireGraphSchema(driver: Driver) {
  const { records } = await driver.executeQuery(
    "SHOW CONSTRAINTS YIELD name,type,labelsOrTypes,properties WHERE type='UNIQUENESS' RETURN name,labelsOrTypes,properties",
  );
  const valid = new Set(
    records
      .filter(
        (record) =>
          (record.get('properties') as string[]).join(',') === 'key' &&
          record.get('name') ===
            'provenance_' + (record.get('labelsOrTypes') as string[]).join(','),
      )
      .map((record) => record.get('name')),
  );
  if (!labels.every((label) => valid.has('provenance_' + label)))
    throw new Error('Run graph setup before projecting');
}

async function rows<T>(tx: ManagedTransaction, query: string, params: Record<string, unknown>) {
  const result = await tx.run(query, params);
  return result.records.map((record) => record.toObject() as T);
}

type Head = { cursor: number; syncedAt: string | null };
export async function cursorFor(driver: Driver, scope: string) {
  graphId.parse(scope);
  const session = driver.session({ database: 'neo4j' });
  try {
    return await session.executeRead(
      async (tx) => (await rows<Head>(tx, readHead, { scope }))[0]!,
      queryLimit,
    );
  } finally {
    await session.close();
  }
}

export async function syncOnce(driver: Driver, sql: Sql, scope: string) {
  const { cursor } = await cursorFor(driver, scope);
  const page = await readSource(sql, scope, cursor);
  if (page.next === cursor)
    return { from: cursor, through: cursor, size: page.size, projected: 0, advanced: false };
  const session = driver.session({ database: 'neo4j' });
  try {
    const advanced = await session.executeWrite(
      async (tx) => {
        const [locked] = await rows<Head>(tx, lockHead, { scope });
        if (locked?.cursor !== cursor) return false;
        await tx.run(upsertFacts, { scope, facts: page.facts });
        await tx.run(setHead, { scope, cursor: page.next, syncedAt: new Date().toISOString() });
        return true;
      },
      { timeout: 15000 },
    );
    return {
      from: cursor,
      through: advanced ? page.next : cursor,
      size: page.size,
      projected: advanced ? page.facts.length : 0,
      advanced,
    };
  } finally {
    await session.close();
  }
}

/** Input is a full bounded snapshot read from the committed outbox. */
export async function rebuild(driver: Driver, scope: string, size: number, facts: ApprovedFact[]) {
  graphId.parse(scope);
  if (!Number.isSafeInteger(size) || size < 0 || size > 10000 || facts.length > size)
    throw new Error('Invalid rebuild snapshot');
  const session = driver.session({ database: 'neo4j' });
  try {
    return await session.executeWrite(
      async (tx) => {
        const [locked] = await rows<Head>(tx, lockHead, { scope });
        if (!locked || locked.cursor > size)
          throw new Error('Rebuild snapshot is behind the current graph cursor');
        await tx.run('MATCH (n:Prov {scope:$scope}) DETACH DELETE n', { scope });
        for (let index = 0; index < facts.length; index += 100)
          await tx.run(upsertFacts, { scope, facts: facts.slice(index, index + 100) });
        await tx.run(setHead, { scope, cursor: size, syncedAt: new Date().toISOString() });
        return { size, projected: facts.length };
      },
      { timeout: 60000 },
    );
  } finally {
    await session.close();
  }
}

export async function review(
  driver: Driver,
  scope: string,
  from: Date,
  to: Date,
  target?: {
    recordId: string;
    version: number;
  },
) {
  graphId.parse(scope);
  const params = { scope, from: timestamp(from), to: timestamp(to) };
  const session = driver.session({ database: 'neo4j' });
  try {
    return await session.executeRead(async (tx) => {
      const [start] = await rows<Head>(tx, readHead, { scope });
      if (!start) throw new Error('Graph cursor is unavailable');
      if (start.cursor === 0)
        return { head: start, pairings: [], upward: [], evidenceReuse: [], ancestry: [] };
      const pairs = await rows<ProvenanceReview['pairings'][number]>(tx, pairings, params);
      const rises = await rows<ProvenanceReview['upward'][number]>(tx, upward, params);
      const evidence = await rows<ProvenanceReview['evidenceReuse'][number]>(
        tx,
        evidenceReuse,
        params,
      );
      const path = target
        ? await rows<ProvenanceReview['ancestry'][number]>(tx, ancestry, { scope, ...target })
        : [];
      const [end] = await rows<Head>(tx, readHead, { scope });
      if (!end || start.cursor !== end.cursor || start.syncedAt !== end.syncedAt)
        throw new Error('Graph advanced during review; try again');
      return { head: end, pairings: pairs, upward: rises, evidenceReuse: evidence, ancestry: path };
    }, queryLimit);
  } finally {
    await session.close();
  }
}

export async function priorFeatures(driver: Driver, scope: string, requestId: string, from: Date) {
  graphId.parse(scope);
  graphId.parse(requestId);
  const session = driver.session({ database: 'neo4j' });
  try {
    return (
      (
        await session.executeRead(
          (tx) =>
            rows<{
              requestId: string;
              eventTime: string;
              priorPairCount: number;
              priorEvidenceCount: number;
            }>(tx, features, { scope, requestId, from: timestamp(from) }),
          queryLimit,
        )
      )[0] ?? null
    );
  } finally {
    await session.close();
  }
}
