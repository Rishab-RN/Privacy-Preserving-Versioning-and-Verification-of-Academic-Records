import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import {
  DEPARTMENTS,
  INSTITUTION,
  PILOT_COURSE,
  PROGRAMMES,
  TERM,
  generatePilotData,
} from '../../../../packages/pilot-data/src/index.js';
import type { PilotData, SectionKey } from '../../../../packages/pilot-data/src/index.js';
import type { PasswordMaterial } from '../../src/security.js';
import { MigrationError } from '../db/migrations.js';

/** Synthetic term dates and grading scheme for the pilot institution. */
export const PILOT_TERM_DATES = { starts: '2026-08-17', ends: '2027-01-31' } as const;
export const PILOT_SCHEME = { code: 'RVCE-2022-ABS10', version: 1, max: '10.00', pass: '4.00' };

export interface PilotAccount {
  readonly subject: string;
  readonly password: string;
}

/** Password hashing is injected so tests can avoid scrypt; the CLI uses the API's scrypt profile. */
export interface CredentialTools {
  hash(password: string): Promise<PasswordMaterial>;
  verify(password: string, material: PasswordMaterial): Promise<boolean>;
}

export interface PilotFixture {
  readonly institutionId: string;
  readonly termId: string;
  readonly offerings: Readonly<Record<SectionKey, string>>;
  readonly counts: {
    readonly accounts: number;
    readonly students: number;
    readonly enrolments: number;
    readonly offeringDuties: number;
    readonly departmentDuties: number;
    readonly rosterDelegations: number;
    readonly offeringPolicies: number;
  };
}

/** Deterministic UUID for a pilot fact, matching PostgreSQL `md5('pilot:' || name)::uuid`. */
export function pilotId(name: string): string {
  const hex = createHash('md5').update(`pilot:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Login subjects in a fixed order: staff personas, then students. */
export function pilotSubjects(data: PilotData = generatePilotData()): string[] {
  return [...data.staff.map((member) => member.subject), ...data.students.map((s) => s.subject)];
}

const conflict = (what: string) =>
  new MigrationError(`Existing pilot ${what} conflicts with the dataset; nothing was overwritten`);

async function ensure(
  client: Client,
  what: string,
  insert: string,
  values: readonly unknown[],
  check: string,
  checkValues: readonly unknown[],
  expected: Readonly<Record<string, string>>,
) {
  await client.query(insert, values as unknown[]);
  const row = (await client.query<Record<string, unknown>>(check, checkValues as unknown[]))
    .rows[0];
  for (const [column, value] of Object.entries(expected)) {
    if (row === undefined || String(row[column]) !== value) throw conflict(what);
  }
}

/**
 * Seeds the synthetic pilot institution (`ARDC`) into PostgreSQL from `generatePilotData()`:
 * catalogue, offerings, students and enrolments, login accounts with institutional roles, and
 * the migration 0016 department, duty and roster-delegation facts. Every fact has a
 * deterministic ID, so a repeated run changes nothing. Existing credentials are verified, never
 * reset. The whole seed runs in one transaction.
 */
export async function provisionPilot(
  client: Client,
  accounts: readonly PilotAccount[],
  tools: CredentialTools,
  data: PilotData = generatePilotData(),
): Promise<PilotFixture> {
  const subjects = pilotSubjects(data);
  if (accounts.length !== subjects.length || accounts.some((a, i) => a.subject !== subjects[i])) {
    throw new MigrationError(
      'Pilot accounts do not match the pilot dataset; no password was reset',
    );
  }
  const institutionId = pilotId('institution');
  const termId = pilotId(`term:${TERM.code}`);
  const schemeId = pilotId(`scheme:${PILOT_SCHEME.code}`);
  const courseId = pilotId(`course:${PILOT_COURSE.code}`);
  const departmentId = (code: string) => pilotId(`department:${code}`);
  const offeringId = (key: string) => pilotId(`offering:${key}`);

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 16]);
    await ensure(
      client,
      'institution',
      'INSERT INTO academic.institution(institution_id,institution_code,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [institutionId, INSTITUTION.code, INSTITUTION.name],
      'SELECT institution_id FROM academic.institution WHERE institution_code=$1',
      [INSTITUTION.code],
      { institution_id: institutionId },
    );
    for (const programme of PROGRAMMES) {
      await ensure(
        client,
        `programme ${programme.code}`,
        'INSERT INTO academic.programme(programme_id,institution_id,programme_code,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [pilotId(`programme:${programme.code}`), institutionId, programme.code, programme.name],
        'SELECT programme_id FROM academic.programme WHERE institution_id=$1 AND programme_code=$2',
        [institutionId, programme.code],
        { programme_id: pilotId(`programme:${programme.code}`) },
      );
    }
    await ensure(
      client,
      'term',
      'INSERT INTO academic.academic_term(term_id,institution_id,term_code,starts_on,ends_on) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [termId, institutionId, TERM.code, PILOT_TERM_DATES.starts, PILOT_TERM_DATES.ends],
      'SELECT term_id FROM academic.academic_term WHERE institution_id=$1 AND term_code=$2',
      [institutionId, TERM.code],
      { term_id: termId },
    );
    await ensure(
      client,
      'grading scheme',
      `INSERT INTO academic.grading_scheme(scheme_id,institution_id,scheme_code,version,max_points,pass_points)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        schemeId,
        institutionId,
        PILOT_SCHEME.code,
        PILOT_SCHEME.version,
        PILOT_SCHEME.max,
        PILOT_SCHEME.pass,
      ],
      'SELECT scheme_id,max_points,pass_points FROM academic.grading_scheme WHERE institution_id=$1 AND scheme_code=$2 AND version=$3',
      [institutionId, PILOT_SCHEME.code, PILOT_SCHEME.version],
      { scheme_id: schemeId, max_points: PILOT_SCHEME.max, pass_points: PILOT_SCHEME.pass },
    );
    await ensure(
      client,
      'course',
      'INSERT INTO academic.course(course_id,institution_id,course_code,title) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [courseId, institutionId, PILOT_COURSE.code, PILOT_COURSE.title],
      'SELECT course_id FROM academic.course WHERE institution_id=$1 AND course_code=$2',
      [institutionId, PILOT_COURSE.code],
      { course_id: courseId },
    );
    for (const department of DEPARTMENTS) {
      await ensure(
        client,
        `department ${department.code}`,
        'INSERT INTO pilot.department(department_id,institution_id,department_code,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [departmentId(department.code), institutionId, department.code, department.name],
        'SELECT department_id FROM pilot.department WHERE institution_id=$1 AND department_code=$2',
        [institutionId, department.code],
        { department_id: departmentId(department.code) },
      );
    }
    for (const offering of data.offerings) {
      const id = offeringId(offering.key);
      await ensure(
        client,
        `offering ${offering.key}`,
        `INSERT INTO academic.course_offering(offering_id,course_id,term_id,scheme_id,section_code,credits)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [id, courseId, termId, schemeId, offering.key.toUpperCase(), PILOT_COURSE.credits],
        'SELECT course_id,term_id,scheme_id,section_code,credits FROM academic.course_offering WHERE offering_id=$1',
        [id],
        {
          course_id: courseId,
          term_id: termId,
          scheme_id: schemeId,
          section_code: offering.key.toUpperCase(),
          credits: `${PILOT_COURSE.credits}.00`,
        },
      );
      await ensure(
        client,
        `offering department ${offering.key}`,
        'INSERT INTO pilot.offering_department(offering_id,department_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [id, departmentId(offering.department)],
        'SELECT department_id FROM pilot.offering_department WHERE offering_id=$1',
        [id],
        { department_id: departmentId(offering.department) },
      );
      const policy = data.meta.policies.assessment;
      await ensure(
        client,
        `assessment policy ${offering.key}`,
        'INSERT INTO assessment.offering_policy(offering_id,policy_id,policy_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, policy.id, policy.version],
        'SELECT policy_id,policy_version FROM assessment.offering_policy WHERE offering_id=$1',
        [id],
        { policy_id: policy.id, policy_version: String(policy.version) },
      );
    }

    const users = new Map<string, string>();
    for (const account of accounts) {
      await client.query(
        'INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [pilotId(`user:${account.subject}`), account.subject],
      );
      const user = await client.query<{ user_id: string; account_state: string }>(
        'SELECT user_id,account_state FROM academic.app_user WHERE auth_subject=$1',
        [account.subject],
      );
      const row = user.rows[0];
      if (row?.account_state !== 'active') {
        throw new MigrationError(`Pilot account ${account.subject} is disabled; nothing was reset`);
      }
      users.set(account.subject, row.user_id);
      const existing = await client.query<PasswordMaterial>(
        'SELECT profile,salt_hex,derived_key_hex FROM access_control.password_credential_context WHERE user_id=$1',
        [row.user_id],
      );
      if (existing.rows[0]) {
        if (!(await tools.verify(account.password, existing.rows[0]))) {
          throw new MigrationError(
            `Existing password for ${account.subject} differs; nothing was reset`,
          );
        }
      } else {
        const material = await tools.hash(account.password);
        await client.query(
          'INSERT INTO access_control.password_credential(user_id,salt_hex,derived_key_hex) VALUES($1,$2,$3)',
          [row.user_id, material.salt_hex, material.derived_key_hex],
        );
      }
    }
    const userFor = (subject: string) => {
      const id = users.get(subject);
      if (!id) throw new MigrationError(`No pilot account for ${subject}`);
      return id;
    };
    const assignRole = (user: string, role: string) =>
      client.query(
        'INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [institutionId, user, role],
      );

    for (const student of data.students) {
      const user = userFor(student.subject);
      await assignRole(user, 'student');
      const studentId = pilotId(`student:${student.usn}`);
      await client.query('SELECT academic.register_student($1,$2,$3,$4,$5::smallint,$6)', [
        studentId,
        institutionId,
        pilotId(`programme:${student.programme}`),
        student.usn,
        student.admissionYear,
        user,
      ]);
      const enrolmentId = pilotId(`enrolment:${student.usn}`);
      await ensure(
        client,
        `enrolment ${student.usn}`,
        'INSERT INTO academic.enrolment(enrolment_id,student_id,offering_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [enrolmentId, studentId, offeringId(student.offering)],
        'SELECT student_id,offering_id FROM academic.enrolment WHERE enrolment_id=$1',
        [enrolmentId],
        { student_id: studentId, offering_id: offeringId(student.offering) },
      );
    }

    const subjectByKey = new Map(data.staff.map((member) => [member.key, member.subject]));
    for (const member of data.staff) {
      const user = userFor(member.subject);
      for (const role of member.roles) await assignRole(user, role);
      for (const duty of member.offeringDuties) {
        await client.query(
          'INSERT INTO pilot.offering_duty VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [offeringId(duty.offering), user, duty.duty],
        );
      }
      for (const duty of member.departmentDuties) {
        if (duty.term !== TERM.code) throw conflict(`duty term for ${member.key}`);
        await client.query(
          'INSERT INTO pilot.department_duty VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [departmentId(duty.department), termId, user, duty.duty],
        );
      }
      // Migration 0016 models roster delegations only; other delegated tasks arrive with T3/T4.
      for (const [index, delegation] of member.delegations.entries()) {
        if (!delegation.tasks.includes('reconcile_roster')) continue;
        const grantor = userFor(subjectByKey.get(delegation.grantor) ?? '');
        for (const department of delegation.departments) {
          await client.query(
            `INSERT INTO pilot.roster_delegation(delegation_id,department_id,term_id,grantor_id,grantee_id,valid_during)
             VALUES($1,$2,$3,$4,$5,tstzrange($6,$7,'[)')) ON CONFLICT DO NOTHING`,
            [
              pilotId(`delegation:${member.key}:${index}:${department}`),
              departmentId(department),
              termId,
              grantor,
              user,
              delegation.validFrom,
              delegation.validUntil,
            ],
          );
        }
      }
    }

    const counts = (
      await client.query<Record<keyof PilotFixture['counts'], string>>(
        `SELECT
          (SELECT count(*) FROM academic.role_assignment WHERE institution_id=$1 AND role_code='student') AS students,
          (SELECT count(DISTINCT user_id) FROM academic.role_assignment WHERE institution_id=$1) AS accounts,
          (SELECT count(*) FROM academic.enrolment e JOIN pilot.offering_department USING(offering_id)
            JOIN pilot.department d USING(department_id) WHERE d.institution_id=$1) AS enrolments,
          (SELECT count(*) FROM pilot.offering_duty a JOIN pilot.offering_department USING(offering_id)
            JOIN pilot.department d USING(department_id) WHERE d.institution_id=$1) AS "offeringDuties",
          (SELECT count(*) FROM pilot.department_duty a JOIN pilot.department d USING(department_id)
            WHERE d.institution_id=$1) AS "departmentDuties",
          (SELECT count(*) FROM pilot.roster_delegation a JOIN pilot.department d USING(department_id)
            WHERE d.institution_id=$1) AS "rosterDelegations",
          (SELECT count(*) FROM assessment.offering_policy p JOIN pilot.offering_department USING(offering_id)
            JOIN pilot.department d USING(department_id) WHERE d.institution_id=$1) AS "offeringPolicies"`,
        [institutionId],
      )
    ).rows[0]!;
    await client.query('COMMIT');
    return {
      institutionId,
      termId,
      offerings: Object.fromEntries(
        data.offerings.map((o) => [o.key, offeringId(o.key)]),
      ) as Record<SectionKey, string>,
      counts: {
        accounts: Number(counts.accounts),
        students: Number(counts.students),
        enrolments: Number(counts.enrolments),
        offeringDuties: Number(counts.offeringDuties),
        departmentDuties: Number(counts.departmentDuties),
        rosterDelegations: Number(counts.rosterDelegations),
        offeringPolicies: Number(counts.offeringPolicies),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
