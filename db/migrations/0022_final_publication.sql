-- Final publication of pilot results after the paper-viewing window.
-- An exam approver who took no part in the offering's marks declares its results final once no
-- correction request is pending. The final publication records each enrolment's current grade
-- version and creates no new grade rows. After it, paper-viewing corrections are closed.

CREATE TABLE assessment.final_grade (
  publication_id uuid NOT NULL REFERENCES assessment.publication,
  record_id uuid NOT NULL REFERENCES academic.grade_record,
  version_no integer NOT NULL,
  PRIMARY KEY (publication_id, record_id),
  FOREIGN KEY (record_id, version_no) REFERENCES academic.grade_version(record_id, version_no)
);
CREATE TRIGGER final_grade_immutable BEFORE UPDATE OR DELETE ON assessment.final_grade
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER final_grade_member BEFORE INSERT ON assessment.final_grade
FOR EACH ROW EXECUTE FUNCTION assessment.guard_publication_member();

CREATE FUNCTION assessment.final_publication(p_offering uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT p.publication_id FROM assessment.publication p
  WHERE p.offering_id=p_offering AND p.kind='final'
$$;

-- Correction requests on the offering's records that have no decision yet.
CREATE FUNCTION assessment.pending_corrections(p_offering uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT count(*)::integer FROM workflow.change_request q
  JOIN evidence.reference r ON r.evidence_id=q.evidence_id
  JOIN academic.grade_record g ON g.record_id=r.record_id
  JOIN academic.enrolment e ON e.enrolment_id=g.enrolment_id
  WHERE e.offering_id=p_offering
    AND NOT EXISTS (SELECT FROM workflow.decision d WHERE d.request_id=q.request_id)
$$;

CREATE FUNCTION assessment.final_counts(p_final uuid, OUT records integer, OUT revised integer)
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT count(*)::integer, count(*) FILTER (WHERE f.version_no<>pg.version_no)::integer
  FROM assessment.final_grade f
  JOIN assessment.publication fp ON fp.publication_id=f.publication_id
  JOIN assessment.publication pp ON pp.offering_id=fp.offering_id AND pp.kind='provisional'
  JOIN assessment.publication_grade pg ON pg.publication_id=pp.publication_id
    AND pg.record_id=f.record_id
  WHERE f.publication_id=p_final
$$;

CREATE FUNCTION assessment.finalize_results(p_digest text,p_offering uuid)
RETURNS TABLE(publication_id uuid, published_at text, records integer, revised integer,
  created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; prior assessment.publication%ROWTYPE; provisional uuid; created_id uuid;
  stamp timestamptz; counts record;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  PERFORM assessment.authorize_publication(actor,p_offering);
  -- Serialized with paper-viewing proposals on the same offering.
  PERFORM pg_advisory_xact_lock(hashtextextended('publication:' || p_offering::text, 0));
  SELECT * INTO prior FROM assessment.publication p WHERE p.offering_id=p_offering AND p.kind='final';
  IF FOUND THEN
    IF prior.publisher_id=actor THEN
      SELECT * INTO counts FROM assessment.final_counts(prior.publication_id);
      RETURN QUERY SELECT prior.publication_id, workflow.iso(prior.published_at), counts.records,
        counts.revised, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'The offering already has final results' USING ERRCODE='AB014';
  END IF;
  SELECT p.publication_id INTO provisional FROM assessment.publication p
    WHERE p.offering_id=p_offering AND p.kind='provisional';
  IF provisional IS NULL THEN
    RAISE EXCEPTION 'Final results need a provisional publication' USING ERRCODE='AB012';
  END IF;
  IF assessment.pending_corrections(p_offering)>0 THEN
    RAISE EXCEPTION 'Correction requests are still pending' USING ERRCODE='AB013';
  END IF;
  INSERT INTO assessment.publication(offering_id,kind,publisher_id)
    VALUES(p_offering,'final',actor)
    RETURNING publication.publication_id, publication.published_at INTO created_id, stamp;
  INSERT INTO assessment.final_grade(publication_id,record_id,version_no)
    SELECT created_id, g.record_id, g.latest_version_no
    FROM assessment.publication_grade pg JOIN academic.grade_record g ON g.record_id=pg.record_id
    WHERE pg.publication_id=provisional;
  SELECT * INTO counts FROM assessment.final_counts(created_id);
  RETURN QUERY SELECT created_id, workflow.iso(stamp), counts.records, counts.revised, true;
END $$;

-- Paper-viewing proposals close once results are final: the context refuses them before any
-- evidence is stored, and the proposal checks again under the offering's lock.
CREATE OR REPLACE FUNCTION assessment.pvp_context(p_digest text,p_record uuid)
RETURNS TABLE(offering_id uuid, student_code text, latest_version integer, policy_id text,
  policy_version integer, attendance jsonb, marks jsonb, revisions jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target record;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  SELECT * INTO target FROM assessment.pvp_record(actor,p_record);
  IF EXISTS (SELECT FROM assessment.final_grade f WHERE f.record_id=p_record) THEN
    RAISE EXCEPTION 'Final results cannot be corrected' USING ERRCODE='AB011';
  END IF;
  RETURN QUERY
    SELECT e.offering_id, st.student_code, g.latest_version_no, op.policy_id, op.policy_version,
      jsonb_build_object('eligible',a.eligible,'percent',a.percent),
      assessment.published_marks(target.publication_id,target.enrolment_id),
      assessment.revisions(p_record)
    FROM academic.grade_record g
    JOIN academic.enrolment e ON e.enrolment_id=g.enrolment_id
    JOIN academic.student st ON st.student_id=e.student_id
    JOIN assessment.publication_attendance a ON a.publication_id=target.publication_id
      AND a.enrolment_id=target.enrolment_id
    JOIN assessment.offering_policy op ON op.offering_id=e.offering_id
    WHERE g.record_id=p_record;
END $$;

CREATE OR REPLACE FUNCTION assessment.propose_pvp(p_digest text,p_record uuid,p_key uuid,p_expected integer,
  p_evidence uuid,p_marks jsonb,p_grade_points numeric,p_outcome text,p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target record; offering uuid; effective timestamptz; stored jsonb; supplied jsonb;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF jsonb_typeof(p_marks) IS DISTINCT FROM 'object' OR p_marks='{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid revaluation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO target FROM assessment.pvp_record(actor,p_record);
  SELECT e.offering_id INTO offering FROM academic.enrolment e WHERE e.enrolment_id=target.enrolment_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('publication:' || offering::text, 0));
  IF assessment.final_publication(offering) IS NOT NULL THEN
    RAISE EXCEPTION 'Final results cannot be corrected' USING ERRCODE='AB011';
  END IF;
  IF NOT EXISTS (
    SELECT FROM evidence.reference r WHERE r.evidence_id=p_evidence AND r.record_id=p_record
      AND r.category='revaluation_request'
  ) THEN
    RAISE EXCEPTION 'Revaluation evidence must belong to the record' USING ERRCODE='23514';
  END IF;
  -- Every revised component needs an evaluated mark in the published inputs.
  IF EXISTS (
    SELECT FROM jsonb_object_keys(p_marks) k
    WHERE NOT EXISTS (
      SELECT FROM assessment.publication_input i JOIN assessment.mark m ON m.batch_id=i.batch_id
      WHERE i.publication_id=target.publication_id AND m.enrolment_id=target.enrolment_id
        AND m.component_code=k AND m.points IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Only evaluated published components can be revalued' USING ERRCODE='23514';
  END IF;
  SELECT jsonb_object_agg(k, v::numeric(6,2)) INTO supplied FROM jsonb_each_text(p_marks) AS x(k,v);
  SELECT jsonb_object_agg(m.component_code, m.points) INTO stored
    FROM assessment.pvp_mark m WHERE m.evidence_id=p_evidence;
  IF stored IS NULL THEN
    INSERT INTO assessment.pvp_mark(evidence_id,component_code,points)
      SELECT p_evidence, k, v::numeric(6,2) FROM jsonb_each_text(p_marks) AS x(k,v);
  ELSIF stored IS DISTINCT FROM supplied THEN
    RAISE EXCEPTION 'The evidence already records different revised marks' USING ERRCODE='23505';
  END IF;
  SELECT lower(v.valid_during) INTO effective FROM academic.grade_version v
    JOIN assessment.publication_grade pg ON pg.record_id=v.record_id AND pg.version_no=v.version_no
    WHERE pg.record_id=p_record AND pg.publication_id=target.publication_id;
  RETURN workflow.propose_change(p_digest,p_record,p_key,p_expected,p_grade_points,p_outcome,
    effective,NULL,p_evidence,p_reason);
END $$;

-- Final grades cannot change through any correction route.
CREATE OR REPLACE FUNCTION assessment.guard_published_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE target uuid;
BEGIN
  SELECT r.record_id INTO target FROM evidence.reference r WHERE r.evidence_id=NEW.evidence_id;
  IF EXISTS (SELECT FROM assessment.final_grade f WHERE f.record_id=target) THEN
    RAISE EXCEPTION 'A final pilot grade cannot be corrected' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT FROM assessment.publication_grade pg WHERE pg.record_id=target)
    AND NOT EXISTS (SELECT FROM assessment.pvp_mark m WHERE m.evidence_id=NEW.evidence_id) THEN
    RAISE EXCEPTION 'A published pilot grade changes only through paper viewing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- The publication view adds the final publication, pending corrections and final versions.
DROP FUNCTION assessment.publication_view(text,uuid);
CREATE FUNCTION assessment.publication_view(p_digest text,p_offering uuid)
RETURNS TABLE(publication_id uuid, kind text, publisher_subject text, published_at text,
  policy_id text, policy_version integer, inputs jsonb, results jsonb, final jsonb,
  pending_corrections integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target assessment.publication%ROWTYPE; closing assessment.publication%ROWTYPE;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT assessment.result_capable(actor) THEN
    RAISE EXCEPTION 'Reading results requires a results duty' USING ERRCODE='42501';
  END IF;
  IF NOT assessment.result_scope(actor,p_offering) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO target FROM assessment.publication p WHERE p.offering_id=p_offering AND p.kind='provisional';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The offering has no published results' USING ERRCODE='AB010';
  END IF;
  SELECT * INTO closing FROM assessment.publication p WHERE p.offering_id=p_offering AND p.kind='final';
  RETURN QUERY
    SELECT target.publication_id, target.kind, u.auth_subject, workflow.iso(target.published_at),
      op.policy_id, op.policy_version,
      (SELECT jsonb_agg(jsonb_build_object('batchId',b.batch_id,'stage',b.stage,
          'revisionNo',b.revision_no) ORDER BY b.stage)
       FROM assessment.publication_input i JOIN assessment.batch b ON b.batch_id=i.batch_id
       WHERE i.publication_id=target.publication_id),
      (SELECT coalesce(jsonb_agg(jsonb_build_object('enrolmentId',a.enrolment_id,
          'studentCode',st.student_code,'recordId',g.record_id,'versionNo',v.version_no,
          'gradePoints',v.grade_points,'outcome',v.outcome,
          'current',jsonb_build_object('versionNo',cv.version_no,'gradePoints',cv.grade_points,
            'outcome',cv.outcome),
          'finalVersionNo',(SELECT f.version_no FROM assessment.final_grade f
            WHERE f.publication_id=closing.publication_id AND f.record_id=g.record_id),
          'attendance',jsonb_build_object('eligible',a.eligible,'percent',a.percent),
          'marks',assessment.published_marks(target.publication_id,a.enrolment_id),
          'revisions',assessment.revisions(g.record_id))
        ORDER BY st.student_code), '[]'::jsonb)
       FROM assessment.publication_attendance a
       JOIN academic.enrolment e ON e.enrolment_id=a.enrolment_id
       JOIN academic.student st ON st.student_id=e.student_id
       JOIN academic.grade_record g ON g.enrolment_id=a.enrolment_id
       JOIN assessment.publication_grade pg ON pg.publication_id=target.publication_id
         AND pg.record_id=g.record_id
       JOIN academic.grade_version v ON v.record_id=pg.record_id AND v.version_no=pg.version_no
       JOIN academic.grade_version cv ON cv.record_id=g.record_id AND cv.version_no=g.latest_version_no
       WHERE a.publication_id=target.publication_id),
      (SELECT jsonb_build_object('publicationId',closing.publication_id,
          'publisherSubject',fu.auth_subject,'publishedAt',workflow.iso(closing.published_at))
       FROM academic.app_user fu WHERE fu.user_id=closing.publisher_id),
      assessment.pending_corrections(p_offering)
    FROM academic.app_user u
    JOIN assessment.offering_policy op ON op.offering_id=target.offering_id
    WHERE u.user_id=target.publisher_id;
END $$;

-- Students see the Final label and time once results are final.
CREATE OR REPLACE FUNCTION assessment.my_results(p_digest text)
RETURNS TABLE(offering_id uuid, record_id uuid, course_code text, section_code text,
  term_code text, kind text, published_at text, policy_id text, policy_version integer,
  published_version integer, version_no integer, grade_points numeric, outcome text,
  attendance jsonb, marks jsonb, revisions jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT EXISTS (
    SELECT FROM academic.role_assignment WHERE user_id=actor AND role_code='student'
  ) THEN
    RAISE EXCEPTION 'Own results are for students' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT p.offering_id, g.record_id, c.course_code, o.section_code, t.term_code,
      coalesce(fp.kind,p.kind), workflow.iso(coalesce(fp.published_at,p.published_at)),
      op.policy_id, op.policy_version, pg.version_no, cv.version_no, cv.grade_points, cv.outcome,
      jsonb_build_object('eligible',a.eligible,'percent',a.percent),
      assessment.published_marks(p.publication_id,e.enrolment_id), assessment.revisions(g.record_id)
    FROM academic.student st
    JOIN academic.enrolment e ON e.student_id=st.student_id
    JOIN assessment.publication p ON p.offering_id=e.offering_id AND p.kind='provisional'
    LEFT JOIN assessment.publication fp ON fp.offering_id=p.offering_id AND fp.kind='final'
    JOIN assessment.publication_attendance a ON a.publication_id=p.publication_id
      AND a.enrolment_id=e.enrolment_id
    JOIN academic.grade_record g ON g.enrolment_id=e.enrolment_id
    JOIN assessment.publication_grade pg ON pg.publication_id=p.publication_id AND pg.record_id=g.record_id
    JOIN academic.grade_version cv ON cv.record_id=g.record_id AND cv.version_no=g.latest_version_no
    JOIN academic.course_offering_context o ON o.offering_id=p.offering_id
    JOIN academic.course c ON c.course_id=o.course_id
    JOIN academic.academic_term t ON t.term_id=o.term_id
    JOIN assessment.offering_policy op ON op.offering_id=p.offering_id
    WHERE st.user_id=actor
    ORDER BY t.term_code, c.course_code, p.published_at;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA assessment FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA assessment FROM PUBLIC;
GRANT SELECT,INSERT ON assessment.final_grade TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.final_publication(uuid),assessment.pending_corrections(uuid),
  assessment.final_counts(uuid),assessment.authorize_publication(uuid,uuid),
  assessment.publisher_capable(uuid),assessment.publisher_scope(uuid,uuid),
  assessment.offering_participant(uuid,uuid),assessment.pvp_record(uuid,uuid),
  assessment.revisions(uuid),assessment.published_marks(uuid,uuid),assessment.result_capable(uuid),
  assessment.result_scope(uuid,uuid),assessment.offering_scope(uuid),
  assessment.active_delegations(uuid,timestamptz) TO academic_assessment_owner;
ALTER FUNCTION assessment.finalize_results(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.publication_view(text,uuid) OWNER TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.guard_published_change() TO scholarproof_workflow_owner;
GRANT EXECUTE ON FUNCTION assessment.entry_context(text,uuid,text),
  assessment.create_revision(text,uuid,text,integer,uuid,jsonb),assessment.submit_batch(text,uuid),
  assessment.list_batches(text,uuid),assessment.read_batch(text,uuid),
  assessment.validate_batch(text,uuid,text),assessment.review_batch(text,uuid,text,text),
  assessment.review_queue(text),assessment.validation_queue(text),
  assessment.publication_inputs(text,uuid),
  assessment.publish_results(text,uuid,uuid,uuid,jsonb,jsonb),
  assessment.publication_view(text,uuid),assessment.my_results(text),
  assessment.pvp_context(text,uuid),
  assessment.propose_pvp(text,uuid,uuid,integer,uuid,jsonb,numeric,text,text),
  assessment.my_desk(text),assessment.finalize_results(text,uuid) TO scholarproof_api_access;
