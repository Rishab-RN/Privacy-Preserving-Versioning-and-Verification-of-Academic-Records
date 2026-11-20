import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { configurationValue, configuredPort } from '../lib/service-checks.js';

export const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

export function quoteDatabaseName(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name))
    throw new DatabaseConfigurationError(
      'Use a lowercase local database name containing letters, digits and underscores',
    );
  return `"${name}"`;
}

export function createDatabaseClient(database = configurationValue(process.env, 'POSTGRES_DB')) {
  quoteDatabaseName(database);
  return new Client({
    host: '127.0.0.1',
    port: configuredPort(process.env.POSTGRES_PORT ?? '55432'),
    database,
    user: configurationValue(process.env, 'POSTGRES_USER'),
    password: configurationValue(process.env, 'POSTGRES_PASSWORD'),
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    application_name: 'scholarproof-db-tooling',
  });
}

export function configuredDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const name = configurationValue(env, 'POSTGRES_DB');
  quoteDatabaseName(name);
  if (['postgres', 'template0', 'template1'].includes(name)) {
    throw new DatabaseConfigurationError(
      'Configure a dedicated project database before running migrations or seeds',
    );
  }
  return name;
}

export function safeDatabaseError(error: unknown): string {
  if (
    error instanceof Error &&
    ['MigrationError', 'DatabaseConfigurationError'].includes(error.name)
  )
    return error.message;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z0-9]{5}$|^E[A-Z]+$/.test(code)) {
    return `Database operation failed (${code}); check local service access and migration documentation`;
  }
  return 'Database operation failed; check configuration and the local service state';
}
