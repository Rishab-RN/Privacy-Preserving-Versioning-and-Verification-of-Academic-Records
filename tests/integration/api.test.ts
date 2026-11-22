import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { createApp } from '../../apps/api/src/app.js';
import { openDataRuntime, readDataConfig } from '../../apps/api/src/data-runtime.js';
import { EVIDENCE_COLLECTION, MongoEvidenceStore } from '../../apps/api/src/evidence-store.js';
import type { EvidenceDocument, EvidenceStore } from '../../apps/api/src/evidence-store.js';
import { Platform } from '../../apps/api/src/platform.js';
import { digestToken, hashPassword, newToken } from '../../apps/api/src/security.js';
import { connectTestClient, fixture } from '../database/helpers.js';

const errorCode = (expected: string | number) => (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: unknown }).code === expected;
const password = 'Synthetic test password 2026';
const payload = {
  schemaVersion: 1 as const,
  category: 'supporting_note' as const,
  data: { note: 'Original evidence content', verified: true },
};

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}
interface RequestOptions {
  method?: 'GET' | 'POST';
  token?: string;
  key?: string;
  body?: unknown;
  rawBody?: string;
}

function failureCode(result: HttpResult): string {
  const error = result.body.error as { code?: string } | undefined;
  return error?.code ?? '';
}
function textField(result: HttpResult, name: string): string {
  const value = result.body[name];
  assert.equal(typeof value, 'string');
  return value as string;
}

test('authenticated HTTP and evidence workflows use isolated restricted database identities', async (context) => {
  const database = process.env.TEST_DATABASE_NAME ?? '';
  assert.match(database, /^scholarproof_test_[a-f0-9]{32}$/);
  assert.equal(process.env.POSTGRES_DB, database);
  assert.equal(process.env.TEST_MONGO_DATABASE, database);
  assert.equal(process.env.API_MONGO_DB, database);
  const config = readDataConfig();
  assert.ok(config);
  const admin = await connectTestClient();
  let runtime: Awaited<ReturnType<typeof openDataRuntime>> | undefined = undefined;
  const servers: Server[] = [];
  const mongoClients: MongoClient[] = [];
  context.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await runtime?.close();
    await Promise.all(mongoClients.map((client) => client.close()));
    await admin.end();
  });

  const f = await fixture(admin);
  const foreign = await fixture(admin);
  await f.append(0, 6);
  await f.append(1, 8);
  const clocks = await admin.query<{ version_no: number; known_at: string }>(
    `SELECT version_no,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS known_at
     FROM academic.grade_version WHERE record_id=$1 ORDER BY version_no`,
    [f.id('record')],
  );
  const before = clocks.rows[0]!.known_at;
  const after = clocks.rows[1]!.known_at;
  const subject = (role: string) => `test:${role}:${randomUUID()}`;
  const registrarSubject = subject('registrar');
  await admin.query('UPDATE academic.app_user SET auth_subject=$1 WHERE user_id=$2', [
    registrarSubject,
    f.id('author'),
  ]);

  async function actor(role: string, institutionId = f.id('institution')) {
    const userId = randomUUID();
    const login = subject(role);
    await admin.query('INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$2)', [
      userId,
      login,
    ]);
    await admin.query(
      'INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,$3)',
      [institutionId, userId, role],
    );
    return { userId, subject: login };
  }
  async function credential(userId: string) {
    const material = await hashPassword(password);
    await admin.query(
      'INSERT INTO access_control.password_credential(user_id,profile,salt_hex,derived_key_hex) VALUES($1,$2,$3,$4)',
      [userId, material.profile, material.salt_hex, material.derived_key_hex],
    );
  }
  async function session(userId: string, expired = false) {
    const token = newToken();
    await admin.query(
      expired
        ? "INSERT INTO access_control.api_session(token_digest,user_id,created_at,expires_at) VALUES($1,$2,statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour')"
        : 'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
      [digestToken(token), userId],
    );
    return token;
  }
  const student = await actor('student');
  const peer = await actor('student');
  const auditor = await actor('auditor');
  const examiner = await actor('examiner');
  const disabled = await actor('student');
  const foreignRegistrar = await actor('registrar', foreign.id('institution'));
  await admin.query('UPDATE academic.student SET user_id=$1 WHERE student_id=$2', [
    student.userId,
    f.id('student'),
  ]);
  const peerStudentId = randomUUID();
  const peerEnrolmentId = randomUUID();
  const peerRecordId = randomUUID();
  await admin.query(
    "INSERT INTO academic.student(student_id,institution_id,programme_id,user_id,student_code,admission_year) VALUES($1,$2,$3,$4,'PEER_STUDENT',2026)",
    [peerStudentId, f.id('institution'), f.id('programme'), peer.userId],
  );
  await admin.query(
    'INSERT INTO academic.enrolment(enrolment_id,institution_id,student_id,offering_id) VALUES($1,$2,$3,$4)',
    [peerEnrolmentId, f.id('institution'), peerStudentId, f.id('offering')],
  );
  await admin.query(
    'INSERT INTO academic.grade_record(record_id,institution_id,enrolment_id) VALUES($1,$2,$3)',
    [peerRecordId, f.id('institution'), peerEnrolmentId],
  );
  for (const id of [student.userId, f.id('author'), disabled.userId]) await credential(id);
  await admin.query("UPDATE academic.app_user SET account_state='disabled' WHERE user_id=$1", [
    disabled.userId,
  ]);

  const adminMongo = new MongoClient(`mongodb://127.0.0.1:${config.mongoPort}`, {
    authSource: 'admin',
    auth: { username: process.env.MONGO_ROOT_USER!, password: process.env.MONGO_ROOT_PASSWORD! },
    serverSelectionTimeoutMS: 3000,
    socketTimeoutMS: 5000,
  });
  mongoClients.push(adminMongo);
  await adminMongo.connect();
  const mongoDb: Db = adminMongo.db(database);
  const documents = mongoDb.collection<EvidenceDocument>(EVIDENCE_COLLECTION);
  const restrictedMongo = new MongoClient(`mongodb://127.0.0.1:${config.mongoPort}`, {
    authSource: database,
    auth: { username: config.mongoUser, password: config.mongoPassword },
    serverSelectionTimeoutMS: 3000,
    socketTimeoutMS: 5000,
  });
  mongoClients.push(restrictedMongo);
  await restrictedMongo.connect();
  const runtimeDocuments = restrictedMongo
    .db(database)
    .collection<EvidenceDocument>(EVIDENCE_COLLECTION);
  runtime = await openDataRuntime(config);
  const platform = runtime.platform;
  async function start(appPlatform: Platform) {
    const server = createApp(appPlatform).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return async (path: string, options: RequestOptions = {}): Promise<HttpResult> => {
      const headers = new Headers();
      if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
      if (options.key) headers.set('Idempotency-Key', options.key);
      let body: string | undefined;
      if (options.method === 'POST') {
        headers.set('Content-Type', 'application/json');
        body = options.rawBody ?? JSON.stringify(options.body ?? {});
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const raw = await response.text();
      return {
        status: response.status,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        headers: response.headers,
      };
    };
  }
  const request = await start(platform);
  const studentLogin = await platform.login(student.subject, password);
  const studentToken = studentLogin.token;
  const registrarToken = (await platform.login(registrarSubject, password)).token;
  const peerToken = await session(peer.userId);
  const auditorToken = await session(auditor.userId);
  const examinerToken = await session(examiner.userId);
  const foreignToken = await session(foreignRegistrar.userId);
  const transcript = (id: string, known = after) =>
    `/students/${id}/transcript?knownAt=${encodeURIComponent(known)}&effectiveAt=2026-05-01T00%3A00%3A00Z`;
  const uploadPath = `/records/${f.id('record')}/evidence`;
  const reference = async (key: string) => {
    const result = await admin.query<{ evidence_id: string; state: string }>(
      'SELECT evidence_id,state FROM evidence.reference WHERE submitted_by=$1 AND request_key=$2',
      [student.userId, key],
    );
    return result.rows[0];
  };
  let evidenceId = '';

  await context.test(
    'real password login returns an opaque token and generic failures',
    async () => {
      const valid = await request('/auth/login', {
        method: 'POST',
        body: { subject: student.subject, password },
      });
      assert.equal(valid.status, 200);
      assert.match(textField(valid, 'token'), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(valid.body.tokenType, 'Bearer');
      assert.equal(valid.headers.get('cache-control'), 'no-store');
      const wrong = await request('/auth/login', {
        method: 'POST',
        body: { subject: student.subject, password: 'Wrong synthetic password' },
      });
      const missing = await request('/auth/login', {
        method: 'POST',
        body: { subject: subject('missing'), password },
      });
      const inactive = await request('/auth/login', {
        method: 'POST',
        body: { subject: disabled.subject, password },
      });
      for (const response of [wrong, missing, inactive]) assert.equal(response.status, 401);
      assert.deepEqual(wrong.body, missing.body);
      assert.deepEqual(wrong.body, inactive.body);
      const saved = await admin.query<{ token_digest: string }>(
        'SELECT token_digest FROM access_control.api_session WHERE token_digest=$1',
        [digestToken(studentToken)],
      );
      assert.equal(saved.rowCount, 1);
      assert.match(saved.rows[0]!.token_digest, /^[a-f0-9]{64}$/);
      assert.equal(saved.rows[0]!.token_digest === studentToken, false);
    },
  );

  await context.test(
    'missing, malformed, expired, logged-out and disabled sessions fail',
    async () => {
      assert.equal((await request('/auth/me')).status, 401);
      assert.equal((await request('/auth/me', { token: 'malformed' })).status, 401);
      assert.equal(
        (await request('/auth/me', { token: await session(student.userId, true) })).status,
        401,
      );
      const logoutToken = await session(student.userId);
      assert.equal(
        (await request('/auth/logout', { method: 'POST', token: logoutToken })).status,
        204,
      );
      assert.equal((await request('/auth/me', { token: logoutToken })).status, 401);
      await admin.query("UPDATE academic.app_user SET account_state='disabled' WHERE user_id=$1", [
        student.userId,
      ]);
      try {
        assert.equal((await request('/auth/me', { token: studentToken })).status, 401);
      } finally {
        await admin.query("UPDATE academic.app_user SET account_state='active' WHERE user_id=$1", [
          student.userId,
        ]);
      }
      const me = await request('/auth/me', { token: studentToken });
      assert.equal(me.status, 200);
      assert.equal(me.body.userId, student.userId);
    },
  );

  await context.test(
    'student subject and staff institution scope protect temporal transcripts',
    async () => {
      const old = await request(transcript(f.id('student'), before), { token: studentToken });
      const current = await request(transcript(f.id('student')), { token: studentToken });
      assert.equal(old.status, 200);
      assert.equal(current.status, 200);
      const oldRecords = old.body.records as { grade_points: string; recorded_at: string }[];
      const records = current.body.records as { grade_points: string; recorded_at: string }[];
      assert.equal(oldRecords[0]?.grade_points, '6.00');
      assert.equal(records[0]?.grade_points, '8.00');
      assert.equal(records[0]?.recorded_at, after);
      assert.equal((await request(transcript(peerStudentId), { token: studentToken })).status, 404);
      assert.equal(
        (await request(transcript(foreign.id('student')), { token: studentToken })).status,
        404,
      );
      for (const token of [registrarToken, auditorToken])
        assert.equal((await request(transcript(f.id('student')), { token })).status, 200);
      assert.equal(
        (await request(transcript(foreign.id('student')), { token: registrarToken })).status,
        404,
      );
      assert.equal(
        (await request(transcript(f.id('student')), { token: foreignToken })).status,
        404,
      );
      assert.equal(
        (await request(transcript(f.id('student')), { token: examinerToken })).status,
        403,
      );
      const empty = await request(transcript(peerStudentId), { token: peerToken });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.records, []);
    },
  );

  await context.test(
    'a removed institutional role affects the next authenticated request',
    async () => {
      await admin.query('DELETE FROM academic.role_assignment WHERE user_id=$1', [auditor.userId]);
      try {
        assert.equal(
          (await request(transcript(f.id('student')), { token: auditorToken })).status,
          403,
        );
      } finally {
        await admin.query(
          "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'auditor')",
          [f.id('institution'), auditor.userId],
        );
      }
    },
  );

  await context.test(
    'strict contracts reject spoofed identity, malformed identifiers and oversized JSON',
    async () => {
      assert.equal(
        (await request('/students/not-a-uuid/transcript', { token: studentToken })).status,
        400,
      );
      assert.equal(
        (
          await request(
            `${transcript(f.id('student'))}&institutionId=${foreign.id('institution')}`,
            { token: studentToken },
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(uploadPath, {
            method: 'POST',
            token: studentToken,
            key: randomUUID(),
            body: { ...payload, submittedBy: f.id('author') },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(uploadPath, {
            method: 'POST',
            token: studentToken,
            key: randomUUID(),
            rawBody: '{"broken"',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(uploadPath, {
            method: 'POST',
            token: studentToken,
            key: randomUUID(),
            rawBody: JSON.stringify({ note: 'x'.repeat(80_000) }),
          })
        ).status,
        413,
      );
      const unicode = {
        ...payload,
        data: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [`field${index}`, '界'.repeat(4000)]),
        ),
      };
      assert.equal(
        (
          await request(uploadPath, {
            method: 'POST',
            token: studentToken,
            key: randomUUID(),
            body: unicode,
          })
        ).status,
        413,
      );
    },
  );

  await context.test(
    'evidence upload and exact idempotent retry preserve one scoped immutable reference',
    async () => {
      const key = randomUUID();
      const first = await request(uploadPath, {
        method: 'POST',
        token: studentToken,
        key,
        body: payload,
      });
      assert.equal(first.status, 201);
      evidenceId = textField(first, 'evidenceId');
      const repeated = await request(uploadPath, {
        method: 'POST',
        token: studentToken,
        key,
        body: payload,
      });
      assert.equal(repeated.status, 201);
      assert.equal(repeated.body.evidenceId, evidenceId);
      assert.equal((await reference(key))?.state, 'available');
      assert.equal(await documents.countDocuments({ _id: evidenceId }), 1);
      assert.equal(
        (
          await request(uploadPath, {
            method: 'POST',
            token: studentToken,
            key,
            body: { ...payload, data: { note: 'Changed content' } },
          })
        ).status,
        409,
      );
      const read = await request(`/evidence/${evidenceId}`, { token: studentToken });
      assert.equal(read.status, 200);
      assert.deepEqual(read.body.content, payload);
      assert.equal(
        (await request(`/evidence/${evidenceId}`, { token: registrarToken })).status,
        200,
      );
    },
  );

  await context.test(
    'wrong subject and role requests are denied before touching the document store',
    async () => {
      let calls = 0;
      const deniedStore: EvidenceStore = {
        put: async () => {
          calls++;
          throw new Error('Unexpected document access');
        },
        get: async () => {
          calls++;
          throw new Error('Unexpected document access');
        },
      };
      const denied = await start(new Platform(platform.repository, deniedStore));
      assert.equal(
        (
          await denied(`/records/${peerRecordId}/evidence`, {
            method: 'POST',
            token: studentToken,
            key: randomUUID(),
            body: payload,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await denied(`/records/${foreign.id('record')}/evidence`, {
            method: 'POST',
            token: registrarToken,
            key: randomUUID(),
            body: payload,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await denied(uploadPath, {
            method: 'POST',
            token: auditorToken,
            key: randomUUID(),
            body: payload,
          })
        ).status,
        403,
      );
      assert.equal((await denied(`/evidence/${evidenceId}`, { token: peerToken })).status, 404);
      assert.equal((await denied(`/evidence/${evidenceId}`, { token: auditorToken })).status, 403);
      assert.equal(calls, 0);
    },
  );

  await context.test(
    'Mongo validation and runtime privileges reject invalid or mutable data',
    async () => {
      const existing = await documents.findOne({ _id: evidenceId });
      assert.ok(existing);
      await assert.rejects(
        runtimeDocuments.insertOne({
          ...existing,
          _id: randomUUID(),
          schemaVersion: 2,
        } as unknown as EvidenceDocument),
        errorCode(121),
      );
      await assert.rejects(
        runtimeDocuments.updateOne({ _id: evidenceId }, { $set: { bodyUtf8: 'changed' } }),
        errorCode(13),
      );
      await assert.rejects(runtimeDocuments.deleteOne({ _id: evidenceId }), errorCode(13));
      await assert.rejects(
        restrictedMongo
          .db(database)
          .command({ collMod: EVIDENCE_COLLECTION, validationLevel: 'off' }),
        errorCode(13),
      );
      await assert.rejects(
        platform.repository.sql.query(
          'UPDATE academic.grade_version SET grade_points=9 WHERE record_id=$1',
          [f.id('record')],
        ),
        errorCode('42501'),
      );
      await assert.rejects(
        platform.repository.sql.query('CREATE TABLE academic.forbidden_http_test(id integer)'),
        errorCode('42501'),
      );
      const who = await platform.repository.sql.query<{ name: string }>(
        'SELECT current_user AS name',
      );
      assert.equal(who.rows[0]?.name, config.user);
      assert.equal(who.rows[0]?.name === process.env.POSTGRES_USER, false);
    },
  );

  await context.test(
    'digest tampering and missing Mongo content cannot return unverified evidence',
    async () => {
      const stored = await documents.findOne({ _id: evidenceId });
      assert.ok(stored);
      const tampered = stored.bodyUtf8.replace('Original', 'Tampered');
      assert.equal(Buffer.byteLength(tampered), stored.sizeBytes);
      await documents.updateOne({ _id: evidenceId }, { $set: { bodyUtf8: tampered } });
      const damaged = await request(`/evidence/${evidenceId}`, { token: studentToken });
      assert.equal(damaged.status, 503);
      assert.equal(failureCode(damaged), 'EVIDENCE_INTEGRITY_FAILURE');
      assert.equal(Object.hasOwn(damaged.body, 'content'), false);
      assert.equal(JSON.stringify(damaged.body).includes('Tampered'), false);
      await documents.deleteOne({ _id: evidenceId });
      const missing = await request(`/evidence/${evidenceId}`, { token: studentToken });
      assert.equal(missing.status, 503);
      assert.equal(failureCode(missing), 'EVIDENCE_UNAVAILABLE');
    },
  );

  await context.test(
    'document-store failure leaves pending SQL evidence and retries the same identity',
    async () => {
      const failedStore: EvidenceStore = {
        put: async () => {
          throw new Error('Synthetic document outage');
        },
        get: async () => null,
      };
      const failedRequest = await start(new Platform(platform.repository, failedStore));
      const key = randomUUID();
      const failed = await failedRequest(uploadPath, {
        method: 'POST',
        token: studentToken,
        key,
        body: payload,
      });
      assert.equal(failed.status, 503);
      const pending = await reference(key);
      assert.equal(pending?.state, 'pending');
      assert.equal(await documents.countDocuments({ _id: pending!.evidence_id }), 0);
      assert.equal(
        failureCode(await request(`/evidence/${pending!.evidence_id}`, { token: studentToken })),
        'EVIDENCE_PENDING',
      );
      const retried = await request(uploadPath, {
        method: 'POST',
        token: studentToken,
        key,
        body: payload,
      });
      assert.equal(retried.status, 201);
      assert.equal(retried.body.evidenceId, pending!.evidence_id);
      assert.equal((await reference(key))?.state, 'available');
    },
  );

  await context.test(
    'SQL confirmation failure after Mongo insertion is recoverable without a false success',
    async () => {
      const key = randomUUID();
      const original = platform.repository.available.bind(platform.repository);
      platform.repository.available = async () => {
        throw new Error('Synthetic SQL confirmation outage');
      };
      try {
        const failed = await request(uploadPath, {
          method: 'POST',
          token: studentToken,
          key,
          body: payload,
        });
        assert.equal(failed.status, 503);
        const pending = await reference(key);
        assert.equal(pending?.state, 'pending');
        assert.equal(await documents.countDocuments({ _id: pending!.evidence_id }), 1);
      } finally {
        platform.repository.available = original;
      }
      const retried = await request(uploadPath, {
        method: 'POST',
        token: studentToken,
        key,
        body: payload,
      });
      assert.equal(retried.status, 201);
      assert.equal((await reference(key))?.evidence_id, retried.body.evidenceId);
      assert.equal((await reference(key))?.state, 'available');
      const grades = await admin.query<{ versions: string; latest: number }>(
        'SELECT count(*)::text AS versions,max(version_no) AS latest FROM academic.grade_version WHERE record_id=$1',
        [f.id('record')],
      );
      assert.deepEqual(grades.rows[0], { versions: '2', latest: 2 });
    },
  );

  await context.test(
    'Mongo idempotent insertion rejects an existing different immutable document',
    async () => {
      const id = randomUUID();
      const encoded = JSON.stringify(payload);
      const doc: EvidenceDocument = {
        _id: id,
        schemaVersion: 1,
        institutionId: f.id('institution'),
        recordId: f.id('record'),
        submittedBy: student.userId,
        digestSha256: 'a'.repeat(64),
        sizeBytes: Buffer.byteLength(encoded),
        bodyUtf8: encoded,
      };
      const store = new MongoEvidenceStore(restrictedMongo.db(database));
      await store.put(doc);
      await store.put({ ...doc });
      await assert.rejects(store.put({ ...doc, bodyUtf8: 'Changed' }), {
        name: 'EvidenceConflictError',
      });
    },
  );

  await context.test(
    'startup rejects newly granted PostgreSQL credential-write privileges',
    async () => {
      assert.match(config.user, /^scholarproof_http_[a-f0-9]{32}$/);
      await admin.query(
        `GRANT UPDATE(derived_key_hex) ON access_control.password_credential TO "${config.user}"`,
      );
      try {
        await assert.rejects(async () => {
          const unsafe = await openDataRuntime(config);
          await unsafe.close();
        }, /PostgreSQL permissions/);
      } finally {
        await admin.query(
          `REVOKE UPDATE(derived_key_hex) ON access_control.password_credential FROM "${config.user}"`,
        );
      }
      const restored = await openDataRuntime(config);
      await restored.close();
    },
  );

  await context.test(
    'startup rejects an extra MongoDB readWrite role and accepts restored privileges',
    async () => {
      const role = { role: 'readWrite', db: database };
      await mongoDb.command({ grantRolesToUser: config.mongoUser, roles: [role] });
      try {
        await assert.rejects(async () => {
          const unsafe = await openDataRuntime(config);
          await unsafe.close();
        }, /MongoDB permissions/);
      } finally {
        await mongoDb.command({ revokeRolesFromUser: config.mongoUser, roles: [role] });
      }
      const restored = await openDataRuntime(config);
      await restored.close();
    },
  );
});
