import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Client } from 'pg';
import {
  createDatabaseClient,
  projectRoot,
  quoteDatabaseName,
} from '../../apps/api/scripts/db/config.js';
import {
  applyMigrations,
  loadMigrations,
  sqlChecksum,
} from '../../apps/api/scripts/db/migrations.js';
import { seedDemo } from '../../apps/api/scripts/db/seeds.js';

const relations = [
  'academic.institution',
  'academic.app_user',
  'academic.role_assignment',
  'academic.programme',
  'academic.student',
  'academic.academic_term',
  'academic.grading_scheme',
  'academic.course',
  'academic.course_offering',
  'academic.enrolment',
  'academic.grade_record',
  'academic.grade_version',
  'academic.grade_temporal_segment',
  'access_control.password_credential',
  'access_control.api_session',
  'evidence.reference',
  'workflow.change_request',
  'workflow.decision',
  'workflow.domain_event',
  'workflow.outbox_delivery',
] as const;
const derived = new Set<string>([
  'academic.student',
  'academic.course_offering',
  'academic.enrolment',
  'academic.grade_version',
  'academic.grade_temporal_segment',
  'access_control.password_credential',
  'evidence.reference',
  'workflow.change_request',
  'workflow.decision',
  'workflow.domain_event',
  'workflow.outbox_delivery',
]);

async function snapshot(client: Client, normalized: boolean) {
  const result: Record<string, unknown> = {};
  for (const relation of relations) {
    // Names are a closed source-code allowlist, never caller/database input.
    const name = normalized && derived.has(relation) ? `${relation}_context` : relation;
    const query = await client.query<{ rows: unknown }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${name} t`,
    );
    result[relation] = query.rows[0]!.rows;
  }
  return result;
}

test('a populated Week 4 database upgrades losslessly without rewriting credentials, history or queued events', async () => {
  // The outer harness is required even though this case creates a second,
  // independently named disposable database for testing the old schema.
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
    const migrations = loadMigrations();
    assert.ok(migrations.some((migration) => migration.version === '0009'));
    const legacy = migrations.filter((migration) => Number(migration.version) <= 7);
    assert.equal(legacy.length, 7);
    assert.equal((await applyMigrations(target, legacy)).length, 7);
    const oldSeed = readFileSync(join(projectRoot, 'db/seeds/0001_demo.sql'), 'utf8');
    await target.query('BEGIN');
    try {
      await target.query(oldSeed);
      await target.query(`CREATE TABLE scholarproof_meta.seed_runs (
        name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      await target.query('INSERT INTO scholarproof_meta.seed_runs(name,checksum) VALUES($1,$2)', [
        '0001_demo.sql',
        sqlChecksum(oldSeed),
      ]);
      await target.query('COMMIT');
    } catch (error) {
      await target.query('ROLLBACK');
      throw error;
    }
    const ids = await target.query<{
      institution: string;
      author: string;
      record: string;
    }>(`SELECT md5('demo:institution')::uuid AS institution,
      md5('demo:registrar')::uuid AS author,md5('demo:record:1:1')::uuid AS record`);
    const f = ids.rows[0]!;
    const approver = randomUUID();
    const proposerToken = randomBytes(32).toString('hex');
    const approverToken = randomBytes(32).toString('hex');
    await target.query(
      "INSERT INTO access_control.password_credential(user_id,profile,salt_hex,derived_key_hex) VALUES($1,'scrypt-v1',$2,$3)",
      [f.author, 'a'.repeat(32), 'b'.repeat(128)],
    );
    await target.query('INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$2)', [
      approver,
      `test:upgrade:${randomUUID()}`,
    ]);
    await target.query(
      "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar')",
      [f.institution, approver],
    );
    await target.query(
      'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2),($3,$4)',
      [proposerToken, f.author, approverToken, approver],
    );
    const evidence = randomUUID();
    await target.query(
      `INSERT INTO evidence.reference(evidence_id,institution_id,record_id,submitted_by,request_key,category,
        document_schema_version,digest_sha256,size_bytes)
       VALUES($1,$2,$3,$4,$5,'supporting_note',1,$6,128)`,
      [evidence, f.institution, f.record, f.author, randomUUID(), 'c'.repeat(64)],
    );
    await target.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
      evidence,
    ]);
    const proposed = await target.query<{ request: string }>(
      "SELECT workflow.propose_change($1,$2,$3,2,9,'passed','2026-01-01T00:00:00Z',NULL,$4,'Upgrade preservation fixture') AS request",
      [proposerToken, f.record, randomUUID(), evidence],
    );
    const request = proposed.rows[0]!.request;
    const accepted = await target.query<{ version: number }>(
      "SELECT workflow.approve_change($1,$2,'Independent upgrade fixture review') AS version",
      [approverToken, request],
    );
    assert.equal(accepted.rows[0]?.version, 3);
    const rejectedProposal = await target.query<{ request: string }>(
      "SELECT workflow.propose_change($1,$2,$3,3,8,'passed','2026-01-01T00:00:00Z',NULL,$4,'Rejected upgrade fixture') AS request",
      [proposerToken, f.record, randomUUID(), evidence],
    );
    await target.query("SELECT workflow.reject_change($1,$2,'Independent upgrade rejection')", [
      approverToken,
      rejectedProposal.rows[0]!.request,
    ]);
    const leased = await target.query<{ event_id: string; lease_token: string }>(
      'SELECT * FROM workflow.claim_deliveries(1,60)',
    );
    assert.equal(leased.rowCount, 1);
    await target.query("SELECT workflow.fail_delivery($1,$2,'MONGO_UNAVAILABLE')", [
      leased.rows[0]!.event_id,
      leased.rows[0]!.lease_token,
    ]);
    const before = await snapshot(target, false);
    const oldMigrations = await target.query(
      "SELECT * FROM scholarproof_meta.schema_migrations WHERE version<='0007' ORDER BY version",
    );
    const seedMarker = await target.query(
      "SELECT * FROM scholarproof_meta.seed_runs WHERE name='0001_demo.sql'",
    );
    const upgraded = await applyMigrations(target);
    assert.ok(upgraded.includes('0008_bcnf_storage.sql'));
    assert.ok(upgraded.includes('0009_bcnf_workflow.sql'));
    assert.deepEqual(await snapshot(target, true), before);
    assert.deepEqual(
      (
        await target.query(
          "SELECT * FROM scholarproof_meta.schema_migrations WHERE version<='0007' ORDER BY version",
        )
      ).rows,
      oldMigrations.rows,
    );
    assert.equal(await seedDemo(target), false);
    assert.deepEqual(
      (await target.query("SELECT * FROM scholarproof_meta.seed_runs WHERE name='0001_demo.sql'"))
        .rows,
      seedMarker.rows,
    );
    assert.deepEqual(await snapshot(target, true), before);
    assert.equal(
      (await target.query('SELECT count(*)::int AS count FROM academic.student_programme')).rows[0]
        ?.count,
      25,
    );
    assert.deepEqual(await applyMigrations(target), []);
  } finally {
    await target?.end();
    if (created) {
      assert.match(database, /^scholarproof_test_[a-f0-9]{32}$/);
      await maintenance.query(`DROP DATABASE ${quoteDatabaseName(database)} WITH (FORCE)`);
    }
    await maintenance.end();
  }
});
