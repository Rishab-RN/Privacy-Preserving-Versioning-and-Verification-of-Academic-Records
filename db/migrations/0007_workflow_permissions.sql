GRANT USAGE ON SCHEMA academic,access_control,evidence,workflow TO scholarproof_workflow_owner;
GRANT SELECT ON academic.app_user,academic.role_assignment,academic.grade_record,academic.grade_version,
  academic.grade_temporal_segment,academic.enrolment,academic.student,academic.course_offering,
  academic.grading_scheme,access_control.api_session,evidence.reference TO scholarproof_workflow_owner;
GRANT INSERT ON academic.grade_version,academic.grade_temporal_segment TO scholarproof_workflow_owner;
GRANT UPDATE(latest_version_no) ON academic.grade_record TO scholarproof_workflow_owner;
GRANT UPDATE(system_during) ON academic.grade_temporal_segment TO scholarproof_workflow_owner;
-- PostgreSQL row locking requires UPDATE on a column, even for FOR SHARE.
GRANT UPDATE(section_code) ON academic.course_offering TO scholarproof_workflow_owner;
GRANT EXECUTE ON FUNCTION academic.append_grade_version(uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)
  TO scholarproof_workflow_owner;
GRANT SELECT,INSERT ON workflow.change_request,workflow.decision,workflow.domain_event,workflow.outbox_delivery
  TO scholarproof_workflow_owner;
GRANT UPDATE(request_id) ON workflow.change_request TO scholarproof_workflow_owner;
GRANT UPDATE ON workflow.outbox_delivery TO scholarproof_workflow_owner;

CREATE FUNCTION workflow.iso(p_time timestamptz) RETURNS text LANGUAGE sql STABLE STRICT
SET search_path=pg_catalog,workflow,pg_temp AS $$
  SELECT pg_catalog.to_char(p_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

CREATE FUNCTION workflow.actor_for_session(p_digest text) RETURNS uuid LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Active session required' USING ERRCODE='28000';
  END IF;
  SELECT u.user_id INTO actor FROM access_control.api_session s JOIN academic.app_user u USING(user_id)
    WHERE s.token_digest=p_digest AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND u.account_state='active';
  IF actor IS NULL THEN RAISE EXCEPTION 'Active session required' USING ERRCODE='28000'; END IF;
  RETURN actor;
END;
$$;

CREATE FUNCTION workflow.require_staff(p_actor uuid,p_auditor boolean DEFAULT false) RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM academic.role_assignment ra JOIN academic.app_user u USING(user_id)
    WHERE u.user_id=p_actor AND u.account_state='active'
      AND (ra.role_code='registrar' OR (p_auditor AND ra.role_code='auditor'))) THEN
    RAISE EXCEPTION 'This role cannot perform this workflow operation' USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE FUNCTION workflow.lock_record(p_actor uuid,p_record uuid) RETURNS academic.grade_record LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE row_record academic.grade_record%ROWTYPE;
BEGIN
  SELECT gr.* INTO row_record FROM academic.grade_record gr WHERE gr.record_id=p_record
    AND EXISTS(SELECT 1 FROM academic.role_assignment ra JOIN academic.app_user u USING(user_id)
      WHERE ra.user_id=p_actor AND u.account_state='active' AND ra.institution_id=gr.institution_id AND ra.role_code='registrar')
    FOR UPDATE OF gr;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002'; END IF;
  RETURN row_record;
END;
$$;

CREATE FUNCTION workflow.emit_event(p_request uuid,p_actor uuid,p_kind text,p_version integer DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE req workflow.change_request%ROWTYPE; evidence_row evidence.reference%ROWTYPE;
  decision_row workflow.decision%ROWTYPE; grade_row academic.grade_version%ROWTYPE;
  event_id uuid:=gen_random_uuid(); event_time timestamptz:=clock_timestamp(); tenant uuid; body jsonb;
BEGIN
  SELECT * INTO STRICT req FROM workflow.change_request WHERE request_id=p_request;
  SELECT * INTO STRICT evidence_row FROM evidence.reference WHERE evidence_id=req.evidence_id;
  SELECT institution_id INTO STRICT tenant FROM academic.grade_record WHERE record_id=req.record_id;
  SELECT * INTO decision_row FROM workflow.decision WHERE request_id=p_request;
  IF p_version IS NOT NULL THEN
    SELECT * INTO STRICT grade_row FROM academic.grade_version WHERE record_id=req.record_id AND version_no=p_version;
  END IF;
  body:=jsonb_build_object('schemaVersion',1,'eventId',event_id,'kind',p_kind,'institutionId',tenant,
    'recordId',req.record_id,'requestId',req.request_id,'actorId',p_actor,'occurredAt',workflow.iso(event_time),
    'proposerId',req.proposer_id,
    'evidence',jsonb_build_object('evidenceId',evidence_row.evidence_id,'digestSha256',evidence_row.digest_sha256,'sizeBytes',evidence_row.size_bytes),
    'proposal',jsonb_build_object('expectedVersion',req.expected_version,'gradePoints',req.grade_points::text,
      'outcome',req.outcome,'validFrom',workflow.iso(lower(req.valid_during)),
      'validUntil',CASE WHEN upper_inf(req.valid_during) THEN NULL ELSE workflow.iso(upper(req.valid_during)) END,
      'reason',req.reason,'submittedAt',workflow.iso(req.created_at)),
    'decision',CASE WHEN decision_row.request_id IS NULL THEN NULL ELSE jsonb_build_object(
      'code',decision_row.decision_code,'actorId',decision_row.decider_id,'reason',decision_row.reason,
      'versionNo',decision_row.version_no,'decidedAt',workflow.iso(decision_row.decided_at)) END,
    'revision',CASE WHEN p_version IS NULL THEN NULL ELSE jsonb_build_object(
      'versionNo',grade_row.version_no,'previousVersionNo',grade_row.previous_version_no,
      'gradePoints',grade_row.grade_points::text,'outcome',grade_row.outcome,
      'validFrom',workflow.iso(lower(grade_row.valid_during)),
      'validUntil',CASE WHEN upper_inf(grade_row.valid_during) THEN NULL ELSE workflow.iso(upper(grade_row.valid_during)) END,
      'recordedAt',workflow.iso(grade_row.recorded_at),'authorId',grade_row.author_id,'reason',grade_row.reason) END);
  INSERT INTO workflow.domain_event(event_id,request_id,record_id,kind,occurred_at,payload)
    VALUES(event_id,req.request_id,req.record_id,p_kind,event_time,body);
  INSERT INTO workflow.outbox_delivery(event_id) VALUES(event_id);
  RETURN event_id;
END;
$$;

CREATE FUNCTION workflow.propose_change(p_token_digest text,p_record_id uuid,p_idempotency_key uuid,
  p_expected_version integer,p_grade_points numeric,p_outcome text,p_valid_from timestamptz,
  p_valid_until timestamptz,p_evidence_id uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE actor uuid; gr academic.grade_record%ROWTYPE; existing workflow.change_request%ROWTYPE;
  request_id uuid; validity tstzrange; policy_max numeric; policy_pass numeric;
BEGIN
  actor:=workflow.actor_for_session(p_token_digest);
  PERFORM workflow.require_staff(actor);
  IF p_record_id IS NULL OR p_idempotency_key IS NULL OR p_evidence_id IS NULL OR
    p_expected_version IS NULL OR p_expected_version<0 OR p_outcome IS NULL OR
    p_outcome NOT IN ('passed','failed','withdrawn','incomplete') OR p_reason IS NULL OR
    length(p_reason)>500 OR length(btrim(p_reason))<1 OR p_valid_from IS NULL OR NOT isfinite(p_valid_from)
    OR p_valid_from<timestamptz '0001-01-01 00:00:00+00' OR p_valid_from>=timestamptz '10000-01-01 00:00:00+00'
    OR (p_valid_until IS NOT NULL AND (NOT isfinite(p_valid_until) OR p_valid_until<=p_valid_from))
    OR (p_valid_until IS NOT NULL AND p_valid_until>=timestamptz '10000-01-01 00:00:00+00')
    OR (p_grade_points IS NOT NULL AND p_grade_points<>round(p_grade_points,2)) THEN
    RAISE EXCEPTION 'Invalid change request fields' USING ERRCODE='22023';
  END IF;
  gr:=workflow.lock_record(actor,p_record_id);
  validity:=tstzrange(p_valid_from,p_valid_until,'[)');
  SELECT * INTO existing FROM workflow.change_request WHERE proposer_id=actor AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.record_id IS DISTINCT FROM p_record_id OR existing.expected_version IS DISTINCT FROM p_expected_version
      OR existing.grade_points IS DISTINCT FROM p_grade_points OR existing.outcome IS DISTINCT FROM p_outcome
      OR existing.valid_during IS DISTINCT FROM validity OR existing.evidence_id IS DISTINCT FROM p_evidence_id
      OR existing.reason IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'Idempotency key already identifies different input' USING ERRCODE='23505';
    END IF;
    RETURN existing.request_id;
  END IF;
  IF coalesce(gr.latest_version_no,0)<>p_expected_version THEN
    RAISE EXCEPTION 'Expected version is stale' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM evidence.reference er WHERE er.evidence_id=p_evidence_id
    AND er.record_id=p_record_id AND er.institution_id=gr.institution_id AND er.state='available') THEN
    RAISE EXCEPTION 'Available evidence for this record is required' USING ERRCODE='23514';
  END IF;
  SELECT gs.max_points,gs.pass_points INTO policy_max,policy_pass FROM academic.enrolment e
    JOIN academic.course_offering co ON co.offering_id=e.offering_id
    JOIN academic.grading_scheme gs ON gs.scheme_id=co.scheme_id WHERE e.enrolment_id=gr.enrolment_id FOR SHARE OF co;
  IF (p_grade_points IS NOT NULL AND (p_grade_points<0 OR p_grade_points>policy_max))
    OR (p_outcome IN ('passed','failed') AND p_grade_points IS NULL)
    OR (p_outcome IN ('withdrawn','incomplete') AND p_grade_points IS NOT NULL)
    OR (p_outcome='passed' AND p_grade_points<policy_pass)
    OR (p_outcome='failed' AND p_grade_points>=policy_pass) THEN
    RAISE EXCEPTION 'Grade disagrees with selected policy' USING ERRCODE='23514';
  END IF;
  INSERT INTO workflow.change_request(record_id,proposer_id,idempotency_key,expected_version,grade_points,
    outcome,valid_during,reason,evidence_id) VALUES(p_record_id,actor,p_idempotency_key,p_expected_version,
      p_grade_points,p_outcome,validity,p_reason,p_evidence_id) RETURNING change_request.request_id INTO request_id;
  PERFORM workflow.emit_event(request_id,actor,'request.submitted');
  RETURN request_id;
END;
$$;

CREATE FUNCTION workflow.approve_change(p_token_digest text,p_request_id uuid,p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE actor uuid; record_id uuid; gr academic.grade_record%ROWTYPE;
  req workflow.change_request%ROWTYPE; prior workflow.decision%ROWTYPE; version integer;
BEGIN
  actor:=workflow.actor_for_session(p_token_digest); PERFORM workflow.require_staff(actor);
  IF p_reason IS NULL OR length(p_reason)>500 OR length(btrim(p_reason))<1 THEN
    RAISE EXCEPTION 'Decision reason is required' USING ERRCODE='22023';
  END IF;
  SELECT r.record_id INTO record_id FROM workflow.change_request r WHERE r.request_id=p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002'; END IF;
  gr:=workflow.lock_record(actor,record_id);
  SELECT * INTO STRICT req FROM workflow.change_request r WHERE r.request_id=p_request_id FOR UPDATE;
  IF req.proposer_id=actor THEN RAISE EXCEPTION 'A different registrar must approve' USING ERRCODE='42501'; END IF;
  SELECT * INTO prior FROM workflow.decision WHERE request_id=p_request_id;
  IF FOUND THEN
    IF prior.decision_code='approved' AND prior.decider_id=actor AND prior.reason=p_reason THEN RETURN prior.version_no; END IF;
    RAISE EXCEPTION 'Request already has a different decision' USING ERRCODE='55000';
  END IF;
  IF coalesce(gr.latest_version_no,0)<>req.expected_version THEN
    RAISE EXCEPTION 'Expected version is stale' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM evidence.reference er WHERE er.evidence_id=req.evidence_id
    AND er.record_id=req.record_id AND er.institution_id=gr.institution_id AND er.state='available') THEN
    RAISE EXCEPTION 'Available bound evidence is required' USING ERRCODE='23514';
  END IF;
  version:=academic.append_grade_version(req.record_id,req.expected_version,req.grade_points,req.outcome,
    lower(req.valid_during),CASE WHEN upper_inf(req.valid_during) THEN NULL ELSE upper(req.valid_during) END,actor,req.reason);
  INSERT INTO workflow.decision(request_id,record_id,decision_code,decider_id,reason,version_no)
    VALUES(req.request_id,req.record_id,'approved',actor,p_reason,version);
  PERFORM workflow.emit_event(req.request_id,actor,'grade.accepted',version);
  RETURN version;
END;
$$;

CREATE FUNCTION workflow.reject_change(p_token_digest text,p_request_id uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE actor uuid; record_id uuid; req workflow.change_request%ROWTYPE; prior workflow.decision%ROWTYPE;
BEGIN
  actor:=workflow.actor_for_session(p_token_digest); PERFORM workflow.require_staff(actor);
  IF p_reason IS NULL OR length(p_reason)>500 OR length(btrim(p_reason))<1 THEN
    RAISE EXCEPTION 'Decision reason is required' USING ERRCODE='22023';
  END IF;
  SELECT r.record_id INTO record_id FROM workflow.change_request r WHERE r.request_id=p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002'; END IF;
  PERFORM workflow.lock_record(actor,record_id);
  SELECT * INTO STRICT req FROM workflow.change_request r WHERE r.request_id=p_request_id FOR UPDATE;
  IF req.proposer_id=actor THEN RAISE EXCEPTION 'A different registrar must decide' USING ERRCODE='42501'; END IF;
  SELECT * INTO prior FROM workflow.decision WHERE request_id=p_request_id;
  IF FOUND THEN
    IF prior.decision_code='rejected' AND prior.decider_id=actor AND prior.reason=p_reason THEN RETURN; END IF;
    RAISE EXCEPTION 'Request already has a different decision' USING ERRCODE='55000';
  END IF;
  INSERT INTO workflow.decision(request_id,record_id,decision_code,decider_id,reason)
    VALUES(req.request_id,req.record_id,'rejected',actor,p_reason);
  PERFORM workflow.emit_event(req.request_id,actor,'request.rejected');
END;
$$;

CREATE FUNCTION workflow.get_change(p_token_digest text,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
DECLARE actor uuid; req workflow.change_request%ROWTYPE; gr academic.grade_record%ROWTYPE;
  decision_row workflow.decision%ROWTYPE; deliveries jsonb;
BEGIN
  actor:=workflow.actor_for_session(p_token_digest); PERFORM workflow.require_staff(actor,true);
  SELECT r.* INTO req FROM workflow.change_request r JOIN academic.grade_record g ON g.record_id=r.record_id
    WHERE r.request_id=p_request_id AND EXISTS(SELECT 1 FROM academic.role_assignment ra JOIN academic.app_user u USING(user_id)
      WHERE ra.user_id=actor AND u.account_state='active' AND ra.institution_id=g.institution_id AND ra.role_code IN ('registrar','auditor'));
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO STRICT gr FROM academic.grade_record WHERE record_id=req.record_id;
  SELECT * INTO decision_row FROM workflow.decision WHERE request_id=req.request_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',e.event_id,'kind',e.kind,
    'state',CASE WHEN d.delivered_at IS NOT NULL THEN 'delivered' WHEN d.quarantined_at IS NOT NULL THEN 'quarantined'
      WHEN d.lease_until>clock_timestamp() THEN 'leased' ELSE 'pending' END,
    'attempts',d.attempt_count,'nextAttemptAt',workflow.iso(d.next_attempt_at),'lastErrorCode',d.last_error_code)
    ORDER BY e.occurred_at,e.event_id),'[]'::jsonb) INTO deliveries
    FROM workflow.domain_event e JOIN workflow.outbox_delivery d USING(event_id) WHERE e.request_id=req.request_id;
  RETURN jsonb_build_object('requestId',req.request_id,'recordId',req.record_id,'expectedVersion',req.expected_version,
    'gradePoints',req.grade_points::text,'outcome',req.outcome,'validFrom',workflow.iso(lower(req.valid_during)),
    'validUntil',CASE WHEN upper_inf(req.valid_during) THEN NULL ELSE workflow.iso(upper(req.valid_during)) END,
    'evidenceId',req.evidence_id,'reason',req.reason,'submittedBy',req.proposer_id,'submittedAt',workflow.iso(req.created_at),
    'currentVersion',coalesce(gr.latest_version_no,0),'stale',decision_row.request_id IS NULL AND coalesce(gr.latest_version_no,0)<>req.expected_version,
    'decision',CASE WHEN decision_row.request_id IS NULL THEN NULL ELSE jsonb_build_object('code',decision_row.decision_code,
      'actorId',decision_row.decider_id,'reason',decision_row.reason,'versionNo',decision_row.version_no,'decidedAt',workflow.iso(decision_row.decided_at)) END,
    'deliveries',deliveries);
END;
$$;

CREATE FUNCTION workflow.claim_deliveries(p_limit integer,p_lease_seconds integer)
RETURNS TABLE(event_id uuid,lease_token uuid,attempt integer,payload jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'Invalid claim limits' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH due AS (
    SELECT d.event_id,d.consumer FROM workflow.outbox_delivery d
    WHERE d.delivered_at IS NULL AND d.quarantined_at IS NULL AND d.next_attempt_at<=clock_timestamp()
      AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp())
    ORDER BY d.next_attempt_at,d.event_id LIMIT p_limit FOR UPDATE OF d SKIP LOCKED
  ), claimed AS (
    UPDATE workflow.outbox_delivery d SET attempt_count=d.attempt_count+1,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    FROM due WHERE d.event_id=due.event_id AND d.consumer=due.consumer
    RETURNING d.event_id,d.lease_token,d.attempt_count
  ) SELECT c.event_id,c.lease_token,c.attempt_count,e.payload FROM claimed c JOIN workflow.domain_event e ON e.event_id=c.event_id;
END;
$$;

CREATE FUNCTION workflow.ack_delivery(p_event_id uuid,p_lease_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  UPDATE workflow.outbox_delivery d SET delivered_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error_code=NULL
    WHERE d.event_id=p_event_id AND d.consumer='mongo-records-v1' AND d.delivered_at IS NULL AND d.quarantined_at IS NULL
      AND d.lease_token=p_lease_token AND d.lease_until>clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION workflow.fail_delivery(p_event_id uuid,p_lease_token uuid,p_error_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,workflow,pg_temp AS $$
BEGIN
  IF p_error_code IS NULL OR p_error_code NOT IN ('MONGO_UNAVAILABLE','PROJECTION_CONFLICT','INVALID_EVENT','WORKER_INTERRUPTED') THEN
    RAISE EXCEPTION 'Invalid safe delivery error code' USING ERRCODE='22023';
  END IF;
  UPDATE workflow.outbox_delivery d SET failure_count=d.failure_count+1,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,power(2,least(d.failure_count,9))::integer)),
    quarantined_at=CASE WHEN d.failure_count+1>=8 THEN clock_timestamp() ELSE NULL END,
    lease_token=NULL,lease_until=NULL,last_error_code=p_error_code
    WHERE d.event_id=p_event_id AND d.consumer='mongo-records-v1' AND d.delivered_at IS NULL AND d.quarantined_at IS NULL
      AND d.lease_token=p_lease_token AND d.lease_until>clock_timestamp();
  RETURN FOUND;
END;
$$;

-- Ownership is deliberately separate from application logins/groups.
GRANT CREATE ON SCHEMA workflow TO scholarproof_workflow_owner;
DO $$ DECLARE fn record;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='workflow' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO scholarproof_workflow_owner',fn.signature);
  END LOOP;
END;
$$;
REVOKE CREATE ON SCHEMA workflow FROM scholarproof_workflow_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA workflow FROM PUBLIC;
GRANT USAGE ON SCHEMA workflow TO scholarproof_api_access,scholarproof_worker_access;
GRANT EXECUTE ON FUNCTION workflow.propose_change(text,uuid,uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text),
  workflow.approve_change(text,uuid,text),workflow.reject_change(text,uuid,text),workflow.get_change(text,uuid)
  TO scholarproof_api_access;
GRANT EXECUTE ON FUNCTION workflow.claim_deliveries(integer,integer),workflow.ack_delivery(uuid,uuid),workflow.fail_delivery(uuid,uuid,text)
  TO scholarproof_worker_access;
GRANT SELECT ON workflow.domain_event TO scholarproof_worker_access;

COMMENT ON FUNCTION workflow.approve_change(text,uuid,text) IS
  'Prototype two-registrar approval atomically appends grade facts, decision, audit event and outbox. Available SQL evidence metadata binds the reviewed bytes; no live Mongo availability or signed-credential publication is asserted.';
