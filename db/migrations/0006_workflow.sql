-- Prototype policy: one registrar proposes, a different registrar approves/applies.
-- SQL owns decisions and durable event delivery. No credential is published here.
CREATE SCHEMA workflow;

DO $$
DECLARE role_name text; role_id oid;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['scholarproof_workflow_owner','scholarproof_worker_access'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    SELECT oid INTO STRICT role_id FROM pg_roles WHERE rolname=role_name;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=role_id AND
      (rolcanlogin OR NOT rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolconfig IS NOT NULL))
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_id)
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=role_id)
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=role_id OR
        (nspname IN ('academic','access_control','evidence','workflow') AND has_schema_privilege(role_id,oid,'CREATE')))
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=role_id)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=role_id)
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('academic','access_control','evidence') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(role_id,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(role_id,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
      OR has_function_privilege(role_id,
        'academic.append_grade_version(uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)','EXECUTE') THEN
      RAISE EXCEPTION 'Existing workflow role has incompatible flags or memberships' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    JOIN pg_roles member_role ON member_role.oid=m.member
    WHERE parent.rolname='scholarproof_workflow_owner' AND member_role.rolname IN
      ('scholarproof_api_access','scholarproof_worker_access')) THEN
    RAISE EXCEPTION 'Application roles cannot inherit the workflow owner' USING ERRCODE='42501';
  END IF;
END;
$$;

ALTER TABLE evidence.reference ADD CONSTRAINT evidence_reference_record_identity UNIQUE(evidence_id,record_id);

CREATE TABLE workflow.change_request (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES academic.grade_record(record_id),
  proposer_id uuid NOT NULL REFERENCES academic.app_user(user_id),
  idempotency_key uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>=0),
  grade_points numeric CHECK(grade_points>=0 AND grade_points<=10 AND grade_points=round(grade_points,2)),
  outcome text NOT NULL CHECK(outcome IN ('passed','failed','withdrawn','incomplete')),
  valid_during tstzrange NOT NULL CHECK(NOT isempty(valid_during) AND NOT lower_inf(valid_during)
    AND isfinite(lower(valid_during)) AND lower_inc(valid_during) AND NOT upper_inc(valid_during)
    AND (upper_inf(valid_during) OR isfinite(upper(valid_during)))),
  reason text NOT NULL CHECK(length(reason)<=500 AND length(btrim(reason))>=1),
  evidence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
  UNIQUE(proposer_id,idempotency_key),
  UNIQUE(request_id,record_id),
  FOREIGN KEY(evidence_id,record_id) REFERENCES evidence.reference(evidence_id,record_id),
  CHECK((outcome IN ('passed','failed') AND grade_points IS NOT NULL)
    OR (outcome IN ('withdrawn','incomplete') AND grade_points IS NULL))
);

CREATE TABLE workflow.decision (
  request_id uuid PRIMARY KEY,
  record_id uuid NOT NULL,
  decision_code text NOT NULL CHECK(decision_code IN ('approved','rejected')),
  decider_id uuid NOT NULL REFERENCES academic.app_user(user_id),
  reason text NOT NULL CHECK(length(reason)<=500 AND length(btrim(reason))>=1),
  version_no integer,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(decided_at)),
  FOREIGN KEY(request_id,record_id) REFERENCES workflow.change_request(request_id,record_id),
  FOREIGN KEY(record_id,version_no) REFERENCES academic.grade_version(record_id,version_no),
  UNIQUE(record_id,version_no),
  CHECK((decision_code='approved' AND version_no IS NOT NULL AND version_no>0)
    OR (decision_code='rejected' AND version_no IS NULL))
);

CREATE TABLE workflow.domain_event (
  event_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  record_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('request.submitted','request.rejected','grade.accepted')),
  occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'
    AND payload ?& ARRAY['schemaVersion','eventId','kind','institutionId','recordId','requestId','actorId','occurredAt','proposerId','evidence','revision']
    AND jsonb_typeof(payload->'schemaVersion')='number' AND payload->>'schemaVersion'='1'
    AND payload->>'eventId'=event_id::text AND payload->>'recordId'=record_id::text
    AND payload->>'requestId'=request_id::text AND payload->>'kind'=kind
    AND jsonb_typeof(payload->'evidence')='object'
    AND ((kind='grade.accepted' AND jsonb_typeof(payload->'revision')='object')
      OR (kind<>'grade.accepted' AND jsonb_typeof(payload->'revision')='null'))),
  FOREIGN KEY(request_id,record_id) REFERENCES workflow.change_request(request_id,record_id),
  UNIQUE(request_id,kind)
);

CREATE TABLE workflow.outbox_delivery (
  event_id uuid NOT NULL REFERENCES workflow.domain_event(event_id),
  consumer text NOT NULL DEFAULT 'mongo-records-v1' CHECK(consumer='mongo-records-v1'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(next_attempt_at)),
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz CHECK(delivered_at IS NULL OR isfinite(delivered_at)),
  last_error_code text CHECK(last_error_code IN ('MONGO_UNAVAILABLE','PROJECTION_CONFLICT','INVALID_EVENT','WORKER_INTERRUPTED')),
  quarantined_at timestamptz CHECK(quarantined_at IS NULL OR isfinite(quarantined_at)),
  PRIMARY KEY(event_id,consumer),
  CHECK((lease_token IS NULL AND lease_until IS NULL) OR
    (lease_token IS NOT NULL AND lease_until IS NOT NULL AND isfinite(lease_until))),
  CHECK(delivered_at IS NULL OR (lease_token IS NULL AND quarantined_at IS NULL)),
  CHECK(quarantined_at IS NULL OR (lease_token IS NULL AND delivered_at IS NULL))
);

CREATE INDEX change_request_record_idx ON workflow.change_request(record_id,created_at);
CREATE INDEX domain_event_replay_idx ON workflow.domain_event(occurred_at,event_id);
CREATE INDEX outbox_due_idx ON workflow.outbox_delivery(next_attempt_at,event_id)
  WHERE delivered_at IS NULL AND quarantined_at IS NULL;

CREATE TRIGGER change_request_immutable BEFORE UPDATE OR DELETE ON workflow.change_request
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER decision_immutable BEFORE UPDATE OR DELETE ON workflow.decision
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER domain_event_immutable BEFORE UPDATE OR DELETE ON workflow.domain_event
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

CREATE FUNCTION workflow.guard_record_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF (NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.enrolment_id IS DISTINCT FROM OLD.enrolment_id
      OR NEW.institution_id IS DISTINCT FROM OLD.institution_id)
    AND EXISTS(SELECT 1 FROM workflow.change_request WHERE record_id=OLD.record_id) THEN
    RAISE EXCEPTION 'A proposed academic record cannot change identity' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_record_identity BEFORE UPDATE ON academic.grade_record
FOR EACH ROW EXECUTE FUNCTION workflow.guard_record_identity();

CREATE FUNCTION workflow.guard_offering_context() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF (NEW.offering_id IS DISTINCT FROM OLD.offering_id
    OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
    OR NEW.course_id IS DISTINCT FROM OLD.course_id
    OR NEW.term_id IS DISTINCT FROM OLD.term_id
    OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id
    OR NEW.credits IS DISTINCT FROM OLD.credits)
    AND EXISTS(SELECT 1 FROM workflow.change_request r
      JOIN academic.grade_record g ON g.record_id=r.record_id
      JOIN academic.enrolment e ON e.enrolment_id=g.enrolment_id
      WHERE e.offering_id=OLD.offering_id) THEN
    RAISE EXCEPTION 'A proposed offering cannot change academic policy or identity' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_offering_context BEFORE UPDATE ON academic.course_offering
FOR EACH ROW EXECUTE FUNCTION workflow.guard_offering_context();

REVOKE ALL ON SCHEMA workflow FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA workflow FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA workflow FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA workflow REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMENT ON TABLE workflow.domain_event IS
  'Immutable audit/provenance journal. UUIDs and timestamps are not a global commit order; future Neo4j/ML consumers can backfill retained events.';
COMMENT ON TABLE workflow.outbox_delivery IS
  'At-least-once delivery with expiring capability leases and safe errors. Quarantine counts failures, not lease expirations. No unimplemented consumer is marked delivered.';
