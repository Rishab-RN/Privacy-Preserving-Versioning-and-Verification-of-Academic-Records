import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  ChangeRequestStatus,
  PilotBatch,
  PilotPublication,
  PilotPvpProposal,
  PilotStudentResult,
} from '@scholarproof/contracts';
import { RVCE_2022_ITL_S1, calculateResult } from '../../packages/assessment/src/index.js';
import type { CourseResult } from '../../packages/assessment/src/index.js';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import { pilotId } from '../../apps/api/scripts/pilot/provision.js';
import { digestToken } from '../../apps/api/src/security.js';
import { connectTestClient } from '../database/helpers.js';
import {
  personaSubjects,
  pilotWorkflow,
  provisionTestPilot,
  sessionFor,
  startPilotApi,
} from './pilot-fixture.js';

const data = generatePilotData();
const REASON = 'Expert team revaluation after paper viewing';

function storedGrade(result: CourseResult) {
  return result.gradePoints === null || result.outcome === null
    ? { gradePoints: null, outcome: 'incomplete' }
    : { gradePoints: result.gradePoints, outcome: result.outcome };
}

test('T6 paper-viewing corrections follow R12 and create a provable new version', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const fixture = await provisionTestPilot(admin, data);
  const tokens = new Map<string, string>();
  for (const [key, subject] of personaSubjects(data)) {
    tokens.set(key, await sessionFor(admin, subject));
  }
  const candidate = data.students.find((s) => s.usn === 'SYN24AI003')!;
  tokens.set('AI003', await sessionFor(admin, candidate.subject));
  const { runtime, call } = await startPilotApi(t, tokens);
  await pilotWorkflow(call, data, fixture.offerings).publishedAiA();

  const view = async () =>
    (
      await call<PilotPublication>(
        'GET',
        `/pilot/offerings/${fixture.offerings['ai-a']}/publication`,
        'P1',
      )
    ).json;
  const published = await view();
  const rowOf = (publication: PilotPublication, usn: string) =>
    publication.results.find((r) => r.studentCode === usn)!;
  const target = rowOf(published, 'SYN24AI003');
  const absent = rowOf(published, 'SYN24AI005');
  assert.equal(target.versionNo, 1);

  // The stored inputs for the candidate, read back through the marks API.
  const original: Record<string, string> = {};
  for (const input of published.inputs) {
    const batch = (await call<PilotBatch>('GET', `/pilot/batches/${input.batchId}`, 'P1')).json;
    const row = batch.rows.find((r) => r.studentCode === 'SYN24AI003');
    batch.components.forEach((code, i) => {
      if (row) original[code] = row.values[i]!;
    });
  }
  const attendance = data.assessments.find((a) => a.usn === 'SYN24AI003')!.attendance;
  const before = calculateResult(RVCE_2022_ITL_S1, { attendance, marks: original });
  const after = calculateResult(RVCE_2022_ITL_S1, {
    attendance,
    marks: { ...original, see_part_b: '26' },
  });
  assert.deepEqual([before.outcome, after.outcome], ['failed', 'passed']);

  const pvp = (
    as: string | null,
    recordId: string,
    revised: Record<string, string>,
    expectedVersion = 1,
    key = randomUUID(),
  ) =>
    call<PilotPvpProposal>(
      'POST',
      `/pilot/records/${recordId}/pvp`,
      as,
      { expectedVersion, revised, reason: REASON },
      key,
    );

  await t.test('only registrars propose, and R12 limits what may change', async () => {
    const raise = { see_part_b: '26' };
    assert.equal((await pvp(null, target.recordId, raise)).status, 401);
    for (const who of ['F1', 'H1', 'E1', 'S1', 'P1', 'D1', 'A1', 'ST1']) {
      assert.equal((await pvp(who, target.recordId, raise)).status, 403, who);
    }
    assert.equal((await pvp('R1', randomUUID(), raise)).status, 404);
    assert.equal(
      (await pvp('R1', target.recordId, { see_lab_viva: '20' })).code,
      'PVP_LAB_EXCLUDED',
    );
    assert.equal((await pvp('R1', target.recordId, { test1: '50' })).code, 'PVP_SEE_ONLY');
    assert.equal(
      (await pvp('R1', target.recordId, { see_part_b: '10' })).code,
      'NO_NEGATIVE_EVALUATION',
    );
    assert.equal(
      (await pvp('R1', target.recordId, { see_part_b: original.see_part_b! })).code,
      'NO_CHANGE',
    );
    assert.equal(
      (await pvp('R1', target.recordId, { see_part_b: '81' })).code,
      'MARKS_ABOVE_MAXIMUM',
    );
    assert.equal(
      (await pvp('R1', absent.recordId, { see_part_a: '10' })).code,
      'PVP_NOT_APPLICABLE',
    );
    assert.equal((await pvp('R1', target.recordId, raise, 2)).code, 'STALE_REVISION');

    // The generic correction route cannot change a published pilot grade.
    const note = await call<{ evidenceId: string }>(
      'POST',
      `/records/${target.recordId}/evidence`,
      'R1',
      { schemaVersion: 1, category: 'supporting_note', data: { note: 'Manual change attempt' } },
    );
    assert.equal(note.status, 201, JSON.stringify(note.json));
    const bypass = await call('POST', `/records/${target.recordId}/change-requests`, 'R1', {
      expectedVersion: 1,
      gradePoints: '10.00',
      outcome: 'passed',
      validFrom: new Date().toISOString(),
      validUntil: null,
      evidenceId: note.json.evidenceId,
      reason: 'Direct change without paper viewing',
    });
    assert.equal(bypass.code, 'INVALID_CHANGE');
  });

  await t.test('an approved revaluation creates version 2, visible and provable', async () => {
    const key = randomUUID();
    const revised = { see_part_a: original.see_part_a!, see_part_b: '26' };
    const proposed = await pvp('R1', target.recordId, revised, 1, key);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
    const grade = storedGrade(after);
    assert.deepEqual(proposed.json.increased, ['see_part_b'], 'equal marks are not revisions');
    assert.deepEqual(proposed.json.result, {
      letter: after.letter,
      gradePoints: grade.gradePoints,
      outcome: grade.outcome,
    });
    assert.equal(proposed.json.request.decision, null);
    const retry = await pvp('R1', target.recordId, revised, 1, key);
    assert.equal(retry.json.request.requestId, proposed.json.request.requestId);

    const evidence = await call<{
      recordId: string;
      content: { category: string; data: Record<string, unknown> };
    }>('GET', `/evidence/${proposed.json.evidenceId}`, 'R1');
    assert.equal(evidence.status, 200, JSON.stringify(evidence.json));
    const { category, data: stored } = evidence.json.content;
    assert.deepEqual(
      [evidence.json.recordId, category, stored.process, stored.components, stored.revised],
      [target.recordId, 'revaluation_request', 'paper_viewing', ['see_part_b'], ['26']],
    );

    const provable = async () =>
      (
        await runtime.platform.repository.sql.query<{ recordId: string; versionNo: number }>(
          'SELECT "recordId","versionNo" FROM privacy.eligible_records($1,$2)',
          [digestToken(tokens.get('AI003')!), pilotId('student:SYN24AI003')],
        )
      ).rows;
    assert.deepEqual(await provable(), [], 'a published failing grade is not provable');

    const requestId = proposed.json.request.requestId;
    const approve = (as: string) =>
      call<ChangeRequestStatus>('POST', `/change-requests/${requestId}/approve`, as, {
        reason: 'Revaluation checked against the scheme',
      });
    assert.equal((await approve('R1')).status, 403, 'the proposer cannot approve');
    const approved = await approve('R2');
    assert.equal(approved.status, 202, JSON.stringify(approved.json));
    assert.equal(approved.json.decision?.versionNo, 2);

    const corrected = rowOf(await view(), 'SYN24AI003');
    assert.deepEqual(
      [
        corrected.versionNo,
        corrected.publishedVersionNo,
        corrected.revisedAfterPvp,
        corrected.letter,
        corrected.gradePoints,
        corrected.outcome,
        corrected.matches,
      ],
      [2, 1, true, after.letter, grade.gradePoints, grade.outcome, true],
    );
    assert.deepEqual((await view()).audit.mismatches, []);

    const own = await call<{ results: PilotStudentResult[] }>('GET', '/pilot/my-results', 'AI003');
    const [result] = own.json.results;
    assert.deepEqual(
      [result!.versionNo, result!.revisedAfterPvp, result!.letter, result!.label],
      [2, true, after.letter, 'Provisional'],
    );
    assert.deepEqual(result!.see, after.see);
    assert.equal(result!.recordId, target.recordId);

    assert.deepEqual(await provable(), [{ recordId: target.recordId, versionNo: 2 }]);
    const version = await admin.query<{ author: string; reason: string }>(
      `SELECT u.auth_subject AS author, v.reason FROM academic.grade_version v
       JOIN academic.app_user u ON u.user_id=v.author_id WHERE v.record_id=$1 AND v.version_no=2`,
      [target.recordId],
    );
    assert.deepEqual(version.rows, [{ author: 'pilot:r2', reason: REASON }]);
  });

  await t.test('revised marks are immutable and private', async () => {
    await assert.rejects(admin.query('UPDATE assessment.pvp_mark SET points=80'), {
      code: '55000',
    });
    await assert.rejects(
      runtime.platform.repository.sql.query('SELECT * FROM assessment.pvp_mark'),
      { code: '42501' },
    );
  });
});
