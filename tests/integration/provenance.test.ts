import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import { fixture, connectTestClient } from '../database/helpers.js';
import { createApp } from '../../apps/api/src/app.js';
import { openDataRuntime, readDataConfig } from '../../apps/api/src/data-runtime.js';
import { digestToken, newToken } from '../../apps/api/src/security.js';
import {
  cursorFor,
  extractGraphFeatures,
  openGraph,
  priorFeatures,
  rebuild,
  review,
  setupSchema,
  syncOnce,
} from '../../apps/api/src/provenance/graph.js';
import { readSource } from '../../apps/api/src/provenance/source.js';
import { reviewSql } from '../../apps/api/scripts/graph/baseline.js';

test(
  'Neo4j projection reconciles outbox order, SQL answers, bounded features and reviewer scope',
  {
    skip: !process.env.GRAPH_NEO4J_PASSWORD && 'Graph configuration unavailable',
  },
  async (t) => {
    const graph = openGraph()!;
    const admin = await connectTestClient();
    t.after(() => admin.end());
    const f = await fixture(admin),
      other = await fixture(admin);
    const scope = f.id('institution'),
      outside = other.id('institution'),
      recordId = f.id('record');
    t.after(async () => {
      try {
        await graph.executeQuery('MATCH (n:Prov {scope:$scope}) DETACH DELETE n', { scope });
        await graph.executeQuery('MATCH (h:ProvenanceHead {key:$scope}) DELETE h', { scope });
      } finally {
        await graph.close();
      }
    });
    const config = readDataConfig();
    assert.ok(config);
    const worker = new Pool({
      host: '127.0.0.1',
      port: config.port,
      database: config.database,
      user: process.env.WORKER_POSTGRES_USER!,
      password: process.env.WORKER_POSTGRES_PASSWORD!,
    });
    t.after(() => worker.end());
    const runtime = await openDataRuntime(config);
    t.after(() => runtime.close());
    await setupSchema(graph);
    const approverId = randomUUID(),
      auditorId = randomUUID();
    await admin.query(
      'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$1::uuid::text),($2,$2::uuid::text)',
      [approverId, auditorId],
    );
    await admin.query(
      "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar'),($1,$3,'auditor')",
      [scope, approverId, auditorId],
    );
    async function session(actor: string) {
      const token = newToken();
      await admin.query(
        'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
        [digestToken(token), actor],
      );
      return token;
    }
    const requester = await session(f.id('author')),
      approver = await session(approverId);
    const reviewer = await session(auditorId),
      foreign = await session(other.id('author'));
    const evidenceId = randomUUID();
    const hash = 'e'.repeat(64);
    await admin.query(
      "INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes) VALUES($1,$2,$3,$4,'supporting_note',$5,24)",
      [evidenceId, recordId, f.id('author'), randomUUID(), hash],
    );
    await admin.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
      evidenceId,
    ]);
    async function approve(expected: number, points: number) {
      const request = (
        await admin.query<{ id: string }>(
          "SELECT workflow.propose_change($1,$2,$3,$4,$5,'passed','2026-01-01',NULL,$6,'Synthetic graph fixture') AS id",
          [digestToken(requester), recordId, randomUUID(), expected, points, evidenceId],
        )
      ).rows[0]!.id;
      await admin.query(
        "SELECT workflow.approve_change($1,$2,'Independent graph fixture approval')",
        [digestToken(approver), request],
      );
      return request;
    }
    await f.append(0, 6);
    const one = await approve(1, 7);
    const two = await approve(2, 8.5);
    const server = createApp(runtime.platform, graph).listen(0, '127.0.0.1');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/provenance`;
    const get = (institution: string, token: string, query = '') =>
      fetch(`${endpoint}/${institution}${query}`, {
        headers: { Authorization: 'Bearer ' + token },
      });
    const target = `?recordId=${recordId}&version=3`;
    await t.test('review is tenant-scoped and reports lag before a graph sync', async () => {
      assert.equal((await get(scope, foreign, target)).status, 404);
      assert.equal((await get(outside, reviewer, target)).status, 404);
      const response = await get(scope, reviewer, target);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'lagging');
      await assert.rejects(
        runtime.platform.repository.sql.query('SELECT * FROM provenance.approved_fact'),
        { code: '42501' },
      );
      await assert.rejects(worker.query('SELECT * FROM provenance.approved_fact'), {
        code: '42501',
      });
    });
    await t.test(
      'anomaly snapshots are read-only and restricted to the reviewer institution',
      async () => {
        assert.equal((await get(scope, foreign, '/anomalies' + target)).status, 404);
        assert.equal((await get(outside, reviewer, '/anomalies' + target)).status, 404);
        assert.equal((await get(scope, reviewer, '/anomalies?version=3')).status, 400);
        const empty = await get(scope, reviewer, '/anomalies' + target);
        assert.equal(empty.status, 200);
        assert.deepEqual(await empty.json(), {
          status: 'unavailable',
          committed: 4,
          reason: 'missing-snapshot',
        });
      },
    );

    await t.test(
      'two overlapping workers and a duplicate retry produce one exact graph',
      async () => {
        await Promise.all([syncOnce(graph, worker, scope), syncOnce(graph, worker, scope)]);
        const retry = await syncOnce(graph, worker, scope);
        assert.equal(retry.advanced, false);
        assert.equal(retry.through, 4);
        const tomorrow = new Date(Date.now() + 86400000),
          from = new Date(Date.now() - 86400000);
        const { head, ...result } = await review(graph, scope, from, tomorrow, {
          recordId,
          version: 3,
        });
        assert.equal(head.cursor, 4);
        assert.deepEqual(result, await reviewSql(admin, scope, from, tomorrow, recordId, 3));
        assert.deepEqual(
          result.ancestry.map((row) => [row.version, row.requestId]),
          [
            [3, two],
            [2, one],
            [1, null],
          ],
        );
        assert.equal(result.pairings[0]?.count, 2);
        assert.equal(result.upward[0]?.deltaHundredths, 250);
        assert.equal(result.evidenceReuse[0]?.digest, hash);
        const picked = await priorFeatures(graph, scope, two, from);
        assert.equal(picked?.priorPairCount, 1);
        assert.equal(picked?.priorEvidenceCount, 1);
        const response = await get(scope, reviewer, target);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, 'current');
      },
    );

    await t.test(
      'Neo4j unavailability leaves approvals durable and recovery catches up',
      async () => {
        const unreachable = openGraph({ ...process.env, GRAPH_NEO4J_PORT: '1' })!;
        try {
          await assert.rejects(syncOnce(unreachable, worker, scope));
        } finally {
          await unreachable.close();
        }
        await approve(3, 8);
        const pending = await get(scope, reviewer, target);
        assert.equal((await pending.json()).status, 'lagging');
        await syncOnce(graph, worker, scope);
        assert.equal((await cursorFor(graph, scope)).cursor, 6);
        const snapshot = await readSource(worker, scope, 0);
        await assert.rejects(rebuild(graph, scope, 4, snapshot.facts.slice(0, 2)), /behind/);
        const before = await review(graph, scope, new Date(0), new Date(Date.now() + 86400000), {
          recordId,
          version: 4,
        });
        await rebuild(graph, scope, snapshot.size, snapshot.facts.toReversed());
        const after = await review(graph, scope, new Date(0), new Date(Date.now() + 86400000), {
          recordId,
          version: 4,
        });
        assert.deepEqual({ ...after, head: before.head }, before);
      },
    );
    await t.test(
      'anomaly counts exclude equal timestamps, late commits and events before the exact lower bound',
      async () => {
        const featureScope = randomUUID();
        const source = (await readSource(worker, scope, 0)).facts[0]!;
        const facts = [
          '2026-01-01T00:00:00.123455Z',
          '2026-01-01T00:00:00.123456Z',
          '2026-01-31T00:00:00.123456Z',
          '2026-01-31T00:00:00.123456Z',
          '2026-01-30T00:00:00.000000Z',
        ].map((occurred_at, position) => ({
          ...source,
          occurred_at,
          position,
          request_id: randomUUID(),
          event_id: randomUUID(),
          version_no: position + 2,
        }));
        try {
          await rebuild(graph, featureScope, facts.length, facts);
          const result = await extractGraphFeatures(graph, featureScope, facts.length, facts);
          assert.deepEqual(result.counts.get(facts[3]!.request_id), { pair30d: 1, evidence30d: 1 });
          await assert.rejects(
            extractGraphFeatures(graph, featureScope, facts.length + 1, facts),
            /must match the SQL snapshot/,
          );
        } finally {
          await graph.executeQuery('MATCH (n:Prov {scope:$scope}) DETACH DELETE n', {
            scope: featureScope,
          });
          await graph.executeQuery('MATCH (h:ProvenanceHead {key:$scope}) DELETE h', {
            scope: featureScope,
          });
        }
      },
    );
  },
);
