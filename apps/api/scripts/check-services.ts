import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { configurationValue, configuredPort, runServiceChecks } from './lib/service-checks.js';

const env = process.env;

const results = await runServiceChecks([
  {
    service: 'PostgreSQL',
    probe: async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: configuredPort(env.POSTGRES_PORT ?? '55432'),
        database: configurationValue(env, 'POSTGRES_DB'),
        user: configurationValue(env, 'POSTGRES_USER'),
        password: configurationValue(env, 'POSTGRES_PASSWORD'),
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1 AS connected');
      } finally {
        await client.end();
      }
    },
  },
  {
    service: 'MongoDB',
    probe: async () => {
      const user = encodeURIComponent(configurationValue(env, 'MONGO_ROOT_USER'));
      const password = encodeURIComponent(configurationValue(env, 'MONGO_ROOT_PASSWORD'));
      const port = configuredPort(env.MONGO_PORT ?? '57017');
      const client = new MongoClient(
        `mongodb://${user}:${password}@127.0.0.1:${port}/?authSource=admin`,
        {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 5000,
        },
      );
      try {
        await client.connect();
        await client.db('admin').command({ ping: 1 });
      } finally {
        await client.close();
      }
    },
  },
]);

for (const result of results) {
  console.info(
    `${result.ok ? 'PASS' : 'FAIL'} ${result.service}${result.code ? `: ${result.code}` : ': authenticated query succeeded'}`,
  );
}
if (results.some((result) => !result.ok)) {
  console.error('Check npm run doctor -- --require-docker, container health and the root .env.');
  process.exitCode = 1;
}
