-- Group role only: application login/password provisioning is a later access stage.
DO $$
BEGIN
  BEGIN
    CREATE ROLE scholarproof_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'scholarproof_runtime'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Existing scholarproof_runtime role has incompatible privileges; no role was altered'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA academic FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA academic FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA academic FROM PUBLIC;

GRANT USAGE ON SCHEMA academic TO scholarproof_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA academic TO scholarproof_runtime;
GRANT EXECUTE ON FUNCTION academic.transcript_as_of(uuid, timestamptz, timestamptz)
  TO scholarproof_runtime;

-- Do not automatically grant future write functions or tables to a runtime role.
ALTER DEFAULT PRIVILEGES IN SCHEMA academic REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMENT ON ROLE scholarproof_runtime IS
  'Non-owner read-only group for Week 2. API identity, tenant authorization, writer roles and RLS remain later work.';
