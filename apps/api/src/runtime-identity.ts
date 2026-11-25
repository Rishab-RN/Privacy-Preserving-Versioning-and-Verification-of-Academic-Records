import type { Db } from 'mongodb';
import type { Sql } from './repository.js';
import { EVIDENCE_COLLECTION } from './evidence-store.js';
import { privacyFunctions } from './privacy-runtime.js';

export async function assertSafeSqlIdentity(sql: Sql): Promise<void> {
  try {
    const result = await sql.query<{ safe: boolean }>(
      `
      WITH identities AS (
        SELECT r.*, r.rolname=current_user AS is_login
        FROM pg_roles r WHERE r.rolname IN (current_user, 'scholarproof_api_access')
      )
      SELECT count(*)=2 AND bool_and(
        rolcanlogin=is_login AND rolinherit AND rolconfig IS NULL
        AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      )
      AND (SELECT count(*) FROM pg_auth_members m JOIN identities i ON i.oid=m.member
           WHERE i.is_login)=1
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members m JOIN identities i ON i.oid=m.member
        WHERE NOT i.is_login OR m.admin_option OR NOT m.inherit_option
          OR m.roleid IS DISTINCT FROM (SELECT oid FROM identities WHERE NOT is_login)
      )
      AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba IN (SELECT oid FROM identities))
      AND NOT EXISTS (SELECT 1 FROM identities i WHERE has_database_privilege(i.oid,current_database(),'CREATE'))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner IN (SELECT oid FROM identities))
      AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner IN (SELECT oid FROM identities))
      AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner IN (SELECT oid FROM identities))
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace n CROSS JOIN identities i
        WHERE has_schema_privilege(i.oid,n.oid,'CREATE')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN identities i
        WHERE n.nspname='academic' AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(i.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(i.oid,c.oid,'INSERT,UPDATE,REFERENCES'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN identities i
        WHERE n.nspname IN ('workflow','transparency','credential','privacy','provenance') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(i.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(i.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN identities i
        WHERE n.nspname IN ('transparency','credential','privacy','provenance') AND has_function_privilege(i.oid,p.oid,'EXECUTE')
          AND p.oid NOT IN(SELECT to_regprocedure(name)::oid FROM unnest($1::text[]) name WHERE to_regprocedure(name) IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM identities i WHERE has_function_privilege(i.oid,
          'academic.append_grade_version(uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)','EXECUTE')
          OR has_function_privilege(i.oid,
          'academic.register_student(uuid,uuid,uuid,text,smallint,uuid)','EXECUTE')
      )
      AND NOT EXISTS (
        SELECT 1 FROM identities i
        WHERE has_table_privilege(i.oid,'access_control.password_credential',
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(i.oid,'access_control.password_credential','INSERT,UPDATE,REFERENCES')
      )
      AND NOT EXISTS (
        SELECT 1 FROM identities i CROSS JOIN unnest(ARRAY[
          'access_control.password_credential_context','evidence.reference_context'
        ]) AS projection(name)
        WHERE has_table_privilege(i.oid,projection.name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(i.oid,projection.name,'INSERT,UPDATE,REFERENCES')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN identities i
        WHERE (n.nspname,c.relname) IN (('access_control','api_session'),('evidence','reference'))
          AND has_table_privilege(i.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN identities i
        WHERE a.attnum>0 AND NOT a.attisdropped
          AND ((n.nspname='access_control' AND c.relname='api_session' AND a.attname<>'revoked_at')
            OR (n.nspname='evidence' AND c.relname='reference' AND a.attname<>'state'))
          AND has_column_privilege(i.oid,c.oid,a.attnum,'UPDATE')
      )
      AND (
        SELECT has_schema_privilege(i.oid,'academic','USAGE')
          AND has_schema_privilege(i.oid,'access_control','USAGE')
          AND has_schema_privilege(i.oid,'evidence','USAGE')
          AND has_table_privilege(i.oid,'access_control.password_credential','SELECT')
          AND has_table_privilege(i.oid,'access_control.password_credential_context','SELECT')
          AND has_table_privilege(i.oid,'access_control.api_session','SELECT')
          AND has_table_privilege(i.oid,'access_control.api_session','INSERT')
          AND has_column_privilege(i.oid,'access_control.api_session','revoked_at','UPDATE')
          AND has_table_privilege(i.oid,'evidence.reference','SELECT')
          AND has_table_privilege(i.oid,'evidence.reference_context','SELECT')
          AND has_table_privilege(i.oid,'evidence.reference','INSERT')
          AND has_column_privilege(i.oid,'evidence.reference','state','UPDATE')
          AND has_function_privilege(i.oid,'academic.transcript_as_of(uuid,timestamptz,timestamptz)','EXECUTE')
          AND has_schema_privilege(i.oid,'workflow','USAGE')
          AND has_function_privilege(i.oid,'workflow.propose_change(text,uuid,uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)','EXECUTE')
          AND has_function_privilege(i.oid,'workflow.approve_change(text,uuid,text)','EXECUTE')
          AND has_function_privilege(i.oid,'workflow.reject_change(text,uuid,text)','EXECUTE')
          AND has_function_privilege(i.oid,'workflow.get_change(text,uuid)','EXECUTE')
          AND NOT has_function_privilege(i.oid,'workflow.claim_deliveries(integer,integer)','EXECUTE')
          AND NOT EXISTS (
            SELECT 1 FROM unnest(ARRAY[
              'academic.institution','academic.app_user','academic.role_assignment','academic.student',
              'academic.enrolment','academic.course_offering','academic.course','academic.grade_record',
              'academic.grade_version','academic.grade_temporal_segment'
            ]) AS required_table(name) WHERE NOT has_table_privilege(i.oid,required_table.name,'SELECT')
          )
        FROM identities i WHERE i.is_login
      ) AS safe FROM identities
    `,
      [[...privacyFunctions, 'provenance.review_head(text,uuid)']],
    );
    if (result.rows[0]?.safe !== true) throw new Error();
  } catch {
    throw new Error('API PostgreSQL permissions could not be verified as safe');
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function assertSafeMongoIdentity(db: Db): Promise<void> {
  try {
    if (['admin', 'config', 'local'].includes(db.databaseName)) throw new Error();
    const status = await db.command({ connectionStatus: 1, showPrivileges: true });
    const auth = record(status.authInfo);
    const users = auth?.authenticatedUsers;
    const privileges = auth?.authenticatedUserPrivileges;
    if (!Array.isArray(users) || users.length !== 1 || !Array.isArray(privileges))
      throw new Error();
    const user = record(users[0]);
    if (typeof user?.user !== 'string' || user.user.length === 0 || user.db !== db.databaseName) {
      throw new Error();
    }
    const collectionActions = new Set<string>();
    const databaseActions = new Set<string>();
    for (const value of privileges) {
      const privilege = record(value);
      const resource = record(privilege?.resource);
      const actions = privilege?.actions;
      if (
        !resource ||
        Object.keys(resource).length !== 2 ||
        !Object.hasOwn(resource, 'db') ||
        !Object.hasOwn(resource, 'collection') ||
        resource.db !== db.databaseName ||
        !Array.isArray(actions) ||
        actions.length === 0
      )
        throw new Error();
      if (resource.collection === EVIDENCE_COLLECTION) {
        for (const action of actions) {
          if (action !== 'find' && action !== 'insert') throw new Error();
          collectionActions.add(action);
        }
      } else if (resource.collection === '') {
        for (const action of actions) {
          if (action !== 'listCollections') throw new Error();
          databaseActions.add(action);
        }
      } else throw new Error();
    }
    if (
      !collectionActions.has('find') ||
      !collectionActions.has('insert') ||
      !databaseActions.has('listCollections')
    ) {
      throw new Error();
    }
  } catch {
    throw new Error('API MongoDB permissions could not be verified as safe');
  }
}
