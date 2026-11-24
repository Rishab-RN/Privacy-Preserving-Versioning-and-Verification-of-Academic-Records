import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Client } from 'pg';
import { connectTestClient, fixture } from './helpers.js';

const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: string }).code === expected;
const digest = () => randomBytes(32).toString('hex');

async function api<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  await client.query('SET ROLE scholarproof_api_access');
  try {
    return await operation();
  } finally {
    await client.query('RESET ROLE');
  }
}

async function worker<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  await client.query('SET ROLE scholarproof_worker_access');
  try {
    return await operation();
  } finally {
    await client.query('RESET ROLE');
  }
}

async function workflowFixture(client: Client) {
  const f = await fixture(client);
  async function actor(role: string, institution = f.id('institution'), disabled = false) {
    const id = randomUUID();
    const token = digest();
    await client.query(
      'INSERT INTO academic.app_user(user_id,auth_subject,account_state) VALUES($1::uuid,$1::uuid::text,$2)',
      [id, disabled ? 'disabled' : 'active'],
    );
    await client.query(
      'INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,$3)',
      [institution, id, role],
    );
    await client.query(
      'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
      [token, id],
    );
    return { id, token };
  }
  const proposer = { id: f.id('author'), token: digest() };
  await client.query('INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)', [
    proposer.token,
    proposer.id,
  ]);
  const approver = await actor('registrar');
  const auditor = await actor('auditor');
  const student = await actor('student');
  const examiner = await actor('examiner');
  const foreign = await actor('registrar', f.id('otherInstitution'));
  const disabled = await actor('registrar', f.id('institution'), true);
  const evidenceId = randomUUID();
  await client.query(
    `INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
    VALUES($1,$2,$3,$4,'supporting_note',$5,128)`,
    [evidenceId, f.id('record'), proposer.id, randomUUID(), digest()],
  );
  await client.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
    evidenceId,
  ]);
  async function propose(
    options: {
      key?: string;
      expected?: number;
      points?: string | null;
      outcome?: string;
      from?: string;
      until?: string | null;
      evidence?: string;
      reason?: string;
      token?: string;
      record?: string;
    } = {},
  ) {
    const args = [
      options.token ?? proposer.token,
      options.record ?? f.id('record'),
      options.key ?? randomUUID(),
      options.expected ?? 0,
      options.points === undefined ? '7.00' : options.points,
      options.outcome ?? 'passed',
      options.from ?? '2026-01-01T00:00:00Z',
      options.until ?? null,
      options.evidence ?? evidenceId,
      options.reason ?? 'Synthetic proposed academic change',
    ];
    const result = await api(client, () =>
      client.query<{ request: string }>(
        'SELECT workflow.propose_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS request',
        args,
      ),
    );
    return result.rows[0]!.request;
  }
  async function approve(
    request: string,
    token = approver.token,
    reason = 'Synthetic independent approval',
    target = client,
  ) {
    const result = await api(target, () =>
      target.query<{ version: number }>('SELECT workflow.approve_change($1,$2,$3) AS version', [
        token,
        request,
        reason,
      ]),
    );
    return result.rows[0]!.version;
  }
  async function reject(request: string, token = approver.token, reason = 'Synthetic rejection') {
    await api(client, () =>
      client.query('SELECT workflow.reject_change($1,$2,$3)', [token, request, reason]),
    );
  }
  return {
    f,
    proposer,
    approver,
    auditor,
    student,
    examiner,
    foreign,
    disabled,
    evidenceId,
    propose,
    approve,
    reject,
  };
}

async function counts(client: Client, recordId: string) {
  return (
    await client.query(
      `SELECT
    (SELECT count(*)::int FROM academic.grade_version WHERE record_id=$1) AS versions,
    (SELECT latest_version_no FROM academic.grade_record WHERE record_id=$1) AS head,
    (SELECT count(*)::int FROM workflow.decision WHERE record_id=$1) AS decisions,
    (SELECT count(*)::int FROM workflow.domain_event_context WHERE record_id=$1) AS events,
    (SELECT count(*)::int FROM workflow.outbox_delivery d JOIN workflow.domain_event_context e USING(event_id) WHERE e.record_id=$1) AS deliveries`,
      [recordId],
    )
  ).rows[0];
}

test('an initial proposal freezes offering policy and credits before the first grade exists', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const request = await w.propose();
  const other = await client.query<{ scheme_id: string }>(
    "INSERT INTO academic.grading_scheme(institution_id,scheme_code,max_points,pass_points) VALUES($1,'OTHER',10,6) RETURNING scheme_id",
    [w.f.id('institution')],
  );
  await assert.rejects(
    client.query('UPDATE academic.course_offering SET credits=3 WHERE offering_id=$1', [
      w.f.id('offering'),
    ]),
    code('55000'),
  );
  await assert.rejects(
    client.query('UPDATE academic.course_offering SET scheme_id=$1 WHERE offering_id=$2', [
      other.rows[0]!.scheme_id,
      w.f.id('offering'),
    ]),
    code('55000'),
  );
  // A presentation label is not part of the frozen academic context.
  await client.query("UPDATE academic.course_offering SET section_code='B' WHERE offering_id=$1", [
    w.f.id('offering'),
  ]);
  assert.equal(await w.approve(request), 1);
});

test('two registrars issue, partially correct and future-date grades without changing historical answers', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const initial = await w.propose({ points: '6.00' });
  assert.deepEqual(await counts(client, w.f.id('record')), {
    versions: 0,
    head: null,
    decisions: 0,
    events: 1,
    deliveries: 1,
  });
  assert.equal(await w.approve(initial), 1);
  const originalKnown = await w.f.recorded(1);
  const partial = await w.propose({
    expected: 1,
    points: '9.00',
    from: '2026-04-01T00:00:00Z',
    until: '2026-07-01T00:00:00Z',
  });
  assert.equal(await w.approve(partial), 2);
  const afterPartial = await w.f.recorded(2);
  assert.equal((await w.f.asOf(originalKnown, '2026-05-01T00:00:00Z'))[0]?.grade_points, '6.00');
  assert.equal((await w.f.asOf(afterPartial, '2026-05-01T00:00:00Z'))[0]?.grade_points, '9.00');
  assert.equal((await w.f.asOf(afterPartial, '2026-07-01T00:00:00Z'))[0]?.grade_points, '6.00');
  const future = await w.propose({ expected: 2, points: '10.00', from: '2100-01-01T00:00:00Z' });
  assert.equal(await w.approve(future), 3);
  const latestKnown = await w.f.recorded(3);
  assert.equal((await w.f.asOf(latestKnown, '2026-05-01T00:00:00Z'))[0]?.version_no, 2);
  assert.equal((await w.f.asOf(latestKnown, '2100-01-01T00:00:00Z'))[0]?.version_no, 3);
  const event = await client.query<{
    payload: {
      kind: string;
      proposerId: string;
      actorId: string;
      evidence: { evidenceId: string };
      revision: { versionNo: number; gradePoints: string };
    };
  }>("SELECT payload FROM workflow.domain_event WHERE request_id=$1 AND kind='grade.accepted'", [
    future,
  ]);
  assert.equal(event.rows[0]?.payload.kind, 'grade.accepted');
  assert.equal(event.rows[0]?.payload.proposerId, w.proposer.id);
  assert.equal(event.rows[0]?.payload.actorId, w.approver.id);
  assert.equal(event.rows[0]?.payload.evidence.evidenceId, w.evidenceId);
  assert.equal(event.rows[0]?.payload.revision.versionNo, 3);
  assert.equal(event.rows[0]?.payload.revision.gradePoints, '10.00');
  assert.deepEqual(await counts(client, w.f.id('record')), {
    versions: 3,
    head: 3,
    decisions: 3,
    events: 6,
    deliveries: 6,
  });
});

test('proposal and decision retries are exact and rejection does not create a grade', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const key = randomUUID();
  const request = await w.propose({ key });
  assert.equal(await w.propose({ key, points: '7' }), request);
  await assert.rejects(w.propose({ key, points: '8.00' }), code('23505'));
  assert.equal(await w.approve(request), 1);
  // An exact proposal retry remains valid after its expected version is no longer the head.
  assert.equal(await w.propose({ key }), request);
  assert.equal(await w.approve(request), 1);
  await assert.rejects(
    w.approve(request, w.approver.token, 'Changed approval reason'),
    code('55000'),
  );
  await assert.rejects(w.reject(request), code('55000'));
  const rejected = await w.propose({ expected: 1, points: null, outcome: 'incomplete' });
  await w.reject(rejected);
  await w.reject(rejected);
  await assert.rejects(w.approve(rejected), code('55000'));
  assert.deepEqual(await counts(client, w.f.id('record')), {
    versions: 1,
    head: 1,
    decisions: 2,
    events: 4,
    deliveries: 4,
  });
  const result = await api(client, () =>
    client.query<{ state: unknown }>('SELECT workflow.get_change($1,$2) AS state', [
      w.auditor.token,
      rejected,
    ]),
  );
  assert.ok(result.rows[0]?.state);
});

test('workflow checks live sessions, institutional roles, separate approval and evidence binding', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const expired = digest();
  const revoked = digest();
  await client.query(
    `INSERT INTO access_control.api_session(token_digest,user_id,created_at,expires_at)
     VALUES($1,$2,statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour')`,
    [expired, w.approver.id],
  );
  await client.query('INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)', [
    revoked,
    w.approver.id,
  ]);
  await client.query(
    'UPDATE access_control.api_session SET revoked_at=clock_timestamp() WHERE token_digest=$1',
    [revoked],
  );
  for (const token of [digest(), w.disabled.token, expired, revoked])
    await assert.rejects(w.propose({ token }), code('28000'));
  for (const actor of [w.student, w.examiner, w.auditor])
    await assert.rejects(w.propose({ token: actor.token }), code('42501'));
  await assert.rejects(w.propose({ token: w.foreign.token }), code('P0002'));
  const request = await w.propose();
  await assert.rejects(w.approve(request, w.proposer.token), code('42501'));
  await assert.rejects(w.approve(request, w.foreign.token), code('P0002'));
  await assert.rejects(w.approve(request, w.disabled.token), code('28000'));
  await assert.rejects(
    api(client, () =>
      client.query('SELECT workflow.get_change($1,$2)', [w.foreign.token, request]),
    ),
    code('P0002'),
  );
  await assert.rejects(
    api(client, () =>
      client.query('SELECT workflow.get_change($1,$2)', [w.student.token, request]),
    ),
    code('42501'),
  );
  await client.query(
    "DELETE FROM academic.role_assignment WHERE user_id=$1 AND role_code='registrar'",
    [w.approver.id],
  );
  await assert.rejects(w.approve(request), code('42501'));
  const pending = randomUUID();
  await client.query(
    `INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
    VALUES($1,$2,$3,$4,'supporting_note',$5,128)`,
    [pending, w.f.id('record'), w.proposer.id, randomUUID(), digest()],
  );
  await assert.rejects(w.propose({ evidence: pending }), code('23514'));
  const other = await workflowFixture(client);
  await assert.rejects(w.propose({ evidence: other.evidenceId }), code('23514'));
  await assert.rejects(w.propose({ points: '7.001' }), code('22023'));
  await assert.rejects(w.propose({ reason: ' '.repeat(600) + 'valid' }), code('22023'));
  await assert.rejects(
    w.approve(request, w.proposer.token, ' '.repeat(600) + 'valid'),
    code('22023'),
  );
  await assert.rejects(
    w.reject(request, w.proposer.token, ' '.repeat(600) + 'valid'),
    code('22023'),
  );
  await assert.rejects(w.propose({ points: '11.00' }), code('23514'));
  await assert.rejects(w.propose({ points: '4.00', outcome: 'passed' }), code('23514'));
  await assert.rejects(w.propose({ points: null, outcome: 'passed' }), code('23514'));
  await assert.rejects(w.propose({ points: '7.00', outcome: 'withdrawn' }), code('23514'));
  await assert.rejects(w.propose({ from: 'infinity' }), code('22023'));
  await assert.rejects(w.propose({ from: '10000-01-01T00:00:00Z' }), code('22023'));
  await assert.rejects(
    w.propose({ from: '2026-07-01T00:00:00Z', until: '2026-04-01T00:00:00Z' }),
    code('22023'),
  );
  assert.deepEqual(await counts(client, w.f.id('record')), {
    versions: 0,
    head: null,
    decisions: 0,
    events: 1,
    deliveries: 1,
  });
});

test('competing approvals produce one next revision and one expected-version conflict', async (context) => {
  const client = await connectTestClient();
  const other = await connectTestClient();
  context.after(async () => {
    await Promise.all([client.end(), other.end()]);
  });
  const w = await workflowFixture(client);
  await w.approve(await w.propose());
  const left = await w.propose({ expected: 1, points: '8.00' });
  const right = await w.propose({ expected: 1, points: '9.00' });
  const results = await Promise.allSettled([
    w.approve(left),
    w.approve(right, w.approver.token, 'Synthetic independent approval', other),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.equal(
    failed?.status === 'rejected' ? (failed.reason as { code: string }).code : undefined,
    '40001',
  );
  assert.deepEqual(await counts(client, w.f.id('record')), {
    versions: 2,
    head: 2,
    decisions: 2,
    events: 5,
    deliveries: 5,
  });
});

test('a failing outbox insert rolls back approval, revision, head, decision and accepted audit event', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const request = await w.propose();
  const before = await counts(client, w.f.id('record'));
  await client.query(`CREATE FUNCTION workflow.test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic transactional fault' USING ERRCODE='P0001'; END; $$;
    CREATE TRIGGER test_fail_outbox BEFORE INSERT ON workflow.outbox_delivery FOR EACH ROW EXECUTE FUNCTION workflow.test_fail_outbox()`);
  try {
    await assert.rejects(w.approve(request), code('P0001'));
    assert.deepEqual(await counts(client, w.f.id('record')), before);
  } finally {
    await client.query(
      'DROP TRIGGER IF EXISTS test_fail_outbox ON workflow.outbox_delivery; DROP FUNCTION IF EXISTS workflow.test_fail_outbox()',
    );
  }
  assert.equal(await w.approve(request), 1);
});

test('workflow functions resist hostile search paths while direct API writes and owner membership remain denied', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  await client.query(
    'CREATE TEMP TABLE grade_record(record_id uuid,latest_version_no integer); SET search_path=pg_temp,public',
  );
  try {
    const request = await w.propose();
    assert.equal(await w.approve(request), 1);
    await api(client, async () => {
      for (const statement of [
        'UPDATE academic.grade_version SET grade_points=9',
        'DELETE FROM workflow.change_request',
        'DELETE FROM workflow.decision',
        'DELETE FROM workflow.domain_event',
        'UPDATE workflow.outbox_delivery SET attempt_count=0',
        'SELECT * FROM workflow.claim_deliveries(1,30)',
      ])
        await assert.rejects(client.query(statement), code('42501'));
      await assert.rejects(w.f.append(1, 8), code('42501'));
      const membership = await client.query<{ member: boolean }>(
        "SELECT pg_has_role('scholarproof_api_access','scholarproof_workflow_owner','MEMBER') AS member",
      );
      assert.equal(membership.rows[0]?.member, false);
    });
  } finally {
    await client.query('RESET search_path; DROP TABLE IF EXISTS pg_temp.grade_record');
  }
});

interface Claimed {
  event_id: string;
  lease_token: string;
  attempt: number;
  payload: unknown;
}
async function claim(client: Client, limit = 50, seconds = 30) {
  return worker(
    client,
    async () =>
      (
        await client.query<Claimed>('SELECT * FROM workflow.claim_deliveries($1,$2)', [
          limit,
          seconds,
        ])
      ).rows,
  );
}
async function acknowledge(client: Client, event: string, lease: string) {
  return worker(
    client,
    async () =>
      (
        await client.query<{ accepted: boolean }>(
          'SELECT workflow.ack_delivery($1,$2) AS accepted',
          [event, lease],
        )
      ).rows[0]!.accepted,
  );
}

test('workers claim disjoint leases and expired workers cannot acknowledge or fail reclaimed deliveries', async (context) => {
  const client = await connectTestClient();
  const other = await connectTestClient();
  context.after(async () => {
    await Promise.all([client.end(), other.end()]);
  });
  const w = await workflowFixture(client);
  await w.propose();
  await w.propose();
  const [first] = await claim(client, 1);
  const [second] = await claim(other, 1);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.event_id, second.event_id);
  await client.query(
    "UPDATE workflow.outbox_delivery SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",
    [first.event_id],
  );
  assert.equal(await acknowledge(client, first.event_id, first.lease_token), false);
  const reclaimed = (await claim(other)).find((row) => row.event_id === first.event_id);
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.lease_token, first.lease_token);
  assert.equal(await acknowledge(client, first.event_id, first.lease_token), false);
  const staleFailure = await worker(client, () =>
    client.query<{ accepted: boolean }>('SELECT workflow.fail_delivery($1,$2,$3) AS accepted', [
      first.event_id,
      first.lease_token,
      'MONGO_UNAVAILABLE',
    ]),
  );
  assert.equal(staleFailure.rows[0]?.accepted, false);
  assert.equal(await acknowledge(other, reclaimed.event_id, reclaimed.lease_token), true);
  assert.equal(await acknowledge(other, reclaimed.event_id, reclaimed.lease_token), false);
  await assert.rejects(claim(client, 0), code('22023'));
  await assert.rejects(claim(client, 1, 4), code('22023'));
});

test('failed deliveries retain safe retry metadata and quarantine after eight attempts', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const request = await w.propose();
  const event = (
    await client.query<{ event_id: string }>(
      'SELECT event_id FROM workflow.domain_event WHERE request_id=$1',
      [request],
    )
  ).rows[0]!.event_id;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const rows = await claim(client);
    const target = rows.find((row) => row.event_id === event);
    assert.ok(target);
    assert.equal(target.attempt, attempt);
    for (const row of rows.filter((row) => row.event_id !== event))
      await acknowledge(client, row.event_id, row.lease_token);
    if (attempt === 1) {
      await assert.rejects(
        worker(client, () =>
          client.query('SELECT workflow.fail_delivery($1,$2,$3)', [
            event,
            target.lease_token,
            'UNTRUSTED ERROR CONTENT',
          ]),
        ),
        code('22023'),
      );
    }
    const failed = await worker(client, () =>
      client.query<{ accepted: boolean }>('SELECT workflow.fail_delivery($1,$2,$3) AS accepted', [
        event,
        target.lease_token,
        'MONGO_UNAVAILABLE',
      ]),
    );
    assert.equal(failed.rows[0]?.accepted, true);
    if (attempt < 8)
      await client.query(
        "UPDATE workflow.outbox_delivery SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
        [event],
      );
  }
  const row = (
    await client.query(
      'SELECT attempt_count,last_error_code,quarantined_at,lease_token,delivered_at FROM workflow.outbox_delivery WHERE event_id=$1',
      [event],
    )
  ).rows[0];
  assert.equal(row.attempt_count, 8);
  assert.equal(row.last_error_code, 'MONGO_UNAVAILABLE');
  assert.notEqual(row.quarantined_at, null);
  assert.equal(row.lease_token, null);
  assert.equal(row.delivered_at, null);
  assert.equal(
    (await claim(client)).some((item) => item.event_id === event),
    false,
  );
});
