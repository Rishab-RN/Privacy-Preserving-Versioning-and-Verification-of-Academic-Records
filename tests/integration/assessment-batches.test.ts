import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  PilotBatch,
  PilotBatchCreated,
  PilotBatchInput,
  PilotBatchSubmission,
  PilotBatchSummary,
} from '@scholarproof/contracts';
import { PILOT_WORLD, decide } from '../../packages/access-matrix/src/index.js';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import { pilotId } from '../../apps/api/scripts/pilot/provision.js';
import { connectTestClient } from '../database/helpers.js';
import {
  personaSubjects,
  provisionTestPilot,
  sessionFor,
  stageBody,
  stageComponents as components,
  startPilotApi,
} from './pilot-fixture.js';
import type { Stage } from './pilot-fixture.js';

const data = generatePilotData();
const body = (offering: string, stage: Stage, expectedRevision: number): PilotBatchInput =>
  stageBody(data, offering, stage, expectedRevision);

test('T3 marks batches are scoped, immutable and agree with the access matrix', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const fixture = await provisionTestPilot(admin, data);
  const offering = (key: string) => fixture.offerings[key as keyof typeof fixture.offerings];

  const subjects = personaSubjects(data);
  const tokens = new Map<string, string>();
  for (const [key, subject] of subjects) tokens.set(key, await sessionFor(admin, subject));
  const { runtime, call } = await startPilotApi(t, tokens);

  const create = (as: string, key: string, input: PilotBatchInput, idempotency?: string) =>
    call<PilotBatchCreated>(
      'POST',
      `/pilot/offerings/${offering(key)}/batches`,
      as,
      input,
      idempotency,
    );
  const submit = (as: string | null, batchId: string) =>
    call<PilotBatchSubmission>('POST', `/pilot/batches/${batchId}/submit`, as);

  const batches = new Map<string, string>();

  await t.test('authors create, retry, revise and submit CIE revisions', async () => {
    const key = randomUUID();
    const first = await create('F1', 'ai-a', body('ai-a', 'cie', 0), key);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.revisionNo, 1);
    assert.equal(first.json.created, true);
    assert.match(first.json.contentDigest, /^[a-f0-9]{64}$/);

    const retry = await create('F1', 'ai-a', body('ai-a', 'cie', 0), key);
    assert.equal(retry.status, 200);
    assert.deepEqual({ ...retry.json, created: true }, first.json);

    const changed = body('ai-a', 'cie', 0);
    changed.rows[0]!.values[0] = '1';
    assert.equal((await create('F1', 'ai-a', changed, key)).code, 'IDEMPOTENCY_CONFLICT');

    const revised = body('ai-a', 'cie', 1);
    revised.rows[0]!.values[0] = '10';
    const second = await create('F1', 'ai-a', revised);
    assert.equal(second.status, 201);
    assert.equal(second.json.revisionNo, 2);
    assert.notEqual(second.json.contentDigest, first.json.contentDigest);

    assert.equal((await create('F1', 'ai-a', body('ai-a', 'cie', 1))).code, 'STALE_REVISION');
    assert.equal((await submit('F1', first.json.batchId)).code, 'STALE_REVISION');

    const submitted = await submit('F1', second.json.batchId);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.alreadySubmitted, false);
    const again = await submit('F1', second.json.batchId);
    assert.equal(again.json.alreadySubmitted, true);
    assert.equal(again.json.submittedAt, submitted.json.submittedAt);
    assert.equal((await create('F1', 'ai-a', body('ai-a', 'cie', 2))).code, 'BATCH_UNDER_REVIEW');

    const list = await call<{ batches: PilotBatchSummary[] }>(
      'GET',
      `/pilot/offerings/${offering('ai-a')}/batches`,
      'F1',
    );
    assert.deepEqual(
      list.json.batches.map((b) => [
        b.stage,
        b.revisionNo,
        b.authorSubject,
        b.submittedAt !== null,
      ]),
      [
        ['cie', 1, 'pilot:f1', false],
        ['cie', 2, 'pilot:f1', true],
      ],
    );
    const read = await call<PilotBatch>('GET', `/pilot/batches/${second.json.batchId}`, 'F1');
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.components, components('cie'));
    assert.equal(read.json.rows.length, 12);
    assert.equal(read.json.policy.id, 'rvce-2022-itl-s1');
    const demo = read.json.rows.find((row) => row.studentCode === 'SYN24AI001');
    assert.equal(demo?.values[0], '10.00');
    batches.set('ai-a/cie', second.json.batchId);
  });

  await t.test('revisions are validated against the policy and roster', async () => {
    const valid = () => body('ai-a', 'cie', 2);
    const expectCode = async (input: PilotBatchInput, code: string) => {
      const response = await create('F1', 'ai-a', input);
      assert.equal(response.status, 422, code);
      assert.equal(response.code, code);
    };
    const withoutQuiz2 = valid();
    withoutQuiz2.components.splice(1, 1);
    for (const row of withoutQuiz2.rows) row.values.splice(1, 1);
    await expectCode(withoutQuiz2, 'MISSING_COMPONENT');
    const tooHigh = valid();
    tooHigh.rows[0]!.values[0] = '10.5';
    await expectCode(tooHigh, 'MARKS_ABOVE_MAXIMUM');
    const absent = valid();
    absent.rows[0]!.values[2] = 'AB';
    await expectCode(absent, 'ABSENCE_NOT_ALLOWED');
    const seeColumn = valid();
    seeColumn.components.push('see_part_a');
    for (const row of seeColumn.rows) row.values.push('10');
    await expectCode(seeColumn, 'UNKNOWN_COMPONENT');
    const foreign = valid();
    foreign.rows[0]!.enrolmentId = pilotId('enrolment:SYN24IS001');
    await expectCode(foreign, 'UNKNOWN_ENROLMENT');
    const partial = valid();
    partial.rows.pop();
    await expectCode(partial, 'INCOMPLETE_ROSTER');
    const duplicate = valid();
    duplicate.rows[1] = duplicate.rows[0]!;
    await expectCode(duplicate, 'DUPLICATE_ENROLMENT');
    const short = valid();
    short.rows[0]!.values.pop();
    await expectCode(short, 'ROW_LENGTH');
    assert.equal((await create('F1', 'ai-a', { ...valid(), stage: 'lab' as Stage })).status, 400);
    const noKey = await call(
      'POST',
      `/pilot/offerings/${offering('ai-a')}/batches`,
      'F1',
      valid(),
      null,
    );
    assert.equal(noKey.status, 400);
  });

  await t.test(
    'batch creation matches the matrix for every persona, offering and stage',
    async () => {
      for (const persona of [...subjects.keys(), null]) {
        for (const key of Object.keys(fixture.offerings)) {
          for (const stage of ['cie', 'see'] as const) {
            // One row for a student outside every roster: allowed callers reach validation (422).
            const probe = {
              ...body('ai-a', stage, 0),
              rows: [{ enrolmentId: randomUUID(), values: components(stage).map(() => '0') }],
            };
            const response = await call(
              'POST',
              `/pilot/offerings/${offering(key)}/batches`,
              persona,
              probe,
            );
            const expected = persona
              ? decide(PILOT_WORLD, persona, 'batch.create', `${key}:${stage}`).outcome.status
              : 401;
            assert.equal(
              response.status,
              expected === 200 ? 422 : expected,
              `${persona} ${key}:${stage}`,
            );
          }
        }
      }
    },
  );

  await t.test(
    'other authors work in their own scope and submission matches the matrix',
    async () => {
      for (const [as, key, stage] of [
        ['E1', 'ai-a', 'see'],
        ['H1', 'ai-b', 'cie'],
        ['F3', 'is-a', 'cie'],
      ] as const) {
        const response = await create(as, key, body(key, stage, 0));
        assert.equal(
          response.status,
          201,
          `${as} ${key}/${stage} ${JSON.stringify(response.json)}`,
        );
        batches.set(`${key}/${stage}`, response.json.batchId);
      }
      for (const [batchKey, batchId] of batches) {
        for (const persona of [...subjects.keys(), null]) {
          const expected = persona
            ? decide(PILOT_WORLD, persona, 'batch.submit', batchKey).outcome.status
            : 401;
          assert.equal((await submit(persona, batchId)).status, expected, `${persona} ${batchKey}`);
        }
      }
    },
  );

  await t.test('reads follow entry, department and exam-approver scope', async () => {
    const cie = batches.get('ai-a/cie')!;
    for (const [persona, status] of [
      ['F1', 200],
      ['H1', 200],
      ['H2', 200],
      ['P1', 200],
      ['E1', 404],
      ['F3', 404],
      ['H3', 404],
      ['S1', 403],
      ['D1', 403],
      ['ST1', 403],
    ] as const) {
      assert.equal((await call('GET', `/pilot/batches/${cie}`, persona)).status, status, persona);
    }
    const seeOnly = await call<{ batches: PilotBatchSummary[] }>(
      'GET',
      `/pilot/offerings/${offering('ai-a')}/batches`,
      'E1',
    );
    assert.deepEqual(
      seeOnly.json.batches.map((b) => b.stage),
      ['see'],
    );
  });

  await t.test('the runtime cannot touch assessment tables and history is immutable', async () => {
    await assert.rejects(runtime.platform.repository.sql.query('SELECT * FROM assessment.mark'), {
      code: '42501',
    });
    await assert.rejects(admin.query('UPDATE assessment.mark SET points=0'), { code: '55000' });
    await assert.rejects(admin.query('DELETE FROM assessment.batch_submission'), { code: '55000' });
    await assert.rejects(
      admin.query('UPDATE assessment.offering_policy SET policy_version=2 WHERE offering_id=$1', [
        offering('ai-a'),
      ]),
      { code: '55000' },
    );
  });
});
