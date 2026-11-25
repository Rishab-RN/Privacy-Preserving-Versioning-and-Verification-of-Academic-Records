CREATE SCHEMA privacy;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='academic_privacy_owner') THEN
    CREATE ROLE academic_privacy_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='academic_privacy_owner'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='academic_privacy_owner')) THEN
    RAISE EXCEPTION 'Unsafe privacy function owner' USING ERRCODE='42501';
  END IF;
END $$;
CREATE TABLE privacy.credential (
  credential_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES workflow.decision(request_id),
  holder numeric(77,0) NOT NULL CHECK(holder>=0 AND holder<21888242871839275222246405745257275088548364400416034343698204186575808495617),
  salt numeric(75,0) NOT NULL CHECK(salt>=0 AND salt<452312848583266388373324160190187140051835877600158453279131187530910662656),
  artifact text NOT NULL CHECK(length(artifact) BETWEEN 100 AND 12000 AND artifact ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(issued_at))
);
CREATE TABLE privacy.issuance_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL UNIQUE REFERENCES privacy.credential(credential_id)
);
CREATE TABLE privacy.revocation (
  credential_id uuid PRIMARY KEY REFERENCES privacy.credential(credential_id),
  actor_id uuid NOT NULL REFERENCES academic.app_user(user_id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(revoked_at))
);
CREATE TABLE privacy.challenge (
  challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES privacy.credential(credential_id),
  threshold integer NOT NULL CHECK(threshold BETWEEN 0 AND 9999),
  nonce uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at))
);
CREATE TABLE privacy.revocation_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL UNIQUE REFERENCES privacy.revocation(credential_id)
);
CREATE TABLE privacy.challenge_use (
  challenge_id uuid PRIMARY KEY REFERENCES privacy.challenge(challenge_id),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(verified_at))
);
-- All nontrivial determinants in these base relations are keys; tenant, student,
-- record/version, status, protocol and fixed expiration TTL remain computed.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['credential','issuance_event','revocation','revocation_event','challenge','challenge_use'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON privacy.%I FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change()',relation);
  END LOOP;
END $$;

CREATE VIEW privacy.credential_context AS
SELECT c.*,d.record_id,d.version_no,g.institution_id,g.latest_version_no,e.student_id,s.user_id,
  (v.grade_points*100)::integer AS grade,(gs.max_points*100)::integer AS maximum,
  CASE WHEN r.credential_id IS NOT NULL THEN 'revoked'
    WHEN g.latest_version_no<>d.version_no THEN 'superseded' ELSE 'current' END AS status
FROM privacy.credential c JOIN workflow.decision d USING(request_id)
JOIN academic.grade_record g USING(record_id) JOIN academic.enrolment e USING(enrolment_id)
JOIN academic.student s USING(student_id) JOIN academic.grade_version v ON v.record_id=d.record_id AND v.version_no=d.version_no
JOIN academic.course_offering o USING(offering_id) JOIN academic.grading_scheme gs USING(scheme_id)
LEFT JOIN privacy.revocation r USING(credential_id);

CREATE VIEW privacy.event_public AS
SELECT e.event_id,c.request_id,c.institution_id,c.issued_at AS occurred_at,
jsonb_build_object('schemaVersion',1,'eventId',e.event_id,'kind','credential.issued',
  'institutionId',c.institution_id,'credentialId',c.credential_id,'requestId',c.request_id,
  'recordId',c.record_id,'versionNo',c.version_no,'artifactDigest',encode(sha256(convert_to(c.artifact,'UTF8')),'hex'),
  'occurredAt',workflow.iso(c.issued_at)) AS payload
FROM privacy.issuance_event e JOIN privacy.credential_context c USING(credential_id)
UNION ALL
SELECT e.event_id,c.request_id,c.institution_id,r.revoked_at,
jsonb_build_object('schemaVersion',1,'eventId',e.event_id,'kind','credential.revoked',
  'institutionId',c.institution_id,'credentialId',c.credential_id,'requestId',c.request_id,
  'recordId',c.record_id,'versionNo',c.version_no,'artifactDigest',encode(sha256(convert_to(c.artifact,'UTF8')),'hex'),
  'actorId',r.actor_id,'reason',r.reason,'occurredAt',workflow.iso(r.revoked_at))
FROM privacy.revocation_event e JOIN privacy.credential_context c USING(credential_id) JOIN privacy.revocation r USING(credential_id);

CREATE FUNCTION privacy.owned(p_token text,p_record uuid) RETURNS uuid LANGUAGE plpgsql
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_token);
  IF NOT EXISTS(SELECT 1 FROM academic.grade_record g JOIN academic.enrolment e USING(enrolment_id)
    JOIN academic.student s USING(student_id) JOIN academic.role_assignment a ON a.user_id=s.user_id AND a.institution_id=s.institution_id
    WHERE g.record_id=p_record AND s.user_id=actor AND a.role_code='student') THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  RETURN actor;
END $$;
CREATE FUNCTION privacy.material(p_token text,p_record uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM privacy.owned(p_token,p_record);
  SELECT jsonb_build_object('requestId',d.request_id,'recordId',g.record_id,'versionNo',d.version_no,
    'institutionId',g.institution_id,'grade',(v.grade_points*100)::integer,'maximum',(gs.max_points*100)::integer)
  INTO result FROM academic.grade_record g JOIN workflow.decision d ON d.record_id=g.record_id AND d.version_no=g.latest_version_no
    JOIN academic.grade_version v ON v.record_id=d.record_id AND v.version_no=d.version_no
    JOIN academic.enrolment e USING(enrolment_id) JOIN academic.course_offering o USING(offering_id)
    JOIN academic.grading_scheme gs USING(scheme_id)
    WHERE g.record_id=p_record AND v.outcome='passed' AND v.grade_points IS NOT NULL;
  IF result IS NULL THEN RAISE EXCEPTION 'A current independently approved passed numeric grade is required' USING ERRCODE='23514'; END IF;
  RETURN result;
END $$;
CREATE FUNCTION privacy.issue(p_token text,p_id uuid,p_request uuid,p_holder numeric,p_salt numeric,p_artifact text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE record uuid; expected integer; latest integer; old privacy.credential%ROWTYPE;
BEGIN
  SELECT d.record_id,d.version_no INTO record,expected FROM workflow.decision d WHERE request_id=p_request;
  PERFORM privacy.owned(p_token,record);
  SELECT latest_version_no INTO latest FROM academic.grade_record WHERE record_id=record FOR UPDATE;
  SELECT * INTO old FROM privacy.credential WHERE credential_id=p_id;
  IF FOUND THEN
    IF old.request_id IS DISTINCT FROM p_request OR old.holder IS DISTINCT FROM p_holder
      OR old.salt IS DISTINCT FROM p_salt OR old.artifact IS DISTINCT FROM p_artifact THEN
      RAISE EXCEPTION 'Credential idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN p_id;
  END IF;
  IF expected IS NULL OR latest IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM academic.grade_version WHERE record_id=record AND version_no=expected AND outcome='passed' AND grade_points IS NOT NULL) THEN
    RAISE EXCEPTION 'Record version changed' USING ERRCODE='40001';
  END IF;
  INSERT INTO privacy.credential(credential_id,request_id,holder,salt,artifact) VALUES(p_id,p_request,p_holder,p_salt,p_artifact);
  RETURN p_id;
END $$;
CREATE FUNCTION privacy.read_owned(p_token text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE c privacy.credential_context%ROWTYPE;
BEGIN
  SELECT * INTO c FROM privacy.credential_context WHERE credential_id=p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM privacy.owned(p_token,c.record_id);
  RETURN jsonb_build_object('credentialId',c.credential_id,'recordId',c.record_id,'versionNo',c.version_no,
    'artifact',c.artifact,'salt',c.salt::text,'grade',c.grade::text,'maximum',c.maximum::text,'holder',c.holder::text,'status',c.status);
END $$;
CREATE FUNCTION privacy.new_challenge(p_token text,p_id uuid,p_threshold integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE c privacy.credential_context%ROWTYPE; q privacy.challenge%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM privacy.credential_context WHERE credential_id=p_id;
  PERFORM privacy.owned(p_token,c.record_id);
  IF c.status<>'current' OR p_threshold IS NULL OR p_threshold<0 OR p_threshold>c.maximum THEN
    RAISE EXCEPTION 'Credential or threshold unavailable' USING ERRCODE='23514'; END IF;
  INSERT INTO privacy.challenge(credential_id,threshold) VALUES(p_id,p_threshold) RETURNING * INTO q;
  RETURN jsonb_build_object('challengeId',q.challenge_id);
END $$;
CREATE FUNCTION privacy.read_challenge(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object('challengeId',q.challenge_id,'credentialId',c.credential_id,'artifact',c.artifact,
    'threshold',q.threshold::text,'nonce',q.nonce,'expiresAt',workflow.iso(q.created_at+interval '120 seconds'),
    'recordId',c.record_id,'versionNo',c.version_no,'status',c.status,'used',u.challenge_id IS NOT NULL)
  INTO result FROM privacy.challenge q JOIN privacy.credential_context c USING(credential_id)
  LEFT JOIN privacy.challenge_use u USING(challenge_id) WHERE q.challenge_id=p_id;
  IF result IS NULL THEN RAISE EXCEPTION 'Challenge not found' USING ERRCODE='P0002'; END IF;
  RETURN result;
END $$;
CREATE FUNCTION privacy.consume(p_id uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE record uuid; c privacy.credential_context%ROWTYPE; q privacy.challenge%ROWTYPE;
BEGIN
  SELECT g.record_id INTO record FROM privacy.challenge ch JOIN privacy.credential c USING(credential_id)
    JOIN workflow.decision g USING(request_id) WHERE ch.challenge_id=p_id;
  IF record IS NULL THEN RAISE EXCEPTION 'Challenge not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM academic.grade_record WHERE record_id=record FOR UPDATE;
  SELECT * INTO STRICT q FROM privacy.challenge WHERE challenge_id=p_id;
  SELECT * INTO STRICT c FROM privacy.credential_context WHERE credential_id=q.credential_id;
  IF q.created_at+interval '120 seconds'<=clock_timestamp() THEN RAISE EXCEPTION 'Challenge expired' USING ERRCODE='22023'; END IF;
  IF c.status<>'current' THEN RETURN c.status; END IF;
  INSERT INTO privacy.challenge_use(challenge_id) VALUES(p_id);
  RETURN 'current';
END $$;
CREATE FUNCTION privacy.revoke(p_token text,p_id uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE actor uuid; c privacy.credential_context%ROWTYPE; old privacy.revocation%ROWTYPE;
BEGIN
  actor:=workflow.actor_for_session(p_token);
  SELECT * INTO STRICT c FROM privacy.credential_context WHERE credential_id=p_id;
  PERFORM 1 FROM academic.grade_record WHERE record_id=c.record_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM academic.role_assignment WHERE user_id=actor AND institution_id=c.institution_id AND role_code='registrar') THEN
    RAISE EXCEPTION 'Registrar role required' USING ERRCODE='42501'; END IF;
  SELECT * INTO old FROM privacy.revocation WHERE credential_id=p_id;
  IF FOUND THEN
    IF old.actor_id IS DISTINCT FROM actor OR old.reason IS DISTINCT FROM p_reason THEN RAISE EXCEPTION 'Conflicting revocation' USING ERRCODE='55000'; END IF;
    RETURN;
  END IF;
  INSERT INTO privacy.revocation(credential_id,actor_id,reason) VALUES(p_id,actor,p_reason);
END $$;

-- Append issuance into the existing tree without changing any earlier leaf.
CREATE OR REPLACE VIEW transparency.event_context WITH(security_invoker=false) AS
SELECT e.event_id,'workflow'::text AS source_kind,e.request_id,e.kind,e.occurred_at,g.institution_id,e.payload
FROM workflow.domain_event e JOIN workflow.change_request q USING(request_id) JOIN evidence.reference r USING(evidence_id)
JOIN academic.grade_record g USING(record_id)
UNION ALL SELECT event_id,'credential'::text,request_id,payload->>'kind',occurred_at,institution_id,payload FROM privacy.event_public;
CREATE OR REPLACE FUNCTION transparency.guard_event_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,transparency,pg_temp AS $$ BEGIN
  IF (EXISTS(SELECT 1 FROM workflow.domain_event WHERE event_id=NEW.event_id))::integer
    +(EXISTS(SELECT 1 FROM privacy.issuance_event WHERE event_id=NEW.event_id))::integer
    +(EXISTS(SELECT 1 FROM privacy.revocation_event WHERE event_id=NEW.event_id))::integer<>1 THEN
    RAISE EXCEPTION 'Exactly one authoritative source is required' USING ERRCODE='23503'; END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION transparency.guard_event_position() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE tenant uuid; head bigint;
BEGIN
  SELECT institution_id INTO tenant FROM transparency.event_context WHERE event_id=NEW.event_id;
  IF tenant IS NULL OR tenant IS DISTINCT FROM NEW.institution_id THEN RAISE EXCEPTION 'Event scope mismatch' USING ERRCODE='23503'; END IF;
  SELECT tree_size INTO head FROM transparency.log_state WHERE institution_id=tenant;
  IF NEW.leaf_index IS DISTINCT FROM head-1 THEN RAISE EXCEPTION 'Append slot mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION transparency.sequence_private_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,transparency,pg_temp AS $$ DECLARE tenant uuid; slot bigint;
BEGIN
  SELECT institution_id INTO STRICT tenant FROM privacy.event_public WHERE event_id=NEW.event_id;
  INSERT INTO transparency.event_source VALUES(NEW.event_id);
  INSERT INTO transparency.log_state(institution_id) VALUES(tenant) ON CONFLICT DO NOTHING;
  UPDATE transparency.log_state SET tree_size=tree_size+1 WHERE institution_id=tenant RETURNING tree_size-1 INTO slot;
  INSERT INTO transparency.event_position VALUES(NEW.event_id,tenant,slot,transparency.random_salt());
  RETURN NEW;
END $$;
CREATE TRIGGER private_transparency AFTER INSERT ON privacy.issuance_event FOR EACH ROW EXECUTE FUNCTION transparency.sequence_private_event();
CREATE TRIGGER private_transparency AFTER INSERT ON privacy.revocation_event FOR EACH ROW EXECUTE FUNCTION transparency.sequence_private_event();
CREATE FUNCTION privacy.emit_issuance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$ BEGIN
  IF TG_TABLE_NAME='revocation' THEN INSERT INTO privacy.revocation_event(credential_id) VALUES(NEW.credential_id);
  ELSE INSERT INTO privacy.issuance_event(credential_id) VALUES(NEW.credential_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issued AFTER INSERT ON privacy.credential FOR EACH ROW EXECUTE FUNCTION privacy.emit_issuance();
CREATE TRIGGER revoked AFTER INSERT ON privacy.revocation FOR EACH ROW EXECUTE FUNCTION privacy.emit_issuance();
ALTER FUNCTION transparency.read_expected_event(uuid) RENAME TO read_expected_workflow_event;
REVOKE ALL ON FUNCTION transparency.read_expected_workflow_event(uuid) FROM academic_log_reader;
CREATE FUNCTION transparency.read_expected_event(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER
SET search_path=pg_catalog,transparency,pg_temp AS $$ DECLARE result jsonb; BEGIN
  SELECT payload INTO result FROM privacy.event_public WHERE event_id=p_id;
  IF FOUND THEN RETURN result; END IF;
  RETURN transparency.read_expected_workflow_event(p_id);
END $$;

REVOKE ALL ON SCHEMA privacy FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA privacy FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA privacy FROM PUBLIC;
REVOKE ALL ON FUNCTION transparency.sequence_private_event(),transparency.read_expected_event(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA privacy,academic,workflow,access_control TO academic_privacy_owner;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA privacy TO academic_privacy_owner;
GRANT SELECT ON academic.app_user,academic.role_assignment,academic.student,academic.enrolment,academic.grade_record,
  academic.grade_version,academic.course_offering,academic.grading_scheme,workflow.decision,access_control.api_session TO academic_privacy_owner;
GRANT UPDATE(latest_version_no) ON academic.grade_record TO academic_privacy_owner;
GRANT EXECUTE ON FUNCTION workflow.actor_for_session(text),workflow.iso(timestamptz) TO academic_privacy_owner;
GRANT USAGE ON SCHEMA privacy TO scholarproof_api_access,academic_log_owner;
GRANT SELECT ON privacy.event_public,privacy.issuance_event,privacy.revocation_event TO academic_log_owner;
GRANT EXECUTE ON FUNCTION workflow.iso(timestamptz) TO academic_log_owner;
GRANT SELECT ON workflow.change_request_context,workflow.decision,workflow.decision_context,evidence.reference_context,
  academic.grade_version,academic.grade_version_context TO academic_log_owner;
GRANT EXECUTE ON FUNCTION privacy.material(text,uuid),privacy.issue(text,uuid,uuid,numeric,numeric,text),
  privacy.read_owned(text,uuid),privacy.new_challenge(text,uuid,integer),privacy.read_challenge(uuid),privacy.consume(uuid),privacy.revoke(text,uuid,text)
  TO scholarproof_api_access;
GRANT CREATE ON SCHEMA privacy TO academic_privacy_owner;
DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='privacy' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO academic_privacy_owner',f.signature);
END LOOP; END $$;
ALTER VIEW privacy.credential_context OWNER TO academic_privacy_owner;
ALTER VIEW privacy.event_public OWNER TO academic_privacy_owner;
REVOKE CREATE ON SCHEMA privacy FROM academic_privacy_owner;
GRANT CREATE ON SCHEMA transparency TO academic_log_owner;
ALTER FUNCTION transparency.sequence_private_event() OWNER TO academic_log_owner;
ALTER FUNCTION transparency.read_expected_event(uuid) OWNER TO academic_log_owner;
ALTER VIEW transparency.event_context OWNER TO academic_log_owner;
REVOKE CREATE ON SCHEMA transparency FROM academic_log_owner;
GRANT EXECUTE ON FUNCTION transparency.read_expected_event(uuid) TO academic_log_reader;
