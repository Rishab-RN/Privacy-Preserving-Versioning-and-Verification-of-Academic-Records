import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { logConfig } from './config.js';
import { assertLogMongoIdentity, assertLogSqlIdentity } from './identity.js';

export async function openLogRuntime(config = logConfig(), requireMongo = true) {
  const sql = new Client({
    host: '127.0.0.1',
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    application_name: 'academic-transparency-operator',
  });
  const mongo = new MongoClient(`mongodb://127.0.0.1:${config.mongoPort}`, {
    authSource: config.mongoDatabase,
    auth: { username: config.mongoUser, password: config.mongoPassword },
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
    socketTimeoutMS: 10000,
    maxPoolSize: 2,
  });
  const close = async () => {
    await Promise.allSettled([sql.end(), mongo.close()]);
  };
  try {
    await sql.connect();
    await assertLogSqlIdentity(sql);
    const db = mongo.db(config.mongoDatabase);
    if (requireMongo) {
      await mongo.connect();
      await assertLogMongoIdentity(db);
    }
    return { sql, db, close };
  } catch (error) {
    await close();
    throw error;
  }
}
