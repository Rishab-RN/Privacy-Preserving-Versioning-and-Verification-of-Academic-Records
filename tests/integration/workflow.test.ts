import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { openDataRuntime, readDataConfig } from '../../apps/api/src/data-runtime.js';
import type { EvidenceStore } from '../../apps/api/src/evidence-store.js';
import { Platform } from '../../apps/api/src/platform.js';
import { digestToken, newToken } from '../../apps/api/src/security.js';
import { connectTestClient, fixture } from '../database/helpers.js';
import { quoteDatabaseName } from '../../apps/api/scripts/db/config.js';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}
interface Options {
  method?: 'GET' | 'POST';
  token?: string;
  key?: string;
  body?: unknown;
}
interface ChangeView {
  requestId: string;
  recordId: string;
  expectedVersion: number;
  currentVersion: number;
  stale: boolean;
  decision: null | {
    code: 'approved' | 'rejected';
    actorId: string;
    reason: string;
    versionNo: number | null;
  };
  deliveries: { eventId: string; kind: string; state: string; attempts: number }[];
}
const code = (result: HttpResult) => (result.body.error as { code?: string } | undefined)?.code;
const change = (result: HttpResult) => {
  assert.equal(typeof result.body.requestId, 'string');
  return result.body as unknown as ChangeView;
};

test('HTTP academic changes require distinct scoped registrars and retain durable delivery state', async (context) => {
  const database = process.env.TEST_DATABASE_NAME ?? '';
  assert.match(database, /^scholarproof_test_[a-f0-9]{32}$/);
  assert.equal(process.env.POSTGRES_DB, database);
  assert.equal(process.env.TEST_MONGO_DATABASE, database);
  const config = readDataConfig();
  assert.ok(config);
  const admin = await connectTestClient();
  const resources: { runtime?: Awaited<ReturnType<typeof openDataRuntime>> } = {};
  const servers: Server[] = [];
  context.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
    await resources.runtime?.close();
    await admin.end();
  });
  const f = await fixture(admin);
  const other = await fixture(admin);
  async function session(userId: string) {
    const token = newToken();
    await admin.query(
      'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
      [digestToken(token), userId],
    );
    return token;
  }
  async function actor(role: string, institutionId = f.id('institution'), disabled = false) {
    const userId = randomUUID();
    await admin.query(
      'INSERT INTO academic.app_user(user_id,auth_subject,account_state) VALUES($1,$2,$3)',
      [userId, `test:workflow:${randomUUID()}`, disabled ? 'disabled' : 'active'],
    );
    await admin.query(
      'INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,$3)',
      [institutionId, userId, role],
    );
    return { userId, token: await session(userId) };
  }
  const proposer = { userId: f.id('author'), token: await session(f.id('author')) };
  const approver = await actor('registrar');
  const student = await actor('student');
  const auditor = await actor('auditor');
  const examiner = await actor('examiner');
  const foreign = await actor('registrar', other.id('institution'));
  const disabled = await actor('registrar', f.id('institution'), true);
  await admin.query('UPDATE academic.student SET user_id=$1 WHERE student_id=$2', [
    student.userId,
    f.id('student'),
  ]);
  const runtime = await openDataRuntime(config);
  resources.runtime = runtime;
  async function start(platform: Platform) {
    const server = createApp(platform).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return async (path: string, options: Options = {}): Promise<HttpResult> => {
      const headers = new Headers();
      if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
      if (options.key) headers.set('Idempotency-Key', options.key);
      if (options.method === 'POST') headers.set('Content-Type', 'application/json');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
        method: options.method ?? 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
        headers: response.headers,
      };
    };
  }
  const request = await start(runtime.platform);
  const proposalPath = `/records/${f.id('record')}/change-requests`;
  const approveReason = 'Independent synthetic registrar review';
  let evidenceId = '';
  let initialRequest = '';
  let initialKey = '';
  const body = (expectedVersion: number, gradePoints = '6.00', evidence = evidenceId) => ({
    expectedVersion,
    gradePoints,
    outcome: 'passed',
    validFrom: '2000-01-01T00:00:00Z',
    validUntil: null,
    evidenceId: evidence,
    reason: 'Synthetic proposed academic value',
  });
  const post = (path: string, token: string, value: unknown, key?: string) =>
    request(path, {
      method: 'POST',
      token,
      body: value,
      ...(key ? { key } : {}),
    });
  const propose = (value: unknown, token = proposer.token, key: string = randomUUID()) =>
    post(proposalPath, token, value, key);
  const approve = (id: string, token = approver.token, reason = approveReason) =>
    post(`/change-requests/${id}/approve`, token, { reason });
  const gradeCount = async () =>
    (
      await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM academic.grade_version WHERE record_id=$1',
        [f.id('record')],
      )
    ).rows[0]!.count;

  await context.test(
    'available evidence and a proposal leave academic facts untouched until independent approval',
    async () => {
      const preparation = await request(`/records/${f.id('record')}/change-context`, {
        token: proposer.token,
      });
      assert.equal(preparation.status, 200);
      assert.deepEqual(preparation.body, {
        recordId: f.id('record'),
        latestRecordedVersion: 0,
      });
      const evidence = await post(
        `/records/${f.id('record')}/evidence`,
        proposer.token,
        {
          schemaVersion: 1,
          category: 'supporting_note',
          data: { note: 'Synthetic registrar review evidence' },
        },
        randomUUID(),
      );
      assert.equal(evidence.status, 201);
      assert.equal(typeof evidence.body.evidenceId, 'string');
      evidenceId = evidence.body.evidenceId as string;
      initialKey = randomUUID();
      const result = await propose(body(0), proposer.token, initialKey);
      assert.equal(result.status, 201);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      const view = change(result);
      initialRequest = view.requestId;
      assert.equal(view.currentVersion, 0);
      assert.equal(view.decision, null);
      assert.equal(view.deliveries.length, 1);
      assert.equal(view.deliveries[0]?.state, 'pending');
      assert.equal(await gradeCount(), 0);
      const retried = await propose(body(0, '6'), proposer.token, initialKey);
      assert.equal(retried.status, 201);
      assert.equal(change(retried).requestId, initialRequest);
      const conflict = await propose(body(0, '8.00'), proposer.token, initialKey);
      assert.equal(conflict.status, 409);
      assert.equal(code(conflict), 'IDEMPOTENCY_CONFLICT');
    },
  );

  await context.test(
    'HTTP role, tenant, session and strict-input checks reject unauthorized transitions',
    async () => {
      const preparationPath = `/records/${f.id('record')}/change-context`;
      for (const token of [student.token, auditor.token, examiner.token]) {
        assert.equal((await propose(body(0), token)).status, 403);
        assert.equal((await approve(initialRequest, token)).status, 403);
        assert.equal((await request(preparationPath, { token })).status, 403);
      }
      assert.equal((await request(preparationPath)).status, 401);
      assert.equal((await request(preparationPath, { token: disabled.token })).status, 401);
      assert.equal((await request(preparationPath, { token: foreign.token })).status, 404);
      assert.equal(
        (await request('/records/not-a-uuid/change-context', { token: proposer.token })).status,
        400,
      );
      const revoked = await session(proposer.userId);
      await admin.query(
        'UPDATE access_control.api_session SET revoked_at=clock_timestamp() WHERE token_digest=$1',
        [digestToken(revoked)],
      );
      assert.equal((await request(preparationPath, { token: revoked })).status, 401);
      // A registrar role elsewhere must not turn a linked student into an
      // institutional registrar through the evidence endpoint's broader scope.
      await admin.query(
        "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar')",
        [other.id('institution'), student.userId],
      );
      try {
        assert.equal((await request(preparationPath, { token: student.token })).status, 404);
      } finally {
        await admin.query(
          "DELETE FROM academic.role_assignment WHERE institution_id=$1 AND user_id=$2 AND role_code='registrar'",
          [other.id('institution'), student.userId],
        );
      }
      assert.equal((await propose(body(0), foreign.token)).status, 404);
      assert.equal((await approve(initialRequest, foreign.token)).status, 404);
      assert.equal((await approve(initialRequest, disabled.token)).status, 401);
      assert.equal((await approve(initialRequest, proposer.token)).status, 403);
      assert.equal(
        (await request(`/change-requests/${initialRequest}`, { token: student.token })).status,
        403,
      );
      assert.equal(
        (await request(`/change-requests/${initialRequest}`, { token: foreign.token })).status,
        404,
      );
      assert.equal((await request(`/change-requests/${initialRequest}`)).status, 401);
      assert.equal((await post(proposalPath, proposer.token, body(0))).status, 400);
      assert.equal((await propose({ ...body(0), authorId: approver.userId })).status, 400);
      assert.equal((await propose({ ...body(0), gradePoints: 7 })).status, 400);
      assert.equal((await propose({ ...body(0), gradePoints: '11.00' })).status, 400);
      assert.equal(
        (await propose({ ...body(0), validFrom: '2000-01-01T00:00:00.1234567Z' })).status,
        400,
      );
      assert.equal((await approve('not-a-uuid')).status, 400);
      assert.equal(await gradeCount(), 0);
    },
  );

  await context.test('pending or wrong-record evidence cannot authorize a change', async () => {
    for (const [recordId, available] of [
      [f.id('record'), false],
      [other.id('record'), true],
    ] as const) {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO evidence.reference
        (evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
        VALUES($1,$2,$3,$4,'supporting_note',$5,128)`,
        [id, recordId, proposer.userId, randomUUID(), randomBytes(32).toString('hex')],
      );
      if (available)
        await admin.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
          id,
        ]);
      const result = await propose(body(0, '7.00', id));
      assert.equal(result.status, 400);
      assert.equal(code(result), 'INVALID_CHANGE');
    }
    assert.equal(await gradeCount(), 0);
  });

  await context.test(
    'independent approval commits once and exposes pending delivery without lease secrets',
    async () => {
      const result = await approve(initialRequest);
      assert.equal(result.status, 202);
      const view = change(result);
      assert.equal(view.decision?.code, 'approved');
      assert.equal(view.decision?.actorId, approver.userId);
      assert.equal(view.decision?.versionNo, 1);
      assert.equal(view.currentVersion, 1);
      assert.equal(view.deliveries.length, 2);
      assert.ok(view.deliveries.every((delivery) => delivery.state === 'pending'));
      assert.equal(JSON.stringify(result.body).includes('lease_token'), false);
      assert.equal(JSON.stringify(result.body).includes('leaseToken'), false);
      assert.equal((await approve(initialRequest)).status, 202);
      assert.equal((await propose(body(0), proposer.token, initialKey)).status, 201);
      assert.equal(await gradeCount(), 1);
      const events = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM workflow.domain_event WHERE request_id=$1 AND kind='grade.accepted'",
        [initialRequest],
      );
      assert.equal(events.rows[0]?.count, 1);
      const different = await approve(initialRequest, approver.token, 'Different review input');
      assert.equal(different.status, 409);
      assert.equal(code(different), 'DECISION_CONFLICT');
    },
  );

  await context.test(
    'rejection is immutable and auditor reads do not grant workflow writes',
    async () => {
      const proposed = await propose(body(1, '8.00'));
      assert.equal(proposed.status, 201);
      const id = change(proposed).requestId;
      const input = { reason: 'Synthetic correction rejected after review' };
      assert.equal(
        (await post(`/change-requests/${id}/reject`, approver.token, input)).status,
        200,
      );
      assert.equal(
        (await post(`/change-requests/${id}/reject`, approver.token, input)).status,
        200,
      );
      assert.equal((await approve(id)).status, 409);
      const audited = await request(`/change-requests/${id}`, { token: auditor.token });
      assert.equal(audited.status, 200);
      assert.equal(change(audited).decision?.code, 'rejected');
      assert.equal(change(audited).decision?.versionNo, null);
      assert.equal((await post(`/change-requests/${id}/reject`, auditor.token, input)).status, 403);
      assert.equal(await gradeCount(), 1);
    },
  );

  await context.test(
    'simultaneous HTTP approvals have one winner and one explicit version conflict',
    async () => {
      const first = change(await propose(body(1, '7.00'))).requestId;
      const second = change(await propose(body(1, '9.00'))).requestId;
      const results = await Promise.all([approve(first), approve(second)]);
      assert.deepEqual(results.map((result) => result.status).sort(), [202, 409]);
      assert.equal(code(results.find((result) => result.status === 409)!), 'VERSION_CONFLICT');
      assert.equal(await gradeCount(), 2);
      const loser = results[0]!.status === 409 ? first : second;
      const status = await request(`/change-requests/${loser}`, { token: proposer.token });
      assert.equal(change(status).stale, true);
      assert.equal(change(status).decision, null);
    },
  );

  await context.test(
    'future-effective approval does not replace the effective transcript grade',
    async () => {
      const result = await propose({ ...body(2, '10.00'), validFrom: '2100-01-01T00:00:00Z' });
      assert.equal(result.status, 201);
      const accepted = await approve(change(result).requestId);
      assert.equal(accepted.status, 202);
      assert.equal(change(accepted).currentVersion, 3);
      const preparation = await request(`/records/${f.id('record')}/change-context`, {
        token: proposer.token,
      });
      assert.equal(preparation.status, 200);
      assert.equal(preparation.body.latestRecordedVersion, 3);
      const known = await admin.query<{ known: string }>(
        `SELECT to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS known
      FROM academic.grade_version WHERE record_id=$1 AND version_no=3`,
        [f.id('record')],
      );
      const query = new URLSearchParams({
        knownAt: known.rows[0]!.known,
        effectiveAt: '2026-06-01T00:00:00Z',
      });
      const transcript = await request(`/students/${f.id('student')}/transcript?${query}`, {
        token: student.token,
      });
      assert.equal(transcript.status, 200);
      const records = transcript.body.records as { record_id: string; version_no: number }[];
      assert.equal(records.find((record) => record.record_id === f.id('record'))?.version_no, 2);
      assert.equal(await gradeCount(), 3);
    },
  );

  await context.test(
    'a SQL-confirmed evidence manifest permits durable approval while Mongo is unavailable',
    async () => {
      let documentCalls = 0;
      const unavailable: EvidenceStore = {
        put: async () => {
          documentCalls++;
          throw new Error('Synthetic unavailable store');
        },
        get: async () => {
          documentCalls++;
          throw new Error('Synthetic unavailable store');
        },
      };
      const degraded = await start(new Platform(runtime.platform.repository, unavailable));
      const proposed = await propose(body(3, '8.00'));
      assert.equal(proposed.status, 201);
      const id = change(proposed).requestId;
      const result = await degraded(`/change-requests/${id}/approve`, {
        method: 'POST',
        token: approver.token,
        body: { reason: approveReason },
      });
      assert.equal(result.status, 202);
      assert.equal(change(result).decision?.versionNo, 4);
      assert.ok(change(result).deliveries.every((delivery) => delivery.state === 'pending'));
      assert.equal(documentCalls, 0);
      assert.equal(await gradeCount(), 4);
      const unknown = await request('/not-an-implemented-route', { token: approver.token });
      assert.equal(unknown.status, 404);
    },
  );
  await context.test('HTTP reason limits match PostgreSQL Unicode codepoints', async () => {
    assert.equal((await propose({ ...body(4), reason: '😀'.repeat(501) })).status, 400);
    const proposed = await propose({ ...body(4), reason: '😀'.repeat(500) });
    assert.equal(proposed.status, 201);
    const path = `/change-requests/${change(proposed).requestId}/reject`;
    assert.equal((await post(path, approver.token, { reason: '😀'.repeat(501) })).status, 400);
    assert.equal((await post(path, approver.token, { reason: '😀'.repeat(500) })).status, 200);
    assert.equal(await gradeCount(), 4);
  });
  await context.test('startup rejects database CREATE privileges on the API identity', async () => {
    const identity = process.env.API_POSTGRES_USER ?? '';
    assert.match(identity, /^scholarproof_http_[a-f0-9]{32}$/);
    // All names are the generated harness resources; no development grant changes.
    await admin.query(
      `GRANT CREATE ON DATABASE ${quoteDatabaseName(database)} TO ${quoteDatabaseName(identity)}`,
    );
    try {
      await assert.rejects(openDataRuntime(config), /permissions could not be verified/);
    } finally {
      await admin.query(
        `REVOKE CREATE ON DATABASE ${quoteDatabaseName(database)} FROM ${quoteDatabaseName(identity)}`,
      );
    }
    const restored = await openDataRuntime(config);
    await restored.close();
  });
});
