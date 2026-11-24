import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  createDatabaseClient,
  projectRoot,
  quoteDatabaseName,
  safeDatabaseError,
} from './config.js';
import { applyMigrations, loadMigrations } from './migrations.js';

const databaseName = `scholarproof_test_${randomUUID().replaceAll('-', '')}`;
const maintenance = createDatabaseClient('postgres');
let created = false;
try {
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteDatabaseName(databaseName)} TEMPLATE template0`);
  created = true;
  const target = createDatabaseClient(databaseName);
  const concurrent = createDatabaseClient(databaseName);
  try {
    await Promise.all([target.connect(), concurrent.connect()]);
    const results = await Promise.all([applyMigrations(target), applyMigrations(concurrent)]);
    assert.deepEqual(
      results.map((applied) => applied.length).sort((a, b) => a - b),
      [0, loadMigrations().length],
    );
    console.info('Concurrent fresh migration runners applied each migration exactly once');
  } finally {
    await Promise.all([target.end(), concurrent.end()]);
  }
  console.info('Running database integration checks in an isolated temporary database');
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('tsx/cli')),
      '--test',
      '--test-concurrency=1',
      join(projectRoot, 'tests/database/academic.test.ts'),
      join(projectRoot, 'tests/database/access.test.ts'),
      join(projectRoot, 'tests/database/workflow.test.ts'),
      join(projectRoot, 'tests/database/bcnf.test.ts'),
      join(projectRoot, 'tests/database/bcnf-upgrade.test.ts'),
      join(projectRoot, 'tests/database/transparency.test.ts'),
      join(projectRoot, 'tests/database/event-sources.test.ts'),
      join(projectRoot, 'tests/database/migrations.test.ts'),
    ],
    {
      cwd: projectRoot,
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_NAME: databaseName },
    },
  );
  const [code] = await once(child, 'exit');
  process.exitCode = typeof code === 'number' ? code : 1;
} catch (error) {
  console.error(safeDatabaseError(error));
  process.exitCode = 1;
} finally {
  if (created) {
    if (/^scholarproof_test_[a-f0-9]{32}$/.test(databaseName)) {
      try {
        await maintenance.query(`DROP DATABASE ${quoteDatabaseName(databaseName)} WITH (FORCE)`);
        console.info('Removed the temporary test database; development data was not reset');
      } catch (error) {
        console.error(`Temporary database cleanup failed: ${safeDatabaseError(error)}`);
        process.exitCode = 1;
      }
    } else {
      console.error('Refusing cleanup of a database outside this test run');
      process.exitCode = 1;
    }
  }
  await maintenance.end();
}
