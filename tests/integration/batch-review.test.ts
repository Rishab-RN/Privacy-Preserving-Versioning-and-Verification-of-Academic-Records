import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  PilotBatch,
  PilotBatchCreated,
  PilotBatchSubmission,
  PilotBatchSummary,
  PilotQueueEntry,
  PilotReviewResult,
  PilotValidationResult,
} from '@scholarproof/contracts';
import { PILOT_WORLD, decide } from '../../packages/access-matrix/src/index.js';
import type { Batch, Delegation, World } from '../../packages/access-matrix/src/index.js';
import { TERM, generatePilotData } from '../../packages/pilot-data/src/index.js';
import { pilotId } from '../../apps/api/scripts/pilot/provision.js';
import { connectTestClient } from '../database/helpers.js';
import {
  personaSubjects,
  provisionTestPilot,
  sessionFor,
  stageBody,
  startPilotApi,
} from './pilot-fixture.js';
import type { Stage } from './pilot-fixture.js';

const data = generatePilotData();
const isDelegation: Delegation = {
  grantor: 'P1',
  tasks: ['validate_import'],
  departments: ['IS'],
  term: TERM.code,
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: '2028-01-01T00:00:00Z',
};

test('T4 review and validation are scoped, separated and agree with the access matrix', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const fixture = await provisionTestPilot(admin, data);
  const offering = (key: string) => fixture.offerings[key as keyof typeof fixture.offerings];
  const subjects = personaSubjects(data);
  const tokens = new Map<string, string>();
  for (const [key, subject] of subjects) tokens.set(key, await sessionFor(admin, subject));

  // Test-only facts: F3 and P2 receive IS validation delegations from P1 to exercise the
  // author/validator and validator/reviewer conflicts; a separate staff account holds only an
  // expired delegation.
  const grant = (grantee: string, department: string, from: string, until: string) =>
    admin.query(
      `INSERT INTO assessment.validation_delegation(department_id,term_id,grantor_id,grantee_id,valid_during)
       SELECT $1,$2,g.user_id,e.user_id,tstzrange($5,$6,'[)') FROM academic.app_user g, academic.app_user e
       WHERE g.auth_subject=$3 AND e.auth_subject=$4`,
      [pilotId(`department:${department}`), fixture.termId, 'pilot:p1', grantee, from, until],
    );
  await grant('pilot:f3', 'IS', isDelegation.validFrom, isDelegation.validUntil);
  await grant('pilot:p2', 'IS', isDelegation.validFrom, isDelegation.validUntil);
  const expiredSubject = `pilot-test:expired-${randomUUID()}`;
  await admin.query('INSERT INTO academic.app_user(auth_subject) VALUES($1)', [expiredSubject]);
  await admin.query(
    `INSERT INTO academic.role_assignment(institution_id,user_id,role_code)
     SELECT $1,user_id,'exam_staff' FROM academic.app_user WHERE auth_subject=$2`,
    [fixture.institutionId, expiredSubject],
  );
  await grant(expiredSubject, 'AI', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
  tokens.set('EXPIRED', await sessionFor(admin, expiredSubject));

  const { runtime, call } = await startPilotApi(t, tokens);
  const list = (as: string, key: string) =>
    call<{ batches: PilotBatchSummary[] }>('GET', `/pilot/offerings/${offering(key)}/batches`, as);
  const validate = (as: string | null, batchId: string, note?: string) =>
    call<PilotValidationResult>(
      'POST',
      `/pilot/batches/${batchId}/validate`,
      as,
      note ? { note } : {},
    );
  const review = (as: string | null, batchId: string, verdict: string, reason?: string) =>
    call<PilotReviewResult>('POST', `/pilot/batches/${batchId}/review`, as, {
      verdict,
      ...(reason ? { reason } : {}),
    });

  /** The submitted head revision for an author, creating or submitting it when needed. */
  async function submittedHead(author: string, key: string, stage: Stage): Promise<string> {
    const heads = (await list(author, key)).json.batches.filter((b) => b.stage === stage);
    let head = heads.at(-1);
    if (!head || head.review?.verdict === 'returned') {
      const created = await call<PilotBatchCreated>(
        'POST',
        `/pilot/offerings/${offering(key)}/batches`,
        author,
        stageBody(data, key, stage, head?.revisionNo ?? 0),
      );
      assert.equal(created.status, 201, JSON.stringify(created.json));
      head = { batchId: created.json.batchId, submittedAt: null } as PilotBatchSummary;
    }
    if (!head.submittedAt) {
      const submitted = await call<PilotBatchSubmission>(
        'POST',
        `/pilot/batches/${head.batchId}/submit`,
        author,
      );
      assert.equal(submitted.status, 200);
    }
    return head.batchId;
  }

  const ids = {
    'ai-a/cie': await submittedHead('F1', 'ai-a', 'cie'),
    'ai-a/see': await submittedHead('E1', 'ai-a', 'see'),
    'ai-b/cie': await submittedHead('H1', 'ai-b', 'cie'),
    'is-a/cie': await submittedHead('F3', 'is-a', 'cie'),
  };

  await t.test(
    'exam-section staff validate submitted batches inside an active delegation',
    async () => {
      const queue = await call<{ batches: PilotQueueEntry[] }>(
        'GET',
        '/pilot/validation-queue',
        'S1',
      );
      assert.equal(queue.status, 200);
      const queued = new Set(queue.json.batches.map((b) => b.batchId));
      for (const key of ['ai-a/cie', 'ai-a/see', 'ai-b/cie'] as const)
        assert.ok(queued.has(ids[key]), key);
      assert.ok(!queued.has(ids['is-a/cie']), 'IS is outside S1 delegation');

      const first = await validate('S1', ids['ai-a/cie'], 'Roster reconciled against SLcM export');
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.deepEqual([first.json.missingRows, first.json.alreadyValidated], [0, false]);
      assert.equal((await validate('S1', ids['ai-a/cie'])).json.alreadyValidated, true);
      const see = await validate('S1', ids['ai-a/see']);
      assert.equal(see.json.missingRows, 2, 'the two NE students have no SEE row');
      assert.equal((await validate('S1', ids['ai-b/cie'])).status, 200);
      assert.equal((await validate('S1', ids['is-a/cie'])).status, 404);
      assert.equal((await validate('F3', ids['is-a/cie'])).code, 'SOD_CONFLICT');
      assert.equal((await validate('P2', ids['is-a/cie'])).status, 200);
      assert.equal((await validate('F1', ids['ai-a/cie'])).status, 403);
      assert.equal((await validate('EXPIRED', ids['ai-a/cie'])).status, 403);
      assert.equal((await call('GET', '/pilot/validation-queue', 'EXPIRED')).status, 403);
    },
  );

  await t.test(
    'department review approves, returns and enforces separation of duties',
    async () => {
      const h1Queue = await call<{ batches: PilotQueueEntry[] }>(
        'GET',
        '/pilot/review-queue',
        'H1',
      );
      const h1Ids = h1Queue.json.batches.map((b) => b.batchId);
      assert.ok(h1Ids.includes(ids['ai-a/cie']));
      assert.ok(!h1Ids.includes(ids['ai-b/cie']), 'own batches never appear in a reviewer queue');
      const h2Queue = await call<{ batches: PilotQueueEntry[] }>(
        'GET',
        '/pilot/review-queue',
        'H2',
      );
      assert.ok(h2Queue.json.batches.some((b) => b.batchId === ids['ai-b/cie']));

      assert.equal((await review('H1', ids['ai-b/cie'], 'approved')).code, 'SELF_REVIEW');
      assert.equal((await review('H1', ids['ai-a/see'], 'approved')).status, 404);
      assert.equal((await review('H1', ids['is-a/cie'], 'approved')).status, 404);
      assert.equal((await review('H2', ids['ai-b/cie'], 'returned')).status, 400);

      const returned = await review(
        'H2',
        ids['ai-b/cie'],
        'returned',
        'Lab test missing for two rows',
      );
      assert.deepEqual([returned.status, returned.json.verdict], [200, 'returned']);
      const heads = (await list('H1', 'ai-b')).json.batches.filter((b) => b.stage === 'cie');
      const reopened = await call<PilotBatchCreated>(
        'POST',
        `/pilot/offerings/${offering('ai-b')}/batches`,
        'H1',
        stageBody(data, 'ai-b', 'cie', heads.at(-1)!.revisionNo),
      );
      assert.equal(reopened.status, 201, 'a return reopens marks entry');
      assert.equal(
        (await review('H2', reopened.json.batchId, 'approved')).code,
        'BATCH_NOT_SUBMITTED',
      );
      assert.equal((await validate('S1', reopened.json.batchId)).code, 'BATCH_NOT_SUBMITTED');
      ids['ai-b/cie'] = await submittedHead('H1', 'ai-b', 'cie');

      const approved = await review('H1', ids['ai-a/cie'], 'approved');
      assert.deepEqual([approved.status, approved.json.alreadyReviewed], [200, false]);
      assert.equal((await review('H1', ids['ai-a/cie'], 'approved')).json.alreadyReviewed, true);
      assert.equal((await review('H2', ids['ai-a/cie'], 'approved')).code, 'ALREADY_REVIEWED');
      const locked = await call<PilotBatchCreated>(
        'POST',
        `/pilot/offerings/${offering('ai-a')}/batches`,
        'F1',
        stageBody(
          data,
          'ai-a',
          'cie',
          (await list('F1', 'ai-a')).json.batches.filter((b) => b.stage === 'cie').at(-1)!
            .revisionNo,
        ),
      );
      assert.equal(locked.code, 'BATCH_APPROVED');

      const read = await call<PilotBatch>('GET', `/pilot/batches/${ids['ai-a/cie']}`, 'F1');
      assert.equal(read.json.review?.verdict, 'approved');
      assert.equal(read.json.review?.reviewerSubject, 'pilot:h1');
      assert.equal(read.json.validation?.validatorSubject, 'pilot:s1');
      assert.equal(read.json.validation?.note, 'Roster reconciled against SLcM export');

      assert.equal((await review('P2', ids['is-a/cie'], 'approved')).code, 'SOD_CONFLICT');
      assert.equal((await review('H3', ids['is-a/cie'], 'approved')).status, 200);
    },
  );

  await t.test('validation and review match the access matrix at the current time', async () => {
    const batch = (
      offeringKey: string,
      stage: Stage,
      author: string,
      validators: string[],
      reviewer: string | null,
    ): Batch => ({
      offering: offeringKey,
      stage,
      author,
      validators,
      reviewer,
    });
    const live: World = {
      ...PILOT_WORLD,
      now: new Date().toISOString(),
      principals: {
        ...PILOT_WORLD.principals,
        F3: { ...PILOT_WORLD.principals.F3!, delegations: [isDelegation] },
        P2: { ...PILOT_WORLD.principals.P2!, delegations: [isDelegation] },
      },
      batches: {
        'ai-a/cie': batch('ai-a', 'cie', 'F1', ['S1'], 'H1'),
        'ai-a/see': batch('ai-a', 'see', 'E1', ['S1'], null),
        'ai-b/cie': batch('ai-b', 'cie', 'H1', [], null),
        'is-a/cie': batch('is-a', 'cie', 'F3', ['P2'], 'H3'),
      },
    };
    // Allowed calls may still meet a state conflict once another participant has acted.
    const stateConflicts = new Set(['ALREADY_VALIDATED', 'ALREADY_REVIEWED']);
    for (const action of ['batch.validate', 'batch.review'] as const) {
      for (const [key, batchId] of Object.entries(ids)) {
        for (const persona of [...subjects.keys(), null]) {
          const expected = persona
            ? decide(live, persona, action, key).outcome
            : { status: 401, code: 'UNAUTHENTICATED' };
          const response =
            action === 'batch.validate'
              ? await validate(persona, batchId)
              : await review(persona, batchId, 'approved');
          const label = `${persona} ${action} ${key}`;
          if (expected.status === 200) {
            assert.ok(
              response.status === 200 ||
                (response.status === 409 && stateConflicts.has(response.code ?? '')),
              `${label}: ${response.status} ${response.code}`,
            );
          } else {
            assert.equal(response.status, expected.status, label);
            if (expected.code === 'SELF_REVIEW' || expected.code === 'SOD_CONFLICT') {
              assert.equal(response.code, expected.code, label);
            }
          }
        }
      }
    }
  });

  await t.test('review and validation history is immutable and private', async () => {
    await assert.rejects(admin.query("UPDATE assessment.batch_review SET reason='changed'"), {
      code: '55000',
    });
    await assert.rejects(admin.query('DELETE FROM assessment.validation_report'), {
      code: '55000',
    });
    await assert.rejects(
      runtime.platform.repository.sql.query('SELECT * FROM assessment.batch_review'),
      { code: '42501' },
    );
  });
});
