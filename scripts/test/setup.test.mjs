import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { initializeEnvironment, validateLocalEnvironment } from '../lib/environment.mjs';
import { ENV_TEMPLATE, temporaryProject } from './helpers.mjs';

test('creates independent generated passwords and preserves unrelated settings', (context) => {
  const root = temporaryProject(context);
  writeFileSync(join(root, '.env.example'), ENV_TEMPLATE);
  const result = initializeEnvironment(root);
  assert.equal(result.created, true);
  const contents = readFileSync(join(root, '.env'), 'utf8');
  const env = parseEnv(contents);
  assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
  assert.match(env.MONGO_ROOT_PASSWORD, /^[a-f0-9]{48}$/);
  assert.notEqual(env.POSTGRES_PASSWORD, env.MONGO_ROOT_PASSWORD);
  assert.equal(JSON.stringify(result).includes(env.POSTGRES_PASSWORD), false);
  assert.equal(JSON.stringify(result).includes(env.MONGO_ROOT_PASSWORD), false);
  assert.equal(env.POSTGRES_PORT, '55432');
  assert.equal(validateLocalEnvironment(contents).ok, true);
});

test('repeated setup never rotates initialized database credentials', (context) => {
  const root = temporaryProject(context);
  writeFileSync(join(root, '.env.example'), ENV_TEMPLATE);
  initializeEnvironment(root);
  const original = readFileSync(join(root, '.env'));
  assert.equal(initializeEnvironment(root).created, false);
  assert.deepEqual(readFileSync(join(root, '.env')), original);
});

test('preserves an existing environment byte-for-byte even without a template', (context) => {
  const root = temporaryProject(context);
  const existing = '# existing volume credentials\r\nPOSTGRES_PASSWORD=keep-me\r\n';
  writeFileSync(join(root, '.env'), existing);
  assert.equal(initializeEnvironment(root).created, false);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), existing);
});

test('rejects incomplete or duplicate secret templates without creating .env', (context) => {
  const root = temporaryProject(context);
  for (const contents of [
    ENV_TEMPLATE.replace(/^MONGO_ROOT_PASSWORD=.*\n/m, ''),
    `${ENV_TEMPLATE}POSTGRES_PASSWORD=duplicate\n`,
  ]) {
    writeFileSync(join(root, '.env.example'), contents);
    assert.throws(() => initializeEnvironment(root), /template/);
    assert.equal(existsSync(join(root, '.env')), false);
  }
});

test('refuses a non-file destination without altering it', (context) => {
  const root = temporaryProject(context);
  mkdirSync(join(root, '.env'));
  assert.throws(() => initializeEnvironment(root), /not a regular file/);
});

test('environment diagnostics reject placeholders and conflicting ports without exposing values', () => {
  const placeholder = validateLocalEnvironment(ENV_TEMPLATE);
  assert.equal(placeholder.ok, false);
  assert.doesNotMatch(JSON.stringify(placeholder), /replace-with-a-local/);
  const configured = ENV_TEMPLATE.replaceAll(
    'replace-with-a-local-postgres-password',
    'synthetic-secret-a',
  ).replaceAll('replace-with-a-local-mongo-password', 'synthetic-secret-b');
  assert.equal(
    validateLocalEnvironment(configured.replace('MONGO_PORT=57017', 'MONGO_PORT=55432')).ok,
    false,
  );
  const invalid = validateLocalEnvironment(configured.replace('API_PORT=4000', 'API_PORT=65536'));
  assert.equal(invalid.ok, false);
  assert.doesNotMatch(JSON.stringify(invalid), /synthetic-secret/);
});
