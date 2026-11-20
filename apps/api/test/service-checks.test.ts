import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configurationValue,
  configuredPort,
  runServiceChecks,
} from '../scripts/lib/service-checks.js';

test('one failed service does not prevent the other authenticated probe', async () => {
  let mongoChecked = false;
  const results = await runServiceChecks([
    {
      service: 'PostgreSQL',
      probe: async () => {
        throw Object.assign(new Error('synthetic-secret'), { code: 'ECONNREFUSED' });
      },
    },
    {
      service: 'MongoDB',
      probe: async () => {
        mongoChecked = true;
      },
    },
  ]);
  assert.equal(mongoChecked, true);
  assert.deepEqual(results, [
    { service: 'PostgreSQL', ok: false, code: 'ECONNREFUSED' },
    { service: 'MongoDB', ok: true },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /synthetic-secret/);
});

test('reports invalid configuration independently and validates complete port values', async () => {
  for (const value of ['', '0', '65536', '5e3', '57017oops']) {
    assert.throws(() => configuredPort(value));
  }
  const results = await runServiceChecks([
    {
      service: 'PostgreSQL',
      probe: async () => {
        configurationValue({}, 'POSTGRES_PASSWORD');
      },
    },
    { service: 'MongoDB', probe: async () => {} },
  ]);
  assert.equal(results[0]?.code, 'CONFIGURATION_INVALID');
  assert.equal(results[1]?.ok, true);
});

test('authentication failures are recognizable without returning exception contents', async () => {
  const results = await runServiceChecks([
    {
      service: 'PostgreSQL',
      probe: async () => {
        throw { code: '28P01', message: 'password=synthetic-secret' };
      },
    },
    {
      service: 'MongoDB',
      probe: async () => {
        throw { code: 18, message: 'mongodb://user:synthetic-secret@host' };
      },
    },
  ]);
  assert.equal(
    results.every((result) => result.code === 'AUTHENTICATION_FAILED'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(results), /synthetic-secret|mongodb:\/\//);
});

test('unknown exception codes cannot leak connection details', async () => {
  const results = await runServiceChecks([
    {
      service: 'MongoDB',
      probe: async () => {
        throw { code: 'mongodb://user:synthetic-secret@host', message: 'synthetic-secret' };
      },
    },
  ]);
  assert.deepEqual(results, [{ service: 'MongoDB', ok: false, code: 'CONNECTION_FAILED' }]);
});
