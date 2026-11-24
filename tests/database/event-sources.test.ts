import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Client } from 'pg';
import { createDatabaseClient, quoteDatabaseName } from '../../apps/api/scripts/db/config.js';
import { applyMigrations, loadMigrations } from '../../apps/api/scripts/db/migrations.js';
import {
  checkpointKeyId,
  verifyEventProof,
  commitEvent,
  merkleRoot,
  signCheckpoint,
} from '@academic-records/verification';
import { generateKeyPairSync } from 'node:crypto';
import { exportEventProof, publishCheckpoint, readJournal } from '../../apps/log/src/journal.js';
import { connectTestClient, fixture } from './helpers.js';

async function sourceFixture(client: Client) {
  const f = await fixture(client);
  const evidence = randomUUID();
  await client.query(
    `INSERT INTO evidence.reference
    (evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
    VALUES($1,$2,$3,$4,'supporting_note',$5,20)`,
    [evidence, f.id('record'), f.id('author'), randomUUID(), randomBytes(32).toString('hex')],
  );
  await client.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
    evidence,
  ]);
  const token = randomBytes(32).toString('hex');
  await client.query('INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)', [
    token,
    f.id('author'),
  ]);
  const emit = async () => {
    await client.query('SET ROLE scholarproof_api_access');
    try {
      return (
        await client.query<{ id: string }>(
          `SELECT workflow.propose_change(
        $1,$2,$3,0,7,'passed','2026-01-01',NULL,$4,'Event source fixture') AS id`,
          [token, f.id('record'), randomUUID(), evidence],
        )
      ).rows[0]!.id;
    } finally {
      await client.query('RESET ROLE');
    }
  };
  return { f, emit };
}

test('source identities append atomically and registry/view privileges remain isolated', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const { f, emit } = await sourceFixture(client);
  await emit();
  const before = await client.query(
    `SELECT s.event_id,e.source_kind,e.institution_id,p.leaf_index
    FROM transparency.event_source s JOIN transparency.event_context e USING(event_id)
    JOIN transparency.event_position p USING(event_id) WHERE e.institution_id=$1`,
    [f.id('institution')],
  );
  assert.equal(before.rowCount, 1);
  assert.equal(before.rows[0]!.source_kind, 'workflow');
  await client.query('BEGIN');
  await emit();
  await client.query('ROLLBACK');
  assert.deepEqual(
    (
      await client.query(
        `SELECT s.event_id,e.source_kind,e.institution_id,p.leaf_index
    FROM transparency.event_source s JOIN transparency.event_context e USING(event_id)
    JOIN transparency.event_position p USING(event_id) WHERE e.institution_id=$1`,
        [f.id('institution')],
      )
    ).rows,
    before.rows,
  );
  for (const role of ['scholarproof_api_access', 'scholarproof_worker_access']) {
    await client.query(`SET ROLE ${role}`);
    try {
      await assert.rejects(client.query('SELECT * FROM transparency.event_source'), {
        code: '42501',
      });
      await assert.rejects(client.query('SELECT * FROM transparency.event_context'), {
        code: '42501',
      });
    } finally {
      await client.query('RESET ROLE');
    }
  }
  await client.query('SET ROLE academic_log_reader');
  try {
    assert.equal(
      (
        await client.query('SELECT * FROM transparency.event_context WHERE institution_id=$1', [
          f.id('institution'),
        ])
      ).rowCount,
      1,
    );
    await assert.rejects(
      client.query('INSERT INTO transparency.event_source VALUES($1)', [randomUUID()]),
      { code: '42501' },
    );
  } finally {
    await client.query('RESET ROLE');
  }
});

test('orphan registry identities fail deferred validation and existing identities are immutable', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  await client.query('BEGIN');
  const orphan = randomUUID();
  await client.query('INSERT INTO transparency.event_source VALUES($1)', [orphan]);
  await assert.rejects(client.query('COMMIT'), { code: '23503' });
  await client.query('ROLLBACK');
  assert.equal(
    (await client.query('SELECT 1 FROM transparency.event_source WHERE event_id=$1', [orphan]))
      .rowCount,
    0,
  );
  const { f, emit } = await sourceFixture(client);
  await emit();
  const event = (
    await client.query('SELECT event_id FROM transparency.event_context WHERE institution_id=$1', [
      f.id('institution'),
    ])
  ).rows[0]!.event_id;
  await assert.rejects(
    client.query('DELETE FROM transparency.event_source WHERE event_id=$1', [event]),
    { code: '55000' },
  );
  await assert.rejects(
    client.query('UPDATE transparency.event_source SET event_id=$1 WHERE event_id=$2', [
      randomUUID(),
      event,
    ]),
    { code: '55000' },
  );
});

test('populated source upgrade preserves signed history and old proofs after a new append', async () => {
  assert.match(process.env.TEST_DATABASE_NAME ?? '', /^scholarproof_test_[a-f0-9]{32}$/);
  const name = `scholarproof_test_${randomUUID().replaceAll('-', '')}`;
  const maintenance = createDatabaseClient('postgres');
  let client: Client | undefined;
  let created = false;
  try {
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteDatabaseName(name)} TEMPLATE template0`);
    created = true;
    client = createDatabaseClient(name);
    await client.connect();
    const migrations = loadMigrations();
    await applyMigrations(
      client,
      migrations.filter((m) => Number(m.version) <= 10),
    );
    const { f, emit } = await sourceFixture(client);
    await emit();
    const logId = f.id('institution');
    const keys = generateKeyPairSync('ed25519');
    // Before the shared view exists, capture its original authoritative bytes.
    const before = (
      await client.query('SELECT * FROM transparency.event_position ORDER BY event_id')
    ).rows;
    const state = (await client.query('SELECT * FROM transparency.log_state')).rows;
    const payloads = (
      await client.query('SELECT payload FROM workflow.domain_event ORDER BY event_id')
    ).rows;
    const position = before[0]!;
    const commitment = commitEvent({
      logId,
      index: 0,
      salt: position.salt.toString('hex'),
      payload: payloads[0]!.payload,
    });
    const signed = signCheckpoint(
      {
        profile: 'academic-records-log-v1',
        logId,
        treeSize: 1,
        bootstrapSize: 0,
        rootHash: merkleRoot([commitment]),
        issuedAt: '2026-11-25T10:00:00.000Z',
        keyId: checkpointKeyId(keys.publicKey),
      },
      keys.privateKey,
    );
    await client.query('SELECT transparency.record_checkpoint($1,$2,$3,$4,$5,$6)', [
      logId,
      1,
      Buffer.from(signed.body.rootHash, 'hex'),
      signed.body.issuedAt,
      signed.body.keyId,
      Buffer.from(signed.signature, 'base64url'),
    ]);
    const checkpoints = (await client.query('SELECT * FROM transparency.checkpoint')).rows;
    await applyMigrations(client, migrations);
    assert.deepEqual(
      (await client.query('SELECT * FROM transparency.event_position ORDER BY event_id')).rows,
      before,
    );
    assert.deepEqual((await client.query('SELECT * FROM transparency.log_state')).rows, state);
    assert.deepEqual(
      (await client.query('SELECT * FROM transparency.checkpoint')).rows,
      checkpoints,
    );
    assert.deepEqual(
      (await client.query('SELECT payload FROM workflow.domain_event ORDER BY event_id')).rows,
      payloads,
    );
    assert.deepEqual(
      await publishCheckpoint(client, logId, keys.privateKey, keys.publicKey, signed),
      signed,
    );
    const snapshot = await readJournal(client, logId);
    const proof = exportEventProof(snapshot, signed, snapshot.entries[0]!.eventId);
    await emit();
    const next = await readJournal(client, logId);
    assert.equal(next.treeSize, 2);
    assert.deepEqual(next.entries[0], snapshot.entries[0]);
    assert.equal(
      verifyEventProof(proof, keys.publicKey, { logId, eventId: snapshot.entries[0]!.eventId })
        .valid,
      true,
    );
    assert.deepEqual(await applyMigrations(client, migrations), []);
  } finally {
    await client?.end();
    if (created) await maintenance.query(`DROP DATABASE ${quoteDatabaseName(name)} WITH (FORCE)`);
    await maintenance.end();
  }
});
