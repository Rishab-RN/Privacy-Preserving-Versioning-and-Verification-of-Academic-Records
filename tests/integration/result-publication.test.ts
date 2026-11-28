import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  PilotBatch,
  PilotPublication,
  PilotPublishResult,
  PilotStudentResult,
} from '@scholarproof/contracts';
import { PILOT_WORLD, decide } from '../../packages/access-matrix/src/index.js';
import { RVCE_2022_ITL_S1, calculateResult } from '../../packages/assessment/src/index.js';
import type { CourseResult } from '../../packages/assessment/src/index.js';
import type { Batch, World } from '../../packages/access-matrix/src/index.js';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import { pilotId } from '../../apps/api/scripts/pilot/provision.js';
import { connectTestClient } from '../database/helpers.js';
import {
  personaSubjects,
  pilotAttendance,
  pilotWorkflow,
  provisionTestPilot,
  sessionFor,
  startPilotApi,
} from './pilot-fixture.js';
import type { Stage } from './pilot-fixture.js';

const data = generatePilotData();
const OFFERINGS = ['ai-a', 'ai-b', 'is-a'] as const;

const attendanceFor = (offering: string) => pilotAttendance(data, offering);

/** The stored grade for a computed result: results without grade points are incomplete. */
function storedGrade(result: CourseResult) {
  return result.gradePoints === null || result.outcome === null
    ? { gradePoints: null, outcome: 'incomplete' }
    : { gradePoints: result.gradePoints, outcome: result.outcome };
}

test('T5 publication is authorized, separated, audited and visible only to its students', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const fixture = await provisionTestPilot(admin, data);
  const offering = (key: string) => fixture.offerings[key as keyof typeof fixture.offerings];
  const subjects = personaSubjects(data);
  const personaOf = new Map([...subjects].map(([key, subject]) => [subject, key]));
  const tokens = new Map<string, string>();
  for (const [key, subject] of subjects) tokens.set(key, await sessionFor(admin, subject));
  const { runtime, call } = await startPilotApi(t, tokens);

  const publish = (as: string | null, key: string, attendance: unknown = attendanceFor(key)) =>
    call<PilotPublishResult>('POST', `/pilot/offerings/${offering(key)}/publish`, as, {
      attendance,
    });
  const view = (as: string | null, key: string) =>
    call<PilotPublication>('GET', `/pilot/offerings/${offering(key)}/publication`, as);
  const mine = (as: string) =>
    call<{ results: PilotStudentResult[] }>('GET', '/pilot/my-results', as);

  const { submitted, reviewed } = pilotWorkflow(call, data, fixture.offerings);

  const aiCie = await reviewed('F1', 'ai-a', 'H1');
  assert.equal(aiCie.review?.verdict, 'approved');
  const aiSee = await submitted('E1', 'ai-a', 'see');
  // P2, an exam approver, reviews or has validated IS-A, so it may never publish IS-A.
  await reviewed('F3', 'is-a', 'P2');

  // An independent recomputation from the actual input revisions, which may carry corrections
  // made by earlier tests, and the imported attendance.
  const marksOf = new Map<string, Record<string, string>>();
  for (const { batchId } of [aiCie, aiSee]) {
    const batch = (await call<PilotBatch>('GET', `/pilot/batches/${batchId}`, 'P1')).json;
    for (const row of batch.rows) {
      const marks = marksOf.get(row.studentCode) ?? {};
      batch.components.forEach((code, i) => (marks[code] = row.values[i]!));
      marksOf.set(row.studentCode, marks);
    }
  }
  const recomputed = new Map(
    data.assessments
      .filter((a) => a.offering === 'ai-a')
      .map((a) => [
        a.usn,
        calculateResult(RVCE_2022_ITL_S1, { attendance: a.attendance, marks: marksOf.get(a.usn)! }),
      ]),
  );

  await t.test('publication needs a separate exam approver and complete inputs', async () => {
    assert.ok(!(await mine('ST1')).json.results.some((r) => r.offeringId === offering('ai-a')));
    assert.equal((await view('P1', 'ai-a')).code, 'NOT_PUBLISHED');

    assert.equal((await publish(null, 'ai-a')).status, 401);
    for (const persona of ['H1', 'F1', 'E1', 'S1', 'R1', 'D1', 'ST1']) {
      assert.equal((await publish(persona, 'ai-a')).status, 403, persona);
    }
    const unknown = await call('POST', `/pilot/offerings/${randomUUID()}/publish`, 'P1', {
      attendance: attendanceFor('ai-a'),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await publish('P2', 'is-a')).code, 'SOD_CONFLICT');
    assert.equal((await publish('P1', 'is-a')).code, 'SEE_NOT_SUBMITTED');
    assert.ok(
      ['CIE_NOT_APPROVED', 'SEE_NOT_SUBMITTED'].includes((await publish('P1', 'ai-b')).code ?? ''),
    );

    const attendance = attendanceFor('ai-a');
    const malformed = await call('POST', `/pilot/offerings/${offering('ai-a')}/publish`, 'P1', {});
    assert.equal(malformed.status, 400);
    assert.equal((await publish('P1', 'ai-a', attendance.slice(1))).code, 'ATTENDANCE_INCOMPLETE');
    assert.equal(
      (await publish('P1', 'ai-a', [...attendance, attendance[0]])).code,
      'DUPLICATE_ENROLMENT',
    );
    assert.equal(
      (await publish('P1', 'ai-a', [...attendance.slice(1), attendanceFor('is-a')[0]])).code,
      'UNKNOWN_ENROLMENT',
    );
    const everyoneEligible = attendance.map((row) => ({ ...row, eligible: true }));
    assert.equal(
      (await publish('P1', 'ai-a', everyoneEligible)).code,
      'SEE_ROWS_MISSING',
      'SYN24AI007 would be eligible but has no SEE row',
    );
    const ineligibleWithSee = attendance.map((row, i) =>
      i === 0 ? { ...row, eligible: false } : row,
    );
    assert.equal((await publish('P1', 'ai-a', ineligibleWithSee)).code, 'INELIGIBLE_HAS_SEE_MARKS');
    const overHundred = attendance.map((row, i) => (i === 0 ? { ...row, percent: '101' } : row));
    assert.equal((await publish('P1', 'ai-a', overHundred)).code, 'INVALID_ATTENDANCE');

    const first = await publish('P1', 'ai-a');
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.deepEqual(
      [first.json.records, first.json.alreadyPublished, first.json.kind],
      [12, false, 'provisional'],
    );
    assert.deepEqual(first.json.inputs, { cie: aiCie.batchId, see: aiSee.batchId });
    const again = await publish('P1', 'ai-a');
    assert.deepEqual(
      [again.status, again.json.alreadyPublished, again.json.publicationId],
      [200, true, first.json.publicationId],
    );
    const changed = attendance.map((row, i) => (i === 0 ? { ...row, percent: '90' } : row));
    assert.equal((await publish('P1', 'ai-a', changed)).code, 'ALREADY_PUBLISHED');
    assert.equal((await publish('P2', 'ai-a')).code, 'ALREADY_PUBLISHED');
  });

  await t.test('published grades match the calculator and the recomputation audit', async () => {
    const published = await view('P1', 'ai-a');
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const publication = published.json;
    assert.equal(publication.publisherSubject, 'pilot:p1');
    assert.deepEqual(publication.policy, { id: 'rvce-2022-itl-s1', version: 1 });
    assert.deepEqual(
      publication.inputs.map((input) => input.batchId),
      [aiCie.batchId, aiSee.batchId],
    );
    assert.deepEqual(publication.audit, { records: 12, mismatches: [] });
    assert.equal(publication.results.length, recomputed.size);
    for (const [usn, expected] of recomputed) {
      const row = publication.results.find((r) => r.studentCode === usn);
      assert.ok(row, usn);
      const grade = storedGrade(expected);
      assert.deepEqual(
        [row.versionNo, row.status, row.letter, row.gradePoints, row.outcome, row.matches],
        [1, expected.status, expected.letter, grade.gradePoints, grade.outcome, true],
        usn,
      );
      assert.deepEqual([row.cie, row.see], [expected.cie, expected.see], usn);
    }

    const versions = await admin.query<{ count: string }>(
      `SELECT count(*) FROM academic.grade_version v JOIN academic.grade_record g USING(record_id)
       JOIN academic.enrolment e USING(enrolment_id)
       WHERE e.offering_id=$1 AND v.version_no=1 AND v.author_id=$2 AND v.reason='Provisional publication'`,
      [offering('ai-a'), pilotId('user:pilot:p1')],
    );
    assert.equal(versions.rows[0]!.count, '12');
    const transcript = await admin.query<{ grade_points: string; outcome: string }>(
      'SELECT grade_points,outcome FROM academic.current_transcript WHERE student_id=$1',
      [pilotId('student:SYN24AI001')],
    );
    const demo = storedGrade(recomputed.get('SYN24AI001')!);
    assert.deepEqual(transcript.rows, [
      { grade_points: demo.gradePoints?.toFixed(2) ?? null, outcome: demo.outcome },
    ]);

    for (const persona of ['F1', 'H1', 'H2', 'P2', 'R1', 'A1']) {
      assert.equal((await view(persona, 'ai-a')).status, 200, persona);
    }
    for (const persona of ['E1', 'S1', 'D1', 'ST1']) {
      assert.equal((await view(persona, 'ai-a')).status, 403, persona);
    }
    for (const persona of ['F3', 'H3']) {
      assert.equal((await view(persona, 'ai-a')).status, 404, persona);
    }
  });

  await t.test('students see only their own provisional results', async () => {
    const own = await mine('ST1');
    assert.equal(own.status, 200);
    assert.equal(own.json.results.length, 1);
    const [result] = own.json.results;
    const expected = recomputed.get('SYN24AI001')!;
    const grade = storedGrade(expected);
    assert.deepEqual(
      [result!.courseCode, result!.label, result!.letter, result!.gradePoints, result!.outcome],
      ['CD252IA', 'Provisional', expected.letter, grade.gradePoints, grade.outcome],
    );
    assert.equal(expected.status, 'graded', 'the demo student has a graded result');
    assert.deepEqual([result!.cie, result!.see], [expected.cie, expected.see]);
    assert.deepEqual((await mine('ST2')).json.results, []);
    assert.deepEqual((await mine('ST3')).json.results, []);
    assert.equal((await mine('F1')).status, 403);
  });

  await t.test('publication and result reads match the access matrix', async () => {
    const history = await admin.query<{
      offering_id: string;
      stage: Stage;
      revision_no: number;
      author: string;
      reviewer: string | null;
      validator: string | null;
    }>(
      `SELECT b.offering_id, b.stage, b.revision_no, au.auth_subject AS author,
         ru.auth_subject AS reviewer, vu.auth_subject AS validator
       FROM assessment.batch b JOIN academic.app_user au ON au.user_id=b.author_id
       LEFT JOIN assessment.batch_review r ON r.batch_id=b.batch_id
       LEFT JOIN academic.app_user ru ON ru.user_id=r.reviewer_id
       LEFT JOIN assessment.validation_report v ON v.batch_id=b.batch_id
       LEFT JOIN assessment.validation_delegation d ON d.delegation_id=v.delegation_id
       LEFT JOIN academic.app_user vu ON vu.user_id=d.grantee_id
       WHERE b.offering_id=ANY($1)`,
      [OFFERINGS.map(offering)],
    );
    const keyOf = new Map(OFFERINGS.map((key) => [offering(key), key]));
    const persona = (subject: string | null) => (subject ? personaOf.get(subject) : undefined);
    const batches: Record<string, Batch> = {};
    for (const row of history.rows) {
      const validator = persona(row.validator);
      batches[`${keyOf.get(row.offering_id)}/${row.stage}/r${row.revision_no}`] = {
        offering: keyOf.get(row.offering_id)!,
        stage: row.stage,
        author: persona(row.author) ?? row.author,
        validators: validator ? [validator] : [],
        reviewer: persona(row.reviewer) ?? null,
      };
    }
    const published = new Set<string | undefined>(
      (
        await admin.query<{ offering_id: string }>('SELECT offering_id FROM assessment.publication')
      ).rows.map((row) => keyOf.get(row.offering_id)),
    );
    const live: World = {
      ...PILOT_WORLD,
      now: new Date().toISOString(),
      offerings: Object.fromEntries(
        Object.entries(PILOT_WORLD.offerings).map(([key, value]) => [
          key,
          { ...value, published: published.has(key) },
        ]),
      ),
      batches,
    };
    assert.deepEqual([...published], ['ai-a']);

    // Allowed calls may still meet the offering's state: inputs not ready or already published.
    const stateConflicts = new Set(['ALREADY_PUBLISHED', 'CIE_NOT_APPROVED', 'SEE_NOT_SUBMITTED']);
    for (const key of OFFERINGS) {
      for (const who of [...subjects.keys(), null]) {
        const expected = who
          ? decide(live, who, 'results.publish', key).outcome
          : { status: 401, code: 'UNAUTHENTICATED' };
        const response = await publish(who, key);
        const label = `${who} results.publish ${key}`;
        if (expected.status === 200) {
          assert.ok(
            response.status === 200 ||
              (response.status === 409 && stateConflicts.has(response.code ?? '')),
            `${label}: ${response.status} ${response.code}`,
          );
        } else {
          assert.equal(response.status, expected.status, label);
          if (expected.code === 'SOD_CONFLICT') assert.equal(response.code, expected.code, label);
        }
      }
    }

    const ownResults = new Map<string, Set<string>>();
    for (const student of ['ST1', 'ST2', 'ST3']) {
      ownResults.set(
        student,
        new Set((await mine(student)).json.results.map((r) => keyOf.get(r.offeringId)!)),
      );
    }
    for (const [resultKey, result] of Object.entries(live.results)) {
      for (const who of [...subjects.keys(), null]) {
        const expected = who
          ? decide(live, who, 'result.read', resultKey).outcome
          : { status: 401, code: 'UNAUTHENTICATED' };
        const label = `${who} result.read ${resultKey}`;
        const student = ownResults.get(who ?? '');
        if (student) {
          assert.equal(student.has(result.offering), expected.status === 200, label);
          continue;
        }
        const response = await view(who, result.offering);
        if (expected.status === 200 && !published.has(result.offering)) {
          assert.equal(response.code, 'NOT_PUBLISHED', label);
        } else {
          assert.equal(response.status, expected.status, label);
        }
      }
    }
  });

  await t.test('publication facts are immutable and private', async () => {
    await assert.rejects(admin.query("UPDATE assessment.publication SET kind='final'"), {
      code: '55000',
    });
    await assert.rejects(admin.query('DELETE FROM assessment.publication_grade'), {
      code: '55000',
    });
    await assert.rejects(
      admin.query('UPDATE assessment.publication_attendance SET eligible=false'),
      {
        code: '55000',
      },
    );
    await assert.rejects(
      runtime.platform.repository.sql.query('SELECT * FROM assessment.publication'),
      { code: '42501' },
    );
  });
});
