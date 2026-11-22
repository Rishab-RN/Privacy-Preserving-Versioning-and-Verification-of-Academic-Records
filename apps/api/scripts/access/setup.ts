import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MongoClient } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { Client } from 'pg';
import { configuredDatabase, createDatabaseClient, projectRoot } from '../db/config.js';
import { migrationStatus } from '../db/migrations.js';
import { configurationValue, configuredPort } from '../lib/service-checks.js';
import {
  EVIDENCE_COLLECTION,
  initializeEvidenceCollection,
  verifyEvidenceCollection,
} from '../../src/evidence-store.js';

const apiUser = 'scholarproof_api';
const mongoDatabase = 'scholarproof_evidence';
const postgresGroup = 'scholarproof_api_access';
const mongoRole = 'scholarproof_evidence_access';

export interface ApiEnvironment {
  API_DATA_ENABLED: 'true';
  API_POSTGRES_USER: typeof apiUser;
  API_POSTGRES_PASSWORD: string;
  API_MONGO_USER: typeof apiUser;
  API_MONGO_PASSWORD: string;
  API_MONGO_DB: typeof mongoDatabase;
}

export class AccessSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessSetupError';
  }
}

export function ensureApiEnvironment(path = join(projectRoot, '.env.api')): ApiEnvironment {
  try {
    writeFileSync(
      path,
      [
        '# Generated local API credentials. Preserve when reusing provisioned users.',
        'API_DATA_ENABLED=true',
        `API_POSTGRES_USER=${apiUser}`,
        `API_POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
        `API_MONGO_USER=${apiUser}`,
        `API_MONGO_PASSWORD=${randomBytes(32).toString('hex')}`,
        `API_MONGO_DB=${mongoDatabase}`,
        '',
      ].join('\n'),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST') {
      throw new AccessSetupError('Could not create the local API environment file');
    }
  }
  if (!lstatSync(path).isFile()) {
    throw new AccessSetupError('The API environment path must be a regular file');
  }
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([^\s]*)$/.exec(line);
    const name = match?.[1];
    if (!name || Object.hasOwn(values, name)) {
      throw new AccessSetupError('The API environment file has invalid or duplicate settings');
    }
    values[name] = match[2] ?? '';
  }
  if (
    Object.keys(values).length !== 6 ||
    values.API_DATA_ENABLED !== 'true' ||
    values.API_POSTGRES_USER !== apiUser ||
    values.API_MONGO_USER !== apiUser ||
    values.API_MONGO_DB !== mongoDatabase ||
    !/^[a-f0-9]{64}$/.test(values.API_POSTGRES_PASSWORD ?? '') ||
    !/^[a-f0-9]{64}$/.test(values.API_MONGO_PASSWORD ?? '')
  ) {
    throw new AccessSetupError('The API environment file has incompatible local access settings');
  }
  return values as unknown as ApiEnvironment;
}

function apiPostgres(environment: ApiEnvironment): Client {
  return new Client({
    host: '127.0.0.1',
    port: configuredPort(process.env.POSTGRES_PORT ?? '55432'),
    database: configuredDatabase(),
    user: environment.API_POSTGRES_USER,
    password: environment.API_POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: 'scholarproof-access-verification',
  });
}

async function verifyPostgresCredential(environment: ApiEnvironment): Promise<void> {
  const client = apiPostgres(environment);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

async function provisionPostgres(admin: Client, environment: ApiEnvironment): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 3]);
    const group = await admin.query<{ safe: boolean }>(
      `SELECT NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe
       FROM pg_roles WHERE rolname=$1`,
      [postgresGroup],
    );
    if (group.rows[0]?.safe !== true) {
      throw new AccessSetupError('Apply the access migration before provisioning API credentials');
    }
    const role = await admin.query<{ safe: boolean }>(
      `SELECT rolcanlogin AND rolinherit AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
        AND rolconfig IS NULL AS safe FROM pg_roles WHERE rolname=$1`,
      [apiUser],
    );
    if (role.rowCount) {
      if (role.rows[0]?.safe !== true) {
        throw new AccessSetupError('Existing PostgreSQL API role has incompatible flags');
      }
      const membership = await admin.query<{
        role: string;
        admin_option: boolean;
        inherit_option: boolean;
      }>(
        `SELECT parent.rolname AS role, membership.admin_option, membership.inherit_option FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid=membership.roleid
         JOIN pg_roles member_role ON member_role.oid=membership.member WHERE member_role.rolname=$1`,
        [apiUser],
      );
      if (
        membership.rows.some(
          (row) => row.role !== postgresGroup || row.admin_option || !row.inherit_option,
        )
      ) {
        throw new AccessSetupError('Existing PostgreSQL API role has unexpected memberships');
      }
      const elevated = await admin.query<{ unsafe: boolean }>(
        `WITH api AS (SELECT oid FROM pg_roles WHERE rolname=$1)
         SELECT EXISTS(SELECT 1 FROM pg_database, api WHERE datdba=api.oid)
         OR EXISTS(SELECT 1 FROM pg_namespace, api WHERE nspowner=api.oid)
         OR EXISTS(SELECT 1 FROM pg_class, api WHERE relowner=api.oid)
         OR EXISTS(SELECT 1 FROM pg_proc, api WHERE proowner=api.oid)
         OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl, api WHERE acl.grantee=api.oid)
         OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl, api WHERE acl.grantee=api.oid)
         OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) acl, api WHERE acl.grantee=api.oid)
         OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl, api WHERE acl.grantee=api.oid)
         AS unsafe`,
        [apiUser],
      );
      if (elevated.rows[0]?.unsafe !== false) {
        throw new AccessSetupError(
          'Existing PostgreSQL API role owns objects or has direct object grants',
        );
      }
      // Verify the preserved password before changing any grants. Never reset it.
      await verifyPostgresCredential(environment);
    } else {
      // Both identifier and password are fixed/validated, not arbitrary SQL inputs.
      await admin.query(
        `CREATE ROLE "${apiUser}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${environment.API_POSTGRES_PASSWORD}'`,
      );
    }
    await admin.query(`GRANT "${postgresGroup}" TO "${apiUser}"`);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  await verifyPostgresCredential(environment);
}

function apiMongo(environment: ApiEnvironment): MongoClient {
  const port = configuredPort(process.env.MONGO_PORT ?? '57017');
  return new MongoClient(`mongodb://127.0.0.1:${port}`, {
    authSource: environment.API_MONGO_DB,
    auth: { username: environment.API_MONGO_USER, password: environment.API_MONGO_PASSWORD },
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
}

async function verifyMongoCredential(
  environment: ApiEnvironment,
  checkCollection: boolean,
): Promise<void> {
  const client = apiMongo(environment);
  try {
    await client.connect();
    await client.db(environment.API_MONGO_DB).command({ ping: 1 });
    if (checkCollection) await verifyEvidenceCollection(client.db(environment.API_MONGO_DB));
  } finally {
    await client.close();
  }
}

function rolePrivileges(db: string) {
  return [
    { resource: { db, collection: EVIDENCE_COLLECTION }, actions: ['find', 'insert'] },
    { resource: { db, collection: '' }, actions: ['listCollections'] },
  ];
}

function normalizedPrivileges(privileges: unknown): unknown {
  if (!Array.isArray(privileges)) return null;
  return privileges
    .map((privilege: Document) => ({
      resource: privilege.resource as unknown,
      actions: Array.isArray(privilege.actions) ? [...privilege.actions].sort() : null,
    }))
    .sort((a, b) => JSON.stringify(a.resource).localeCompare(JSON.stringify(b.resource)));
}

async function provisionMongo(db: Db, environment: ApiEnvironment): Promise<void> {
  const expectedRoles = [{ role: mongoRole, db: environment.API_MONGO_DB }];
  const users = await db.command({ usersInfo: environment.API_MONGO_USER });
  const existing = (users.users as Document[])[0];
  if (existing) {
    if (!isDeepStrictEqual(existing.roles, expectedRoles)) {
      throw new AccessSetupError('Existing MongoDB API user has unexpected roles');
    }
    await verifyMongoCredential(environment, false);
  }
  await initializeEvidenceCollection(db);
  const roles = await db.command({
    rolesInfo: mongoRole,
    showPrivileges: true,
  });
  const role = (roles.roles as Document[])[0];
  const privileges = rolePrivileges(environment.API_MONGO_DB);
  if (role) {
    if (
      !Array.isArray(role.roles) ||
      role.roles.length !== 0 ||
      !isDeepStrictEqual(normalizedPrivileges(role.privileges), normalizedPrivileges(privileges))
    ) {
      throw new AccessSetupError('Existing MongoDB evidence role has incompatible privileges');
    }
  } else {
    await db.command({ createRole: mongoRole, privileges, roles: [] });
  }
  if (!existing) {
    await db.command({
      createUser: environment.API_MONGO_USER,
      pwd: environment.API_MONGO_PASSWORD,
      roles: expectedRoles,
    });
  }
  await verifyMongoCredential(environment, true);
}

export async function setupApiAccess(): Promise<void> {
  let stage = 'configuration';
  let postgres: Client | undefined;
  let mongo: MongoClient | undefined;
  try {
    const environment = ensureApiEnvironment();
    postgres = createDatabaseClient(configuredDatabase());
    stage = 'PostgreSQL migration verification';
    await postgres.connect();
    if ((await migrationStatus(postgres)).some((migration) => migration.state !== 'applied')) {
      throw new AccessSetupError('Apply all migrations before provisioning API access');
    }
    stage = 'PostgreSQL login provisioning';
    await provisionPostgres(postgres, environment);
    console.info('PostgreSQL API access verified');
    stage = 'MongoDB evidence provisioning';
    const port = configuredPort(process.env.MONGO_PORT ?? '57017');
    mongo = new MongoClient(`mongodb://127.0.0.1:${port}`, {
      authSource: 'admin',
      auth: {
        username: configurationValue(process.env, 'MONGO_ROOT_USER'),
        password: configurationValue(process.env, 'MONGO_ROOT_PASSWORD'),
      },
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    await mongo.connect();
    await provisionMongo(mongo.db(environment.API_MONGO_DB), environment);
    console.info('MongoDB evidence validation and restricted API access verified');
    console.info('Local .env.api preserved; credentials were not printed or rotated');
  } catch (error) {
    console.error(`API access setup failed during ${stage}`);
    if (error instanceof AccessSetupError) console.error(error.message);
    console.error(
      'Provisioning may be partial. Fix the cause and retry with the preserved .env.api; no cross-store atomicity is claimed.',
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([postgres?.end(), mongo?.close()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupApiAccess();
}
