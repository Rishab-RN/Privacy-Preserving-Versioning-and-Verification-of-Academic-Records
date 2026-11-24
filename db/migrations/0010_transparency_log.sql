-- Per-institution committed-order positions. The runner supplies one transaction.
-- Historical events have no recoverable SQL commit order: bootstrap ordering is
-- explicitly (occurred_at,event_id), not a claim about their original commits.
LOCK TABLE workflow.domain_event IN SHARE ROW EXCLUSIVE MODE;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE SCHEMA transparency;

DO $$
DECLARE role_name text; role_id oid; reader_id oid;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['academic_log_owner','academic_log_reader','academic_log_signer'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    SELECT oid INTO STRICT role_id FROM pg_roles WHERE rolname=role_name;
    SELECT oid INTO reader_id FROM pg_roles WHERE rolname='academic_log_reader';
    IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=role_id AND
      (rolcanlogin OR NOT rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolconfig IS NOT NULL))
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_id AND
        (role_name<>'academic_log_signer' OR roleid IS DISTINCT FROM reader_id OR admin_option OR NOT inherit_option))
      OR (role_name='academic_log_owner' AND EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=role_id))
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=role_id)
      OR has_database_privilege(role_id,current_database(),'CREATE')
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=role_id OR
        (nspname IN ('academic','access_control','evidence','workflow','transparency') AND has_schema_privilege(role_id,oid,'CREATE')))
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=role_id)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=role_id)
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('academic','access_control','evidence','workflow','transparency') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(role_id,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(role_id,c.oid,'INSERT,UPDATE,REFERENCES')))
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='access_control' AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(role_id,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(role_id,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'Existing transparency role has incompatible flags, ownership or memberships' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid
    JOIN pg_roles r ON r.oid=m.member WHERE p.rolname IN ('academic_log_owner','academic_log_reader','academic_log_signer')
      AND r.rolname IN ('scholarproof_api_access','scholarproof_worker_access','scholarproof_workflow_owner')) THEN
    RAISE EXCEPTION 'Application roles cannot inherit transparency roles' USING ERRCODE='42501';
  END IF;
END;
$$;
GRANT academic_log_reader TO academic_log_signer;

CREATE TABLE transparency.log_state (
  institution_id uuid PRIMARY KEY REFERENCES academic.institution(institution_id),
  tree_size bigint NOT NULL DEFAULT 0 CHECK(tree_size BETWEEN 0 AND 9007199254740991),
  bootstrap_size bigint NOT NULL DEFAULT 0 CHECK(bootstrap_size BETWEEN 0 AND tree_size)
);
CREATE TABLE transparency.event_position (
  event_id uuid PRIMARY KEY REFERENCES workflow.domain_event(event_id),
  institution_id uuid NOT NULL REFERENCES transparency.log_state(institution_id),
  leaf_index bigint NOT NULL CHECK(leaf_index BETWEEN 0 AND 9007199254740990),
  salt bytea NOT NULL CHECK(octet_length(salt)=32),
  UNIQUE(institution_id,leaf_index)
);
CREATE TABLE transparency.checkpoint (
  institution_id uuid NOT NULL REFERENCES transparency.log_state(institution_id),
  tree_size bigint NOT NULL CHECK(tree_size BETWEEN 0 AND 9007199254740991),
  root_hash bytea NOT NULL CHECK(octet_length(root_hash)=32),
  issued_at timestamptz(3) NOT NULL CHECK(isfinite(issued_at)
    AND issued_at>=timestamptz '0001-01-01 00:00:00+00' AND issued_at<timestamptz '10000-01-01 00:00:00+00'),
  key_id text NOT NULL CHECK(key_id ~ '^[a-f0-9]{64}$'),
  signature bytea NOT NULL CHECK(octet_length(signature)=64),
  PRIMARY KEY(institution_id,tree_size)
);

-- Resolve pgcrypto's installed namespace once. The resulting function calls its
-- fully qualified extension function, including when pgcrypto predates this migration.
DO $$
DECLARE crypto_schema name;
BEGIN
  SELECT n.nspname INTO STRICT crypto_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
  EXECUTE format('CREATE FUNCTION transparency.random_salt() RETURNS bytea LANGUAGE sql VOLATILE
    SET search_path=pg_catalog,pg_temp AS %L',format('SELECT %I.gen_random_bytes(32)',crypto_schema));
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO academic_log_owner',crypto_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.gen_random_bytes(integer) TO academic_log_owner',crypto_schema);
END;
$$;

INSERT INTO transparency.log_state(institution_id,tree_size,bootstrap_size)
SELECT g.institution_id,count(*),count(*) FROM workflow.domain_event d
  JOIN workflow.change_request q USING(request_id) JOIN evidence.reference e USING(evidence_id)
  JOIN academic.grade_record g USING(record_id) GROUP BY g.institution_id;
INSERT INTO transparency.event_position(event_id,institution_id,leaf_index,salt)
SELECT d.event_id,g.institution_id,
  row_number() OVER(PARTITION BY g.institution_id ORDER BY d.occurred_at,d.event_id)-1,
  transparency.random_salt()
FROM workflow.domain_event d JOIN workflow.change_request q USING(request_id)
  JOIN evidence.reference e USING(evidence_id) JOIN academic.grade_record g USING(record_id);

DO $$
BEGIN
  IF (SELECT count(*) FROM workflow.domain_event)<>(SELECT count(*) FROM transparency.event_position)
    OR EXISTS(SELECT 1 FROM transparency.log_state s WHERE s.tree_size<>
      (SELECT count(*) FROM transparency.event_position p WHERE p.institution_id=s.institution_id)) THEN
    RAISE EXCEPTION 'Transparency bootstrap did not preserve every existing event' USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE FUNCTION transparency.guard_log_state() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,transparency,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'A transparency log cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.institution_id IS DISTINCT FROM OLD.institution_id
    OR NEW.bootstrap_size IS DISTINCT FROM OLD.bootstrap_size
    OR NEW.tree_size IS DISTINCT FROM OLD.tree_size+1 THEN
    RAISE EXCEPTION 'Only a single append may advance a transparency log' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER log_state_append_only BEFORE UPDATE OR DELETE ON transparency.log_state
FOR EACH ROW EXECUTE FUNCTION transparency.guard_log_state();

CREATE FUNCTION transparency.guard_event_position() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE tenant uuid; head bigint;
BEGIN
  SELECT g.institution_id INTO tenant FROM workflow.domain_event d
    JOIN workflow.change_request q USING(request_id) JOIN evidence.reference e USING(evidence_id)
    JOIN academic.grade_record g USING(record_id) WHERE d.event_id=NEW.event_id;
  IF tenant IS NULL OR tenant IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'An event position must match its authoritative institutional scope' USING ERRCODE='23503';
  END IF;
  SELECT tree_size INTO head FROM transparency.log_state WHERE institution_id=tenant;
  IF NEW.leaf_index IS DISTINCT FROM head-1 THEN
    RAISE EXCEPTION 'An event position must occupy the current append slot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_position_scope BEFORE INSERT ON transparency.event_position
FOR EACH ROW EXECUTE FUNCTION transparency.guard_event_position();
CREATE TRIGGER event_position_immutable BEFORE UPDATE OR DELETE ON transparency.event_position
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER checkpoint_immutable BEFORE UPDATE OR DELETE ON transparency.checkpoint
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

CREATE FUNCTION transparency.sequence_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE tenant uuid; slot bigint;
BEGIN
  SELECT g.institution_id INTO tenant FROM workflow.change_request q
    JOIN evidence.reference e USING(evidence_id) JOIN academic.grade_record g USING(record_id)
    WHERE q.request_id=NEW.request_id;
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'A transparency event needs an authoritative institution' USING ERRCODE='23503';
  END IF;
  INSERT INTO transparency.log_state(institution_id) VALUES(tenant) ON CONFLICT(institution_id) DO NOTHING;
  -- The row lock survives until the outer workflow transaction commits/rolls back.
  UPDATE transparency.log_state SET tree_size=tree_size+1 WHERE institution_id=tenant RETURNING tree_size-1 INTO slot;
  INSERT INTO transparency.event_position(event_id,institution_id,leaf_index,salt)
    VALUES(NEW.event_id,tenant,slot,transparency.random_salt());
  RETURN NEW;
END;
$$;
CREATE TRIGGER domain_event_transparency AFTER INSERT ON workflow.domain_event
FOR EACH ROW EXECUTE FUNCTION transparency.sequence_event();

-- Reconstruct authoritative facts instead of trusting a saved payload/hash column.
-- Submission precedes any decision, even when this audit runs after approval.
CREATE FUNCTION transparency.read_expected_event(p_event_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE STRICT
SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE event_row workflow.domain_event%ROWTYPE; req workflow.change_request_context%ROWTYPE;
  evidence_row evidence.reference_context%ROWTYPE; decision_row workflow.decision_context%ROWTYPE;
  grade_row academic.grade_version_context%ROWTYPE; tenant uuid; actor uuid; result_version integer;
BEGIN
  SELECT * INTO event_row FROM workflow.domain_event WHERE event_id=p_event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO STRICT req FROM workflow.change_request_context WHERE request_id=event_row.request_id;
  SELECT * INTO STRICT evidence_row FROM evidence.reference_context WHERE evidence_id=req.evidence_id;
  SELECT institution_id INTO STRICT tenant FROM academic.grade_record WHERE record_id=req.record_id;
  IF event_row.kind='request.submitted' THEN
    actor:=req.proposer_id;
  ELSE
    SELECT * INTO STRICT decision_row FROM workflow.decision_context WHERE request_id=req.request_id;
    IF decision_row.record_id IS DISTINCT FROM req.record_id
      OR (event_row.kind='grade.accepted' AND decision_row.decision_code<>'approved')
      OR (event_row.kind='request.rejected' AND decision_row.decision_code<>'rejected')
      OR event_row.kind NOT IN ('grade.accepted','request.rejected') THEN
      RAISE EXCEPTION 'Event kind must agree with its authoritative decision' USING ERRCODE='23514';
    END IF;
    actor:=decision_row.decider_id;
    result_version:=decision_row.version_no;
    IF result_version IS NOT NULL THEN
      SELECT * INTO STRICT grade_row FROM academic.grade_version_context
        WHERE record_id=req.record_id AND version_no=result_version;
    END IF;
  END IF;
  RETURN jsonb_build_object('schemaVersion',1,'eventId',event_row.event_id,'kind',event_row.kind,
    'institutionId',tenant,'recordId',req.record_id,'requestId',req.request_id,'actorId',actor,
    'occurredAt',workflow.iso(event_row.occurred_at),'proposerId',req.proposer_id,
    'evidence',jsonb_build_object('evidenceId',evidence_row.evidence_id,'digestSha256',evidence_row.digest_sha256,'sizeBytes',evidence_row.size_bytes),
    'proposal',jsonb_build_object('expectedVersion',req.expected_version,'gradePoints',req.grade_points::text,
      'outcome',req.outcome,'validFrom',workflow.iso(lower(req.valid_during)),
      'validUntil',CASE WHEN upper_inf(req.valid_during) THEN NULL ELSE workflow.iso(upper(req.valid_during)) END,
      'reason',req.reason,'submittedAt',workflow.iso(req.created_at)),
    'decision',CASE WHEN decision_row.request_id IS NULL THEN NULL ELSE jsonb_build_object(
      'code',decision_row.decision_code,'actorId',decision_row.decider_id,'reason',decision_row.reason,
      'versionNo',decision_row.version_no,'decidedAt',workflow.iso(decision_row.decided_at)) END,
    'revision',CASE WHEN result_version IS NULL THEN NULL ELSE jsonb_build_object(
      'versionNo',grade_row.version_no,'previousVersionNo',grade_row.previous_version_no,
      'gradePoints',grade_row.grade_points::text,'outcome',grade_row.outcome,
      'validFrom',workflow.iso(lower(grade_row.valid_during)),
      'validUntil',CASE WHEN upper_inf(grade_row.valid_during) THEN NULL ELSE workflow.iso(upper(grade_row.valid_during)) END,
      'recordedAt',workflow.iso(grade_row.recorded_at),'authorId',grade_row.author_id,'reason',grade_row.reason) END);
END;
$$;

CREATE FUNCTION transparency.record_checkpoint(p_institution uuid,p_tree_size bigint,p_root_hash bytea,
  p_issued_at timestamptz,p_key_id text,p_signature bytea) RETURNS transparency.checkpoint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE head transparency.log_state%ROWTYPE; existing transparency.checkpoint%ROWTYPE;
  prefix_count bigint; first_index bigint; last_index bigint;
BEGIN
  IF p_institution IS NULL OR p_tree_size IS NULL OR p_tree_size<0 OR p_tree_size>9007199254740991
    OR p_root_hash IS NULL OR octet_length(p_root_hash)<>32 OR p_signature IS NULL OR octet_length(p_signature)<>64
    OR p_key_id IS NULL OR p_key_id !~ '^[a-f0-9]{64}$' OR p_issued_at IS NULL OR NOT isfinite(p_issued_at)
    OR p_issued_at<timestamptz '0001-01-01 00:00:00+00' OR p_issued_at>=timestamptz '10000-01-01 00:00:00+00'
    OR p_issued_at IS DISTINCT FROM date_trunc('milliseconds',p_issued_at) THEN
    RAISE EXCEPTION 'Invalid checkpoint fields' USING ERRCODE='22023';
  END IF;
  INSERT INTO transparency.log_state(institution_id) VALUES(p_institution) ON CONFLICT(institution_id) DO NOTHING;
  SELECT * INTO STRICT head FROM transparency.log_state WHERE institution_id=p_institution FOR UPDATE;
  IF p_tree_size>head.tree_size OR p_tree_size<head.bootstrap_size THEN
    RAISE EXCEPTION 'Checkpoint size must describe an available post-bootstrap prefix' USING ERRCODE='23514';
  END IF;
  SELECT count(*),min(leaf_index),max(leaf_index) INTO prefix_count,first_index,last_index
    FROM transparency.event_position WHERE institution_id=p_institution AND leaf_index<p_tree_size;
  IF prefix_count<>p_tree_size OR (p_tree_size>0 AND (first_index<>0 OR last_index<>p_tree_size-1)) THEN
    RAISE EXCEPTION 'Checkpoint prefix contains missing positions' USING ERRCODE='23514';
  END IF;
  SELECT * INTO existing FROM transparency.checkpoint WHERE institution_id=p_institution AND tree_size=p_tree_size;
  IF FOUND THEN
    IF existing.root_hash IS DISTINCT FROM p_root_hash OR existing.issued_at IS DISTINCT FROM p_issued_at
      OR existing.key_id IS DISTINCT FROM p_key_id OR existing.signature IS DISTINCT FROM p_signature THEN
      RAISE EXCEPTION 'A checkpoint already binds different evidence at this size' USING ERRCODE='23505';
    END IF;
    RETURN existing;
  END IF;
  INSERT INTO transparency.checkpoint(institution_id,tree_size,root_hash,issued_at,key_id,signature)
    VALUES(p_institution,p_tree_size,p_root_hash,p_issued_at,p_key_id,p_signature) RETURNING * INTO existing;
  RETURN existing;
END;
$$;

REVOKE ALL ON SCHEMA transparency FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA transparency FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA transparency FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA transparency REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA transparency,academic,evidence,workflow TO academic_log_owner,academic_log_reader;
GRANT SELECT,INSERT ON transparency.log_state,transparency.event_position,transparency.checkpoint TO academic_log_owner;
GRANT UPDATE(tree_size) ON transparency.log_state TO academic_log_owner;
GRANT SELECT ON workflow.domain_event,workflow.change_request,evidence.reference,academic.grade_record TO academic_log_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA transparency TO academic_log_reader;
GRANT SELECT ON workflow.domain_event,workflow.domain_event_context,workflow.change_request,workflow.change_request_context,
  workflow.decision,workflow.decision_context,workflow.outbox_delivery,evidence.reference,evidence.reference_context,
  academic.institution,academic.grade_record,academic.grade_version,academic.grade_version_context,
  academic.grade_temporal_segment,academic.grade_temporal_segment_context,academic.enrolment,academic.enrolment_context,
  academic.course_offering,academic.course_offering_context,academic.course,academic.academic_term,
  academic.grading_scheme TO academic_log_reader;
GRANT EXECUTE ON FUNCTION workflow.iso(timestamptz),transparency.read_expected_event(uuid) TO academic_log_reader;
GRANT EXECUTE ON FUNCTION transparency.record_checkpoint(uuid,bigint,bytea,timestamptz,text,bytea) TO academic_log_signer;

GRANT CREATE ON SCHEMA transparency TO academic_log_owner;
DO $$ DECLARE fn record;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='transparency' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO academic_log_owner',fn.signature);
  END LOOP;
END;
$$;
REVOKE CREATE ON SCHEMA transparency FROM academic_log_owner;

COMMENT ON TABLE transparency.log_state IS
  'BCNF key institution_id. Serialized transactional append counter; bootstrap_size is a frozen migration import boundary, not recovered historical commit order.';
COMMENT ON TABLE transparency.event_position IS
  'BCNF keys event_id and (institution_id,leaf_index). Private random salt; no public payloads, copied constants or persisted commitment cache.';
COMMENT ON TABLE transparency.checkpoint IS
  'BCNF key (institution_id,tree_size). Operator key IDs may authorize multiple logs. Bootstrap size derives from log_state; profile/algorithm constants are encoded by the versioned verifier profile.';
COMMENT ON FUNCTION transparency.record_checkpoint(uuid,bigint,bytea,timestamptz,text,bytea) IS
  'Trusted signer persistence boundary, not SQL signature/root verification. Sign only a committed snapshot on a separate connection; independently verify pinned-key signatures and actual-payload roots before exporting after commit.';
COMMENT ON FUNCTION transparency.read_expected_event(uuid) IS
  'Private invoker audit reconstruction from current immutable authoritative SQL facts; submission decision/revision remain null after later decisions. Unknown event IDs return null.';
