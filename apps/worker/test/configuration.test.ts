import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkerEnvironment } from '../scripts/setup.js';
import { workerConfig } from '../src/runtime.js';

test('worker provisioning preserves independently generated credentials and rejects duplicate settings', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarproof-worker-'));
  const path = join(directory, '.env.worker');
  context.after(() => {
    rmSync(path, { force: true });
    rmdirSync(directory);
  });
  const first = ensureWorkerEnvironment(path);
  const contents = readFileSync(path);
  assert.notEqual(first.WORKER_POSTGRES_PASSWORD, first.WORKER_MONGO_PASSWORD);
  assert.deepEqual(ensureWorkerEnvironment(path), first);
  assert.deepEqual(readFileSync(path), contents);
  writeFileSync(path, contents.toString() + 'WORKER_POSTGRES_USER=scholarproof_worker\n');
  assert.throws(() => ensureWorkerEnvironment(path));
});

test('worker configuration requires a dedicated runtime identity', () => {
  assert.throws(() => workerConfig({}));
  const env = {
    POSTGRES_DB: 'scholarproof',
    POSTGRES_USER: 'admin',
    MONGO_ROOT_USER: 'root',
    WORKER_POSTGRES_USER: 'worker',
    WORKER_POSTGRES_PASSWORD: 'test-only',
    WORKER_MONGO_USER: 'worker',
    WORKER_MONGO_PASSWORD: 'test-only',
    WORKER_MONGO_DB: 'evidence',
  };
  assert.equal(workerConfig(env).user, 'worker');
  assert.throws(() => workerConfig({ ...env, WORKER_POSTGRES_USER: 'admin' }), /dedicated/);
  assert.throws(() => workerConfig({ ...env, WORKER_MONGO_DB: 'admin' }), /dedicated/);
  assert.throws(() => workerConfig({ ...env, POSTGRES_PORT: '55432junk' }));
});
