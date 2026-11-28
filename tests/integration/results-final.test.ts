import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  PilotFinalizeResult,
  PilotPublication,
  PilotPvpProposal,
  PilotStudentResult,
} from '@scholarproof/contracts';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import { connectTestClient } from '../database/helpers.js';
import {
  personaSubjects,
  pilotWorkflow,
  provisionTestPilot,
  sessionFor,
  startPilotApi,
} from './pilot-fixture.js';

const data = generatePilotData();

test('final publication closes paper viewing without new grade rows', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const fixture = await provisionTestPilot(admin, data);
  const tokens = new Map<string, string>();
  for (const [key, subject] of personaSubjects(data)) {
    tokens.set(key, await sessionFor(admin, subject));
  }
  const { runtime, call } = await startPilotApi(t, tokens);
  const workflow = pilotWorkflow(call, data, fixture.offerings);
  await workflow.publishedAiA();
  // P2, an exam approver, reviews or has validated IS-A, so it may never publish IS-A.
  await workflow.reviewed('F3', 'is-a', 'P2');

  const offering = (key: string) => fixture.offerings[key as 'ai-a'];
  const view = async () =>
    (await call<PilotPublication>('GET', `/pilot/offerings/${offering('ai-a')}/publication`, 'P1'))
      .json;
  const finalize = (as: string | null, key = 'ai-a') =>
    call<PilotFinalizeResult>('POST', `/pilot/offerings/${offering(key)}/finalize`, as, {});
  const before = await view();
  assert.deepEqual([before.final, before.pendingCorrections], [null, 0]);
  // A student whose SEE theory mark can still go up, other than the T6 correction.
  const target = before.results.find(
    (r) =>
      r.studentCode !== 'SYN24AI003' &&
      r.paperViewing.some(
        (c) => c.code === 'see_part_a' && c.marks !== 'AB' && Number(c.marks) < 20,
      ),
  )!;
  const raised = {
    see_part_a: (
      Number(target.paperViewing.find((c) => c.code === 'see_part_a')!.marks) + 1
    ).toFixed(2),
  };
  const revalue = () =>
    call<PilotPvpProposal>('POST', `/pilot/records/${target.recordId}/pvp`, 'R1', {
      expectedVersion: target.versionNo,
      revised: raised,
      reason: 'Late revaluation after paper viewing',
    });

  await t.test('only a separate exam approver may publish final results', async () => {
    assert.equal((await finalize(null)).status, 401);
    for (const who of ['H1', 'F1', 'E1', 'S1', 'R1', 'D1', 'ST1']) {
      assert.equal((await finalize(who)).status, 403, who);
    }
    const unknown = await call('POST', `/pilot/offerings/${randomUUID()}/finalize`, 'P1', {});
    assert.equal(unknown.status, 404);
    assert.equal((await finalize('P2', 'is-a')).code, 'SOD_CONFLICT');
    assert.equal((await finalize('P1', 'is-a')).code, 'PROVISIONAL_REQUIRED');
  });

  await t.test('pending corrections block final publication', async () => {
    const proposal = await revalue();
    assert.equal(proposal.status, 201, JSON.stringify(proposal.json));
    assert.equal((await view()).pendingCorrections, 1);
    assert.equal((await finalize('P1')).code, 'PVP_PENDING');
    const rejected = await call(
      'POST',
      `/change-requests/${proposal.json.request.requestId}/reject`,
      'R2',
      { reason: 'The expert team did not confirm the revaluation' },
    );
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
    assert.equal((await view()).pendingCorrections, 0);
  });

  await t.test('final publication fixes current versions without new grade rows', async () => {
    const versions = async () =>
      (
        await admin.query<{ count: string }>(
          `SELECT count(*) FROM academic.grade_version v JOIN academic.grade_record g USING(record_id)
           JOIN academic.enrolment e USING(enrolment_id) WHERE e.offering_id=$1`,
          [offering('ai-a')],
        )
      ).rows[0]!.count;
    const versionsBefore = await versions();
    const current = await view();
    const revised = current.results.filter((r) => r.versionNo !== r.publishedVersionNo).length;

    const first = await finalize('P1');
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.deepEqual(
      [first.json.kind, first.json.records, first.json.revised, first.json.alreadyFinal],
      ['final', 12, revised, false],
    );
    const again = await finalize('P1');
    assert.deepEqual(
      [again.status, again.json.alreadyFinal, again.json.publicationId],
      [200, true, first.json.publicationId],
    );
    assert.equal((await finalize('P2')).code, 'ALREADY_FINAL');
    assert.equal(await versions(), versionsBefore, 'final publication adds no grade versions');

    const final = await view();
    assert.equal(final.final?.publisherSubject, 'pilot:p1');
    assert.ok(final.results.every((r) => r.finalVersionNo === r.versionNo));
    assert.deepEqual(final.audit.mismatches, []);
    const own = await call<{ results: PilotStudentResult[] }>('GET', '/pilot/my-results', 'ST1');
    assert.deepEqual(
      own.json.results.map((r) => r.label),
      ['Final'],
    );
  });

  await t.test('final grades cannot be corrected', async () => {
    assert.equal((await revalue()).code, 'RESULTS_FINAL');
    const note = await call<{ evidenceId: string }>(
      'POST',
      `/records/${target.recordId}/evidence`,
      'R1',
      { schemaVersion: 1, category: 'supporting_note', data: { note: 'Change after final' } },
    );
    assert.equal(note.status, 201);
    const bypass = await call('POST', `/records/${target.recordId}/change-requests`, 'R1', {
      expectedVersion: target.versionNo,
      gradePoints: '10.00',
      outcome: 'passed',
      validFrom: new Date().toISOString(),
      validUntil: null,
      evidenceId: note.json.evidenceId,
      reason: 'Direct change after final publication',
    });
    assert.equal(bypass.code, 'INVALID_CHANGE');
    await assert.rejects(admin.query('UPDATE assessment.final_grade SET version_no=1'), {
      code: '55000',
    });
    await assert.rejects(
      runtime.platform.repository.sql.query('SELECT * FROM assessment.final_grade'),
      { code: '42501' },
    );
  });
});
