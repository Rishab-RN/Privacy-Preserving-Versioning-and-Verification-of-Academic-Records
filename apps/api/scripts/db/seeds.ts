import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { projectRoot } from './config.js';
import { MigrationError, migrationStatus, sqlChecksum } from './migrations.js';

export async function seedDemo(client: Client) {
  if ((await migrationStatus(client)).some((row) => row.state !== 'applied')) {
    throw new MigrationError('Apply all migrations before loading the synthetic fixture');
  }
  const name = '0001_demo.sql';
  const sql = readFileSync(join(projectRoot, 'db/seeds', name), 'utf8').replaceAll('\r\n', '\n');
  const checksum = sqlChecksum(sql);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 2]);
    await client.query(`CREATE TABLE IF NOT EXISTS scholarproof_meta.seed_runs (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const previous = await client.query<{ checksum: string }>(
      'SELECT checksum FROM scholarproof_meta.seed_runs WHERE name=$1',
      [name],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum)
        throw new MigrationError('Applied demo seed changed; do not rewrite an existing seed');
      await client.query('COMMIT');
      return false;
    }
    await client.query(sql);
    await client.query('INSERT INTO scholarproof_meta.seed_runs(name,checksum) VALUES($1,$2)', [
      name,
      checksum,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
