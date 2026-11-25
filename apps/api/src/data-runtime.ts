import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { closeProofRuntime } from '@academic-records/zk';
import { MongoEvidenceStore, verifyEvidenceCollection } from './evidence-store.js';
import { Repository } from './repository.js';
import { Platform } from './platform.js';
import { assertSafeSqlIdentity, assertSafeMongoIdentity } from './runtime-identity.js';

export interface DataConfig {
  database: string;
  port: number;
  user: string;
  password: string;
  mongoDatabase: string;
  mongoPort: number;
  mongoUser: string;
  mongoPassword: string;
}
export function readDataConfig(env: NodeJS.ProcessEnv = process.env): DataConfig | null {
  if (env.API_DATA_ENABLED === undefined || env.API_DATA_ENABLED === 'false') return null;
  if (env.API_DATA_ENABLED !== 'true') throw new Error('API_DATA_ENABLED must be true or false');
  const required = (key: string) => {
    const value = env[key];
    if (!value || value.startsWith('replace-with-'))
      throw new Error(`Configure ${key} using access:setup`);
    return value;
  };
  const port = (key: string, fallback: string) => {
    const value = env[key] ?? fallback;
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const database = required('POSTGRES_DB');
  const user = required('API_POSTGRES_USER');
  const mongoDatabase = required('API_MONGO_DB');
  const mongoUser = required('API_MONGO_USER');
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    ['postgres', 'template0', 'template1'].includes(database) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(mongoDatabase) ||
    user === env.POSTGRES_USER ||
    mongoUser === env.MONGO_ROOT_USER
  ) {
    throw new Error('Use dedicated API identities and project databases');
  }
  return {
    database,
    port: port('POSTGRES_PORT', '55432'),
    user,
    password: required('API_POSTGRES_PASSWORD'),
    mongoDatabase,
    mongoPort: port('MONGO_PORT', '57017'),
    mongoUser,
    mongoPassword: required('API_MONGO_PASSWORD'),
  };
}

export async function openDataRuntime(config: DataConfig) {
  const sql = new Pool({
    host: '127.0.0.1',
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  sql.on('error', () => console.error('PostgreSQL runtime connection failed'));
  const mongo = new MongoClient(`mongodb://127.0.0.1:${config.mongoPort}`, {
    auth: { username: config.mongoUser, password: config.mongoPassword },
    authSource: config.mongoDatabase,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 5000,
  });
  const close = async () => {
    await Promise.allSettled([sql.end(), mongo.close(), closeProofRuntime()]);
  };
  try {
    await assertSafeSqlIdentity(sql);
    await mongo.connect();
    await assertSafeMongoIdentity(mongo.db(config.mongoDatabase));
    await verifyEvidenceCollection(mongo.db(config.mongoDatabase));
    await mongo
      .db(config.mongoDatabase)
      .collection('evidence_documents')
      .findOne({}, { projection: { _id: 1 } });
    return {
      platform: new Platform(
        new Repository(sql),
        new MongoEvidenceStore(mongo.db(config.mongoDatabase)),
      ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
