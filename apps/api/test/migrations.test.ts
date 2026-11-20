import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredDatabase, quoteDatabaseName } from '../scripts/db/config.js';
import { sqlChecksum, verifyMigrationHistory } from '../scripts/db/migrations.js';

test('migration checksums are stable across checkout line endings', () => {
  assert.equal(sqlChecksum('SELECT 1;\nSELECT 2;\n'), sqlChecksum('SELECT 1;\r\nSELECT 2;\r\n'));
});

test('migration history rejects modified, missing and reordered applied files', () => {
  const migrations = [
    { version: '0001', name: '0001_first.sql', checksum: sqlChecksum('SELECT 1'), sql: 'SELECT 1' },
    {
      version: '0002',
      name: '0002_second.sql',
      checksum: sqlChecksum('SELECT 2'),
      sql: 'SELECT 2',
    },
  ];
  const first = migrations[0]!;
  const second = migrations[1]!;
  assert.doesNotThrow(() => verifyMigrationHistory(migrations, [first]));
  assert.throws(
    () => verifyMigrationHistory(migrations, [{ ...first, checksum: '0'.repeat(64) }]),
    /checksum/,
  );
  assert.throws(() => verifyMigrationHistory(migrations, [second]), /prefix/);
  assert.throws(() => verifyMigrationHistory([first], [first, second]), /prefix/);
});

test('database tooling rejects unsafe identifiers and protects maintenance databases', () => {
  for (const name of ['', 'some-db', 'template0; DROP DATABASE other', 'UPPERCASE']) {
    assert.throws(() => quoteDatabaseName(name));
  }
  for (const POSTGRES_DB of ['postgres', 'template0', 'template1']) {
    assert.throws(() => configuredDatabase({ POSTGRES_DB }), /dedicated/);
  }
  assert.equal(quoteDatabaseName('scholarproof_test_123'), '"scholarproof_test_123"');
});
