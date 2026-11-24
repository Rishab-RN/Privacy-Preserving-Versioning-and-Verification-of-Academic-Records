import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDatabaseCommand } from '../db/command.js';
import { projectRoot } from '../db/config.js';
import { MigrationError } from '../db/migrations.js';
import { hashPassword, verifyPassword, type PasswordMaterial } from '../../src/security.js';

interface Account {
  subject: string;
  password: string;
}
await runDatabaseCommand(async (client) => {
  const ready = await client.query<{ ready: boolean }>(
    "SELECT to_regprocedure('workflow.approve_change(text,uuid,text)') IS NOT NULL AS ready",
  );
  if (!ready.rows[0]?.ready)
    throw new MigrationError('Apply Week 4 migrations before workflow:demo');
  const catalogue = await client.query<{
    institution_id: string;
    student_id: string;
    term_id: string;
    scheme_id: string;
  }>(`
    SELECT i.institution_id,s.student_id,t.term_id,g.scheme_id FROM academic.institution i
    JOIN academic.student s USING(institution_id) JOIN academic.academic_term t USING(institution_id)
    JOIN academic.grading_scheme g USING(institution_id)
    WHERE i.institution_code='DEMO_UNIVERSITY' AND s.student_code='DEMO_STUDENT_001'
      AND t.term_code='2026-DEMO' AND g.scheme_code='DEMO_TEN_POINT' AND g.version=1`);
  const fixture = catalogue.rows[0];
  if (!fixture) throw new MigrationError('Run db:seed before workflow:demo');
  const directory = join(projectRoot, '.runtime');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'workflow-accounts.json');
  const subjects = ['demo:workflow-proposer', 'demo:workflow-approver'];
  try {
    writeFileSync(
      path,
      JSON.stringify(
        subjects.map((subject) => ({ subject, password: randomBytes(24).toString('base64url') })),
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST')
      throw error;
  }
  if (!lstatSync(path).isFile())
    throw new MigrationError('Workflow account path must be a regular file');
  const accounts: Account[] = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Array.isArray(accounts) ||
    accounts.length !== 2 ||
    accounts.some(
      (account, index) =>
        account.subject !== subjects[index] || !/^[A-Za-z0-9_-]{32}$/.test(account.password),
    )
  )
    throw new MigrationError('Incompatible workflow demo accounts; no password was reset');
  await client.query('BEGIN');
  let committed = false;
  try {
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 5]);
    for (const account of accounts) {
      await client.query(
        'INSERT INTO academic.app_user(auth_subject) VALUES($1) ON CONFLICT(auth_subject) DO NOTHING',
        [account.subject],
      );
      const user = await client.query<{ user_id: string; account_state: string }>(
        'SELECT user_id,account_state FROM academic.app_user WHERE auth_subject=$1',
        [account.subject],
      );
      if (user.rows[0]?.account_state !== 'active')
        throw new MigrationError('A workflow demo account is disabled; no account state was reset');
      const id = user.rows[0]!.user_id;
      await client.query(
        "INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,'registrar') ON CONFLICT DO NOTHING",
        [fixture.institution_id, id],
      );
      const existing = await client.query<PasswordMaterial>(
        'SELECT profile,salt_hex,derived_key_hex FROM access_control.password_credential_context WHERE user_id=$1',
        [id],
      );
      if (existing.rows[0]) {
        if (!(await verifyPassword(account.password, existing.rows[0])))
          throw new MigrationError('Existing workflow password differs; no credential was reset');
      } else {
        const material = await hashPassword(account.password);
        await client.query(
          'INSERT INTO access_control.password_credential(user_id,salt_hex,derived_key_hex) VALUES($1,$2,$3)',
          [id, material.salt_hex, material.derived_key_hex],
        );
      }
    }
    const course = await client.query<{ course_id: string }>(
      `INSERT INTO academic.course(course_id,institution_id,course_code,title)
      VALUES(md5('demo:workflow:course')::uuid,$1,'DEMO_WORKFLOW','Synthetic Workflow Course') ON CONFLICT(institution_id,course_code) DO NOTHING RETURNING course_id`,
      [fixture.institution_id],
    );
    const courseId =
      course.rows[0]?.course_id ??
      (
        await client.query<{ course_id: string }>(
          "SELECT course_id FROM academic.course WHERE institution_id=$1 AND course_code='DEMO_WORKFLOW'",
          [fixture.institution_id],
        )
      ).rows[0]!.course_id;
    await client.query(
      `INSERT INTO academic.course_offering(offering_id,course_id,term_id,scheme_id,credits)
      VALUES(md5('demo:workflow:offering')::uuid,$1,$2,$3,4) ON CONFLICT(offering_id) DO NOTHING`,
      [courseId, fixture.term_id, fixture.scheme_id],
    );
    await client.query(
      `INSERT INTO academic.enrolment(enrolment_id,student_id,offering_id)
      VALUES(md5('demo:workflow:enrolment')::uuid,$1,md5('demo:workflow:offering')::uuid) ON CONFLICT(enrolment_id) DO NOTHING`,
      [fixture.student_id],
    );
    await client.query(
      `INSERT INTO academic.grade_record(record_id,institution_id,enrolment_id)
      VALUES(md5('demo:workflow:record')::uuid,$1,md5('demo:workflow:enrolment')::uuid) ON CONFLICT(record_id) DO NOTHING`,
      [fixture.institution_id],
    );
    const record = await client.query<{
      record_id: string;
      enrolment_id: string;
      institution_id: string;
      student_id: string;
      course_id: string;
      term_id: string;
      scheme_id: string;
      credits: string;
    }>(`
      SELECT g.record_id,g.enrolment_id,g.institution_id,e.student_id,o.course_id,o.term_id,o.scheme_id,o.credits
      FROM academic.grade_record g JOIN academic.enrolment e USING(enrolment_id)
      JOIN academic.course_offering o USING(offering_id) WHERE g.record_id=md5('demo:workflow:record')::uuid`);
    const row = record.rows[0];
    if (
      !row ||
      row.institution_id !== fixture.institution_id ||
      row.student_id !== fixture.student_id ||
      row.course_id !== courseId ||
      row.term_id !== fixture.term_id ||
      row.scheme_id !== fixture.scheme_id ||
      row.credits !== '4.00'
    )
      throw new MigrationError(
        'Existing workflow fixture conflicts; no catalogue facts were overwritten',
      );
    await client.query('COMMIT');
    committed = true;
    const publicFixture = {
      recordId: row.record_id,
      studentId: row.student_id,
      institutionId: row.institution_id,
    };
    const fixturePath = join(directory, 'workflow-fixture.json');
    try {
      writeFileSync(fixturePath, JSON.stringify(publicFixture, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST')
        throw error;
    }
    const saved = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof publicFixture;
    if (
      saved.recordId !== publicFixture.recordId ||
      saved.studentId !== publicFixture.studentId ||
      saved.institutionId !== publicFixture.institutionId
    )
      throw new MigrationError('Workflow fixture metadata conflicts; existing file was preserved');
    console.info(
      'Verified two synthetic registrars and the workflow record; passwords are in ignored .runtime/workflow-accounts.json',
    );
    console.info('Existing accounts, credentials and academic versions were not reset');
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  }
});
