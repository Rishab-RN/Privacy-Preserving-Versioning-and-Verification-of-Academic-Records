import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { Document } from 'mongodb';
import { connectTestClient, fixture } from '../database/helpers.js';
import { quoteDatabaseName } from '../../apps/api/scripts/db/config.js';
import { openWorkerRuntime, workerConfig } from '../../apps/worker/src/runtime.js';
import { runBatch, replayJournal } from '../../apps/worker/src/runner.js';
import {
  projectEvent,
  digestPayload,
  PROJECTION_COLLECTIONS,
  ProjectionConflictError,
} from '../../apps/worker/src/projection.js';

test('restricted worker delivers, recovers and rebuilds committed projections', async (context) => {
  const database = process.env.TEST_MONGO_DATABASE ?? '';
  assert.match(database, /^scholarproof_test_[a-f0-9]{32}$/);
  const admin = await connectTestClient();
  context.after(() => admin.end());
  const rootMongo = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT ?? '57017'}`, {
    authSource: 'admin',
    auth: { username: process.env.MONGO_ROOT_USER!, password: process.env.MONGO_ROOT_PASSWORD! },
    serverSelectionTimeoutMS: 3000,
  });
  await rootMongo.connect();
  context.after(() => rootMongo.close());
  const rootDb = rootMongo.db(database);
  const runtime = await openWorkerRuntime(workerConfig());
  const second = await openWorkerRuntime(workerConfig());
  context.after(async () => {
    await Promise.all([runtime.close(), second.close()]);
  });
  type Row = Document & { _id: string };

  async function drain() {
    for (let index = 0; index < 100; index++) {
      const result = await runBatch(runtime.sql, runtime.db);
      assert.equal(result.failed, 0);
      if (!result.claimed) return;
    }
    throw new Error('Test queue did not drain');
  }
  async function createHistory() {
    const f = await fixture(admin);
    const proposer = randomBytes(32).toString('hex');
    const approver = randomBytes(32).toString('hex');
    const approverId = randomUUID();
    await admin.query(
      'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1::uuid,$1::uuid::text)',
      [approverId],
    );
    await admin.query(
      "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar')",
      [f.id('institution'), approverId],
    );
    await admin.query(
      'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2),($3,$4)',
      [proposer, f.id('author'), approver, approverId],
    );
    const evidence = randomUUID();
    await admin.query(
      "INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes) VALUES($1,$2,$3,$4,'supporting_note',$5,10)",
      [evidence, f.id('record'), f.id('author'), randomUUID(), randomBytes(32).toString('hex')],
    );
    await admin.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
      evidence,
    ]);
    async function transition(
      expected: number,
      points: string,
      from = '2000-01-01T00:00:00Z',
      reason = 'Synthetic worker fixture',
    ) {
      await admin.query('SET ROLE scholarproof_api_access');
      try {
        const proposed = await admin.query<{ id: string }>(
          "SELECT workflow.propose_change($1,$2,$3,$4,$5,'passed',$6,NULL,$7,$8) AS id",
          [proposer, f.id('record'), randomUUID(), expected, points, from, evidence, reason],
        );
        await admin.query(
          "SELECT workflow.approve_change($1,$2,'Synthetic independent approval')",
          [approver, proposed.rows[0]!.id],
        );
      } finally {
        await admin.query('RESET ROLE');
      }
    }
    return { f, transition };
  }
  const history = await createHistory();
  await history.transition(0, '6.00');
  await history.transition(1, '9.00', '2100-01-01T00:00:00Z');

  await context.test('normal delivery preserves future-effective SQL semantics', async () => {
    await drain();
    const head = await runtime.db
      .collection<Row>(PROJECTION_COLLECTIONS.heads)
      .findOne({ _id: history.f.id('record') });
    assert.equal(head?.latestRecordedVersion, 2);
    assert.equal(
      await runtime.db
        .collection(PROJECTION_COLLECTIONS.revisions)
        .countDocuments({ recordId: history.f.id('record') }),
      2,
    );
    const current = await admin.query(
      'SELECT version_no FROM academic.current_transcript WHERE record_id=$1',
      [history.f.id('record')],
    );
    assert.equal(current.rows[0]?.version_no, 1);
    assert.equal((await runBatch(runtime.sql, runtime.db)).claimed, 0);
  });
  await context.test(
    'late and duplicate events cannot regress a recorded-version head',
    async () => {
      const other = await createHistory();
      await other.transition(0, '6.00');
      await other.transition(1, '8.00');
      const events = await admin.query<{ payload: unknown }>(
        "SELECT payload FROM workflow.domain_event_context WHERE record_id=$1 AND kind='grade.accepted' ORDER BY (payload->'revision'->>'versionNo')::int",
        [other.f.id('record')],
      );
      await projectEvent(runtime.db, events.rows[1]!.payload);
      await projectEvent(runtime.db, events.rows[0]!.payload);
      await projectEvent(runtime.db, events.rows[1]!.payload);
      const head = await runtime.db
        .collection<Row>(PROJECTION_COLLECTIONS.heads)
        .findOne({ _id: other.f.id('record') });
      assert.equal(head?.latestRecordedVersion, 2);
      assert.equal(
        await runtime.db
          .collection(PROJECTION_COLLECTIONS.revisions)
          .countDocuments({ recordId: other.f.id('record') }),
        2,
      );
      await drain();
    },
  );
  await context.test(
    'receipt-only partial writes resume and expired leases reject stale acknowledgements',
    async () => {
      const other = await createHistory();
      await other.transition(0, '7.00');
      const claims = await runtime.sql.query<{
        event_id: string;
        lease_token: string;
        payload: unknown;
      }>('SELECT * FROM workflow.claim_deliveries(50,60)');
      assert.ok(claims.rows.length >= 2);
      const target = claims.rows.find(
        (row) => (row.payload as { kind: string }).kind === 'grade.accepted',
      )!;
      await runtime.db.collection<Row>(PROJECTION_COLLECTIONS.events).insertOne({
        _id: target.event_id,
        digestSha256: digestPayload(target.payload),
        payload: target.payload,
      });
      for (const row of claims.rows.filter((row) => row.event_id !== target.event_id)) {
        await projectEvent(runtime.db, row.payload);
        await runtime.sql.query('SELECT workflow.ack_delivery($1,$2)', [
          row.event_id,
          row.lease_token,
        ]);
      }
      await admin.query(
        "UPDATE workflow.outbox_delivery SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",
        [target.event_id],
      );
      const next = await second.sql.query<{
        event_id: string;
        lease_token: string;
        payload: unknown;
      }>('SELECT * FROM workflow.claim_deliveries(50,60)');
      const reclaimed = next.rows.find((row) => row.event_id === target.event_id)!;
      assert.ok(reclaimed);
      assert.notEqual(reclaimed.lease_token, target.lease_token);
      assert.equal(
        (
          await runtime.sql.query('SELECT workflow.ack_delivery($1,$2) AS ok', [
            target.event_id,
            target.lease_token,
          ])
        ).rows[0]?.ok,
        false,
      );
      assert.equal(
        (
          await runtime.sql.query(
            "SELECT workflow.fail_delivery($1,$2,'MONGO_UNAVAILABLE') AS ok",
            [target.event_id, target.lease_token],
          )
        ).rows[0]?.ok,
        false,
      );
      await projectEvent(second.db, reclaimed.payload);
      assert.equal(
        (
          await second.sql.query('SELECT workflow.ack_delivery($1,$2) AS ok', [
            reclaimed.event_id,
            reclaimed.lease_token,
          ])
        ).rows[0]?.ok,
        true,
      );
      const row = await admin.query(
        'SELECT attempt_count,failure_count,delivered_at FROM workflow.outbox_delivery WHERE event_id=$1',
        [target.event_id],
      );
      assert.equal(row.rows[0]?.attempt_count, 2);
      assert.equal(row.rows[0]?.failure_count, 0);
      assert.ok(row.rows[0]?.delivered_at);
    },
  );
  await context.test('two worker connections claim disjoint deliveries', async () => {
    const other = await createHistory();
    await other.transition(0, '6.00');
    const results = await Promise.all([
      runtime.sql.query('SELECT * FROM workflow.claim_deliveries(1,60)'),
      second.sql.query('SELECT * FROM workflow.claim_deliveries(1,60)'),
    ]);
    assert.equal(results[0].rowCount, 1);
    assert.equal(results[1].rowCount, 1);
    assert.notEqual(results[0].rows[0].event_id, results[1].rows[0].event_id);
    for (const result of results) {
      const row = result.rows[0];
      await projectEvent(runtime.db, row.payload);
      assert.equal(
        (
          await runtime.sql.query('SELECT workflow.ack_delivery($1,$2) AS ok', [
            row.event_id,
            row.lease_token,
          ])
        ).rows[0]?.ok,
        true,
      );
    }
  });
  await context.test('Mongo unavailability leaves durable work and retry recovers it', async () => {
    const other = await createHistory();
    await other.transition(0, '7.00');
    const unavailable = new MongoClient('mongodb://127.0.0.1:1', {
      serverSelectionTimeoutMS: 100,
      connectTimeoutMS: 100,
      socketTimeoutMS: 100,
    });
    try {
      const result = await runBatch(runtime.sql, unavailable.db(database));
      assert.ok(result.failed >= 2);
      assert.equal(result.delivered, 0);
    } finally {
      await unavailable.close();
    }
    const state = await admin.query(
      'SELECT d.last_error_code,d.delivered_at FROM workflow.outbox_delivery d JOIN workflow.domain_event_context e USING(event_id) WHERE e.record_id=$1',
      [other.f.id('record')],
    );
    assert.equal(
      state.rows.every(
        (row) => row.last_error_code === 'MONGO_UNAVAILABLE' && row.delivered_at === null,
      ),
      true,
    );
    await admin.query(
      'UPDATE workflow.outbox_delivery SET next_attempt_at=clock_timestamp() WHERE event_id IN (SELECT event_id FROM workflow.domain_event_context WHERE record_id=$1)',
      [other.f.id('record')],
    );
    await drain();
    assert.equal(
      (
        await runtime.db
          .collection<Row>(PROJECTION_COLLECTIONS.heads)
          .findOne({ _id: other.f.id('record') })
      )?.latestRecordedVersion,
      1,
    );
  });
  await context.test(
    'runtime cannot mutate immutable facts, and altered receipts are surfaced',
    async () => {
      const receipt = await runtime.db.collection<Row>(PROJECTION_COLLECTIONS.events).findOne({});
      assert.ok(receipt);
      await assert.rejects(
        runtime.db.collection<Row>(PROJECTION_COLLECTIONS.events).deleteOne({ _id: receipt._id }),
        (error: unknown) =>
          !!error && typeof error === 'object' && (error as { code?: number }).code === 13,
      );
      await assert.rejects(
        runtime.sql.query('UPDATE academic.grade_version SET grade_points=10'),
        (error: unknown) =>
          !!error && typeof error === 'object' && (error as { code?: string }).code === '42501',
      );
      await rootDb
        .collection<Row>(PROJECTION_COLLECTIONS.events)
        .updateOne(
          { _id: receipt._id },
          { $set: { 'payload.proposal.reason': 'Altered test receipt' } },
        );
      await assert.rejects(projectEvent(runtime.db, receipt.payload), ProjectionConflictError);
      await rootDb
        .collection<Row>(PROJECTION_COLLECTIONS.events)
        .replaceOne({ _id: receipt._id }, receipt);
    },
  );
  await context.test(
    'a controlled isolated projection reset rebuilds from the SQL journal',
    async () => {
      // The enclosing harness guarantees a freshly generated test database. Only
      // derived test documents are cleared; academic facts/evidence are untouched.
      for (const collection of Object.values(PROJECTION_COLLECTIONS))
        await rootDb.collection(collection).deleteMany({});
      const replayed = await replayJournal(runtime.sql, runtime.db);
      assert.ok(replayed > 0);
      assert.equal(
        await runtime.db.collection(PROJECTION_COLLECTIONS.events).countDocuments(),
        replayed,
      );
      const expected = await admin.query(
        "SELECT record_id,max((payload->'revision'->>'versionNo')::int) AS version FROM workflow.domain_event_context WHERE kind='grade.accepted' GROUP BY record_id",
      );
      for (const row of expected.rows)
        assert.equal(
          (
            await runtime.db
              .collection<Row>(PROJECTION_COLLECTIONS.heads)
              .findOne({ _id: row.record_id })
          )?.latestRecordedVersion,
          row.version,
        );
    },
  );
  await context.test('worker startup rejects database CREATE privilege drift', async () => {
    const identity = process.env.WORKER_POSTGRES_USER ?? '';
    assert.match(identity, /^scholarproof_jobs_[a-f0-9]{32}$/);
    const target = process.env.TEST_DATABASE_NAME!;
    await admin.query(
      `GRANT CREATE ON DATABASE ${quoteDatabaseName(target)} TO ${quoteDatabaseName(identity)}`,
    );
    try {
      await assert.rejects(openWorkerRuntime(workerConfig()), /Unsafe worker SQL identity/);
    } finally {
      await admin.query(
        `REVOKE CREATE ON DATABASE ${quoteDatabaseName(target)} FROM ${quoteDatabaseName(identity)}`,
      );
    }
    const restored = await openWorkerRuntime(workerConfig());
    await restored.close();
  });
  await context.test(
    'stopping after one delivery leaves unprocessed leases recoverable',
    async () => {
      const other = await createHistory();
      await other.transition(0, '6.00');
      let visited = 0;
      const stopped = await runBatch(runtime.sql, runtime.db, () => ++visited > 1);
      assert.equal(stopped.claimed, 2);
      assert.equal(stopped.delivered, 1);
      const pending = await admin.query(
        'SELECT d.event_id,d.lease_token FROM workflow.outbox_delivery d JOIN workflow.domain_event_context e USING(event_id) WHERE e.record_id=$1 AND d.delivered_at IS NULL',
        [other.f.id('record')],
      );
      assert.equal(pending.rowCount, 1);
      assert.ok(pending.rows[0]?.lease_token);
      await admin.query(
        "UPDATE workflow.outbox_delivery SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",
        [pending.rows[0]!.event_id],
      );
      await drain();
      assert.equal(
        (
          await runtime.db
            .collection<Row>(PROJECTION_COLLECTIONS.heads)
            .findOne({ _id: other.f.id('record') })
        )?.latestRecordedVersion,
        1,
      );
    },
  );
  await context.test('SQL-valid Unicode reasons fit the Mongo revision profile', async () => {
    const other = await createHistory();
    const reason = '😀'.repeat(500);
    await other.transition(0, '7.00', '2000-01-01T00:00:00Z', reason);
    await drain();
    const revision = await runtime.db
      .collection<Row>(PROJECTION_COLLECTIONS.revisions)
      .findOne({ _id: `${other.f.id('record')}:1` });
    assert.equal((revision?.revision as { reason?: string })?.reason, reason);
  });
});
