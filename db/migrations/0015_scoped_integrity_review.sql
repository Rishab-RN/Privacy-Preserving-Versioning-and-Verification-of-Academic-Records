-- Read one authorized approval and independently reconstruct its committed event.
CREATE FUNCTION transparency.review_event(p_token_digest text,p_request_id uuid,p_entry jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE request jsonb; tenant uuid; head bigint; event uuid; position bigint;
  actual jsonb; expected jsonb; salt bytea;
BEGIN
  request:=workflow.get_change(p_token_digest,p_request_id);
  SELECT institution_id INTO STRICT tenant FROM academic.grade_record
    WHERE record_id=(request->>'recordId')::uuid;
  SELECT tree_size INTO head FROM transparency.log_state WHERE institution_id=tenant;
  head:=coalesce(head,0);
  IF request#>>'{decision,code}' IS DISTINCT FROM 'approved' THEN
    RETURN jsonb_build_object('status','not-approved','scope',tenant,'head',head);
  END IF;
  BEGIN
    SELECT e.event_id,p.leaf_index,e.payload,p.salt INTO STRICT event,position,actual,salt
    FROM workflow.domain_event e LEFT JOIN transparency.event_position p
      ON p.event_id=e.event_id AND p.institution_id=tenant
    WHERE e.request_id=p_request_id AND e.kind='grade.accepted';
    expected:=transparency.read_expected_event(event);
  EXCEPTION WHEN no_data_found OR too_many_rows OR check_violation THEN
    RETURN jsonb_build_object('status','journal-mismatch','scope',tenant,'head',head);
  END;
  IF position IS NULL OR position>=head OR expected IS NULL OR actual IS DISTINCT FROM expected THEN
    RETURN jsonb_build_object('status','journal-mismatch','scope',tenant,'head',head);
  END IF;
  RETURN jsonb_build_object('status','ready','scope',tenant,'head',head,
    'eventId',event,'matches',coalesce(
      p_entry->'index'=to_jsonb(position) AND p_entry->>'salt'=encode(salt,'hex')
      AND p_entry->'payload'=expected,false));
END $$;

REVOKE ALL ON FUNCTION transparency.review_event(text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow.get_change(text,uuid),transparency.read_expected_event(uuid) TO academic_graph_owner;
GRANT SELECT ON workflow.change_request_context,workflow.decision_context,
  academic.grade_version_context,evidence.reference_context TO academic_graph_owner;
GRANT CREATE ON SCHEMA transparency TO academic_graph_owner;
ALTER FUNCTION transparency.review_event(text,uuid,jsonb) OWNER TO academic_graph_owner;
REVOKE CREATE ON SCHEMA transparency FROM academic_graph_owner;
GRANT USAGE ON SCHEMA transparency TO scholarproof_api_access;
GRANT EXECUTE ON FUNCTION transparency.review_event(text,uuid,jsonb) TO scholarproof_api_access;
