import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import {
  canonicalBytes,
  commitEvent,
  compareCheckpoints,
  consistencyProof,
  inclusionProof,
  merkleRoot,
  signCheckpoint,
  verifyEventProof,
} from '@academic-records/verification';
import { connectTestClient, fixture } from '../database/helpers.js';
import { projectRoot } from '../../apps/api/scripts/db/config.js';
import { assertRetainedPrefix } from '../../apps/log/src/anchor.js';
import { auditJournal } from '../../apps/log/src/audit.js';
import {
  exportEventProof,
  journalCommitments,
  publishCheckpoint,
  readJournal,
} from '../../apps/log/src/journal.js';
import { openWorkerRuntime, workerConfig } from '../../apps/worker/src/runtime.js';
import { runBatch } from '../../apps/worker/src/runner.js';
import { assertLogSqlIdentity } from '../../apps/log/src/identity.js';
import { createApp } from '../../apps/api/src/app.js';
import { openDataRuntime, readDataConfig } from '../../apps/api/src/data-runtime.js';
import { digestToken, newToken } from '../../apps/api/src/security.js';
import type { CorrectionIntegrity } from '@scholarproof/contracts';

test('signed workflow history is independently verified against retained observations and actual SQL/Mongo data', async (context) => {
  const admin = await connectTestClient();
  context.after(() => admin.end());
  const log = await connectTestClient();
  context.after(() => log.end());
  await log.query('SET ROLE academic_log_signer');
  const mongo = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT ?? '57017'}`, {
    authSource: 'admin',
    auth: { username: process.env.MONGO_ROOT_USER!, password: process.env.MONGO_ROOT_PASSWORD! },
    serverSelectionTimeoutMS: 3000,
  });
  await mongo.connect();
  context.after(() => mongo.close());
  const db = mongo.db(process.env.TEST_MONGO_DATABASE!);
  assert.match(db.databaseName, /^scholarproof_test_[a-f0-9]{32}$/);
  const worker = await openWorkerRuntime(workerConfig());
  context.after(() => worker.close());
  const f = await fixture(admin),
    logId = f.id('institution');
  const reviewerToken = newToken();
  const proposer = randomBytes(32).toString('hex'),
    approver = digestToken(reviewerToken),
    approverId = randomUUID();
  await admin.query(
    'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$1::uuid::text)',
    [approverId],
  );
  await admin.query(
    "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar')",
    [logId, approverId],
  );
  await admin.query(
    'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2),($3,$4)',
    [proposer, f.id('author'), approver, approverId],
  );
  const evidenceId = randomUUID();
  const bodyUtf8 = JSON.stringify({
    schemaVersion: 1,
    category: 'supporting_note',
    data: { note: 'Synthetic signed-history integration evidence' },
  });
  const digest = createHash('sha256').update(bodyUtf8).digest('hex'),
    size = Buffer.byteLength(bodyUtf8);
  await admin.query(
    "INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes) VALUES($1,$2,$3,$4,'supporting_note',$5,$6)",
    [evidenceId, f.id('record'), f.id('author'), randomUUID(), digest, size],
  );
  const document = {
    _id: evidenceId,
    schemaVersion: 1,
    institutionId: logId,
    recordId: f.id('record'),
    submittedBy: f.id('author'),
    digestSha256: digest,
    sizeBytes: size,
    bodyUtf8,
  };
  const evidenceCollection = db.collection<typeof document>('evidence_documents');
  await evidenceCollection.insertOne(document);
  await admin.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
    evidenceId,
  ]);
  const keys = generateKeyPairSync('ed25519');
  const empty = await publishCheckpoint(log, logId, keys.privateKey, keys.publicKey);
  assert.equal(empty.body.treeSize, 0);
  const request = (
    await admin.query<{ id: string }>(
      "SELECT workflow.propose_change($1,$2,$3,0,8,'passed','2026-01-01T00:00:00Z',NULL,$4,'Signed history fixture') AS id",
      [proposer, f.id('record'), randomUUID(), evidenceId],
    )
  ).rows[0]!.id;
  const first = await publishCheckpoint(log, logId, keys.privateKey, keys.publicKey, empty);
  assert.equal(first.body.treeSize, 1);
  await admin.query("SELECT workflow.approve_change($1,$2,'Independent signed fixture approval')", [
    approver,
    request,
  ]);
  const accepted = await publishCheckpoint(log, logId, keys.privateKey, keys.publicKey, first);
  const snapshot = await readJournal(log, logId);
  const event = snapshot.entries.find((e) => e.payload.kind === 'grade.accepted')!;

  await context.test(
    'commitments, inclusion, consistency, exact checkpoint retries and an offline CLI agree',
    async () => {
      assert.equal(accepted.body.treeSize, 2);
      assert.equal(accepted.body.bootstrapSize, 0);
      assert.deepEqual(
        await publishCheckpoint(log, logId, keys.privateKey, keys.publicKey, accepted),
        accepted,
      );
      const proof = exportEventProof(snapshot, accepted, event.eventId);
      proof.consistencyProof = consistencyProof(journalCommitments(snapshot), first.body.treeSize);
      assert.equal(
        verifyEventProof(proof, keys.publicKey, { logId, eventId: event.eventId }).valid,
        true,
      );
      assert.equal(
        compareCheckpoints(first, accepted, proof.consistencyProof, keys.publicKey).code,
        'valid',
      );
      const directory = resolve(projectRoot, '.runtime', 'verify-test-' + randomUUID());
      mkdirSync(directory, { recursive: true });
      try {
        const bundlePath = join(directory, 'proof.json'),
          publicPath = join(directory, 'public.pem'),
          previousPath = join(directory, 'previous.json');
        writeFileSync(bundlePath, canonicalBytes(proof));
        writeFileSync(previousPath, canonicalBytes(first));
        writeFileSync(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
        const result = execFileSync(
          process.execPath,
          [
            resolve(projectRoot, 'packages/verification/dist/cli.js'),
            'verify',
            '--bundle',
            bundlePath,
            '--public-key',
            publicPath,
            '--log-id',
            logId,
            '--event-id',
            event.eventId,
            '--previous',
            previousPath,
          ],
          { encoding: 'utf8', windowsHide: true },
        );
        assert.equal(JSON.parse(result).valid, true);
        assert.ok(!readFileSync(bundlePath, 'utf8').includes('PRIVATE KEY'));
      } finally {
        const base = resolve(projectRoot, '.runtime') + sep;
        assert.ok(
          directory.startsWith(base) &&
            /^verify-test-[a-f0-9-]+$/.test(directory.slice(base.length)),
        );
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  await context.test(
    'scoped integrity checks distinguish bad proofs, retained conflicts, SQL rollback and missing trust',
    async () => {
      const directory = resolve(projectRoot, '.runtime', 'witness-api-' + randomUUID());
      mkdirSync(directory);
      const retained = join(directory, logId + '.json');
      const publicPath = join(directory, 'test-public.pem');
      const savedKey = process.env.ZK_LOG_PUBLIC_KEY_FILE;
      const savedWitness = process.env.LOG_WITNESS_DIRECTORY;
      writeFileSync(publicPath, keys.publicKey.export({ format: 'pem', type: 'spki' }));
      writeFileSync(retained, canonicalBytes(first));
      process.env.ZK_LOG_PUBLIC_KEY_FILE = publicPath;
      process.env.LOG_WITNESS_DIRECTORY = directory;
      const runtime = await openDataRuntime(readDataConfig()!);
      const server = createApp(runtime.platform).listen(0, '127.0.0.1');
      try {
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}/api/v1/change-requests/`;
        const submit = (bundle: unknown, id = request, token = reviewerToken) =>
          fetch(url + id + '/integrity', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({ bundle: canonicalBytes(bundle).toString('utf8') }),
          });
        const proof = exportEventProof(snapshot, accepted, event.eventId);
        const commitments = journalCommitments(snapshot);
        const path = consistencyProof(commitments, first.body.treeSize);
        assert.equal((await submit(proof, request, newToken())).status, 401);
        assert.equal((await submit(proof, randomUUID())).status, 404);
        await assert.rejects(
          runtime.platform.repository.sql.query('SELECT transparency.read_expected_event($1)', [
            event.eventId,
          ]),
          { code: '42501' },
        );
        await assert.rejects(
          runtime.platform.repository.sql.query('SELECT salt FROM transparency.event_position'),
          { code: '42501' },
        );

        const check = async (bundle: unknown) => {
          const response = await submit(bundle);
          assert.equal(response.status, 200);
          return (await response.json()) as CorrectionIntegrity;
        };
        assert.deepEqual(await check({ ...proof, consistencyProof: path }), {
          event: 'verified',
          witness: 'extended',
          committed: 2,
          checkpointSize: 2,
          retainedSize: 1,
        });
        assert.equal((await check(proof)).witness, 'invalid-consistency');
        assert.equal(
          (await check({ ...proof, checkpoint: { ...accepted, signature: 'A'.repeat(86) } })).event,
          'invalid-proof',
        );
        assert.equal(
          (await check({ ...proof, inclusionProof: ['0'.repeat(64)] })).event,
          'invalid-proof',
        );
        assert.equal(
          (await check(exportEventProof(snapshot, accepted, snapshot.entries[0]!.eventId))).event,
          'invalid-proof',
        );
        const outOfScope = await fixture(admin);
        const foreignToken = newToken();
        await admin.query(
          'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
          [digestToken(foreignToken), outOfScope.id('author')],
        );
        assert.equal((await submit(proof, request, foreignToken)).status, 404);
        await assert.rejects(
          runtime.platform.repository.sql.query('SELECT transparency.review_event($1,$2,NULL)', [
            digestToken(newToken()),
            request,
          ]),
          { code: '28000' },
        );

        writeFileSync(retained, canonicalBytes(accepted));
        assert.equal((await check(proof)).witness, 'matched');
        const otherCommitments = ['b'.repeat(64), commitEvent(proof.entry)];
        const split = signCheckpoint(
          { ...accepted.body, rootHash: merkleRoot(otherCommitments) },
          keys.privateKey,
        );
        const conflicting = await check({
          ...proof,
          checkpoint: split,
          inclusionProof: inclusionProof(otherCommitments, 1),
        });
        assert.equal(conflicting.event, 'verified');
        assert.equal(conflicting.witness, 'split-view');

        await admin.query("SET session_replication_role='replica'");
        try {
          await admin.query(
            'UPDATE transparency.log_state SET tree_size=1 WHERE institution_id=$1',
            [logId],
          );
          const rolledBack = await check(proof);
          assert.equal(rolledBack.event, 'journal-mismatch');
          assert.equal(rolledBack.witness, 'journal-behind-witness');
          await admin.query(
            'UPDATE transparency.log_state SET tree_size=2 WHERE institution_id=$1',
            [logId],
          );
          await admin.query(
            'UPDATE academic.grade_version SET grade_points=9 WHERE record_id=$1 AND version_no=1',
            [f.id('record')],
          );
          assert.equal((await check(proof)).event, 'journal-mismatch');
        } finally {
          await admin.query(
            'UPDATE transparency.log_state SET tree_size=2 WHERE institution_id=$1',
            [logId],
          );
          await admin.query(
            'UPDATE academic.grade_version SET grade_points=8 WHERE record_id=$1 AND version_no=1',
            [f.id('record')],
          );
          await admin.query("SET session_replication_role='origin'");
        }
        unlinkSync(retained);
        assert.equal((await check(proof)).witness, 'unavailable');
        unlinkSync(publicPath);
        assert.equal((await check(proof)).event, 'key-unavailable');
      } finally {
        server.closeAllConnections();
        server.close();
        await runtime.close();
        if (savedKey === undefined) delete process.env.ZK_LOG_PUBLIC_KEY_FILE;
        else process.env.ZK_LOG_PUBLIC_KEY_FILE = savedKey;
        if (savedWitness === undefined) delete process.env.LOG_WITNESS_DIRECTORY;
        else process.env.LOG_WITNESS_DIRECTORY = savedWitness;
        for (const path of [retained, publicPath]) rmSync(path, { force: true });
        rmdirSync(directory);
      }
    },
  );
  await context.test(
    'pending projections are separate from a valid anchored event; delivery completes the audit',
    async () => {
      const pending = await auditJournal(snapshot, db);
      assert.equal(pending.integrity, 'valid');
      assert.equal(pending.projection, 'pending');
      for (let i = 0; i < 100; i++) {
        const result = await runBatch(worker.sql, worker.db);
        assert.equal(result.failed, 0);
        if (!result.claimed) break;
      }
      const delivered = await auditJournal(await readJournal(log, logId), db);
      assert.equal(delivered.integrity, 'valid');
      assert.equal(delivered.projection, 'complete');
    },
  );
  await context.test(
    'an actual grade change is detected even though stored event hashes were untouched',
    async () => {
      await admin.query("SET session_replication_role='replica'");
      try {
        await admin.query(
          'UPDATE academic.grade_version SET grade_points=9 WHERE record_id=$1 AND version_no=1',
          [f.id('record')],
        );
        await assert.rejects(readJournal(log, logId), /Event differs/);
      } finally {
        await admin.query(
          'UPDATE academic.grade_version SET grade_points=8 WHERE record_id=$1 AND version_no=1',
          [f.id('record')],
        );
        await admin.query("SET session_replication_role='origin'");
      }
    },
  );
  await context.test(
    'actual raw Mongo evidence bytes are rehashed, and store outage is unavailable',
    async () => {
      await evidenceCollection.updateOne(
        { _id: evidenceId },
        { $set: { bodyUtf8: bodyUtf8.replace('history', 'h1story') } },
      );
      try {
        assert.equal((await auditJournal(await readJournal(log, logId), db)).integrity, 'invalid');
      } finally {
        await evidenceCollection.updateOne({ _id: evidenceId }, { $set: { bodyUtf8 } });
      }
      const unavailable = {
        collection() {
          return {
            findOne: async () => {
              throw new Error('Synthetic offline store');
            },
          };
        },
      };
      assert.equal(
        (await auditJournal(snapshot, unavailable as unknown as typeof db)).integrity,
        'unavailable',
      );
    },
  );
  await context.test(
    'deleting an anchored position is detected, then its exact private salt is restored',
    async () => {
      const saved = (
        await admin.query('SELECT * FROM transparency.event_position WHERE event_id=$1', [
          event.eventId,
        ])
      ).rows[0]!;
      await admin.query("SET session_replication_role='replica'");
      try {
        await admin.query('DELETE FROM transparency.event_position WHERE event_id=$1', [
          event.eventId,
        ]);
        await assert.rejects(readJournal(log, logId), /entries do not match/);
      } finally {
        await admin.query(
          'INSERT INTO transparency.event_position(event_id,institution_id,leaf_index,salt) VALUES($1,$2,$3,$4)',
          [saved.event_id, saved.institution_id, saved.leaf_index, saved.salt],
        );
        await admin.query("SET session_replication_role='origin'");
      }
      assertRetainedPrefix(await readJournal(log, logId), accepted, keys.publicKey);
    },
  );
  await context.test('a stale SQL grade head is rejected as structural inconsistency', async () => {
    await admin.query("SET session_replication_role='replica'");
    try {
      await admin.query(
        'UPDATE academic.grade_record SET latest_version_no=NULL WHERE record_id=$1',
        [f.id('record')],
      );
      await assert.rejects(
        readJournal(log, logId),
        (error) => (error as { code?: string }).code === 'JOURNAL_INTEGRITY',
      );
    } finally {
      try {
        await admin.query(
          'UPDATE academic.grade_record SET latest_version_no=1 WHERE record_id=$1',
          [f.id('record')],
        );
      } finally {
        await admin.query("SET session_replication_role='origin'");
      }
    }
  });
  await context.test(
    'signer startup rejects unexpected inherited server-program capability',
    async () => {
      const login = 'log_guard_' + randomUUID().replaceAll('-', '');
      await admin.query('BEGIN');
      try {
        await admin.query(
          `CREATE ROLE "${login}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );
        await admin.query(`GRANT academic_log_signer TO "${login}"`);
        await admin.query(`SET LOCAL ROLE "${login}"`);
        await assertLogSqlIdentity(admin);
        await admin.query('RESET ROLE');
        await admin.query('GRANT pg_execute_server_program TO academic_log_signer');
        await admin.query(`SET LOCAL ROLE "${login}"`);
        await assert.rejects(assertLogSqlIdentity(admin), /Unsafe/);
      } finally {
        await admin.query('ROLLBACK');
      }
    },
  );
  await context.test(
    'a real position rewrite and a simulated shorter observation cannot be silently re-signed',
    async () => {
      const original = (
        await admin.query<{ event_id: string; leaf_index: string }>(
          'SELECT event_id,leaf_index FROM transparency.event_position WHERE institution_id=$1',
          [logId],
        )
      ).rows;
      await admin.query("SET session_replication_role='replica'");
      try {
        await admin.query(
          'UPDATE transparency.event_position SET leaf_index=leaf_index+100 WHERE institution_id=$1',
          [logId],
        );
        await admin.query(
          'UPDATE transparency.event_position SET leaf_index=CASE leaf_index WHEN 100 THEN 1 ELSE 0 END WHERE institution_id=$1',
          [logId],
        );
        const reordered = await readJournal(log, logId);
        assert.throws(() => assertRetainedPrefix(reordered, accepted, keys.publicKey), /differs/);
        await assert.rejects(
          publishCheckpoint(log, logId, keys.privateKey, keys.publicKey, accepted),
          /does not match/,
        );
      } finally {
        try {
          await admin.query(
            'UPDATE transparency.event_position SET leaf_index=leaf_index+1000 WHERE institution_id=$1',
            [logId],
          );
          for (const row of original)
            await admin.query(
              'UPDATE transparency.event_position SET leaf_index=$1 WHERE event_id=$2',
              [row.leaf_index, row.event_id],
            );
        } finally {
          await admin.query("SET session_replication_role='origin'");
        }
      }
      const restored = await readJournal(log, logId);
      assertRetainedPrefix(restored, accepted, keys.publicKey);
      assert.throws(
        () =>
          assertRetainedPrefix(
            { ...restored, treeSize: 1, entries: restored.entries.slice(0, 1) },
            accepted,
            keys.publicKey,
          ),
        /shorter/,
      );
    },
  );
});
