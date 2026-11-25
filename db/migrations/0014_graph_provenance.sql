CREATE SCHEMA provenance;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='academic_graph_owner') THEN
    CREATE ROLE academic_graph_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='academic_graph_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='academic_graph_owner'))
  THEN RAISE EXCEPTION 'Unsafe graph function owner' USING ERRCODE='42501'; END IF;
END $$;

-- Project authoritative facts for accepted outbox events. Deliberately omit names,
-- credentials, narrative reasons, evidence bodies and exact grades.
CREATE VIEW provenance.approved_fact AS
SELECT p.institution_id, p.leaf_index, ev.event_id, ev.occurred_at, req.request_id,
  req.proposer_id, d.decider_id, g.record_id, d.version_no, enr.student_id, o.offering_id, o.course_id,
  ref.evidence_id, ref.digest_sha256::text AS digest,
  CASE WHEN prev.grade_points IS NOT NULL AND v.grade_points IS NOT NULL
    THEN ((v.grade_points-prev.grade_points)*100)::integer END AS delta_hundredths
FROM transparency.event_position p
JOIN workflow.domain_event ev USING(event_id)
JOIN workflow.outbox_delivery del USING(event_id)
JOIN workflow.change_request req USING(request_id)
JOIN workflow.decision d USING(request_id)
JOIN academic.grade_record g ON g.record_id=d.record_id AND g.institution_id=p.institution_id
JOIN academic.grade_version v ON v.record_id=g.record_id AND v.version_no=d.version_no
LEFT JOIN academic.grade_version prev ON prev.record_id=g.record_id AND prev.version_no=d.version_no-1
JOIN academic.enrolment enr USING(enrolment_id)
JOIN academic.course_offering o USING(offering_id)
JOIN evidence.reference ref ON ref.evidence_id=req.evidence_id AND ref.record_id=g.record_id
WHERE ev.kind='grade.accepted';

CREATE FUNCTION provenance.source_batch(p_scope uuid,p_after bigint,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,provenance,pg_temp AS $$
  WITH head AS (
    SELECT coalesce(s.tree_size,0) AS size FROM academic.institution i
    LEFT JOIN transparency.log_state s USING(institution_id) WHERE i.institution_id=p_scope
  ), slots AS (
    SELECT leaf_index,event_id FROM transparency.event_position
    WHERE institution_id=p_scope AND leaf_index>=p_after
    ORDER BY leaf_index LIMIT CASE WHEN p_limit BETWEEN 1 AND 100 THEN p_limit ELSE 0 END
  )
  SELECT jsonb_build_object('size',head.size,'slots',coalesce((
    SELECT jsonb_agg(jsonb_build_object('position',p.leaf_index,'accepted',coalesce(e.kind='grade.accepted',false),
      'fact',CASE WHEN f.event_id IS NULL THEN NULL ELSE
        to_jsonb(f)-'institution_id'-'leaf_index'-'occurred_at' ||
        jsonb_build_object('occurred_at',workflow.iso(f.occurred_at)) END) ORDER BY p.leaf_index)
    FROM slots p LEFT JOIN workflow.domain_event e USING(event_id)
    LEFT JOIN provenance.approved_fact f ON f.institution_id=p_scope AND f.leaf_index=p.leaf_index
  ),'[]'::jsonb)) FROM head
$$;

CREATE FUNCTION provenance.review_head(p_token text,p_scope uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,provenance,pg_temp AS $$
DECLARE actor uuid; head bigint;
BEGIN
  actor:=workflow.actor_for_session(p_token);
  IF NOT EXISTS(SELECT 1 FROM academic.role_assignment
    WHERE user_id=actor AND institution_id=p_scope AND role_code IN ('registrar','auditor')) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  SELECT tree_size INTO head FROM transparency.log_state WHERE institution_id=p_scope;
  RETURN coalesce(head,0);
END $$;

REVOKE ALL ON SCHEMA provenance FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA provenance FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA provenance FROM PUBLIC;
GRANT USAGE ON SCHEMA academic,workflow,evidence,transparency,access_control,provenance TO academic_graph_owner;
GRANT SELECT ON academic.institution,academic.grade_record,academic.grade_version,academic.enrolment,
  academic.course_offering,academic.app_user,academic.role_assignment,workflow.domain_event,workflow.outbox_delivery,
  workflow.change_request,workflow.decision,evidence.reference,transparency.log_state,transparency.event_position,
  access_control.api_session TO academic_graph_owner;
GRANT EXECUTE ON FUNCTION workflow.actor_for_session(text),workflow.iso(timestamptz) TO academic_graph_owner;
GRANT CREATE ON SCHEMA provenance TO academic_graph_owner;
ALTER VIEW provenance.approved_fact OWNER TO academic_graph_owner;
ALTER FUNCTION provenance.source_batch(uuid,bigint,integer) OWNER TO academic_graph_owner;
ALTER FUNCTION provenance.review_head(text,uuid) OWNER TO academic_graph_owner;
REVOKE CREATE ON SCHEMA provenance FROM academic_graph_owner;
GRANT USAGE ON SCHEMA provenance TO scholarproof_worker_access,scholarproof_api_access;
GRANT EXECUTE ON FUNCTION provenance.source_batch(uuid,bigint,integer) TO scholarproof_worker_access;
GRANT EXECUTE ON FUNCTION provenance.review_head(text,uuid) TO scholarproof_api_access;
