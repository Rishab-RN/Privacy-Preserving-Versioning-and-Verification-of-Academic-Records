-- Forward BCNF decomposition. Historical migrations remain immutable.
-- The runner executes this migration in one transaction under its migration lock.
-- The temporary audit records are not application relations and disappear at commit.
CREATE TEMP TABLE bcnf_migration_snapshot(relation_name text NOT NULL, payload jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE bcnf_wire_snapshot(relation_name text NOT NULL, payload jsonb NOT NULL) ON COMMIT DROP;

DO $$
DECLARE r record; removed text[];
BEGIN
  FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('academic','access_control','evidence','workflow') AND c.relkind='r'
  LOOP
    removed:=CASE r.nspname||'.'||r.relname
      WHEN 'academic.student' THEN ARRAY['programme_id']
      WHEN 'academic.course_offering' THEN ARRAY['institution_id']
      WHEN 'academic.enrolment' THEN ARRAY['institution_id']
      WHEN 'academic.grade_version' THEN ARRAY['institution_id','previous_version_no']
      WHEN 'academic.grade_temporal_segment' THEN ARRAY['institution_id']
      WHEN 'access_control.password_credential' THEN ARRAY['profile']
      WHEN 'evidence.reference' THEN ARRAY['institution_id','document_schema_version']
      WHEN 'workflow.change_request' THEN ARRAY['record_id']
      WHEN 'workflow.decision' THEN ARRAY['decision_code']
      WHEN 'workflow.domain_event' THEN ARRAY['record_id']
      WHEN 'workflow.outbox_delivery' THEN ARRAY['consumer']
      ELSE ARRAY[]::text[] END;
    EXECUTE format('INSERT INTO pg_temp.bcnf_migration_snapshot SELECT %L,to_jsonb(x)-$1 FROM %I.%I x',
      r.nspname||'.'||r.relname,r.nspname,r.relname) USING removed;
    IF cardinality(removed)>0 THEN
      EXECUTE format('INSERT INTO pg_temp.bcnf_wire_snapshot SELECT %L,to_jsonb(x) FROM %I.%I x',
        r.nspname||'.'||r.relname||'_context',r.nspname,r.relname);
    END IF;
  END LOOP;
END;
$$;

INSERT INTO pg_temp.bcnf_migration_snapshot
SELECT 'academic.student_programme',jsonb_build_object('student_id',student_id,'programme_id',programme_id)
FROM academic.student;

CREATE TABLE academic.student_programme (
  student_id uuid PRIMARY KEY REFERENCES academic.student(student_id) ON DELETE CASCADE,
  programme_id uuid NOT NULL REFERENCES academic.programme(programme_id)
);
INSERT INTO academic.student_programme(student_id,programme_id)
SELECT student_id,programme_id FROM academic.student;

-- Remove dependencies on the copied scope columns before decomposing them.
DROP VIEW academic.current_transcript;
ALTER TABLE academic.enrolment DROP CONSTRAINT enrolment_institution_id_offering_id_fkey;
ALTER TABLE academic.grade_record DROP CONSTRAINT grade_record_institution_id_enrolment_id_fkey;
ALTER TABLE academic.grade_temporal_segment DROP CONSTRAINT grade_temporal_segment_institution_id_record_id_version_no_fkey;
ALTER TABLE workflow.change_request DROP CONSTRAINT change_request_evidence_id_record_id_fkey;
ALTER TABLE workflow.decision DROP CONSTRAINT decision_request_id_record_id_fkey;
ALTER TABLE workflow.domain_event DROP CONSTRAINT domain_event_request_id_record_id_fkey;

ALTER TABLE academic.student DROP COLUMN programme_id;
ALTER TABLE academic.course_offering DROP COLUMN institution_id;
ALTER TABLE academic.enrolment DROP COLUMN institution_id;
ALTER TABLE academic.grade_version DROP COLUMN institution_id, DROP COLUMN previous_version_no;
ALTER TABLE academic.grade_temporal_segment DROP COLUMN institution_id;
ALTER TABLE access_control.password_credential DROP COLUMN profile;
ALTER TABLE evidence.reference DROP COLUMN institution_id, DROP COLUMN document_schema_version;
ALTER TABLE workflow.change_request DROP COLUMN record_id;
ALTER TABLE workflow.decision DROP COLUMN decision_code;
ALTER TABLE workflow.domain_event DROP COLUMN record_id;
ALTER TABLE workflow.outbox_delivery DROP COLUMN consumer;

ALTER TABLE academic.course_offering
  ADD CONSTRAINT course_offering_course_fk FOREIGN KEY(course_id) REFERENCES academic.course(course_id),
  ADD CONSTRAINT course_offering_term_fk FOREIGN KEY(term_id) REFERENCES academic.academic_term(term_id),
  ADD CONSTRAINT course_offering_scheme_fk FOREIGN KEY(scheme_id) REFERENCES academic.grading_scheme(scheme_id),
  ADD CONSTRAINT course_offering_business_key UNIQUE(course_id,term_id,section_code);
ALTER TABLE academic.enrolment
  ADD CONSTRAINT enrolment_student_fk FOREIGN KEY(student_id) REFERENCES academic.student(student_id),
  ADD CONSTRAINT enrolment_offering_fk FOREIGN KEY(offering_id) REFERENCES academic.course_offering(offering_id);
ALTER TABLE academic.grade_record
  ADD CONSTRAINT grade_record_enrolment_fk FOREIGN KEY(enrolment_id) REFERENCES academic.enrolment(enrolment_id);
ALTER TABLE academic.grade_version
  ADD CONSTRAINT grade_version_record_fk FOREIGN KEY(record_id) REFERENCES academic.grade_record(record_id);
ALTER TABLE academic.grade_temporal_segment
  ADD CONSTRAINT grade_segment_version_fk FOREIGN KEY(record_id,version_no)
    REFERENCES academic.grade_version(record_id,version_no),
  ADD CONSTRAINT grade_segment_no_bitemporal_overlap EXCLUDE USING gist
    (record_id WITH =,valid_during WITH &&,system_during WITH &&);
ALTER TABLE evidence.reference
  ADD CONSTRAINT evidence_reference_record_fk FOREIGN KEY(record_id) REFERENCES academic.grade_record(record_id);
ALTER TABLE workflow.change_request
  ADD CONSTRAINT change_request_evidence_fk FOREIGN KEY(evidence_id) REFERENCES evidence.reference(evidence_id);
ALTER TABLE workflow.decision
  ADD CONSTRAINT decision_request_fk FOREIGN KEY(request_id) REFERENCES workflow.change_request(request_id),
  ADD CONSTRAINT decision_version_result CHECK(version_no IS NULL OR version_no>0);
ALTER TABLE workflow.domain_event
  ADD CONSTRAINT domain_event_request_fk FOREIGN KEY(request_id) REFERENCES workflow.change_request(request_id),
  ADD CONSTRAINT domain_event_envelope CHECK(jsonb_typeof(payload)='object'
    AND payload ?& ARRAY['schemaVersion','eventId','kind','institutionId','recordId','requestId','actorId','occurredAt','proposerId','evidence','revision']
    AND payload->'schemaVersion' IS NOT DISTINCT FROM '1'::jsonb
    AND payload->>'eventId' IS NOT DISTINCT FROM event_id::text
    AND payload->>'requestId' IS NOT DISTINCT FROM request_id::text
    AND payload->>'kind' IS NOT DISTINCT FROM kind AND jsonb_typeof(payload->'evidence')='object'
    AND ((kind='grade.accepted' AND jsonb_typeof(payload->'revision')='object')
      OR (kind<>'grade.accepted' AND payload->'revision'='null'::jsonb)));
ALTER TABLE workflow.outbox_delivery ADD CONSTRAINT outbox_delivery_pkey PRIMARY KEY(event_id);

CREATE INDEX student_programme_programme_idx ON academic.student_programme(programme_id);
CREATE INDEX offering_term_normalized_idx ON academic.course_offering(term_id);
CREATE INDEX offering_scheme_normalized_idx ON academic.course_offering(scheme_id);
CREATE INDEX enrolment_student_normalized_idx ON academic.enrolment(student_id);
CREATE INDEX enrolment_offering_normalized_idx ON academic.enrolment(offering_id);
CREATE INDEX grade_segment_current_normalized_idx ON academic.grade_temporal_segment(record_id)
  WHERE upper_inf(system_during);
CREATE INDEX evidence_reference_record_normalized_idx ON evidence.reference(record_id);
CREATE INDEX change_request_evidence_idx ON workflow.change_request(evidence_id,created_at);

-- Read-only reconstruction views retain transport/adaptor shape without storing copies.
CREATE VIEW academic.student_context AS
SELECT s.student_id,s.institution_id,p.programme_id,s.user_id,s.student_code,s.admission_year,s.created_at
FROM academic.student s JOIN academic.student_programme p USING(student_id);
CREATE VIEW academic.course_offering_context AS
SELECT o.offering_id,c.institution_id,o.course_id,o.term_id,o.scheme_id,o.section_code,o.credits
FROM academic.course_offering o JOIN academic.course c USING(course_id);
CREATE VIEW academic.enrolment_context AS
SELECT e.enrolment_id,s.institution_id,e.student_id,e.offering_id,e.created_at
FROM academic.enrolment e JOIN academic.student s USING(student_id);
CREATE VIEW academic.grade_version_context AS
SELECT v.record_id,v.version_no,r.institution_id,
  CASE WHEN v.version_no=1 THEN NULL ELSE v.version_no-1 END AS previous_version_no,
  v.grade_points,v.outcome,v.valid_during,v.recorded_at,v.author_id,v.reason
FROM academic.grade_version v JOIN academic.grade_record r USING(record_id);
CREATE VIEW academic.grade_temporal_segment_context AS
SELECT s.segment_id,r.institution_id,s.record_id,s.version_no,s.valid_during,s.system_during
FROM academic.grade_temporal_segment s JOIN academic.grade_record r USING(record_id);
CREATE VIEW access_control.password_credential_context AS
SELECT user_id,'scrypt-v1'::text AS profile,salt_hex,derived_key_hex,created_at
FROM access_control.password_credential;
CREATE VIEW evidence.reference_context AS
SELECT e.evidence_id,r.institution_id,e.record_id,e.submitted_by,e.request_key,e.category,
  1::integer AS document_schema_version,e.digest_sha256,e.size_bytes,e.state,e.created_at
FROM evidence.reference e JOIN academic.grade_record r USING(record_id);
CREATE VIEW workflow.change_request_context AS
SELECT q.request_id,e.record_id,q.proposer_id,q.idempotency_key,q.expected_version,
  q.grade_points,q.outcome,q.valid_during,q.reason,q.evidence_id,q.created_at
FROM workflow.change_request q JOIN evidence.reference e USING(evidence_id);
CREATE VIEW workflow.decision_context AS
SELECT request_id,record_id,
  CASE WHEN version_no IS NULL THEN 'rejected'::text ELSE 'approved'::text END AS decision_code,
  decider_id,reason,version_no,decided_at FROM workflow.decision;
CREATE VIEW workflow.domain_event_context AS
SELECT d.event_id,d.request_id,q.record_id,d.kind,d.occurred_at,d.payload
FROM workflow.domain_event d JOIN workflow.change_request_context q USING(request_id);
CREATE VIEW workflow.outbox_delivery_context AS
SELECT event_id,'mongo-records-v1'::text AS consumer,attempt_count,failure_count,next_attempt_at,
  lease_token,lease_until,delivered_at,last_error_code,quarantined_at FROM workflow.outbox_delivery;

-- Parent ownership cannot move after a reference has been normalized away.
-- Identifier/tenant changes require a new entity rather than reassigning history.
CREATE FUNCTION academic.guard_stable_scope_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
BEGIN
  IF to_jsonb(NEW)->TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD)->TG_ARGV[0]
    OR NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
    RAISE EXCEPTION 'Academic identifiers and institutional ownership are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER programme_scope_identity BEFORE UPDATE ON academic.programme
FOR EACH ROW EXECUTE FUNCTION academic.guard_stable_scope_identity('programme_id');
CREATE TRIGGER student_scope_identity BEFORE UPDATE ON academic.student
FOR EACH ROW EXECUTE FUNCTION academic.guard_stable_scope_identity('student_id');
CREATE TRIGGER course_scope_identity BEFORE UPDATE ON academic.course
FOR EACH ROW EXECUTE FUNCTION academic.guard_stable_scope_identity('course_id');
CREATE TRIGGER term_scope_identity BEFORE UPDATE ON academic.academic_term
FOR EACH ROW EXECUTE FUNCTION academic.guard_stable_scope_identity('term_id');

CREATE FUNCTION academic.guard_student_programme_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE student_tenant uuid; programme_tenant uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'Student programme identity cannot be reassigned' USING ERRCODE='55000';
  END IF;
  SELECT institution_id INTO student_tenant FROM academic.student WHERE student_id=NEW.student_id FOR KEY SHARE;
  SELECT institution_id INTO programme_tenant FROM academic.programme WHERE programme_id=NEW.programme_id FOR KEY SHARE;
  IF student_tenant IS NULL OR programme_tenant IS NULL OR student_tenant<>programme_tenant THEN
    RAISE EXCEPTION 'Student and programme must belong to the same institution' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER student_programme_scope BEFORE INSERT OR UPDATE ON academic.student_programme
FOR EACH ROW EXECUTE FUNCTION academic.guard_student_programme_scope();

CREATE FUNCTION academic.require_student_programme() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE target uuid;
BEGIN
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.student_id ELSE NEW.student_id END;
  IF EXISTS(SELECT 1 FROM academic.student WHERE student_id=target)
    AND NOT EXISTS(SELECT 1 FROM academic.student_programme WHERE student_id=target) THEN
    RAISE EXCEPTION 'Every student requires exactly one programme assignment' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER student_programme_required AFTER INSERT OR UPDATE ON academic.student
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION academic.require_student_programme();
CREATE CONSTRAINT TRIGGER student_programme_retained AFTER DELETE OR UPDATE ON academic.student_programme
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION academic.require_student_programme();

CREATE FUNCTION academic.guard_offering_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE course_tenant uuid; term_tenant uuid; scheme_tenant uuid; prior_tenant uuid;
BEGIN
  SELECT institution_id INTO course_tenant FROM academic.course WHERE course_id=NEW.course_id FOR KEY SHARE;
  SELECT institution_id INTO term_tenant FROM academic.academic_term WHERE term_id=NEW.term_id FOR KEY SHARE;
  SELECT institution_id INTO scheme_tenant FROM academic.grading_scheme WHERE scheme_id=NEW.scheme_id FOR KEY SHARE;
  IF course_tenant IS NULL OR term_tenant IS NULL OR scheme_tenant IS NULL
    OR course_tenant<>term_tenant OR course_tenant<>scheme_tenant THEN
    RAISE EXCEPTION 'Offering course, term and scheme must share an institution' USING ERRCODE='23503';
  END IF;
  IF TG_OP='UPDATE' THEN
    SELECT institution_id INTO prior_tenant FROM academic.course WHERE course_id=OLD.course_id;
    IF NEW.offering_id IS DISTINCT FROM OLD.offering_id OR prior_tenant<>course_tenant THEN
      RAISE EXCEPTION 'Offering identity and institutional ownership are immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offering_scope BEFORE INSERT OR UPDATE ON academic.course_offering
FOR EACH ROW EXECUTE FUNCTION academic.guard_offering_scope();

CREATE FUNCTION academic.guard_enrolment_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE student_tenant uuid; course_tenant uuid;
BEGIN
  SELECT institution_id INTO student_tenant FROM academic.student WHERE student_id=NEW.student_id FOR KEY SHARE;
  SELECT c.institution_id INTO course_tenant FROM academic.course_offering o JOIN academic.course c USING(course_id)
    WHERE o.offering_id=NEW.offering_id FOR SHARE OF o;
  IF student_tenant IS NULL OR course_tenant IS NULL OR student_tenant<>course_tenant THEN
    RAISE EXCEPTION 'Student and offering must share an institution' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enrolment_scope BEFORE INSERT ON academic.enrolment
FOR EACH ROW EXECUTE FUNCTION academic.guard_enrolment_scope();

CREATE FUNCTION academic.guard_grade_record_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE tenant uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.record_id IS NOT DISTINCT FROM OLD.record_id
    AND NEW.enrolment_id IS NOT DISTINCT FROM OLD.enrolment_id
    AND NEW.institution_id IS NOT DISTINCT FROM OLD.institution_id THEN
    RETURN NEW;
  END IF;
  SELECT s.institution_id INTO tenant FROM academic.enrolment e JOIN academic.student s USING(student_id)
    WHERE e.enrolment_id=NEW.enrolment_id FOR KEY SHARE OF e;
  IF tenant IS NULL OR tenant IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'Grade record and enrolment must share an institution' USING ERRCODE='23503';
  END IF;
  IF TG_OP='UPDATE' AND
    (NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.enrolment_id IS DISTINCT FROM OLD.enrolment_id
      OR NEW.institution_id IS DISTINCT FROM OLD.institution_id)
    AND EXISTS(SELECT 1 FROM evidence.reference WHERE record_id=OLD.record_id) THEN
    RAISE EXCEPTION 'An evidence-bound record cannot change identity' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER grade_record_scope BEFORE INSERT OR UPDATE ON academic.grade_record
FOR EACH ROW EXECUTE FUNCTION academic.guard_grade_record_scope();

CREATE OR REPLACE FUNCTION academic.guard_grade_version() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE record_row academic.grade_record%ROWTYPE; prior_time timestamptz; policy_max numeric; policy_pass numeric;
BEGIN
  SELECT * INTO record_row FROM academic.grade_record WHERE record_id=NEW.record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Grade record does not exist' USING ERRCODE='23503'; END IF;
  IF NEW.version_no IS DISTINCT FROM coalesce(record_row.latest_version_no,0)+1 THEN
    RAISE EXCEPTION 'Grade versions must form a contiguous revision history' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM academic.app_user u JOIN academic.role_assignment ra ON ra.user_id=u.user_id
    WHERE u.user_id=NEW.author_id AND u.account_state='active' AND ra.institution_id=record_row.institution_id
      AND ra.role_code IN ('registrar','examiner')) THEN
    RAISE EXCEPTION 'Author is not active academic staff in this institution' USING ERRCODE='42501';
  END IF;
  SELECT gs.max_points,gs.pass_points INTO policy_max,policy_pass FROM academic.enrolment e
    JOIN academic.course_offering o USING(offering_id) JOIN academic.grading_scheme gs USING(scheme_id)
    WHERE e.enrolment_id=record_row.enrolment_id FOR SHARE OF o;
  IF NEW.grade_points IS NOT NULL AND (NEW.grade_points<0 OR NEW.grade_points>policy_max)
    OR NEW.outcome='passed' AND (NEW.grade_points IS NULL OR NEW.grade_points<policy_pass)
    OR NEW.outcome='failed' AND (NEW.grade_points IS NULL OR NEW.grade_points>=policy_pass) THEN
    RAISE EXCEPTION 'Grade points and outcome disagree with the referenced scheme' USING ERRCODE='23514';
  END IF;
  IF record_row.latest_version_no IS NOT NULL THEN
    SELECT recorded_at INTO prior_time FROM academic.grade_version
      WHERE record_id=NEW.record_id AND version_no=record_row.latest_version_no;
  END IF;
  NEW.recorded_at:=greatest(clock_timestamp(),prior_time+interval '1 microsecond');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION academic.project_grade_version() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE previous_segment academic.grade_temporal_segment%ROWTYPE; remainder tstzrange;
BEGIN
  FOR previous_segment IN SELECT * FROM academic.grade_temporal_segment
    WHERE record_id=NEW.record_id AND upper_inf(system_during) AND valid_during && NEW.valid_during FOR UPDATE
  LOOP
    UPDATE academic.grade_temporal_segment
      SET system_during=tstzrange(lower(previous_segment.system_during),NEW.recorded_at,'[)')
      WHERE segment_id=previous_segment.segment_id;
    FOR remainder IN SELECT unnest(tstzmultirange(previous_segment.valid_during)-tstzmultirange(NEW.valid_during)) LOOP
      INSERT INTO academic.grade_temporal_segment(record_id,version_no,valid_during,system_during)
      VALUES(previous_segment.record_id,previous_segment.version_no,remainder,tstzrange(NEW.recorded_at,NULL,'[)'));
    END LOOP;
  END LOOP;
  INSERT INTO academic.grade_temporal_segment(record_id,version_no,valid_during,system_during)
    VALUES(NEW.record_id,NEW.version_no,NEW.valid_during,tstzrange(NEW.recorded_at,NULL,'[)'));
  UPDATE academic.grade_record SET latest_version_no=NEW.version_no WHERE record_id=NEW.record_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION academic.freeze_used_offering() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM academic.enrolment e JOIN academic.grade_record g USING(enrolment_id)
    WHERE e.offering_id=OLD.offering_id AND g.latest_version_no IS NOT NULL)
    AND (TG_OP='DELETE' OR NEW.offering_id IS DISTINCT FROM OLD.offering_id
      OR NEW.course_id IS DISTINCT FROM OLD.course_id OR NEW.term_id IS DISTINCT FROM OLD.term_id
      OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id OR NEW.credits IS DISTINCT FROM OLD.credits) THEN
    RAISE EXCEPTION 'A grade-used offering cannot change academic policy or identity' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION workflow.guard_record_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF (NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.enrolment_id IS DISTINCT FROM OLD.enrolment_id
    OR NEW.institution_id IS DISTINCT FROM OLD.institution_id)
    AND EXISTS(SELECT 1 FROM workflow.change_request q JOIN evidence.reference e USING(evidence_id)
      WHERE e.record_id=OLD.record_id) THEN
    RAISE EXCEPTION 'A proposed academic record cannot change identity' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION workflow.guard_offering_context() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF (NEW.offering_id IS DISTINCT FROM OLD.offering_id OR NEW.course_id IS DISTINCT FROM OLD.course_id
    OR NEW.term_id IS DISTINCT FROM OLD.term_id OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id
    OR NEW.credits IS DISTINCT FROM OLD.credits)
    AND EXISTS(SELECT 1 FROM workflow.change_request q JOIN evidence.reference r USING(evidence_id)
      JOIN academic.grade_record g ON g.record_id=r.record_id JOIN academic.enrolment e USING(enrolment_id)
      WHERE e.offering_id=OLD.offering_id) THEN
    RAISE EXCEPTION 'A proposed offering cannot change academic policy or identity' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION workflow.guard_decision_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE target uuid;
BEGIN
  SELECT e.record_id INTO target FROM workflow.change_request q JOIN evidence.reference e USING(evidence_id)
    WHERE q.request_id=NEW.request_id;
  IF target IS NULL OR target IS DISTINCT FROM NEW.record_id THEN
    RAISE EXCEPTION 'Decision result must belong to its request record' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_scope BEFORE INSERT ON workflow.decision
FOR EACH ROW EXECUTE FUNCTION workflow.guard_decision_scope();
CREATE FUNCTION workflow.guard_domain_event_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE target uuid; tenant uuid;
BEGIN
  SELECT e.record_id,g.institution_id INTO target,tenant FROM workflow.change_request q
    JOIN evidence.reference e USING(evidence_id) JOIN academic.grade_record g USING(record_id)
    WHERE q.request_id=NEW.request_id;
  IF target IS NULL OR NEW.payload->>'recordId' IS DISTINCT FROM target::text
    OR NEW.payload->>'institutionId' IS DISTINCT FROM tenant::text
    OR NEW.payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR NEW.payload->>'eventId' IS DISTINCT FROM NEW.event_id::text
    OR NEW.payload->>'requestId' IS DISTINCT FROM NEW.request_id::text
    OR NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
    OR NEW.payload->>'occurredAt' IS DISTINCT FROM workflow.iso(NEW.occurred_at) THEN
    RAISE EXCEPTION 'Event envelope must match its immutable request scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER domain_event_scope BEFORE INSERT ON workflow.domain_event
FOR EACH ROW EXECUTE FUNCTION workflow.guard_domain_event_scope();

CREATE OR REPLACE FUNCTION academic.append_grade_version(p_record_id uuid,p_expected_version integer,
  p_grade_points numeric,p_outcome text,p_valid_from timestamptz,p_valid_until timestamptz,p_author_id uuid,p_reason text)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE record_row academic.grade_record%ROWTYPE; next_version integer;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version<0 OR p_valid_from IS NULL OR NOT isfinite(p_valid_from)
    OR (p_valid_until IS NOT NULL AND (NOT isfinite(p_valid_until) OR p_valid_until<=p_valid_from))
    OR (p_grade_points IS NOT NULL AND p_grade_points<>round(p_grade_points,2)) THEN
    RAISE EXCEPTION 'Invalid expected version, validity range or grade precision' USING ERRCODE='22023';
  END IF;
  SELECT * INTO record_row FROM academic.grade_record WHERE record_id=p_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Grade record does not exist' USING ERRCODE='23503'; END IF;
  IF coalesce(record_row.latest_version_no,0)<>p_expected_version THEN
    RAISE EXCEPTION 'Expected version does not match latest recorded revision' USING ERRCODE='40001';
  END IF;
  next_version:=p_expected_version+1;
  INSERT INTO academic.grade_version(record_id,version_no,grade_points,outcome,valid_during,author_id,reason)
  VALUES(p_record_id,next_version,p_grade_points,p_outcome,tstzrange(p_valid_from,p_valid_until,'[)'),p_author_id,p_reason);
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION academic.transcript_as_of(p_student_id uuid,p_known_at timestamptz,p_effective_at timestamptz)
RETURNS TABLE(record_id uuid,version_no integer,course_code text,credits numeric,grade_points numeric,outcome text,
  recorded_at timestamptz,valid_during tstzrange)
LANGUAGE sql STABLE SET search_path=pg_catalog,academic,pg_temp AS $$
  SELECT g.record_id,v.version_no,c.course_code,o.credits,v.grade_points,v.outcome,v.recorded_at,s.valid_during
  FROM academic.enrolment e JOIN academic.grade_record g USING(enrolment_id)
  JOIN academic.grade_temporal_segment s ON s.record_id=g.record_id
  JOIN academic.grade_version v ON v.record_id=s.record_id AND v.version_no=s.version_no
  JOIN academic.course_offering o USING(offering_id) JOIN academic.course c USING(course_id)
  WHERE e.student_id=p_student_id AND s.system_during @> p_known_at AND s.valid_during @> p_effective_at
  ORDER BY c.course_code,g.record_id;
$$;
CREATE VIEW academic.current_transcript AS
SELECT g.institution_id,e.student_id,g.record_id,v.version_no,c.course_code,o.credits,
  v.grade_points,v.outcome,v.recorded_at,s.valid_during
FROM academic.enrolment e JOIN academic.grade_record g USING(enrolment_id)
JOIN academic.grade_temporal_segment s ON s.record_id=g.record_id
JOIN academic.grade_version v ON v.record_id=s.record_id AND v.version_no=s.version_no
JOIN academic.course_offering o USING(offering_id) JOIN academic.course c USING(course_id)
WHERE upper_inf(s.system_during) AND s.valid_during @> CURRENT_TIMESTAMP;

CREATE FUNCTION academic.register_student(p_student uuid,p_institution uuid,p_programme uuid,
  p_code text,p_year smallint,p_user uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql
SET search_path=pg_catalog,academic,pg_temp AS $$
DECLARE prior academic.student%ROWTYPE; prior_programme uuid; target uuid:=coalesce(p_student,gen_random_uuid());
BEGIN
  SELECT * INTO prior FROM academic.student WHERE student_id=target FOR UPDATE;
  IF FOUND THEN
    SELECT programme_id INTO prior_programme FROM academic.student_programme WHERE student_id=target;
    IF prior.institution_id IS DISTINCT FROM p_institution OR prior.student_code IS DISTINCT FROM p_code
      OR prior.admission_year IS DISTINCT FROM p_year OR prior_programme IS DISTINCT FROM p_programme
      OR p_user IS NOT NULL AND prior.user_id IS DISTINCT FROM p_user THEN
      RAISE EXCEPTION 'Student identity already has different values' USING ERRCODE='23505';
    END IF;
    RETURN target;
  END IF;
  INSERT INTO academic.student(student_id,institution_id,user_id,student_code,admission_year)
  VALUES(target,p_institution,p_user,p_code,p_year);
  INSERT INTO academic.student_programme(student_id,programme_id) VALUES(target,p_programme);
  RETURN target;
END;
$$;

-- Restore only previously intended read authority. Context views are not write APIs.
REVOKE ALL ON academic.student_programme FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA academic,access_control,evidence,workflow FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA academic,access_control,evidence,workflow FROM PUBLIC;
GRANT SELECT ON academic.student_programme,academic.student_context,academic.course_offering_context,
  academic.enrolment_context,academic.grade_version_context,academic.grade_temporal_segment_context,
  academic.current_transcript TO scholarproof_runtime,scholarproof_api_access,scholarproof_workflow_owner;
GRANT SELECT ON access_control.password_credential_context TO scholarproof_api_access;
GRANT SELECT ON evidence.reference_context TO scholarproof_api_access,scholarproof_workflow_owner;
GRANT SELECT ON workflow.change_request_context,workflow.decision_context,workflow.domain_event_context,workflow.outbox_delivery_context
  TO scholarproof_workflow_owner;
GRANT SELECT ON academic.course,academic.academic_term,academic.programme TO scholarproof_workflow_owner;

-- Verify exact row preservation in every physical relation and reconstructed shape.
DO $$
DECLARE r record; differences bigint;
BEGIN
  FOR r IN SELECT DISTINCT relation_name FROM pg_temp.bcnf_migration_snapshot LOOP
    EXECUTE format('SELECT count(*) FROM ((SELECT payload FROM pg_temp.bcnf_migration_snapshot WHERE relation_name=$1 EXCEPT ALL SELECT to_jsonb(x) FROM %s x) UNION ALL (SELECT to_jsonb(x) FROM %s x EXCEPT ALL SELECT payload FROM pg_temp.bcnf_migration_snapshot WHERE relation_name=$1)) d',r.relation_name,r.relation_name)
      INTO differences USING r.relation_name;
    IF differences<>0 THEN RAISE EXCEPTION 'BCNF migration did not preserve %',r.relation_name; END IF;
  END LOOP;
  FOR r IN SELECT DISTINCT relation_name FROM pg_temp.bcnf_wire_snapshot LOOP
    EXECUTE format('SELECT count(*) FROM ((SELECT payload FROM pg_temp.bcnf_wire_snapshot WHERE relation_name=$1 EXCEPT ALL SELECT to_jsonb(x) FROM %s x) UNION ALL (SELECT to_jsonb(x) FROM %s x EXCEPT ALL SELECT payload FROM pg_temp.bcnf_wire_snapshot WHERE relation_name=$1)) d',r.relation_name,r.relation_name)
      INTO differences USING r.relation_name;
    IF differences<>0 THEN RAISE EXCEPTION 'BCNF reconstruction did not preserve %',r.relation_name; END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE academic.student_programme IS 'BCNF student-to-programme assignment; a deferred constraint requires exactly one for every student.';
COMMENT ON VIEW academic.grade_version_context IS 'Read reconstruction; institution is derived from record and predecessor is version_no minus one. Neither is duplicated in physical grade history.';
COMMENT ON TABLE workflow.domain_event IS 'Immutable event envelope as one JSON domain value; relational keys are event_id and (request_id,kind). Record scope is derived from the frozen request evidence.';
