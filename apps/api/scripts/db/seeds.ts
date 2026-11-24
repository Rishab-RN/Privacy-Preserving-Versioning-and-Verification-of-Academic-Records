import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { projectRoot } from './config.js';
import { MigrationError, migrationStatus, sqlChecksum } from './migrations.js';

export async function seedDemo(client: Client) {
  const migrations = await migrationStatus(client);
  if (migrations.some((row) => row.state !== 'applied')) {
    throw new MigrationError('Apply all migrations before loading the synthetic fixture');
  }
  const legacyName = '0001_demo.sql';
  const normalizedName = '0002_bcnf_demo.sql';
  const normalized = migrations.some((row) => row.version === '0008');
  const name = normalized ? normalizedName : legacyName;
  const sources = new Map(
    (normalized ? [legacyName, normalizedName] : [legacyName]).map((seedName) => {
      const sql = readFileSync(join(projectRoot, 'db/seeds', seedName), 'utf8').replaceAll(
        '\r\n',
        '\n',
      );
      return [seedName, { sql, checksum: sqlChecksum(sql) }] as const;
    }),
  );
  const { sql, checksum } = sources.get(name)!;
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 2]);
    await client.query(`CREATE TABLE IF NOT EXISTS scholarproof_meta.seed_runs (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const previous = await client.query<{ name: string; checksum: string }>(
      'SELECT name,checksum FROM scholarproof_meta.seed_runs WHERE name=ANY($1::text[])',
      [[...sources.keys()]],
    );
    for (const applied of previous.rows) {
      if (sources.get(applied.name)?.checksum !== applied.checksum)
        throw new MigrationError('Applied demo seed changed; do not rewrite an existing seed');
    }
    if (previous.rows.some((row) => row.name === name)) {
      await client.query('COMMIT');
      return false;
    }
    const carriedForward = normalized && previous.rows.some((row) => row.name === legacyName);
    if (carriedForward) {
      // Migration 0008 decomposes the existing fixture in place. Keep its history,
      // account bindings and any later corrections rather than running inserts.
      const fixture = await client.query<{ valid: boolean }>(`
        SELECT EXISTS(SELECT 1 FROM academic.institution
          WHERE institution_id=md5('demo:institution')::uuid AND institution_code='DEMO_UNIVERSITY')
        AND (SELECT count(*) FROM academic.student WHERE institution_id=md5('demo:institution')::uuid
          AND student_id IN (SELECT md5('demo:student:'||n)::uuid FROM generate_series(1,25) n))=25
        AND NOT EXISTS(SELECT 1 FROM generate_series(1,25) s CROSS JOIN generate_series(1,4) c
          WHERE NOT EXISTS(SELECT 1 FROM academic.grade_record r
            JOIN academic.grade_version v ON v.record_id=r.record_id AND v.version_no=1
            WHERE r.record_id=md5('demo:record:'||s||':'||c)::uuid
              AND r.institution_id=md5('demo:institution')::uuid)) AS valid
      `);
      if (fixture.rows[0]?.valid !== true)
        throw new MigrationError('Existing demo fixture is incomplete; no data was reset');
    } else {
      await client.query(sql);
    }
    await client.query('INSERT INTO scholarproof_meta.seed_runs(name,checksum) VALUES($1,$2)', [
      name,
      checksum,
    ]);
    await client.query('COMMIT');
    return !carriedForward;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
