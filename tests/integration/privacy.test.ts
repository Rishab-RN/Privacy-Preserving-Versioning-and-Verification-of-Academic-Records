import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fixture, connectTestClient } from '../database/helpers.js';
import { PrivacyService } from '../../apps/api/src/privacy-runtime.js';
import { holderCommitment, proveEligibility } from '../../packages/zk/src/index.js';
import { readJournal, publishCheckpoint } from '../../apps/log/src/journal.js';
import { generateKeyPairSync } from 'node:crypto';

after(async () => {
  await (
    globalThis as { curve_bn128?: { terminate: () => Promise<void> } }
  ).curve_bn128?.terminate();
});
test('issuer-bound private grade proof uses approved facts, atomic one-use status and private SQL boundaries', async (context) => {
  const admin = await connectTestClient();
  context.after(() => admin.end());
  const f = await fixture(admin),
    studentId = randomUUID(),
    approverId = randomUUID();
  await admin.query(
    'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$1::uuid::text),($2,$2::uuid::text)',
    [studentId, approverId],
  );
  await admin.query('UPDATE academic.student SET user_id=$1 WHERE student_id=$2', [
    studentId,
    f.id('student'),
  ]);
  await admin.query(
    "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'student'),($1,$3,'registrar')",
    [f.id('institution'), studentId, approverId],
  );
  const student = randomBytes(32).toString('hex'),
    proposer = randomBytes(32).toString('hex'),
    approver = randomBytes(32).toString('hex');
  await admin.query(
    'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2),($3,$4),($5,$6)',
    [student, studentId, proposer, f.id('author'), approver, approverId],
  );
  const evidence = randomUUID();
  await admin.query(
    "INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes) VALUES($1,$2,$3,$4,'supporting_note',$5,20)",
    [evidence, f.id('record'), f.id('author'), randomUUID(), '0'.repeat(64)],
  );
  await admin.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
    evidence,
  ]);
  async function approve(expected: number) {
    const request = (
      await admin.query<{ id: string }>(
        "SELECT workflow.propose_change($1,$2,$3,$4,8.5,'passed','2000-01-01',NULL,$5,'ZK approved test result') AS id",
        [proposer, f.id('record'), randomUUID(), expected, evidence],
      )
    ).rows[0]!.id;
    await admin.query("SELECT workflow.approve_change($1,$2,'Independent ZK approval')", [
      approver,
      request,
    ]);
  }
  await approve(0);
  const restricted = new Pool({
    host: '127.0.0.1',
    port: Number(process.env.POSTGRES_PORT ?? 55432),
    database: process.env.TEST_DATABASE_NAME!,
    user: process.env.API_POSTGRES_USER!,
    password: process.env.API_POSTGRES_PASSWORD!,
    max: 3,
  });
  context.after(() => restricted.end());
  const service = new PrivacyService(restricted),
    secret = '1928374198237419283741928374',
    holder = await holderCommitment(secret);
  const id = randomUUID();
  const [credential, duplicate] = await Promise.all([
    service.issue(student, f.id('record'), id, holder),
    service.issue(student, f.id('record'), id, holder),
  ]);
  assert.deepEqual(credential, duplicate);
  const artifacts = {
    wasm: resolve('.runtime/zk-v1/grade_threshold_js/grade_threshold.wasm'),
    zkey: resolve('.runtime/zk-v1/grade_final.zkey'),
  };
  assert.equal(credential.grade, '850');
  assert.deepEqual(await service.issue(student, f.id('record'), id, holder), credential);
  await context.test(
    'issuer data is holder-scoped, immutable, BCNF and isolated from runtime tables',
    async () => {
      await assert.rejects(service.issue(proposer, f.id('record'), randomUUID(), holder), {
        code: 'P0002',
      });
      await assert.rejects(service.call('read_owned', [proposer, id]), { code: 'P0002' });
      await assert.rejects(restricted.query('SELECT * FROM privacy.credential'), { code: '42501' });
      await assert.rejects(
        admin.query('UPDATE privacy.credential SET salt=1 WHERE credential_id=$1', [id]),
        { code: '55000' },
      );
      const columns = (
        await admin.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='privacy' AND table_name='credential' ORDER BY ordinal_position",
        )
      ).rows.map((r) => r.column_name);
      assert.deepEqual(columns, [
        'credential_id',
        'request_id',
        'holder',
        'salt',
        'artifact',
        'issued_at',
      ]);
    },
  );
  async function challenge() {
    const q = await service.call<{ challengeId: string }>('new_challenge', [student, id, 800]);
    return service.challenge(q.challengeId);
  }
  const q = await challenge(),
    bundle = await proveEligibility(
      q.statement,
      { grade: credential.grade, salt: credential.salt, secret },
      artifacts,
    );
  await context.test(
    'verifier receives no exact grade or blinding; invalid proof does not consume the challenge',
    async () => {
      assert(!Object.hasOwn(q, 'grade'));
      assert(!Object.hasOwn(q, 'salt'));
      const changed = structuredClone(bundle);
      changed.proof.pi_a[0] = '1';
      await assert.rejects(service.verify(q.challengeId, changed), { code: 'INVALID_ZK_PROOF' });
      assert.equal((await service.challenge(q.challengeId)).used, false);
    },
  );
  await context.test(
    'concurrent copies produce exactly one successful current-status acceptance',
    async () => {
      const results = await Promise.allSettled([
        service.verify(q.challengeId, bundle),
        service.verify(q.challengeId, bundle),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const accepted = results.find((r) => r.status === 'fulfilled');
      assert(accepted?.status === 'fulfilled');
      assert.equal(accepted.value.exactGradeDisclosed, false);
      assert.equal(accepted.value.status, 'current');
      await assert.rejects(service.verify(q.challengeId, bundle), { code: 'CHALLENGE_USED' });
    },
  );
  await context.test(
    'signed source extends the old workflow tree without entering the Mongo grade queue',
    async () => {
      const logId = f.id('institution'),
        keys = generateKeyPairSync('ed25519');
      const snapshot = await readJournal(admin, logId);
      assert.equal(snapshot.treeSize, 3);
      assert.equal(snapshot.entries[2]!.sourceKind, 'credential');
      const payload = snapshot.entries[2]!.payload;
      assert.equal(payload.credentialId, id);
      assert(!Object.hasOwn(payload, 'salt'));
      assert(!Object.hasOwn(payload, 'grade'));
      const event = snapshot.entries[2]!.eventId;
      assert.equal(
        (await admin.query('SELECT 1 FROM workflow.outbox_delivery WHERE event_id=$1', [event]))
          .rowCount,
        0,
      );
      const signed = await publishCheckpoint(admin, logId, keys.privateKey, keys.publicKey);
      assert.equal(signed.body.treeSize, 3);
    },
  );
  await context.test('expired consent is rejected by both application and SQL clocks', async () => {
    const expired = randomUUID();
    await admin.query(
      "INSERT INTO privacy.challenge(challenge_id,credential_id,threshold,created_at) VALUES($1,$2,800,clock_timestamp()-interval '3 minutes')",
      [expired, id],
    );
    await assert.rejects(service.verify(expired, bundle), { code: 'CHALLENGE_EXPIRED' });
    await assert.rejects(service.call('consume', [expired]), { code: '22023' });
    assert.equal((await service.challenge(expired)).used, false);
  });
  await context.test(
    'revocation blocks a mathematically valid proof without consuming its challenge',
    async () => {
      const next = await challenge(),
        proof = await proveEligibility(
          next.statement,
          { grade: credential.grade, salt: credential.salt, secret },
          artifacts,
        );
      await service.call('revoke', [proposer, id, 'Revoked for test']);
      await assert.rejects(service.verify(next.challengeId, proof), { code: 'CREDENTIAL_REVOKED' });
      assert.equal((await service.challenge(next.challengeId)).used, false);
    },
  );
  await context.test(
    'a later approved record version supersedes an otherwise valid issued credential',
    async () => {
      const nextId = randomUUID(),
        other = await service.issue(student, f.id('record'), nextId, holder);
      const ch = await service.call<{ challengeId: string }>('new_challenge', [
        student,
        nextId,
        800,
      ]);
      const next = await service.challenge(ch.challengeId);
      const proof = await proveEligibility(
        next.statement,
        { grade: other.grade, salt: other.salt, secret },
        artifacts,
      );
      await approve(1);
      await assert.rejects(service.verify(next.challengeId, proof), {
        code: 'CREDENTIAL_SUPERSEDED',
      });
    },
  );
  const manifest = JSON.parse(readFileSync(resolve('.runtime/zk-v1/manifest.json'), 'utf8')) as {
    setup: string;
  };
  assert.equal(manifest.setup, 'local-development-only');
});
