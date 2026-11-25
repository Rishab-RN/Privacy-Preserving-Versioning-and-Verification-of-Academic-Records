import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabaseClient } from '../db/config.js';
import { openGraph, priorFeatures, review } from '../../src/provenance/graph.js';
import { ancestry, evidenceReuse, pairings, upward } from '../../src/provenance/queries.js';
import { graphId, timestamp } from '../../src/provenance/source.js';
import { reviewSql, sqlWorkloads } from './baseline.js';

const fixture = JSON.parse(await readFile('.runtime/workflow-fixture.json', 'utf8')) as {
  institutionId: string;
  recordId: string;
};
const scope = graphId.parse(fixture.institutionId),
  recordId = graphId.parse(fixture.recordId);
const graph = openGraph();
if (!graph) throw new Error('Configure Neo4j before measuring');
const sql = createDatabaseClient();
try {
  await sql.connect();
  await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const context = (
    await sql.query<{ version: number; slots: string; requestId: string; approvals: number }>(
      `
    SELECT g.latest_version_no AS version,s.tree_size AS slots,
      (SELECT request_id FROM provenance.approved_fact WHERE institution_id=$1 AND record_id=$2
        ORDER BY version_no DESC LIMIT 1) AS "requestId",
      (SELECT count(*)::integer FROM provenance.approved_fact WHERE institution_id=$1) AS approvals
    FROM academic.grade_record g JOIN transparency.log_state s USING(institution_id)
    WHERE g.institution_id=$1 AND g.record_id=$2`,
      [scope, recordId],
    )
  ).rows[0];
  if (!context?.version) throw new Error('Run the approved workflow demo first');
  const { version } = context;
  const to = new Date(),
    from = new Date(to.getTime() - 30 * 86400000);
  const parameters = { scope, recordId, version, from: timestamp(from), to: timestamp(to) };
  const before = await review(graph, scope, from, to, { recordId, version });
  assert.equal(
    before.head.cursor,
    Number(context.slots),
    'Sync the graph to the committed journal before measuring',
  );
  const expected = await reviewSql(sql, scope, from, to, recordId, version);
  assert.deepEqual(before, { ...expected, head: before.head });
  const workloads = { ancestry, pairings, upward, evidenceReuse };
  const graphSession = graph.session({ database: 'neo4j' });
  try {
    const plans: Record<string, unknown> = {};
    const samples = 15;
    const stats = (times: number[]) => {
      const sorted = times.toSorted((a, b) => a - b);
      return {
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      };
    };
    for (const key of Object.keys(workloads) as (keyof typeof workloads)[]) {
      const args: (string | number | Date)[] =
        key === 'ancestry' ? [scope, recordId, version] : [scope, from, to];
      const sqlPlan = (
        await sql.query<{ 'QUERY PLAN': unknown }>(
          'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sqlWorkloads[key],
          args,
        )
      ).rows[0]!['QUERY PLAN'];
      const graphPlan = (await graphSession.run('PROFILE ' + workloads[key], parameters)).summary
        .profile;
      const sqlTime: number[] = [],
        cypherTime: number[] = [];
      for (let i = 0; i < samples; i++) {
        const startSql = performance.now();
        await sql.query<Record<string, unknown>>(sqlWorkloads[key], args);
        sqlTime.push(performance.now() - startSql);
        const startGraph = performance.now();
        await graphSession.run(workloads[key], parameters);
        cypherTime.push(performance.now() - startGraph);
      }
      plans[key] = {
        sql: stats(sqlTime),
        cypher: stats(cypherTime),
        equivalentRows: expected[key].length,
        sqlPlan,
        graphPlan,
      };
    }
    const catalog = (
      await sql.query(`
      SELECT c.oid::regclass::text AS relation, pg_total_relation_size(c.oid)::text AS bytes
      FROM pg_class c WHERE c.oid IN ('academic.grade_version'::regclass,'workflow.change_request'::regclass,
        'workflow.outbox_delivery'::regclass,'workflow.decision'::regclass,'workflow.domain_event'::regclass,
        'transparency.event_position'::regclass,'evidence.reference'::regclass) ORDER BY 1`)
    ).rows;
    const graphNodes = (
      await graphSession.run('MATCH (n:Prov {scope:$scope}) RETURN count(n) AS nodes', { scope })
    ).records[0]!.get('nodes');
    const graphRelationships = (
      await graphSession.run(
        'MATCH (:Prov {scope:$scope})-[r]->(:Prov {scope:$scope}) RETURN count(r) AS relationships',
        { scope },
      )
    ).records[0]!.get('relationships');
    const feature = context.requestId
      ? await priorFeatures(graph, scope, context.requestId, from)
      : null;
    const after = await review(graph, scope, from, to, { recordId, version });
    assert.deepEqual(after, before, 'Projection changed during the measurement');
    const report = {
      observedAt: to.toISOString(),
      source: 'local synthetic proof workflow',
      scope,
      samples,
      committedSlots: Number(context.slots),
      approvals: context.approvals,
      storage: { postgresRelationBytes: catalog, graphNodes, graphRelationships },
      feature,
      workloads: plans,
    };
    await writeFile('.runtime/provenance-measurement.json', JSON.stringify(report, null, 2) + '\n');
    const summary = Object.fromEntries(
      Object.entries(plans).map(([key, value]) => {
        const { sql, cypher, equivalentRows } = value as {
          sql: unknown;
          cypher: unknown;
          equivalentRows: number;
        };
        return [key, { sql, cypher, equivalentRows }];
      }),
    );
    console.info(
      JSON.stringify(
        {
          samples,
          approvals: context.approvals,
          graphNodes,
          graphRelationships,
          workloads: summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await graphSession.close();
  }
  await sql.query('COMMIT');
} finally {
  await Promise.allSettled([sql.end(), graph.close()]);
}
