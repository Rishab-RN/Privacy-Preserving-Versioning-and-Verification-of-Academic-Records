import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient } from '../../apps/api/scripts/db/config.js';

export async function connectTestClient(): Promise<Client> {
  const database = process.env.TEST_DATABASE_NAME ?? '';
  if (!/^scholarproof_test_[a-f0-9]{32}$/.test(database)) {
    throw new Error('Database tests must run through npm run test:db in an isolated database');
  }
  const client = createDatabaseClient(database);
  await client.connect();
  return client;
}

export async function fixture(client: Client) {
  const id = Object.fromEntries(
    [
      'institution',
      'otherInstitution',
      'author',
      'programme',
      'otherProgramme',
      'student',
      'term',
      'scheme',
      'course',
      'offering',
      'enrolment',
      'record',
    ].map((key) => [key, randomUUID()]),
  );
  const get = (key: string) => {
    const value = id[key];
    if (!value) throw new Error('Missing fixture identifier');
    return value;
  };
  await client.query(
    'INSERT INTO academic.institution(institution_id,institution_code,name) VALUES($1::uuid,$1::uuid::text,$3),($2::uuid,$2::uuid::text,$3)',
    [get('institution'), get('otherInstitution'), 'Synthetic institution'],
  );
  await client.query(
    'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1::uuid,$1::uuid::text)',
    [get('author')],
  );
  await client.query(
    "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar')",
    [get('institution'), get('author')],
  );
  await client.query(
    "INSERT INTO academic.programme(programme_id,institution_id,programme_code,name) VALUES($1,$2,'DEMO','Synthetic programme'),($3,$4,'DEMO','Other synthetic programme')",
    [get('programme'), get('institution'), get('otherProgramme'), get('otherInstitution')],
  );
  await client.query("SELECT academic.register_student($1,$2,$3,'SYNTHETIC',2026::smallint)", [
    get('student'),
    get('institution'),
    get('programme'),
  ]);
  await client.query(
    "INSERT INTO academic.academic_term(term_id,institution_id,term_code,starts_on,ends_on) VALUES($1,$2,'DEMO','2026-01-01','2026-12-31')",
    [get('term'), get('institution')],
  );
  await client.query(
    "INSERT INTO academic.grading_scheme(scheme_id,institution_id,scheme_code,max_points,pass_points) VALUES($1,$2,'DEMO',10,5)",
    [get('scheme'), get('institution')],
  );
  await client.query(
    "INSERT INTO academic.course(course_id,institution_id,course_code,title) VALUES($1,$2,'DEMO_DB','Synthetic database course')",
    [get('course'), get('institution')],
  );
  await client.query(
    'INSERT INTO academic.course_offering(offering_id,course_id,term_id,scheme_id,credits) VALUES($1,$2,$3,$4,4)',
    [get('offering'), get('course'), get('term'), get('scheme')],
  );
  await client.query(
    'INSERT INTO academic.enrolment(enrolment_id,student_id,offering_id) VALUES($1,$2,$3)',
    [get('enrolment'), get('student'), get('offering')],
  );
  await client.query(
    'INSERT INTO academic.grade_record(record_id,institution_id,enrolment_id) VALUES($1,$2,$3)',
    [get('record'), get('institution'), get('enrolment')],
  );
  return {
    id: get,
    append: async (
      expected: number,
      points: number | null,
      outcome = 'passed',
      from = '2026-01-01T00:00:00Z',
      until: string | null = null,
    ) => {
      const result = await client.query<{ version: number }>(
        'SELECT academic.append_grade_version($1,$2,$3,$4,$5,$6,$7,$8) AS version',
        [
          get('record'),
          expected,
          points,
          outcome,
          from,
          until,
          get('author'),
          'Synthetic test decision',
        ],
      );
      return result.rows[0]?.version;
    },
    recorded: async (version: number) => {
      const result = await client.query<{ time: string }>(
        'SELECT recorded_at::text AS time FROM academic.grade_version WHERE record_id=$1 AND version_no=$2',
        [get('record'), version],
      );
      const value = result.rows[0]?.time;
      if (!value) throw new Error('Missing revision timestamp');
      return value;
    },
    asOf: async (known: string, effective: string) =>
      (
        await client.query<{ version_no: number; grade_points: string; outcome: string }>(
          'SELECT * FROM academic.transcript_as_of($1,$2,$3)',
          [get('student'), known, effective],
        )
      ).rows,
  };
}
