import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Client } from 'pg';
import { createDatabaseClient, quoteDatabaseName } from '../../apps/api/scripts/db/config.js';
import { applyMigrations, loadMigrations } from '../../apps/api/scripts/db/migrations.js';
import { connectTestClient, fixture } from './helpers.js';

const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: string }).code === expected;

async function asRole<T>(client: Client, role: string, action: () => Promise<T>) {
  assert.ok(
    [
      'scholarproof_api_access',
      'scholarproof_worker_access',
      'academic_log_reader',
      'academic_log_signer',
    ].includes(role),
  );
  await client.query(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await client.query('RESET ROLE');
  }
}

async function journalFixture(client: Client) {
  const f = await fixture(client);
  const evidence = randomUUID();
  await client.query(
    `INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
      VALUES($1,$2,$3,$4,'supporting_note',$5,128)`,
    [evidence, f.id('record'), f.id('author'), randomUUID(), randomBytes(32).toString('hex')],
  );
  await client.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
    evidence,
  ]);
  async function prepare(target = client, createdAt?: string) {
    const request = randomUUID();
    await target.query(
      `INSERT INTO workflow.change_request(request_id,proposer_id,idempotency_key,expected_version,
        grade_points,outcome,valid_during,reason,evidence_id,created_at)
        VALUES($1,$2,$3,0,7.00,'passed',tstzrange('2026-01-01',NULL,'[)'),
          'Synthetic transparency fixture',$4,coalesce($5::timestamptz,clock_timestamp()))`,
      [request, f.id('author'), randomUUID(), evidence, createdAt ?? null],
    );
    return request;
  }
  async function emit(target: Client, request: string) {
    const result = await target.query<{ event: string }>(
      "SELECT workflow.emit_event($1,$2,'request.submitted') AS event",
      [request, f.id('author')],
    );
    return result.rows[0]!.event;
  }
  return { f, evidence, prepare, emit };
}

async function workflowFixture(client: Client) {
  const j = await journalFixture(client);
  const proposerToken = randomBytes(32).toString('hex');
  const approverToken = randomBytes(32).toString('hex');
  const approver = randomUUID();
  await client.query(
    'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1::uuid,$1::uuid::text)',
    [approver],
  );
  await client.query(
    "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar')",
    [j.f.id('institution'), approver],
  );
  await client.query(
    'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2),($3,$4)',
    [proposerToken, j.f.id('author'), approverToken, approver],
  );
  async function propose(expected = 0) {
    const result = await asRole(client, 'scholarproof_api_access', () =>
      client.query<{ request: string }>(
        `SELECT workflow.propose_change($1,$2,$3,$4,7.00,'passed','2026-01-01',NULL,$5,
          'Synthetic transparency proposal') AS request`,
        [proposerToken, j.f.id('record'), randomUUID(), expected, j.evidence],
      ),
    );
    return result.rows[0]!.request;
  }
  async function approve(request: string) {
    await asRole(client, 'scholarproof_api_access', () =>
      client.query("SELECT workflow.approve_change($1,$2,'Synthetic independent approval')", [
        approverToken,
        request,
      ]),
    );
  }
  async function reject(request: string) {
    await asRole(client, 'scholarproof_api_access', () =>
      client.query("SELECT workflow.reject_change($1,$2,'Synthetic independent rejection')", [
        approverToken,
        request,
      ]),
    );
  }
  return { ...j, approver, propose, approve, reject };
}

async function backendPid(client: Client) {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

async function waitForBlock(observer: Client, waiterPid: number, holderPid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await observer.query<{ blocked: boolean }>(
      'SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',
      [waiterPid, holderPid],
    );
    if (result.rows[0]!.blocked) return;
    await delay(20);
  }
  assert.fail('The second institutional append did not wait for the first transaction');
}

const checkpointArgs = (institution: string, size: number) => [
  institution,
  size,
  randomBytes(32),
  '2026-11-25T10:11:12.123Z',
  randomBytes(32).toString('hex'),
  randomBytes(64),
];
const checkpointSql = 'SELECT * FROM transparency.record_checkpoint($1,$2,$3,$4,$5,$6)';

test('transparency storage has minimal BCNF keys and private runtime boundaries', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const columns = await client.query<{ table_name: string; columns: string[] }>(`
    SELECT c.relname AS table_name,array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='transparency' AND c.relkind='r' GROUP BY c.relname ORDER BY c.relname
  `);
  assert.deepEqual(columns.rows, [
    {
      table_name: 'checkpoint',
      columns: ['institution_id', 'tree_size', 'root_hash', 'issued_at', 'key_id', 'signature'],
    },
    {
      table_name: 'event_position',
      columns: ['event_id', 'institution_id', 'leaf_index', 'salt'],
    },
    { table_name: 'event_source', columns: ['event_id'] },
    { table_name: 'log_state', columns: ['institution_id', 'tree_size', 'bootstrap_size'] },
  ]);
  const keys = await client.query<{ relation: string; definition: string }>(`
    SELECT conrelid::regclass::text AS relation,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace='transparency'::regnamespace AND contype IN ('p','u')
    ORDER BY conrelid::regclass::text,pg_get_constraintdef(oid)
  `);
  assert.deepEqual(keys.rows, [
    { relation: 'transparency.checkpoint', definition: 'PRIMARY KEY (institution_id, tree_size)' },
    { relation: 'transparency.event_position', definition: 'PRIMARY KEY (event_id)' },
    {
      relation: 'transparency.event_position',
      definition: 'UNIQUE (institution_id, leaf_index)',
    },
    { relation: 'transparency.event_source', definition: 'PRIMARY KEY (event_id)' },
    { relation: 'transparency.log_state', definition: 'PRIMARY KEY (institution_id)' },
  ]);
  for (const role of ['scholarproof_api_access', 'scholarproof_worker_access']) {
    await asRole(client, role, async () => {
      await assert.rejects(
        client.query('SELECT * FROM transparency.event_position'),
        code('42501'),
      );
      await assert.rejects(
        client.query(checkpointSql, checkpointArgs(randomUUID(), 0)),
        code('42501'),
      );
    });
  }
  for (const role of ['academic_log_reader', 'academic_log_signer']) {
    await asRole(client, role, async () => {
      await client.query('SELECT * FROM transparency.event_position LIMIT 1');
      await client.query('SELECT * FROM workflow.outbox_delivery LIMIT 1');
      await assert.rejects(client.query('SELECT * FROM access_control.api_session'), code('42501'));
      await assert.rejects(
        client.query('SELECT * FROM access_control.password_credential'),
        code('42501'),
      );
      await assert.rejects(
        client.query('INSERT INTO workflow.domain_event(event_id) VALUES($1)', [randomUUID()]),
        code('42501'),
      );
      await assert.rejects(
        client.query('UPDATE transparency.log_state SET tree_size=tree_size+1'),
        code('42501'),
      );
      await assert.rejects(client.query('DELETE FROM transparency.checkpoint'), code('42501'));
    });
  }
  await asRole(client, 'academic_log_reader', async () => {
    await assert.rejects(
      client.query(checkpointSql, checkpointArgs(randomUUID(), 0)),
      code('42501'),
    );
  });
  const privateFunctions = await client.query<{ unsafe: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='transparency'::regnamespace
      AND p.proname IN ('sequence_event','random_salt','guard_log_state','guard_event_position')
      AND (has_function_privilege('academic_log_reader',p.oid,'EXECUTE')
        OR has_function_privilege('academic_log_signer',p.oid,'EXECUTE')
        OR has_function_privilege('scholarproof_api_access',p.oid,'EXECUTE')
        OR has_function_privilege('scholarproof_worker_access',p.oid,'EXECUTE'))) AS unsafe
  `);
  assert.equal(privateFunctions.rows[0]!.unsafe, false);
});

test('same-institution positions serialize commits while other institutions remain independent', async (context) => {
  const observer = await connectTestClient();
  const first = await connectTestClient();
  const second = await connectTestClient();
  context.after(async () => {
    await Promise.all([observer.end(), first.end(), second.end()]);
  });
  const j = await journalFixture(observer);
  const other = await journalFixture(observer);
  const firstRequest = await j.prepare();
  const secondRequest = await j.prepare();
  const otherRequest = await other.prepare();
  const firstPid = await backendPid(first);
  const secondPid = await backendPid(second);
  await first.query('BEGIN');
  await second.query('BEGIN');
  try {
    const firstEvent = await j.emit(first, firstRequest);
    const waiting = j.emit(second, secondRequest);
    await waitForBlock(observer, secondPid, firstPid);
    assert.equal(
      (
        await observer.query('SELECT * FROM transparency.log_state WHERE institution_id=$1', [
          j.f.id('institution'),
        ])
      ).rowCount,
      0,
    );
    await observer.query("SET statement_timeout='2s'");
    try {
      await other.emit(observer, otherRequest);
    } finally {
      await observer.query('RESET statement_timeout');
    }
    await first.query('COMMIT');
    const secondEvent = await waiting;
    await second.query('COMMIT');
    const rows = await observer.query<{ event_id: string; leaf_index: string; salt: Buffer }>(
      'SELECT event_id,leaf_index,salt FROM transparency.event_position WHERE institution_id=$1 ORDER BY leaf_index',
      [j.f.id('institution')],
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.event_id, row.leaf_index]),
      [
        [firstEvent, '0'],
        [secondEvent, '1'],
      ],
    );
    assert.ok(rows.rows.every((row) => Buffer.isBuffer(row.salt) && row.salt.length === 32));
    assert.notDeepEqual(rows.rows[0]!.salt, rows.rows[1]!.salt);
    const head = await observer.query(
      'SELECT tree_size,bootstrap_size FROM transparency.log_state WHERE institution_id=$1',
      [j.f.id('institution')],
    );
    assert.deepEqual(head.rows, [{ tree_size: '2', bootstrap_size: '0' }]);
  } finally {
    await first.query('ROLLBACK');
    await second.query('ROLLBACK');
  }
});

test('a rolled-back append leaves no visible event, salt, gap or advanced head', async (context) => {
  const observer = await connectTestClient();
  const first = await connectTestClient();
  const second = await connectTestClient();
  context.after(async () => {
    await Promise.all([observer.end(), first.end(), second.end()]);
  });
  const j = await journalFixture(observer);
  const secondRequest = await j.prepare();
  const firstPid = await backendPid(first);
  const secondPid = await backendPid(second);
  await first.query('BEGIN');
  await second.query('BEGIN');
  try {
    const firstRequest = await j.prepare(first);
    const removedEvent = await j.emit(first, firstRequest);
    const waiting = j.emit(second, secondRequest);
    await waitForBlock(observer, secondPid, firstPid);
    await first.query('ROLLBACK');
    const retainedEvent = await waiting;
    await second.query('COMMIT');
    assert.equal(
      (
        await observer.query('SELECT * FROM workflow.domain_event WHERE event_id=$1', [
          removedEvent,
        ])
      ).rowCount,
      0,
    );
    const rows = await observer.query(
      'SELECT event_id,leaf_index FROM transparency.event_position WHERE institution_id=$1',
      [j.f.id('institution')],
    );
    assert.deepEqual(rows.rows, [{ event_id: retainedEvent, leaf_index: '0' }]);
    assert.equal(
      (
        await observer.query(
          'SELECT tree_size FROM transparency.log_state WHERE institution_id=$1',
          [j.f.id('institution')],
        )
      ).rows[0]!.tree_size,
      '1',
    );
  } finally {
    await first.query('ROLLBACK');
    await second.query('ROLLBACK');
  }
});

test('API proposal and approval transactions include transparency state atomically', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  let abandonedRequest: string;
  await client.query('BEGIN');
  try {
    abandonedRequest = await w.propose();
    assert.equal(
      (
        await client.query('SELECT tree_size FROM transparency.log_state WHERE institution_id=$1', [
          w.f.id('institution'),
        ])
      ).rows[0]!.tree_size,
      '1',
    );
  } finally {
    await client.query('ROLLBACK');
  }
  assert.equal(
    (
      await client.query('SELECT 1 FROM workflow.change_request WHERE request_id=$1', [
        abandonedRequest!,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await client.query('SELECT 1 FROM transparency.log_state WHERE institution_id=$1', [
        w.f.id('institution'),
      ])
    ).rowCount,
    0,
  );
  const request = await w.propose();
  await client.query('BEGIN');
  try {
    await w.approve(request);
    assert.equal(
      (
        await client.query('SELECT tree_size FROM transparency.log_state WHERE institution_id=$1', [
          w.f.id('institution'),
        ])
      ).rows[0]!.tree_size,
      '2',
    );
  } finally {
    await client.query('ROLLBACK');
  }
  const result = await client.query(
    `SELECT
    (SELECT tree_size FROM transparency.log_state WHERE institution_id=$1) AS size,
    (SELECT count(*)::int FROM academic.grade_version WHERE record_id=$2) AS versions,
    (SELECT count(*)::int FROM workflow.decision WHERE request_id=$3) AS decisions,
    (SELECT count(*)::int FROM workflow.domain_event WHERE request_id=$3) AS events,
    (SELECT count(*)::int FROM workflow.outbox_delivery o JOIN workflow.domain_event e USING(event_id)
      WHERE e.request_id=$3) AS deliveries`,
    [w.f.id('institution'), w.f.id('record'), request],
  );
  assert.deepEqual(result.rows, [
    { size: '1', versions: 0, decisions: 0, events: 1, deliveries: 1 },
  ]);
});

test('private audit reconstructs submission, approval and rejection from authoritative facts', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const w = await workflowFixture(client);
  const approved = await w.propose();
  await w.approve(approved);
  const rejected = await w.propose(1);
  await w.reject(rejected);
  const rows = await asRole(client, 'academic_log_reader', () =>
    client.query<{
      event_id: string;
      kind: string;
      payload: Record<string, unknown>;
      expected: Record<string, unknown>;
    }>(
      `SELECT e.event_id,e.kind,e.payload,transparency.read_expected_event(e.event_id) AS expected
        FROM workflow.domain_event e JOIN transparency.event_position p USING(event_id)
        WHERE p.institution_id=$1 ORDER BY p.leaf_index`,
      [w.f.id('institution')],
    ),
  );
  assert.equal(rows.rowCount, 4);
  for (const row of rows.rows) {
    assert.deepEqual(row.expected, row.payload);
    if (row.kind === 'request.submitted') {
      assert.equal(row.expected.decision, null);
      assert.equal(row.expected.revision, null);
      assert.equal(row.expected.actorId, w.f.id('author'));
    } else assert.equal(row.expected.actorId, w.approver);
  }
  assert.equal(
    (
      await asRole(client, 'academic_log_reader', () =>
        client.query('SELECT transparency.read_expected_event($1) AS expected', [randomUUID()]),
      )
    ).rows[0]!.expected,
    null,
  );
  // An administrator simulates corrupted journal bytes; the immutable source
  // reconstruction must not simply echo that journal payload.
  await client.query('BEGIN');
  try {
    await client.query('ALTER TABLE workflow.domain_event DISABLE TRIGGER domain_event_immutable');
    await client.query(
      `UPDATE workflow.domain_event SET payload=jsonb_set(payload,'{proposal,reason}','"Altered journal"') WHERE event_id=$1`,
      [rows.rows[0]!.event_id],
    );
    const mismatch = await client.query<{ matches: boolean }>(
      'SELECT payload=transparency.read_expected_event(event_id) AS matches FROM workflow.domain_event WHERE event_id=$1',
      [rows.rows[0]!.event_id],
    );
    assert.equal(mismatch.rows[0]!.matches, false);
  } finally {
    await client.query('ROLLBACK');
  }
});

test('checkpoint persistence supports empty logs, exact retries and earlier committed prefixes', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const j = await journalFixture(client);
  const args = checkpointArgs(j.f.id('institution'), 0);
  const record = () =>
    asRole(client, 'academic_log_signer', () => client.query(checkpointSql, args));
  const first = await record();
  assert.deepEqual((await record()).rows, first.rows);
  const timestamp = await client.query<{ issued: string }>(
    `SELECT to_char(issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued
      FROM transparency.checkpoint WHERE institution_id=$1 AND tree_size=0`,
    [j.f.id('institution')],
  );
  assert.equal(timestamp.rows[0]!.issued, '2026-11-25T10:11:12.123Z');
  await j.emit(client, await j.prepare());
  assert.deepEqual((await record()).rows, first.rows);
  const nonempty = checkpointArgs(j.f.id('institution'), 1);
  await asRole(client, 'academic_log_signer', () => client.query(checkpointSql, nonempty));
  await j.emit(client, await j.prepare());
  await asRole(client, 'academic_log_signer', () => client.query(checkpointSql, nonempty));
  for (const changed of [
    args.map((value, index) => (index === 2 ? randomBytes(32) : value)),
    args.map((value, index) => (index === 3 ? '2026-11-25T10:11:12.124Z' : value)),
    args.map((value, index) => (index === 4 ? randomBytes(32).toString('hex') : value)),
    args.map((value, index) => (index === 5 ? randomBytes(64) : value)),
  ]) {
    await assert.rejects(
      asRole(client, 'academic_log_signer', () => client.query(checkpointSql, changed)),
      code('23505'),
    );
  }
  await assert.rejects(
    asRole(client, 'academic_log_signer', () =>
      client.query(checkpointSql, checkpointArgs(j.f.id('institution'), 3)),
    ),
    code('23514'),
  );
  // This function validates storage/shape only. Test byte strings above are not
  // cryptographic evidence; the separate verifier must reject their signatures.
});

test('checkpoint shape, millisecond precision, prefix completeness and append immutability are enforced', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const j = await journalFixture(client);
  const event = await j.emit(client, await j.prepare());
  for (const [index, value] of [
    [1, -1],
    [1, '9007199254740992'],
    [2, randomBytes(31)],
    [3, '2026-11-25T10:11:12.123456Z'],
    [3, 'infinity'],
    [4, 'invalid-key'],
    [5, randomBytes(63)],
  ] as const) {
    const args = checkpointArgs(j.f.id('institution'), 1);
    args[index] = value;
    await assert.rejects(client.query(checkpointSql, args), code('22023'));
  }
  await assert.rejects(
    client.query('UPDATE transparency.event_position SET salt=$1 WHERE event_id=$2', [
      randomBytes(32),
      event,
    ]),
    code('55000'),
  );
  await assert.rejects(
    client.query('DELETE FROM transparency.event_position WHERE event_id=$1', [event]),
    code('55000'),
  );
  await assert.rejects(
    client.query(
      'UPDATE transparency.log_state SET bootstrap_size=tree_size WHERE institution_id=$1',
      [j.f.id('institution')],
    ),
    code('55000'),
  );
  await assert.rejects(
    client.query(
      'UPDATE transparency.log_state SET tree_size=tree_size+2 WHERE institution_id=$1',
      [j.f.id('institution')],
    ),
    code('55000'),
  );
  await client.query('BEGIN');
  try {
    await client.query(
      'ALTER TABLE transparency.event_position DISABLE TRIGGER event_position_immutable',
    );
    await client.query('DELETE FROM transparency.event_position WHERE event_id=$1', [event]);
    await assert.rejects(
      client.query(checkpointSql, checkpointArgs(j.f.id('institution'), 1)),
      code('23514'),
    );
  } finally {
    await client.query('ROLLBACK');
  }
});

test('populated upgrade marks deterministic bootstrap import order and repeats without resequencing', async () => {
  assert.match(process.env.TEST_DATABASE_NAME ?? '', /^scholarproof_test_[a-f0-9]{32}$/);
  const database = `scholarproof_test_${randomUUID().replaceAll('-', '')}`;
  const maintenance = createDatabaseClient('postgres');
  let target: Client | undefined;
  let created = false;
  try {
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteDatabaseName(database)} TEMPLATE template0`);
    created = true;
    target = createDatabaseClient(database);
    await target.connect();
    // This fixture exercises the original Week 5 bootstrap migration in isolation.
    // Later forward upgrades have their own populated-history compatibility checks.
    const migrations = loadMigrations().filter((migration) => Number(migration.version) <= 10);
    await applyMigrations(
      target,
      migrations.filter((migration) => Number(migration.version) <= 9),
    );
    const j = await journalFixture(target);
    for (let index = 0; index < 3; index++) await j.emit(target, await j.prepare());
    const before = await target.query(
      'SELECT event_id,request_id,kind,occurred_at::text,payload FROM workflow.domain_event ORDER BY event_id',
    );
    const importedOrder = await target.query<{ event_id: string }>(
      'SELECT event_id FROM workflow.domain_event ORDER BY occurred_at,event_id',
    );
    assert.equal((await applyMigrations(target, migrations)).length, 1);
    assert.deepEqual(
      (
        await target.query(
          'SELECT event_id,request_id,kind,occurred_at::text,payload FROM workflow.domain_event ORDER BY event_id',
        )
      ).rows,
      before.rows,
    );
    const positions = await target.query<{ event_id: string; leaf_index: string; salt: Buffer }>(
      'SELECT event_id,leaf_index,salt FROM transparency.event_position ORDER BY leaf_index',
    );
    assert.deepEqual(
      positions.rows.map((row) => row.event_id),
      importedOrder.rows.map((row) => row.event_id),
    );
    assert.deepEqual(
      positions.rows.map((row) => row.leaf_index),
      ['0', '1', '2'],
    );
    assert.deepEqual(
      (await target.query('SELECT tree_size,bootstrap_size FROM transparency.log_state')).rows,
      [{ tree_size: '3', bootstrap_size: '3' }],
    );
    assert.deepEqual(await applyMigrations(target, migrations), []);
    assert.deepEqual(
      (
        await target.query(
          'SELECT event_id,leaf_index,salt FROM transparency.event_position ORDER BY leaf_index',
        )
      ).rows,
      positions.rows,
    );
    await assert.rejects(
      target.query(checkpointSql, checkpointArgs(j.f.id('institution'), 2)),
      code('23514'),
    );
    await target.query(checkpointSql, checkpointArgs(j.f.id('institution'), 3));
    const live = await j.emit(target, await j.prepare());
    assert.deepEqual(
      (await target.query('SELECT tree_size,bootstrap_size FROM transparency.log_state')).rows,
      [{ tree_size: '4', bootstrap_size: '3' }],
    );
    assert.deepEqual(
      (
        await target.query('SELECT leaf_index FROM transparency.event_position WHERE event_id=$1', [
          live,
        ])
      ).rows,
      [{ leaf_index: '3' }],
    );
  } finally {
    if (target) await target.end();
    if (created) {
      assert.match(database, /^scholarproof_test_[a-f0-9]{32}$/);
      await maintenance.query(`DROP DATABASE ${quoteDatabaseName(database)} WITH (FORCE)`);
    }
    await maintenance.end();
  }
});
