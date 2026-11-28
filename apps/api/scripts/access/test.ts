import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import type { Client } from 'pg';
import {
  createDatabaseClient,
  projectRoot,
  quoteDatabaseName,
  safeDatabaseError,
} from '../db/config.js';
import { applyMigrations } from '../db/migrations.js';
import { configurationValue, configuredPort } from '../lib/service-checks.js';
import { EVIDENCE_COLLECTION, initializeEvidenceCollection } from '../../src/evidence-store.js';
import {
  initializeProjectionCollections,
  PROJECTION_COLLECTIONS,
} from '../../../worker/src/projection.js';

class IntegrationHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationHarnessError';
  }
}

const suffix = randomUUID().replaceAll('-', '');
const databaseName = `scholarproof_test_${suffix}`;
const loginName = `scholarproof_http_${suffix}`;
const mongoRole = 'http_evidence';
const workerName = `scholarproof_jobs_${suffix}`;
const workerRole = 'test_projections';
const workerPostgresPassword = randomBytes(32).toString('hex');
const workerMongoPassword = randomBytes(32).toString('hex');
const postgresPassword = randomBytes(32).toString('hex');
const mongoPassword = randomBytes(32).toString('hex');

let maintenance: Client | undefined;
let mongo: MongoClient | undefined;
let mongoDatabase: Db | undefined;
let sqlDatabaseCreated = false;
let sqlLoginCreated = false;
let mongoDatabaseClaimed = false;
let mongoRoleCreated = false;
let mongoUserCreated = false;
let workerSqlCreated = false;
let workerMongoRoleCreated = false;
let workerMongoUserCreated = false;
let cleanupFailed = false;
let stage = 'configuration';

const safeNames = () =>
  /^scholarproof_test_[a-f0-9]{32}$/.test(databaseName) &&
  /^scholarproof_http_[a-f0-9]{32}$/.test(loginName) &&
  mongoRole === 'http_evidence' &&
  /^scholarproof_jobs_[a-f0-9]{32}$/.test(workerName) &&
  workerRole === 'test_projections';

function diagnostic(error: unknown): string {
  return error instanceof IntegrationHarnessError ? error.message : safeDatabaseError(error);
}

async function cleanup(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    cleanupFailed = true;
    console.error(`Integration cleanup failed during ${label}: ${diagnostic(error)}`);
    process.exitCode = 1;
  }
}

try {
  if (!safeNames()) throw new IntegrationHarnessError('Refusing unsafe integration resource names');
  maintenance = createDatabaseClient('postgres');
  await maintenance.connect();
  stage = 'isolated PostgreSQL database creation';
  await maintenance.query(`CREATE DATABASE ${quoteDatabaseName(databaseName)} TEMPLATE template0`);
  sqlDatabaseCreated = true;
  const target = createDatabaseClient(databaseName);
  try {
    await target.connect();
    stage = 'isolated PostgreSQL migrations';
    await applyMigrations(target);
  } finally {
    await target.end();
  }

  stage = 'isolated PostgreSQL login provisioning';
  // Identifiers have strict generated-name validation, and the random password is
  // hexadecimal. Neither untrusted SQL input nor secret-bearing URIs are used.
  await maintenance.query(
    `CREATE ROLE ${quoteDatabaseName(loginName)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${postgresPassword}'`,
  );
  sqlLoginCreated = true;
  await maintenance.query(`GRANT scholarproof_api_access TO ${quoteDatabaseName(loginName)}`);
  await maintenance.query(
    `CREATE ROLE ${quoteDatabaseName(workerName)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${workerPostgresPassword}'`,
  );
  workerSqlCreated = true;
  await maintenance.query(`GRANT scholarproof_worker_access TO ${quoteDatabaseName(workerName)}`);

  stage = 'isolated MongoDB connection';
  const mongoPort = configuredPort(process.env.MONGO_PORT ?? '57017');
  mongo = new MongoClient(`mongodb://127.0.0.1:${mongoPort}`, {
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
  mongoDatabase = mongo.db(databaseName);
  const existingDatabases = await mongo.db('admin').command({
    listDatabases: 1,
    nameOnly: true,
    filter: { name: databaseName },
  });
  const existingUser = await mongoDatabase.command({ usersInfo: loginName });
  const existingRole = await mongoDatabase.command({ rolesInfo: mongoRole });
  if (
    !Array.isArray(existingDatabases.databases) ||
    existingDatabases.databases.length !== 0 ||
    !Array.isArray(existingUser.users) ||
    existingUser.users.length !== 0 ||
    !Array.isArray(existingRole.roles) ||
    existingRole.roles.length !== 0
  ) {
    throw new IntegrationHarnessError('Refusing to reuse existing MongoDB integration resources');
  }

  stage = 'isolated MongoDB collection initialization';
  // This name was confirmed absent. Claim it before initialization so a partial
  // collection/validator failure still cleans up only this run's new database.
  mongoDatabaseClaimed = true;
  await initializeEvidenceCollection(mongoDatabase);
  await initializeProjectionCollections(mongoDatabase);
  stage = 'isolated MongoDB role provisioning';
  await mongoDatabase.command({
    createRole: mongoRole,
    privileges: [
      {
        resource: { db: databaseName, collection: EVIDENCE_COLLECTION },
        actions: ['find', 'insert'],
      },
      { resource: { db: databaseName, collection: '' }, actions: ['listCollections'] },
    ],
    roles: [],
  });
  mongoRoleCreated = true;
  stage = 'isolated MongoDB user provisioning';
  await mongoDatabase.command({
    createUser: loginName,
    pwd: mongoPassword,
    roles: [{ role: mongoRole, db: databaseName }],
  });
  mongoUserCreated = true;
  await mongoDatabase.command({
    createRole: workerRole,
    roles: [],
    privileges: [
      {
        resource: { db: databaseName, collection: PROJECTION_COLLECTIONS.events },
        actions: ['find', 'insert'],
      },
      {
        resource: { db: databaseName, collection: PROJECTION_COLLECTIONS.revisions },
        actions: ['find', 'insert'],
      },
      {
        resource: { db: databaseName, collection: PROJECTION_COLLECTIONS.heads },
        actions: ['find', 'insert', 'update'],
      },
      { resource: { db: databaseName, collection: '' }, actions: ['listCollections'] },
    ],
  });
  workerMongoRoleCreated = true;
  await mongoDatabase.command({
    createUser: workerName,
    pwd: workerMongoPassword,
    roles: [{ role: workerRole, db: databaseName }],
  });
  workerMongoUserCreated = true;

  stage = 'HTTP integration checks';
  console.info(
    'Running HTTP integration checks with isolated databases and restricted API credentials',
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('tsx/cli')),
      '--test',
      '--test-concurrency=1',
      join(projectRoot, 'tests/integration/api.test.ts'),
      join(projectRoot, 'tests/integration/workflow.test.ts'),
      join(projectRoot, 'tests/integration/transparency.test.ts'),
      join(projectRoot, 'tests/integration/worker.test.ts'),
      join(projectRoot, 'tests/integration/privacy.test.ts'),
      join(projectRoot, 'tests/integration/provenance.test.ts'),
      join(projectRoot, 'tests/integration/pilot-roster.test.ts'),
      join(projectRoot, 'tests/integration/pilot-setup.test.ts'),
      join(projectRoot, 'tests/integration/assessment-batches.test.ts'),
      join(projectRoot, 'tests/integration/batch-review.test.ts'),
      join(projectRoot, 'tests/integration/result-publication.test.ts'),
    ],
    {
      cwd: projectRoot,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        TEST_DATABASE_NAME: databaseName,
        POSTGRES_DB: databaseName,
        API_DATA_ENABLED: 'true',
        API_POSTGRES_USER: loginName,
        API_POSTGRES_PASSWORD: postgresPassword,
        API_MONGO_DB: databaseName,
        API_MONGO_USER: loginName,
        API_MONGO_PASSWORD: mongoPassword,
        TEST_MONGO_DATABASE: databaseName,
        WORKER_POSTGRES_USER: workerName,
        WORKER_POSTGRES_PASSWORD: workerPostgresPassword,
        WORKER_MONGO_DB: databaseName,
        WORKER_MONGO_USER: workerName,
        WORKER_MONGO_PASSWORD: workerMongoPassword,
      },
    },
  );
  const [exitCode] = await once(child, 'exit');
  process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
} catch (error) {
  console.error(`HTTP integration failed during ${stage}: ${diagnostic(error)}`);
  process.exitCode = 1;
} finally {
  if (!safeNames()) {
    cleanupFailed = true;
    console.error('Refusing cleanup of resources outside this generated integration run');
    process.exitCode = 1;
  } else {
    if (mongoDatabase && workerMongoUserCreated)
      await cleanup('worker MongoDB user removal', () =>
        mongoDatabase!.command({ dropUser: workerName }),
      );
    if (mongoDatabase && workerMongoRoleCreated)
      await cleanup('worker MongoDB role removal', () =>
        mongoDatabase!.command({ dropRole: workerRole }),
      );
    if (mongoDatabase && mongoUserCreated) {
      await cleanup('MongoDB user removal', () => mongoDatabase!.command({ dropUser: loginName }));
    }
    if (mongoDatabase && mongoRoleCreated) {
      await cleanup('MongoDB role removal', () => mongoDatabase!.command({ dropRole: mongoRole }));
    }
    if (mongoDatabase && mongoDatabaseClaimed) {
      await cleanup('MongoDB database removal', () => mongoDatabase!.dropDatabase());
    }
    if (maintenance && sqlDatabaseCreated) {
      await cleanup('PostgreSQL database removal', () =>
        maintenance!.query(`DROP DATABASE ${quoteDatabaseName(databaseName)} WITH (FORCE)`),
      );
    }
    if (maintenance && sqlLoginCreated) {
      await cleanup('PostgreSQL login removal', () =>
        maintenance!.query(`DROP ROLE ${quoteDatabaseName(loginName)}`),
      );
    }
    if (maintenance && workerSqlCreated)
      await cleanup('worker PostgreSQL login removal', () =>
        maintenance!.query(`DROP ROLE ${quoteDatabaseName(workerName)}`),
      );
  }
  await Promise.allSettled([maintenance?.end(), mongo?.close()]);
  if (sqlDatabaseCreated || mongoDatabaseClaimed) {
    if (cleanupFailed) {
      console.error(
        'Some generated integration resources may remain; inspect the cleanup errors before retrying',
      );
    } else {
      console.info(
        'Removed generated integration resources; development databases and users were not changed',
      );
    }
  }
}
