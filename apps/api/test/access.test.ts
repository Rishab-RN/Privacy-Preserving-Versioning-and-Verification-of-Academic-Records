import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureApiEnvironment } from '../scripts/access/setup.js';
import { readDataConfig } from '../src/data-runtime.js';
import { evidenceInput, encodeEvidence, parse, uuid } from '../src/inputs.js';
import {
  digestToken,
  hashPassword,
  newToken,
  verifyPassword,
  WindowLimiter,
} from '../src/security.js';

test('scrypt credentials verify without storing a password, and session tokens have random entropy', async () => {
  const password = 'SyntheticPasswordForTests123';
  const material = await hashPassword(password);
  assert.equal(material.profile, 'scrypt-v1');
  assert.equal(JSON.stringify(material).includes(password), false);
  assert.equal(await verifyPassword(password, material), true);
  assert.equal(await verifyPassword('incorrect password', material), false);
  const first = newToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, newToken());
  assert.match(digestToken(first), /^[a-f0-9]{64}$/);
});

test('bounded limiter rejects attempts and allows a new window', () => {
  let now = 1;
  const limiter = new WindowLimiter(2, 100, () => now);
  limiter.take('a');
  limiter.take('a');
  assert.throws(() => limiter.take('a'), /Retry later/);
  now = 102;
  assert.doesNotThrow(() => limiter.take('a'));
});

test('opaque identifiers accept PostgreSQL UUIDs without imposing version bits', () => {
  assert.equal(
    parse(uuid, '11111111-2222-ffff-0123-ABCDEF123456'),
    '11111111-2222-ffff-0123-abcdef123456',
  );
  assert.throws(() => parse(uuid, '11111111-2222-ffff-0123-abcdef123456;SELECT'));
});

test('evidence encoding is deterministic, bounded in UTF8 and rejects client-owned identity fields', () => {
  const input = {
    schemaVersion: 1,
    category: 'supporting_note',
    data: { b: true, a: 'Synthetic note' },
  };
  const first = encodeEvidence(parse(evidenceInput, input));
  const second = encodeEvidence(
    parse(evidenceInput, { ...input, data: { a: 'Synthetic note', b: true } }),
  );
  assert.deepEqual(first, second);
  assert.throws(() => parse(evidenceInput, { ...input, institutionId: 'untrusted' }));
  assert.throws(() => parse(evidenceInput, { ...input, data: { $where: 'bad' } }));
  const large = {
    ...input,
    data: Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`field${index}`, '界'.repeat(3000)]),
    ),
  };
  assert.throws(() => encodeEvidence(parse(evidenceInput, large)), /65536/);
});

test('API provisioning configuration is generated once, independently, and never overwrites existing values', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarproof-access-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, '.env.api');
  const first = ensureApiEnvironment(path);
  const bytes = readFileSync(path);
  assert.notEqual(first.API_POSTGRES_PASSWORD, first.API_MONGO_PASSWORD);
  assert.deepEqual(ensureApiEnvironment(path), first);
  assert.deepEqual(readFileSync(path), bytes);
  writeFileSync(path, bytes.toString() + 'API_DATA_ENABLED=true\n');
  assert.throws(() => ensureApiEnvironment(path), /duplicate/);
});

test('data API fails closed without explicit setup and rejects administrative identities', () => {
  assert.equal(readDataConfig({}), null);
  assert.throws(() => readDataConfig({ API_DATA_ENABLED: 'yes' }));
  assert.throws(() => readDataConfig({ API_DATA_ENABLED: 'true' }), /Configure/);
  assert.throws(
    () =>
      readDataConfig({
        API_DATA_ENABLED: 'true',
        POSTGRES_DB: 'scholarproof',
        POSTGRES_USER: 'admin',
        API_POSTGRES_USER: 'admin',
        API_MONGO_USER: 'api',
        API_MONGO_DB: 'evidence',
      }),
    /dedicated/,
  );
});
