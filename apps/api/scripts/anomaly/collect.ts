import { randomUUID } from 'node:crypto';
import { stdin } from 'node:process';
import { z } from 'zod';
import {
  extractGraphFeatures,
  openGraph,
  rebuild,
  requireGraphSchema,
} from '../../src/provenance/graph.js';
import { approvalFact, graphId, readSnapshot, windowStart } from '../../src/provenance/source.js';
import type { ApprovedFact } from '../../src/provenance/source.js';
import { openWorkerSql } from '../graph/worker-sql.js';

function counter() {
  const groups = new Map<string, string[]>();
  return (key: string, from: string, at: string) => {
    const history = groups.get(key) ?? [];
    const count = history.filter((time) => time >= from && time < at).length;
    history.push(at);
    groups.set(key, history);
    return count;
  };
}

function tabular(facts: ApprovedFact[]) {
  const recordCount = counter(),
    courseCount = counter(),
    proposerCount = counter();
  return facts.map((fact) => {
    const at = fact.occurred_at;
    const from = windowStart(at);
    return {
      requestId: fact.request_id,
      recordId: fact.record_id,
      version: fact.version_no,
      occurredAt: at,
      features: {
        delta: fact.delta_hundredths ?? 0,
        missingDelta: Number(fact.delta_hundredths === null),
        record30d: recordCount(fact.record_id, from, at),
        course30d: courseCount(fact.course_id, from, at),
        proposer30d: proposerCount(fact.proposer_id, from, at),
      },
    };
  });
}

async function syntheticFacts() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Synthetic input exceeds the byte limit');
    chunks.push(chunk);
  }
  const facts = z
    .array(approvalFact)
    .min(1)
    .max(10000)
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  return facts.map((fact, position) => ({ ...fact, position }));
}

const [mode, argument, ...extra] = process.argv.slice(2);
if (extra.length || !(mode === 'synthetic' ? !argument : mode === 'live' && argument))
  throw new Error('Use synthetic via stdin or live <institution UUID>');
const synthetic = mode === 'synthetic';
const scope = synthetic ? randomUUID() : graphId.parse(argument);
const graph = openGraph();
if (!graph) throw new Error('Configure Neo4j before collecting features');
let syntheticLoaded = false;
try {
  let snapshot: { facts: ApprovedFact[]; size: number };
  if (synthetic) {
    await requireGraphSchema(graph);
    const facts = await syntheticFacts();
    await rebuild(graph, scope, facts.length, facts);
    syntheticLoaded = true;
    snapshot = { facts, size: facts.length };
  } else {
    const sql = await openWorkerSql();
    try {
      await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      snapshot = await readSnapshot(sql, scope);
      await sql.query('COMMIT');
    } finally {
      await sql.end();
    }
  }
  const { counts, syncedAt } = await extractGraphFeatures(
    graph,
    scope,
    snapshot.size,
    snapshot.facts,
  );
  const rows = tabular(snapshot.facts).map((row) => {
    const graph = counts.get(row.requestId);
    if (!graph) throw new Error('Missing Neo4j feature row');
    return { ...row, features: { ...row.features, ...graph } };
  });
  process.stdout.write(JSON.stringify({ scope, through: snapshot.size, syncedAt, rows }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Feature collection failed');
  process.exitCode = 1;
} finally {
  try {
    if (syntheticLoaded)
      await graph.executeQuery(
        'MATCH (n) WHERE (n:Prov AND n.scope=$scope) OR (n:ProvenanceHead AND n.key=$scope) DETACH DELETE n',
        { scope },
      );
  } finally {
    await graph.close();
  }
}
