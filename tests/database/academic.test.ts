import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectTestClient, fixture } from './helpers.js';

const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: string }).code === expected;

test('tenant-safe foreign keys and enrolment uniqueness', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await assert.rejects(
    client.query(
      "INSERT INTO academic.student(institution_id,programme_id,student_code,admission_year) VALUES($1,$2,'CROSS_TENANT',2026)",
      [f.id('institution'), f.id('otherProgramme')],
    ),
    code('23503'),
  );
  await assert.rejects(
    client.query(
      'INSERT INTO academic.enrolment(institution_id,student_id,offering_id) VALUES($1,$2,$3)',
      [f.id('institution'), f.id('student'), f.id('offering')],
    ),
    code('23505'),
  );
  await assert.rejects(
    client.query('INSERT INTO academic.grade_record(institution_id,enrolment_id) VALUES($1,$2)', [
      f.id('institution'),
      f.id('enrolment'),
    ]),
    code('23505'),
  );
});

test('grade policy, outcome, precision, author and range checks reject invalid facts', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await assert.rejects(f.append(0, 11), code('23514'));
  await assert.rejects(f.append(0, 4, 'passed'), code('23514'));
  await assert.rejects(f.append(0, 7, 'failed'), code('23514'));
  await assert.rejects(f.append(0, null, 'passed'), code('23514'));
  await assert.rejects(f.append(0, 7, 'withdrawn'), code('23514'));
  await assert.rejects(f.append(0, 7.123), code('22023'));
  await assert.rejects(
    f.append(0, 7, 'passed', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    code('22023'),
  );
  await client.query("UPDATE academic.app_user SET account_state='disabled' WHERE user_id=$1", [
    f.id('author'),
  ]);
  await assert.rejects(f.append(0, 7), code('42501'));
  await client.query("UPDATE academic.app_user SET account_state='active' WHERE user_id=$1", [
    f.id('author'),
  ]);
  assert.equal(await f.append(0, null, 'incomplete'), 1);
});

test('retroactive correction preserves earlier known-at answers and immutable payloads', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  assert.equal(await f.append(0, 4, 'failed'), 1);
  const firstKnown = await f.recorded(1);
  assert.equal(await f.append(1, 8), 2);
  const secondKnown = await f.recorded(2);
  assert.equal((await f.asOf(firstKnown, '2026-05-01T00:00:00Z'))[0]?.grade_points, '4.00');
  assert.equal((await f.asOf(secondKnown, '2026-05-01T00:00:00Z'))[0]?.grade_points, '8.00');
  await assert.rejects(
    client.query('UPDATE academic.grade_version SET grade_points=9 WHERE record_id=$1', [
      f.id('record'),
    ]),
    code('55000'),
  );
  await assert.rejects(
    client.query('DELETE FROM academic.grade_version WHERE record_id=$1', [f.id('record')]),
    code('55000'),
  );
  await assert.rejects(
    client.query('UPDATE academic.grade_record SET latest_version_no=1 WHERE record_id=$1', [
      f.id('record'),
    ]),
    code('23514'),
  );
  const history = await client.query(
    'SELECT version_no,grade_points FROM academic.grade_version WHERE record_id=$1 ORDER BY version_no',
    [f.id('record')],
  );
  assert.deepEqual(history.rows, [
    { version_no: 1, grade_points: '4.00' },
    { version_no: 2, grade_points: '8.00' },
  ]);
});

test('grading uses the selected scheme and author institutional scope', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  const policy = await client.query<{ scheme_id: string }>(
    "INSERT INTO academic.grading_scheme(institution_id,scheme_code,max_points,pass_points) VALUES($1,'FOUR_POINT',4,2) RETURNING scheme_id",
    [f.id('institution')],
  );
  await client.query('UPDATE academic.course_offering SET scheme_id=$1 WHERE offering_id=$2', [
    policy.rows[0]!.scheme_id,
    f.id('offering'),
  ]);
  await assert.rejects(f.append(0, 4.5), code('23514'));
  await assert.rejects(f.append(0, 1, 'passed'), code('23514'));
  await client.query('UPDATE academic.role_assignment SET institution_id=$1 WHERE user_id=$2', [
    f.id('otherInstitution'),
    f.id('author'),
  ]);
  await assert.rejects(f.append(0, 3), code('42501'));
  await client.query('UPDATE academic.role_assignment SET institution_id=$1 WHERE user_id=$2', [
    f.id('institution'),
    f.id('author'),
  ]);
  assert.equal(await f.append(0, 3), 1);
});

test('direct inserts cannot skip history or supply their own recorded timestamp', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 6);
  const insert = `INSERT INTO academic.grade_version
    (record_id,version_no,institution_id,grade_points,outcome,valid_during,recorded_at,author_id,reason)
    VALUES($1,$2,$3,8,'passed',tstzrange('2026-01-01',NULL,'[)'), '1900-01-01',$4,'Synthetic direct SQL')`;
  await assert.rejects(
    client.query(insert, [f.id('record'), 3, f.id('institution'), f.id('author')]),
    code('23514'),
  );
  await assert.rejects(
    client.query(insert, [f.id('record'), 2, f.id('otherInstitution'), f.id('author')]),
    code('23503'),
  );
  const known = await f.recorded(1);
  await client.query(insert, [f.id('record'), 2, f.id('institution'), f.id('author')]);
  const clock = await client.query<{ monotonic: boolean }>(
    'SELECT recorded_at > $2::timestamptz AS monotonic FROM academic.grade_version WHERE record_id=$1 AND version_no=2',
    [f.id('record'), known],
  );
  assert.equal(clock.rows[0]?.monotonic, true);
  assert.equal((await f.asOf(known, '2026-05-01T00:00:00Z'))[0]?.grade_points, '6.00');
  assert.equal(
    (await f.asOf(await f.recorded(2), '2026-05-01T00:00:00Z'))[0]?.grade_points,
    '8.00',
  );
});

test('partial correction splits valid time, keeps outside pieces and uses half-open boundaries', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 6);
  const firstKnown = await f.recorded(1);
  await f.append(1, 9, 'passed', '2026-04-01T00:00:00Z', '2026-07-01T00:00:00Z');
  const secondKnown = await f.recorded(2);
  for (const [date, expected] of [
    ['2026-03-31T23:59:59Z', '6.00'],
    ['2026-04-01T00:00:00Z', '9.00'],
    ['2026-06-30T23:59:59Z', '9.00'],
    ['2026-07-01T00:00:00Z', '6.00'],
  ]) {
    assert.equal((await f.asOf(secondKnown, date!))[0]?.grade_points, expected);
    assert.equal((await f.asOf(firstKnown, date!))[0]?.grade_points, '6.00');
  }
  const segments = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM academic.grade_temporal_segment WHERE record_id=$1 AND upper_inf(system_during)',
    [f.id('record')],
  );
  assert.equal(segments.rows[0]?.count, '3');
  await assert.rejects(
    client.query(
      'INSERT INTO academic.grade_temporal_segment(institution_id,record_id,version_no,valid_during,system_during) SELECT institution_id,record_id,version_no,valid_during,system_during FROM academic.grade_temporal_segment WHERE record_id=$1 AND upper_inf(system_during) LIMIT 1',
      [f.id('record')],
    ),
    code('23P01'),
  );
});

test('a future-effective latest revision does not replace the present effective grade', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 6, 'passed', '2000-01-01T00:00:00Z');
  await f.append(1, 10, 'passed', '2100-01-01T00:00:00Z');
  const known = await f.recorded(2);
  assert.equal((await f.asOf(known, '2026-05-01T00:00:00Z'))[0]?.version_no, 1);
  assert.equal((await f.asOf(known, '2100-01-01T00:00:00Z'))[0]?.version_no, 2);
  const current = await client.query(
    'SELECT version_no FROM academic.current_transcript WHERE record_id=$1',
    [f.id('record')],
  );
  assert.equal(current.rows[0]?.version_no, 1);
  const head = await client.query(
    'SELECT latest_version_no FROM academic.grade_record WHERE record_id=$1',
    [f.id('record')],
  );
  assert.equal(head.rows[0]?.latest_version_no, 2);
});

test('two simultaneous expected-version corrections have exactly one winner', async (context) => {
  const client = await connectTestClient();
  const other = await connectTestClient();
  context.after(async () => {
    await Promise.all([client.end(), other.end()]);
  });
  const f = await fixture(client);
  await f.append(0, 6);
  const sql = 'SELECT academic.append_grade_version($1,1,$2,$3,$4,NULL,$5,$6)';
  const args = (points: number) => [
    f.id('record'),
    points,
    'passed',
    '2026-01-01T00:00:00Z',
    f.id('author'),
    'Concurrent synthetic correction',
  ];
  const results = await Promise.allSettled([client.query(sql, args(7)), other.query(sql, args(8))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.equal(
    failure?.status === 'rejected' ? (failure.reason as { code: string }).code : undefined,
    '40001',
  );
  const count = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM academic.grade_version WHERE record_id=$1',
    [f.id('record')],
  );
  assert.equal(count.rows[0]?.count, '2');
});

test('policy and grade-used offering facts are immutable', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 7);
  await assert.rejects(
    client.query('UPDATE academic.grading_scheme SET pass_points=4 WHERE scheme_id=$1', [
      f.id('scheme'),
    ]),
    code('55000'),
  );
  await assert.rejects(
    client.query('UPDATE academic.course_offering SET credits=3 WHERE offering_id=$1', [
      f.id('offering'),
    ]),
    code('55000'),
  );
});

test('enrolments cannot reassign historical grades to another student or offering', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 7);
  await client.query(
    "INSERT INTO academic.student(student_id,institution_id,programme_id,student_code,admission_year) VALUES(gen_random_uuid(),$1,$2,'OTHER_STUDENT',2026)",
    [f.id('institution'), f.id('programme')],
  );
  await client.query(
    "INSERT INTO academic.course_offering(institution_id,course_id,term_id,scheme_id,credits,section_code) VALUES($1,$2,$3,$4,3,'B')",
    [f.id('institution'), f.id('course'), f.id('term'), f.id('scheme')],
  );
  for (const reassignment of [
    "student_id=(SELECT student_id FROM academic.student WHERE institution_id=$2 AND student_code='OTHER_STUDENT')",
    "offering_id=(SELECT offering_id FROM academic.course_offering WHERE institution_id=$2 AND section_code='B')",
  ]) {
    await assert.rejects(
      client.query(`UPDATE academic.enrolment SET ${reassignment} WHERE enrolment_id=$1`, [
        f.id('enrolment'),
        f.id('institution'),
      ]),
      code('55000'),
    );
  }
  const transcript = await f.asOf(await f.recorded(1), '2026-05-01T00:00:00Z');
  assert.equal(transcript[0]?.grade_points, '7.00');
});

test('runtime group can read but is neither owner nor an academic writer', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());
  const f = await fixture(client);
  await f.append(0, 7);
  await client.query('SET ROLE scholarproof_runtime');
  try {
    const permissions = await client.query(
      'SELECT current_user AS role, tableowner FROM pg_tables WHERE schemaname=$1 AND tablename=$2',
      ['academic', 'grade_version'],
    );
    assert.equal(permissions.rows[0]?.role, 'scholarproof_runtime');
    assert.notEqual(permissions.rows[0]?.tableowner, 'scholarproof_runtime');
    assert.equal((await f.asOf(await f.recorded(1), '2026-05-01T00:00:00Z')).length, 1);
    await assert.rejects(
      client.query('UPDATE academic.grade_version SET grade_points=8 WHERE record_id=$1', [
        f.id('record'),
      ]),
      code('42501'),
    );
    await assert.rejects(f.append(1, 8), code('42501'));
    await assert.rejects(
      client.query('CREATE TABLE academic.forbidden(id integer)'),
      code('42501'),
    );
  } finally {
    await client.query('RESET ROLE');
  }
});
