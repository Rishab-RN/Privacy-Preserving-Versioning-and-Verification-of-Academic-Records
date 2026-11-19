import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';

test('uses loopback development defaults without requiring a database', () => {
  assert.deepEqual(readConfig({}), {
    host: '127.0.0.1',
    port: 4000,
    environment: 'development',
  });
});

test('rejects ambiguous or invalid ports instead of coercing them', () => {
  for (const API_PORT of ['', '0', '-1', '1.5', '4e3', '4000oops', '65536']) {
    assert.throws(() => readConfig({ API_PORT }), /API_PORT/);
  }
});

test('validates the environment and requires a nonempty bind address', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'staging' }), /NODE_ENV/);
  assert.throws(() => readConfig({ API_HOST: '  ' }), /API_HOST/);
  assert.deepEqual(readConfig({ API_PORT: '65535', NODE_ENV: 'production' }), {
    host: '127.0.0.1',
    port: 65535,
    environment: 'production',
  });
});
