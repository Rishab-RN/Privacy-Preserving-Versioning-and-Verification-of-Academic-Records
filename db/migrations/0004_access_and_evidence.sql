-- Authentication and evidence metadata. The migration runner supplies the transaction.
CREATE SCHEMA access_control;
CREATE SCHEMA evidence;

CREATE TABLE access_control.password_credential (
  user_id uuid PRIMARY KEY REFERENCES academic.app_user(user_id),
  profile text NOT NULL DEFAULT 'scrypt-v1' CHECK (profile = 'scrypt-v1'),
  salt_hex text NOT NULL CHECK (salt_hex ~ '^[a-f0-9]{32}$'),
  derived_key_hex text NOT NULL CHECK (derived_key_hex ~ '^[a-f0-9]{128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at))
);

CREATE TABLE access_control.api_session (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES academic.app_user(user_id),
  -- Both defaults use the same statement clock, preserving the exact hour bound.
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '1 hour',
  revoked_at timestamptz,
  CHECK (isfinite(created_at) AND isfinite(expires_at)
    AND expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= created_at))
);

CREATE INDEX api_session_user_idx ON access_control.api_session(user_id);
CREATE INDEX api_session_expiry_idx ON access_control.api_session(expires_at);

CREATE FUNCTION access_control.guard_session_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, access_control
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Session identity and lifetime are immutable; revocation is one-way'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER api_session_update_guard
BEFORE UPDATE ON access_control.api_session
FOR EACH ROW EXECUTE FUNCTION access_control.guard_session_update();

CREATE TABLE evidence.reference (
  evidence_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  record_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES academic.app_user(user_id),
  request_key uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('supporting_note', 'revaluation_request')),
  document_schema_version integer NOT NULL DEFAULT 1 CHECK (document_schema_version = 1),
  digest_sha256 text NOT NULL CHECK (digest_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 65536),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'available')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  FOREIGN KEY (institution_id, record_id)
    REFERENCES academic.grade_record(institution_id, record_id),
  UNIQUE (submitted_by, request_key)
);

CREATE INDEX evidence_reference_record_idx ON evidence.reference(institution_id, record_id);

CREATE FUNCTION evidence.guard_reference_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, evidence
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'New evidence must begin in the pending state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence metadata is immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'pending' OR NEW.state <> 'available'
    OR (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'Evidence metadata permits only the pending-to-available transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_reference_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON evidence.reference
FOR EACH ROW EXECUTE FUNCTION evidence.guard_reference_change();

REVOKE ALL ON SCHEMA access_control, evidence FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA access_control, evidence FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA access_control, evidence FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA access_control, evidence REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMENT ON TABLE access_control.password_credential IS
  'Versioned scrypt parameters are defined by the application profile. Passwords and session bearer tokens are never stored here.';
COMMENT ON TABLE evidence.reference IS
  'SQL owns scoped immutable metadata/digests and delivery state; MongoDB owns the bounded document payload. Pending is not a completed cross-store transaction.';
