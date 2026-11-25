import type { Client } from 'pg';
import type { Db } from 'mongodb';

export async function assertLogSqlIdentity(sql: Pick<Client, 'query'>): Promise<void> {
  const result = await sql.query<{ safe: boolean }>(`SELECT
    r.rolcanlogin AND r.rolinherit AND r.rolconfig IS NULL
    AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND (SELECT count(*) FROM pg_auth_members WHERE member=r.oid)=1
    AND EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid
      WHERE m.member=r.oid AND p.rolname='academic_log_signer'
        AND NOT m.admin_option AND m.inherit_option)
    AND (SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.member WHERE g.rolname='academic_log_signer')=1
    AND EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.member JOIN pg_roles p ON p.oid=m.roleid
      WHERE g.rolname='academic_log_signer' AND p.rolname='academic_log_reader' AND NOT m.admin_option AND m.inherit_option)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.member WHERE g.rolname='academic_log_reader')
    AND (SELECT count(*) FROM pg_roles g WHERE g.rolname IN ('academic_log_signer','academic_log_reader')
      AND NOT g.rolcanlogin AND g.rolinherit AND g.rolconfig IS NULL
      AND NOT(g.rolsuper OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication OR g.rolbypassrls))=2
    AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
    AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid OR has_schema_privilege(r.oid,oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('academic','access_control','evidence','workflow','transparency','credential','privacy')
        AND c.relkind IN ('r','p','v','m','f') AND
        (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
         OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')
         OR (n.nspname IN ('access_control','credential','privacy') AND (has_table_privilege(r.oid,c.oid,'SELECT') OR has_any_column_privilege(r.oid,c.oid,'SELECT')))))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('academic','access_control','evidence','workflow','transparency','credential','privacy')
        AND has_function_privilege(r.oid,p.oid,'EXECUTE')
        AND p.oid<>coalesce(to_regprocedure('transparency.record_checkpoint(uuid,bigint,bytea,timestamptz,text,bytea)'),0)
        AND p.oid<>coalesce(to_regprocedure('transparency.read_expected_event(uuid)'),0)
        AND p.oid<>coalesce(to_regprocedure('workflow.iso(timestamptz)'),0))
    AND has_table_privilege(r.oid,'transparency.event_position','SELECT')
    AND has_function_privilege(r.oid,'transparency.record_checkpoint(uuid,bigint,bytea,timestamptz,text,bytea)','EXECUTE')
    AS safe FROM pg_roles r WHERE r.rolname=current_user`);
  if (result.rows[0]?.safe !== true) throw new Error('Unsafe transparency SQL identity');
}

export async function assertLogMongoIdentity(db: Db): Promise<void> {
  const status = await db.command({ connectionStatus: 1, showPrivileges: true });
  const auth = status.authInfo as {
    authenticatedUsers?: { user: string; db: string }[];
    authenticatedUserPrivileges?: { resource: Record<string, unknown>; actions: string[] }[];
  };
  if (auth.authenticatedUsers?.length !== 1 || auth.authenticatedUsers[0]?.db !== db.databaseName)
    throw new Error('Unsafe log MongoDB identity');
  const expected = new Set([
    'evidence_documents',
    'workflow_events',
    'grade_revisions',
    'grade_revision_heads',
  ]);
  const found = new Set<string>();
  for (const p of auth.authenticatedUserPrivileges ?? []) {
    if (
      Object.keys(p.resource).length !== 2 ||
      p.resource.db !== db.databaseName ||
      typeof p.resource.collection !== 'string' ||
      !expected.has(p.resource.collection) ||
      p.actions.some((a) => a !== 'find')
    )
      throw new Error('Unsafe log MongoDB grants');
    if (p.actions.includes('find')) found.add(p.resource.collection);
  }
  if ([...expected].some((name) => !found.has(name)))
    throw new Error('Missing log evidence read privilege');
}
