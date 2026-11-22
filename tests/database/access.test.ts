import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Client } from 'pg';
import { loadMigrations } from '../../apps/api/scripts/db/migrations.js';
import { connectTestClient, fixture } from './helpers.js';

const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: string }).code === expected;
const tokenDigest = () => randomBytes(32).toString('hex');

async function insertReference(client: Client, f: Awaited<ReturnType<typeof fixture>>) {
  const evidenceId = randomUUID();
  await client.query(
    `INSERT INTO evidence.reference
      (evidence_id,institution_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,'supporting_note',$6,256)`,
    [evidenceId, f.id('institution'), f.id('record'), f.id('author'), randomUUID(), tokenDigest()],
  );
  return evidenceId;
}

test('credentials and sessions enforce their profiles, finite lifetime and irreversible revocation', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  const credential =
    'INSERT INTO access_control.password_credential(user_id,profile,salt_hex,derived_key_hex) VALUES($1,$2,$3,$4)';
  await assert.rejects(
    client.query(credential, [f.id('author'), 'unknown', '0'.repeat(32), '0'.repeat(128)]),
    code('23514'),
  );
  await assert.rejects(
    client.query(credential, [f.id('author'), 'scrypt-v1', '0'.repeat(31), '0'.repeat(128)]),
    code('23514'),
  );
  await client.query(credential, [f.id('author'), 'scrypt-v1', '0'.repeat(32), '0'.repeat(128)]);
  const session =
    'INSERT INTO access_control.api_session(token_digest,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)';
  for (const [created, expiry] of [
    ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00.000001Z'],
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    ['2026-01-01T00:00:00Z', 'infinity'],
  ]) {
    await assert.rejects(
      client.query(session, [tokenDigest(), f.id('author'), created, expiry]),
      code('23514'),
    );
  }
  const digest = tokenDigest();
  await client.query('INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)', [
    digest,
    f.id('author'),
  ]);
  const lifetime = await client.query<{ one_hour: boolean }>(
    "SELECT expires_at-created_at=interval '1 hour' AS one_hour FROM access_control.api_session WHERE token_digest=$1",
    [digest],
  );
  assert.equal(lifetime.rows[0]?.one_hour, true);
  await assert.rejects(
    client.query(
      "UPDATE access_control.api_session SET expires_at=expires_at+interval '1 minute' WHERE token_digest=$1",
      [digest],
    ),
    code('55000'),
  );
  await client.query(
    'UPDATE access_control.api_session SET revoked_at=clock_timestamp() WHERE token_digest=$1',
    [digest],
  );
  await assert.rejects(
    client.query('UPDATE access_control.api_session SET revoked_at=NULL WHERE token_digest=$1', [
      digest,
    ]),
    code('55000'),
  );
});

test('evidence metadata is scoped, bounded, unique and permits only pending to available', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  const sql = `INSERT INTO evidence.reference
    (evidence_id,institution_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`;
  const requestKey = randomUUID();
  const args = [
    randomUUID(),
    f.id('institution'),
    f.id('record'),
    f.id('author'),
    requestKey,
    'supporting_note',
    tokenDigest(),
    256,
  ];
  await assert.rejects(
    client.query(sql, [randomUUID(), f.id('otherInstitution'), ...args.slice(2)]),
    code('23503'),
  );
  for (const invalidSize of [0, 65537]) {
    await assert.rejects(client.query(sql, [...args.slice(0, 7), invalidSize]), code('23514'));
  }
  await assert.rejects(
    client.query(sql, [...args.slice(0, 5), 'unknown', ...args.slice(6)]),
    code('23514'),
  );
  await client.query(sql, args);
  await assert.rejects(
    client.query(
      `INSERT INTO evidence.reference
        (evidence_id,institution_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes,state)
        VALUES($1,$2,$3,$4,$5,'supporting_note',$6,256,'available')`,
      [
        randomUUID(),
        f.id('institution'),
        f.id('record'),
        f.id('author'),
        randomUUID(),
        tokenDigest(),
      ],
    ),
    code('23514'),
  );
  await assert.rejects(client.query(sql, [randomUUID(), ...args.slice(1)]), code('23505'));
  const evidenceId = args[0];
  await assert.rejects(
    client.query('UPDATE evidence.reference SET digest_sha256=$2,state=$3 WHERE evidence_id=$1', [
      evidenceId,
      tokenDigest(),
      'available',
    ]),
    code('55000'),
  );
  await assert.rejects(
    client.query('DELETE FROM evidence.reference WHERE evidence_id=$1', [evidenceId]),
    code('55000'),
  );
  await client.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
    evidenceId,
  ]);
  for (const state of ['pending', 'available']) {
    await assert.rejects(
      client.query('UPDATE evidence.reference SET state=$2 WHERE evidence_id=$1', [
        evidenceId,
        state,
      ]),
      code('55000'),
    );
  }
});

test('API group can verify credentials, create/revoke sessions and store evidence without academic writes', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 7);
  await client.query(
    'INSERT INTO access_control.password_credential(user_id,salt_hex,derived_key_hex) VALUES($1,$2,$3)',
    [f.id('author'), '0'.repeat(32), '0'.repeat(128)],
  );
  const knownAt = await f.recorded(1);
  await client.query('SET ROLE scholarproof_api_access');
  try {
    assert.equal(
      (
        await client.query(
          'SELECT profile FROM access_control.password_credential WHERE user_id=$1',
          [f.id('author')],
        )
      ).rows[0]?.profile,
      'scrypt-v1',
    );
    assert.equal((await f.asOf(knownAt, '2026-05-01T00:00:00Z')).length, 1);
    const digest = tokenDigest();
    await client.query(
      'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
      [digest, f.id('author')],
    );
    await client.query(
      'UPDATE access_control.api_session SET revoked_at=clock_timestamp() WHERE token_digest=$1 AND revoked_at IS NULL',
      [digest],
    );
    const evidenceId = await insertReference(client, f);
    await client.query(
      "UPDATE evidence.reference SET state='available' WHERE evidence_id=$1 AND state='pending'",
      [evidenceId],
    );
    const denied = [
      'UPDATE academic.grade_version SET grade_points=8',
      "UPDATE access_control.password_credential SET derived_key_hex=repeat('0',128)",
      "UPDATE access_control.api_session SET expires_at=expires_at+interval '1 minute'",
      "UPDATE evidence.reference SET category='revaluation_request'",
      'DELETE FROM evidence.reference',
      'CREATE TABLE academic.forbidden_access_test(id integer)',
      'CREATE TABLE access_control.forbidden_access_test(id integer)',
      'CREATE TABLE evidence.forbidden_access_test(id integer)',
    ];
    for (const statement of denied) await assert.rejects(client.query(statement), code('42501'));
    await assert.rejects(f.append(1, 8), code('42501'));
  } finally {
    await client.query('RESET ROLE');
  }
});

test('role reuse rejects memberships and effective column write grants without retaining mutations', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const sql = loadMigrations().find(
    (migration) => migration.name === '0005_api_permissions.sql',
  )?.sql;
  assert.ok(sql);
  for (const grant of [
    'GRANT scholarproof_runtime TO scholarproof_api_access',
    'GRANT scholarproof_api_access TO scholarproof_runtime',
    'GRANT UPDATE (grade_points) ON academic.grade_version TO scholarproof_runtime',
    'GRANT UPDATE (derived_key_hex) ON access_control.password_credential TO scholarproof_api_access',
  ]) {
    await client.query('BEGIN');
    try {
      await client.query(grant);
      await assert.rejects(client.query(sql), code('42501'));
    } finally {
      await client.query('ROLLBACK');
    }
  }
  await client.query(sql);
});
