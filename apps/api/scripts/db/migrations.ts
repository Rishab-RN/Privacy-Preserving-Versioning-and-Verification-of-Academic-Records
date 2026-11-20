import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { projectRoot } from './config.js';

export interface Migration {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export function sqlChecksum(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
}

export function loadMigrations(directory = join(projectRoot, 'db', 'migrations')): Migration[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return files.map((name, index) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 4)) !== index + 1) {
      throw new MigrationError(
        'Migration files must have contiguous four-digit versions starting at 0001',
      );
    }
    const path = join(directory, name);
    if (!lstatSync(path).isFile())
      throw new MigrationError(`Migration is not a regular file: ${name}`);
    const sql = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    return { version: name.slice(0, 4), name, sql, checksum: sqlChecksum(sql) };
  });
}

export function verifyMigrationHistory(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
) {
  for (const [index, row] of applied.entries()) {
    const local = migrations[index];
    if (!local || local.version !== row.version || local.name !== row.name) {
      throw new MigrationError(
        'Database migration history is not a prefix of the local migration files',
      );
    }
    if (local.checksum !== row.checksum) {
      throw new MigrationError(
        `Applied migration checksum changed: ${local.name}. Add a new migration instead.`,
      );
    }
  }
}

export async function migrationStatus(client: Client, migrations = loadMigrations()) {
  const exists = await client.query<{ present: string | null }>(
    "SELECT to_regclass('scholarproof_meta.schema_migrations')::text AS present",
  );
  const applied = exists.rows[0]?.present
    ? (
        await client.query<AppliedMigration>(
          'SELECT version, name, checksum FROM scholarproof_meta.schema_migrations ORDER BY version',
        )
      ).rows
    : [];
  verifyMigrationHistory(migrations, applied);
  return migrations.map((migration, index) => ({
    version: migration.version,
    name: migration.name,
    state: index < applied.length ? ('applied' as const) : ('pending' as const),
  }));
}

export async function applyMigrations(client: Client, migrations = loadMigrations()) {
  await client.query('SELECT pg_advisory_lock($1, $2)', [1936747376, 1]);
  const appliedNames: string[] = [];
  try {
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS scholarproof_meta;
        CREATE TABLE IF NOT EXISTS scholarproof_meta.schema_migrations (
          version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
          name text NOT NULL UNIQUE,
          checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        REVOKE ALL ON SCHEMA scholarproof_meta FROM PUBLIC;
        REVOKE ALL ON scholarproof_meta.schema_migrations FROM PUBLIC;
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const status = await migrationStatus(client, migrations);
    for (const migration of migrations.filter((_, index) => status[index]?.state === 'pending')) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO scholarproof_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        appliedNames.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        const code =
          error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        const suffix =
          typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? ` (SQLSTATE ${code})` : '';
        throw new MigrationError(
          `Migration failed and was rolled back: ${migration.name}${suffix}`,
          { cause: error },
        );
      }
    }
    return appliedNames;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', [1936747376, 1]).catch(() => {});
  }
}
