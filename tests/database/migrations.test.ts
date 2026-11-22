import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMigrations,
  loadMigrations,
  migrationStatus,
  sqlChecksum,
} from '../../apps/api/scripts/db/migrations.js';
import { connectTestClient } from './helpers.js';
import { seedDemo } from '../../apps/api/scripts/db/seeds.js';

test('migrations are repeatable, checksummed and serialize concurrent runners', async (context) => {
  const client = await connectTestClient();
  const other = await connectTestClient();
  context.after(async () => {
    await Promise.all([client.end(), other.end()]);
  });
  const local = loadMigrations();
  const results = await Promise.all([
    applyMigrations(client, local),
    applyMigrations(other, local),
  ]);
  assert.deepEqual(results, [[], []]);
  assert.equal(
    (await migrationStatus(client, local)).every((row) => row.state === 'applied'),
    true,
  );
  const changed = local.map((migration, index) =>
    index === 0 ? { ...migration, checksum: '0'.repeat(64) } : migration,
  );
  await assert.rejects(applyMigrations(client, changed), /checksum changed/);
  assert.equal((await migrationStatus(client, local)).length, local.length);
});

test('the deterministic synthetic seed can be loaded twice without duplicate records', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  assert.equal(await seedDemo(client), true);
  assert.equal(await seedDemo(client), false);
  const counts = await client.query<{ students: string; records: string; versions: string }>(`
    SELECT
      (SELECT count(*)::text FROM academic.student s JOIN academic.institution i USING(institution_id) WHERE i.institution_code='DEMO_UNIVERSITY') AS students,
      (SELECT count(*)::text FROM academic.grade_record g JOIN academic.institution i USING(institution_id) WHERE i.institution_code='DEMO_UNIVERSITY') AS records,
      (SELECT count(*)::text FROM academic.grade_version v JOIN academic.institution i USING(institution_id) WHERE i.institution_code='DEMO_UNIVERSITY') AS versions
  `);
  assert.deepEqual(counts.rows[0], { students: '25', records: '100', versions: '102' });
});

test('a failed migration rolls back its DDL and does not enter migration history', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const local = loadMigrations();
  const sql =
    'CREATE TABLE academic.rollback_probe(id integer); SELECT * FROM academic.missing_test_relation;';
  const version = String(local.length + 1).padStart(4, '0');
  const bad = { version, name: `${version}_failure_probe.sql`, sql, checksum: sqlChecksum(sql) };
  await assert.rejects(applyMigrations(client, [...local, bad]), /rolled back/);
  const result = await client.query<{ present: string | null }>(
    "SELECT to_regclass('academic.rollback_probe')::text AS present",
  );
  assert.equal(result.rows[0]?.present, null);
  assert.equal((await migrationStatus(client, local)).length, local.length);
});
