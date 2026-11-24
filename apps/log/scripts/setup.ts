import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { ensureSigningKeys } from '../src/local-state.js';
import { assertLogMongoIdentity, assertLogSqlIdentity } from '../src/identity.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const user = 'academic_log_local',
  role = 'academic_log_evidence_reader',
  database = 'scholarproof_evidence';
const path = resolve(root, '.env.log');
const required = (key: string) => {
  const value = process.env[key];
  if (!value || value.startsWith('replace-with-'))
    throw new Error('Configure local services first');
  return value;
};
function port(key: string, fallback: string) {
  const value = process.env[key] ?? fallback;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error('Invalid local port');
  return Number(value);
}

async function setup() {
  try {
    writeFileSync(
      path,
      [
        `LOG_POSTGRES_USER=${user}`,
        `LOG_POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
        `LOG_MONGO_USER=${user}`,
        `LOG_MONGO_PASSWORD=${randomBytes(32).toString('hex')}`,
        `LOG_MONGO_DB=${database}`,
        '',
      ].join('\n'),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isFile()) throw new Error('Log environment must be a regular file');
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([^\s]+)$/.exec(line);
    if (!match?.[1] || Object.hasOwn(values, match[1]))
      throw new Error('Invalid or duplicate log environment setting');
    values[match[1]] = match[2]!;
  }
  if (
    Object.keys(values).length !== 5 ||
    values.LOG_POSTGRES_USER !== user ||
    values.LOG_MONGO_USER !== user ||
    values.LOG_MONGO_DB !== database ||
    !/^[a-f0-9]{64}$/.test(values.LOG_POSTGRES_PASSWORD ?? '') ||
    !/^[a-f0-9]{64}$/.test(values.LOG_MONGO_PASSWORD ?? '')
  )
    throw new Error('Existing log configuration differs; no credentials were replaced');
  const sqlDatabase = required('POSTGRES_DB');
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(sqlDatabase) ||
    ['postgres', 'template0', 'template1'].includes(sqlDatabase)
  )
    throw new Error('Use a dedicated project database');
  const admin = new Client({
    host: '127.0.0.1',
    port: port('POSTGRES_PORT', '55432'),
    database: sqlDatabase,
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
    connectionTimeoutMillis: 5000,
  });
  const mongo = new MongoClient(`mongodb://127.0.0.1:${port('MONGO_PORT', '57017')}`, {
    authSource: 'admin',
    auth: { username: required('MONGO_ROOT_USER'), password: required('MONGO_ROOT_PASSWORD') },
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await admin.connect();
    await admin.query('BEGIN');
    try {
      await admin.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 10]);
      const existing = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [user]);
      if (!existing.rowCount)
        await admin.query(
          `CREATE ROLE "${user}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${values.LOG_POSTGRES_PASSWORD}'`,
        );
      const flags = await admin.query<{ safe: boolean }>(
        `SELECT rolcanlogin AND rolinherit AND rolconfig IS NULL AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid AND (p.rolname<>'academic_log_signer' OR m.admin_option OR NOT m.inherit_option)) AS safe FROM pg_roles r WHERE rolname=$1`,
        [user],
      );
      if (flags.rows[0]?.safe !== true) throw new Error('Existing log SQL identity is unsafe');
      await admin.query(`GRANT academic_log_signer TO "${user}"`);
      await admin.query(`GRANT CONNECT ON DATABASE "${sqlDatabase}" TO "${user}"`);
      await admin.query(`SET LOCAL ROLE "${user}"`);
      await assertLogSqlIdentity(admin);
      await admin.query('RESET ROLE');
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    await mongo.connect();
    const db = mongo.db(database);
    const privileges = [
      'evidence_documents',
      'workflow_events',
      'grade_revisions',
      'grade_revision_heads',
    ].map((collection) => ({ resource: { db: database, collection }, actions: ['find'] }));
    const oldRole = await db.command({ rolesInfo: role, showPrivileges: true });
    if (oldRole.roles.length === 0) await db.command({ createRole: role, privileges, roles: [] });
    else if (
      !isDeepStrictEqual(oldRole.roles[0].roles, []) ||
      !isDeepStrictEqual(oldRole.roles[0].privileges, privileges)
    )
      throw new Error('Existing log Mongo role differs; no grants changed');
    const oldUser = await db.command({ usersInfo: user });
    if (oldUser.users.length === 0)
      await db.command({
        createUser: user,
        pwd: values.LOG_MONGO_PASSWORD,
        roles: [{ role, db: database }],
      });
    else if (!isDeepStrictEqual(oldUser.users[0].roles, [{ role, db: database }]))
      throw new Error('Existing log Mongo identity has unexpected roles');
    const restrictedSql = new Client({
      host: '127.0.0.1',
      port: port('POSTGRES_PORT', '55432'),
      database: sqlDatabase,
      user,
      password: values.LOG_POSTGRES_PASSWORD!,
      connectionTimeoutMillis: 5000,
    });
    const restrictedMongo = new MongoClient(`mongodb://127.0.0.1:${port('MONGO_PORT', '57017')}`, {
      authSource: database,
      auth: { username: user, password: values.LOG_MONGO_PASSWORD! },
      serverSelectionTimeoutMS: 5000,
    });
    try {
      await restrictedSql.connect();
      await assertLogSqlIdentity(restrictedSql);
      await restrictedMongo.connect();
      await assertLogMongoIdentity(restrictedMongo.db(database));
    } finally {
      await Promise.allSettled([restrictedSql.end(), restrictedMongo.close()]);
    }
    ensureSigningKeys(resolve(root, '.runtime/log-keys'));
    console.info(
      'Restricted log access and Ed25519 keys configured; existing credentials/keys preserved',
    );
    console.info(
      'Retained observations belong in .runtime/log-observations, outside the databases',
    );
  } finally {
    await Promise.allSettled([admin.end(), mongo.close()]);
  }
}
setup().catch(() => {
  console.error(
    'Log setup failed; check services, migration and restricted identity configuration. No credentials printed.',
  );
  process.exitCode = 1;
});
