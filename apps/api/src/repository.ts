import type { Pool } from 'pg';
import type { PasswordMaterial } from './security.js';

export type Sql = Pick<Pool, 'query'>;
export interface Principal {
  userId: string;
  subject: string;
  students: { studentId: string; institutionId: string }[];
  roles: { institutionId: string; role: 'registrar' | 'examiner' | 'student' | 'auditor' }[];
}
export interface EvidenceReference {
  evidence_id: string;
  institution_id: string;
  record_id: string;
  submitted_by: string;
  request_key: string;
  category: string;
  document_schema_version: number;
  digest_sha256: string;
  size_bytes: number;
  state: 'pending' | 'available';
  created_at: string;
}

// Re-evaluate live institutional/subject permissions inside each resource query.
const scope = (student = 's', auditor = false, registrarOnly = false) => `EXISTS (
  SELECT 1 FROM academic.role_assignment ra JOIN academic.app_user u ON u.user_id=ra.user_id
  WHERE ra.user_id=$1 AND u.account_state='active' AND ra.institution_id=${student}.institution_id
  AND (ra.role_code IN ('registrar'${auditor ? ", 'auditor'" : ''})
       ${registrarOnly ? '' : `OR (ra.role_code='student' AND ${student}.user_id=$1)`}))`;
const columns = 'r.*, r.created_at::text AS created_at';

export class Repository {
  constructor(readonly sql: Sql) {}
  async credential(subject: string) {
    const result = await this.sql.query<
      PasswordMaterial & { user_id: string; account_state: string }
    >(
      `SELECT c.profile,c.salt_hex,c.derived_key_hex,u.user_id,u.account_state
       FROM access_control.password_credential c JOIN academic.app_user u USING(user_id) WHERE u.auth_subject=$1`,
      [subject],
    );
    return result.rows[0];
  }
  async createSession(userId: string, digest: string) {
    const result = await this.sql.query<{ expires_at: string }>(
      `INSERT INTO access_control.api_session(token_digest,user_id)
       SELECT $1,user_id FROM academic.app_user WHERE user_id=$2 AND account_state='active'
       RETURNING expires_at::text`,
      [digest, userId],
    );
    return result.rows[0]?.expires_at;
  }
  async principal(digest: string): Promise<Principal | null> {
    const user = await this.sql.query<{ user_id: string; auth_subject: string }>(
      `SELECT u.user_id,u.auth_subject FROM access_control.api_session a
       JOIN academic.app_user u USING(user_id) WHERE a.token_digest=$1 AND a.revoked_at IS NULL
       AND a.expires_at>clock_timestamp() AND u.account_state='active'`,
      [digest],
    );
    const row = user.rows[0];
    if (!row) return null;
    const roles = await this.sql.query<{
      institutionId: string;
      role: Principal['roles'][number]['role'];
    }>(
      'SELECT institution_id AS "institutionId",role_code AS role FROM academic.role_assignment WHERE user_id=$1 ORDER BY institution_id,role_code',
      [row.user_id],
    );
    const students = await this.sql.query<{ studentId: string; institutionId: string }>(
      `SELECT s.student_id AS "studentId",s.institution_id AS "institutionId" FROM academic.student s
       WHERE s.user_id=$1 AND EXISTS(SELECT 1 FROM academic.role_assignment ra
         WHERE ra.user_id=$1 AND ra.institution_id=s.institution_id AND ra.role_code='student')`,
      [row.user_id],
    );
    return {
      userId: row.user_id,
      subject: row.auth_subject,
      roles: roles.rows,
      students: students.rows,
    };
  }
  async revoke(digest: string) {
    await this.sql.query(
      'UPDATE access_control.api_session SET revoked_at=clock_timestamp() WHERE token_digest=$1 AND revoked_at IS NULL',
      [digest],
    );
  }
  async transcript(userId: string, studentId: string, knownAt: string, effectiveAt: string) {
    const result = await this.sql.query(
      `SELECT s.student_id,t.record_id,t.version_no,t.course_code,t.credits,t.grade_points,t.outcome,
              to_char(t.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,t.valid_during::text AS valid_during
       FROM academic.student s LEFT JOIN LATERAL academic.transcript_as_of(s.student_id,$3,$4) t ON true
       WHERE s.student_id=$2 AND ${scope('s', true)} LIMIT 501`,
      [userId, studentId, knownAt, effectiveAt],
    );
    if (!result.rowCount) return null;
    return result.rows
      .filter((row) => row.record_id !== null)
      .map(({ student_id: _student, ...row }) => row);
  }
  async record(userId: string, recordId: string, registrarOnly = false) {
    const result = await this.sql.query<{
      institution_id: string;
      latest_recorded_version: number;
    }>(
      `SELECT gr.institution_id,coalesce(gr.latest_version_no,0) AS latest_recorded_version
       FROM academic.grade_record gr JOIN academic.enrolment e USING(enrolment_id)
       JOIN academic.student s USING(student_id) WHERE gr.record_id=$2 AND ${scope('s', false, registrarOnly)}`,
      [userId, recordId],
    );
    return result.rows[0] ?? null;
  }
  async reserve(reference: Omit<EvidenceReference, 'created_at' | 'state'>) {
    await this.sql.query(
      `INSERT INTO evidence.reference
      (evidence_id,institution_id,record_id,submitted_by,request_key,category,document_schema_version,digest_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(submitted_by,request_key) DO NOTHING`,
      [
        reference.evidence_id,
        reference.institution_id,
        reference.record_id,
        reference.submitted_by,
        reference.request_key,
        reference.category,
        reference.document_schema_version,
        reference.digest_sha256,
        reference.size_bytes,
      ],
    );
    const result = await this.sql.query<EvidenceReference>(
      `SELECT ${columns} FROM evidence.reference r WHERE r.submitted_by=$1 AND r.request_key=$2`,
      [reference.submitted_by, reference.request_key],
    );
    return result.rows[0]!;
  }
  async evidence(userId: string, evidenceId: string) {
    const result = await this.sql.query<EvidenceReference>(
      `SELECT ${columns} FROM evidence.reference r JOIN academic.grade_record gr ON gr.record_id=r.record_id
       JOIN academic.enrolment e ON e.enrolment_id=gr.enrolment_id JOIN academic.student s USING(student_id)
       WHERE r.evidence_id=$2 AND ${scope()}`,
      [userId, evidenceId],
    );
    return result.rows[0] ?? null;
  }
  async available(id: string) {
    await this.sql.query(
      "UPDATE evidence.reference SET state='available' WHERE evidence_id=$1 AND state='pending'",
      [id],
    );
  }
}
