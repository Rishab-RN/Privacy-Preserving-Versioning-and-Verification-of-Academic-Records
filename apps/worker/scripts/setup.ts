import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import type { Db, Document } from 'mongodb';
import {
  initializeProjectionCollections,
  ProjectionCollectionConfigurationError,
  PROJECTION_COLLECTIONS,
  verifyProjectionCollections,
} from '../src/projection.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workerUser = 'scholarproof_worker';
const workerGroup = 'scholarproof_worker_access';
const mongoDatabase = 'scholarproof_evidence';
const mongoRole = 'scholarproof_projection_access';

export interface WorkerEnvironment {
  WORKER_POSTGRES_USER: typeof workerUser;
  WORKER_POSTGRES_PASSWORD: string;
  WORKER_MONGO_USER: typeof workerUser;
  WORKER_MONGO_PASSWORD: string;
  WORKER_MONGO_DB: typeof mongoDatabase;
}

export class WorkerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerSetupError';
  }
}

export function ensureWorkerEnvironment(
  path = join(projectRoot, '.env.worker'),
): WorkerEnvironment {
  try {
    writeFileSync(
      path,
      [
        '# Generated local worker credentials. Preserve when reusing provisioned users.',
        `WORKER_POSTGRES_USER=${workerUser}`,
        `WORKER_POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
        `WORKER_MONGO_USER=${workerUser}`,
        `WORKER_MONGO_PASSWORD=${randomBytes(32).toString('hex')}`,
        `WORKER_MONGO_DB=${mongoDatabase}`,
        '',
      ].join('\n'),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST') {
      throw new WorkerSetupError('Could not create the local worker environment file');
    }
  }
  if (!lstatSync(path).isFile())
    throw new WorkerSetupError('Worker environment path must be a regular file');
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([^\s]*)$/.exec(line);
    const name = match?.[1];
    if (!name || Object.hasOwn(values, name)) {
      throw new WorkerSetupError('Worker environment has invalid or duplicate settings');
    }
    values[name] = match[2] ?? '';
  }
  if (
    Object.keys(values).length !== 5 ||
    values.WORKER_POSTGRES_USER !== workerUser ||
    values.WORKER_MONGO_USER !== workerUser ||
    values.WORKER_MONGO_DB !== mongoDatabase ||
    !/^[a-f0-9]{64}$/.test(values.WORKER_POSTGRES_PASSWORD ?? '') ||
    !/^[a-f0-9]{64}$/.test(values.WORKER_MONGO_PASSWORD ?? '')
  ) {
    throw new WorkerSetupError('Worker environment has incompatible local access settings');
  }
  return values as unknown as WorkerEnvironment;
}

function required(key: string): string {
  const value = process.env[key];
  if (!value?.trim() || value.startsWith('replace-with-')) {
    throw new WorkerSetupError(`Configure ${key} before worker setup`);
  }
  return value;
}

function port(key: string, fallback: string): number {
  const value = process.env[key] ?? fallback;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535)
    throw new WorkerSetupError(`Invalid ${key}`);
  return Number(value);
}

function projectDatabase(): string {
  const value = required('POSTGRES_DB');
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(value) ||
    ['postgres', 'template0', 'template1'].includes(value)
  ) {
    throw new WorkerSetupError('Use a dedicated project PostgreSQL database');
  }
  return value;
}

function postgres(user: string, password: string): Client {
  return new Client({
    host: '127.0.0.1',
    port: port('POSTGRES_PORT', '55432'),
    database: projectDatabase(),
    user,
    password,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: 'scholarproof-worker-provisioning',
  });
}

async function verifyPostgresPassword(environment: WorkerEnvironment): Promise<void> {
  const client = postgres(environment.WORKER_POSTGRES_USER, environment.WORKER_POSTGRES_PASSWORD);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

async function provisionPostgres(admin: Client, environment: WorkerEnvironment): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 5]);
    const group = await admin.query<{ safe: boolean }>(
      `SELECT NOT (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
       AND r.rolinherit AND r.rolconfig IS NULL
       AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
       AND to_regprocedure('workflow.claim_deliveries(integer,integer)') IS NOT NULL
       AND to_regprocedure('workflow.ack_delivery(uuid,uuid)') IS NOT NULL
       AND to_regprocedure('workflow.fail_delivery(uuid,uuid,text)') IS NOT NULL
       AND to_regclass('workflow.domain_event') IS NOT NULL
       AND has_table_privilege(r.oid,to_regclass('workflow.domain_event'),'SELECT')
       AND has_function_privilege(r.oid,to_regprocedure('workflow.claim_deliveries(integer,integer)'),'EXECUTE')
       AND has_function_privilege(r.oid,to_regprocedure('workflow.ack_delivery(uuid,uuid)'),'EXECUTE')
       AND has_function_privilege(r.oid,to_regprocedure('workflow.fail_delivery(uuid,uuid,text)'),'EXECUTE')
       AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid OR has_database_privilege(r.oid,oid,'CREATE'))
       AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid OR has_schema_privilege(r.oid,oid,'CREATE'))
       AND NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
       AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
       AND NOT EXISTS(
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname IN ('academic','access_control','evidence','workflow','transparency')
           AND c.relkind IN ('r','p','v','m','f')
           AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
             OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')
             OR ((n.nspname,c.relname)<>('workflow','domain_event') AND
               (has_table_privilege(r.oid,c.oid,'SELECT') OR has_any_column_privilege(r.oid,c.oid,'SELECT'))))
       )
       AND NOT EXISTS(
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname IN ('academic','access_control','evidence','workflow','transparency')
           AND p.oid NOT IN (
             to_regprocedure('workflow.claim_deliveries(integer,integer)'),
             to_regprocedure('workflow.ack_delivery(uuid,uuid)'),
             to_regprocedure('workflow.fail_delivery(uuid,uuid,text)'))
           AND has_function_privilege(r.oid,p.oid,'EXECUTE')
       ) AS safe
       FROM pg_roles r WHERE r.rolname=$1`,
      [workerGroup],
    );
    if (group.rows[0]?.safe !== true)
      throw new WorkerSetupError('Apply workflow permissions before worker setup');

    const existing = await admin.query<{ safe: boolean }>(
      `SELECT rolcanlogin AND rolinherit AND rolconfig IS NULL
       AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe
       FROM pg_roles WHERE rolname=$1`,
      [workerUser],
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.safe !== true)
        throw new WorkerSetupError('Existing worker PostgreSQL role has incompatible flags');
      const memberships = await admin.query<{
        role: string;
        admin_option: boolean;
        inherit_option: boolean;
      }>(
        `SELECT parent.rolname AS role,m.admin_option,m.inherit_option FROM pg_auth_members m
         JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member
         WHERE child.rolname=$1`,
        [workerUser],
      );
      if (
        memberships.rows.some(
          (membership) =>
            membership.role !== workerGroup ||
            membership.admin_option ||
            !membership.inherit_option,
        )
      ) {
        throw new WorkerSetupError('Existing worker PostgreSQL role has unexpected memberships');
      }
      const elevated = await admin.query<{ unsafe: boolean }>(
        `WITH worker AS (SELECT oid FROM pg_roles WHERE rolname=$1)
         SELECT EXISTS(SELECT 1 FROM pg_database,worker WHERE datdba=worker.oid OR has_database_privilege(worker.oid,pg_database.oid,'CREATE'))
         OR EXISTS(SELECT 1 FROM pg_namespace,worker WHERE nspowner=worker.oid)
         OR EXISTS(SELECT 1 FROM pg_class,worker WHERE relowner=worker.oid)
         OR EXISTS(SELECT 1 FROM pg_proc,worker WHERE proowner=worker.oid)
         OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl,worker WHERE acl.grantee=worker.oid)
         OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl,worker WHERE acl.grantee=worker.oid)
         OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) acl,worker WHERE acl.grantee=worker.oid)
         OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl,worker WHERE acl.grantee=worker.oid)
         AS unsafe`,
        [workerUser],
      );
      if (elevated.rows[0]?.unsafe !== false)
        throw new WorkerSetupError(
          'Existing worker PostgreSQL role owns objects or has direct grants',
        );
      // Do not mutate grants or rotate a password until preserved credentials work.
      await verifyPostgresPassword(environment);
    } else {
      // Identifier is fixed and password is constrained to generated hexadecimal.
      await admin.query(
        `CREATE ROLE "${workerUser}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${environment.WORKER_POSTGRES_PASSWORD}'`,
      );
    }
    await admin.query(`GRANT "${workerGroup}" TO "${workerUser}"`);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  await verifyPostgresPassword(environment);
}

function workerMongo(environment: WorkerEnvironment): MongoClient {
  return new MongoClient(`mongodb://127.0.0.1:${port('MONGO_PORT', '57017')}`, {
    authSource: environment.WORKER_MONGO_DB,
    auth: { username: environment.WORKER_MONGO_USER, password: environment.WORKER_MONGO_PASSWORD },
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
}

async function verifyMongoPassword(
  environment: WorkerEnvironment,
  verifyCollections: boolean,
): Promise<void> {
  const client = workerMongo(environment);
  try {
    await client.connect();
    const db = client.db(environment.WORKER_MONGO_DB);
    await db.command({ ping: 1 });
    if (verifyCollections) await verifyProjectionCollections(db);
  } finally {
    await client.close();
  }
}

function expectedPrivileges(db: string) {
  return [
    { resource: { db, collection: PROJECTION_COLLECTIONS.events }, actions: ['find', 'insert'] },
    { resource: { db, collection: PROJECTION_COLLECTIONS.revisions }, actions: ['find', 'insert'] },
    {
      resource: { db, collection: PROJECTION_COLLECTIONS.heads },
      actions: ['find', 'insert', 'update'],
    },
    { resource: { db, collection: '' }, actions: ['listCollections'] },
  ];
}

function normalizedPrivileges(value: unknown): unknown {
  if (!Array.isArray(value)) return null;
  return value
    .map((privilege: Document) => ({
      resource: privilege.resource as unknown,
      actions: Array.isArray(privilege.actions) ? [...privilege.actions].sort() : null,
    }))
    .sort((a, b) => JSON.stringify(a.resource).localeCompare(JSON.stringify(b.resource)));
}

async function provisionMongo(db: Db, environment: WorkerEnvironment): Promise<void> {
  const roles = [{ role: mongoRole, db: environment.WORKER_MONGO_DB }];
  const users = await db.command({ usersInfo: workerUser });
  if (!Array.isArray(users.users))
    throw new WorkerSetupError('Mongo worker user metadata is invalid');
  const user = (users.users as Document[])[0];
  if (user) {
    if (!isDeepStrictEqual(user.roles, roles))
      throw new WorkerSetupError('Existing Mongo worker user has unexpected roles');
    await verifyMongoPassword(environment, false);
  }
  await initializeProjectionCollections(db);
  const roleInfo = await db.command({
    rolesInfo: mongoRole,
    showPrivileges: true,
  });
  if (!Array.isArray(roleInfo.roles))
    throw new WorkerSetupError('Mongo projection role metadata is invalid');
  const role = (roleInfo.roles as Document[])[0];
  const privileges = expectedPrivileges(environment.WORKER_MONGO_DB);
  if (role) {
    if (
      !Array.isArray(role.roles) ||
      role.roles.length ||
      !isDeepStrictEqual(normalizedPrivileges(role.privileges), normalizedPrivileges(privileges))
    ) {
      throw new WorkerSetupError('Existing Mongo projection role has incompatible privileges');
    }
  } else {
    await db.command({ createRole: mongoRole, privileges, roles: [] });
  }
  if (!user)
    await db.command({ createUser: workerUser, pwd: environment.WORKER_MONGO_PASSWORD, roles });
  await verifyMongoPassword(environment, true);
}

export async function setupWorkerAccess(): Promise<void> {
  let stage = 'configuration';
  let adminSql: Client | undefined;
  let adminMongo: MongoClient | undefined;
  try {
    const environment = ensureWorkerEnvironment();
    stage = 'PostgreSQL workflow verification';
    adminSql = postgres(required('POSTGRES_USER'), required('POSTGRES_PASSWORD'));
    await adminSql.connect();
    stage = 'PostgreSQL worker identity provisioning';
    await provisionPostgres(adminSql, environment);
    console.info('Restricted PostgreSQL worker access verified');
    stage = 'MongoDB projection provisioning';
    adminMongo = new MongoClient(`mongodb://127.0.0.1:${port('MONGO_PORT', '57017')}`, {
      authSource: 'admin',
      auth: { username: required('MONGO_ROOT_USER'), password: required('MONGO_ROOT_PASSWORD') },
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    await adminMongo.connect();
    await provisionMongo(adminMongo.db(environment.WORKER_MONGO_DB), environment);
    console.info('Restricted MongoDB projection access and validators verified');
    console.info('Local .env.worker preserved; no credentials were printed or rotated');
  } catch (error) {
    console.error(`Worker setup failed during ${stage}`);
    if (
      error instanceof WorkerSetupError ||
      error instanceof ProjectionCollectionConfigurationError
    )
      console.error(error.message);
    console.error(
      'Setup may be partial. Fix the cause and retry with the preserved .env.worker; no cross-store atomicity is claimed.',
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([adminSql?.end(), adminMongo?.close()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await setupWorkerAccess();
