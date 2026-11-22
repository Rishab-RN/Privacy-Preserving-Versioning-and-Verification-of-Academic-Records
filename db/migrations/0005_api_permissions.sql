-- Reject unsafe reuse rather than altering pre-existing role memberships or grants.
DO $$
DECLARE
  group_name text;
  group_oid oid;
BEGIN
  BEGIN
    CREATE ROLE scholarproof_api_access
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  FOREACH group_name IN ARRAY ARRAY['scholarproof_runtime', 'scholarproof_api_access'] LOOP
    SELECT oid INTO STRICT group_oid FROM pg_roles WHERE rolname = group_name;
    IF EXISTS (
      SELECT 1 FROM pg_roles WHERE oid = group_oid
        AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) OR EXISTS (
      SELECT 1 FROM pg_auth_members WHERE member = group_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = group_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace
      WHERE nspname IN ('academic', 'access_control', 'evidence')
        AND (nspowner = group_oid OR has_schema_privilege(group_oid, oid, 'CREATE'))
    ) OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('academic', 'access_control', 'evidence') AND c.relowner = group_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('academic', 'access_control', 'evidence') AND p.proowner = group_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'academic' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (has_table_privilege(group_oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(group_oid, c.oid, 'INSERT,UPDATE,REFERENCES'))
    ) OR has_function_privilege(group_oid,
      'academic.append_grade_version(uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'Existing % has incompatible privileges or memberships; no grants were altered', group_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- A reused API group may have exactly the writes granted below, but cannot
  -- retain credential-write access or update session/evidence identity columns.
  SELECT oid INTO STRICT group_oid FROM pg_roles WHERE rolname = 'scholarproof_api_access';
  IF has_table_privilege(group_oid, 'access_control.password_credential',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR has_any_column_privilege(group_oid, 'access_control.password_credential', 'INSERT,UPDATE,REFERENCES')
    OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname, c.relname) IN (('access_control', 'api_session'), ('evidence', 'reference'))
        AND has_table_privilege(group_oid, c.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    ) OR EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND ((n.nspname = 'access_control' AND c.relname = 'api_session' AND a.attname <> 'revoked_at')
          OR (n.nspname = 'evidence' AND c.relname = 'reference' AND a.attname <> 'state'))
        AND has_column_privilege(group_oid, c.oid, a.attnum, 'UPDATE')
    ) THEN
    RAISE EXCEPTION 'Existing scholarproof_api_access has incompatible mutable-data privileges; no grants were altered'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA academic, access_control, evidence TO scholarproof_api_access;
GRANT SELECT ON TABLE
  academic.institution, academic.app_user, academic.role_assignment, academic.student,
  academic.enrolment, academic.course_offering, academic.course, academic.grade_record,
  academic.grade_version, academic.grade_temporal_segment
  TO scholarproof_api_access;
GRANT EXECUTE ON FUNCTION academic.transcript_as_of(uuid, timestamptz, timestamptz)
  TO scholarproof_api_access;

GRANT SELECT ON access_control.password_credential TO scholarproof_api_access;
GRANT SELECT, INSERT ON access_control.api_session TO scholarproof_api_access;
GRANT UPDATE (revoked_at) ON access_control.api_session TO scholarproof_api_access;
GRANT SELECT, INSERT ON evidence.reference TO scholarproof_api_access;
GRANT UPDATE (state) ON evidence.reference TO scholarproof_api_access;

COMMENT ON ROLE scholarproof_api_access IS
  'Non-owner API group: academic reads, credential verification, session creation/revocation and bounded evidence metadata. API code enforces tenant/subject scope; no academic writes or RLS guarantee.';
