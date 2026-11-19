import { Client } from 'pg';
import { MongoClient } from 'mongodb';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in the root .env before checking local services`);
  return value;
}

const postgres = new Client({
  host: '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? '55432'),
  database: required('POSTGRES_DB'),
  user: required('POSTGRES_USER'),
  password: required('POSTGRES_PASSWORD'),
  connectionTimeoutMillis: 5000,
});

const mongoUser = encodeURIComponent(required('MONGO_ROOT_USER'));
const mongoPassword = encodeURIComponent(required('MONGO_ROOT_PASSWORD'));
const mongoPort = process.env.MONGO_PORT ?? '57017';
const mongo = new MongoClient(
  `mongodb://${mongoUser}:${mongoPassword}@127.0.0.1:${mongoPort}/?authSource=admin`,
  { serverSelectionTimeoutMS: 5000 },
);

try {
  await postgres.connect();
  await postgres.query('SELECT 1 AS connected');
  console.info('PostgreSQL: authenticated SELECT 1 succeeded');
  await mongo.connect();
  await mongo.db('admin').command({ ping: 1 });
  console.info('MongoDB: authenticated ping succeeded');
} catch {
  console.error('Local service check failed. Check Docker health and the root .env credentials.');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([postgres.end(), mongo.close()]);
}
