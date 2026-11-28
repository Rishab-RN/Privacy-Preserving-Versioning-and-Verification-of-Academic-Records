-- T6 paper-viewing (PVP) corrections of published pilot grades.
-- After provisional publication an expert team may revalue SEE theory scripts. A registrar
-- records the revised marks with revaluation evidence and proposes the recomputed grade through
-- the existing correction workflow; a different registrar approves it into a new grade version.
-- A published pilot grade changes only through such a revaluation.

-- The evidence determines the record and the proposer, so neither is stored again.
CREATE TABLE assessment.pvp_mark (
  evidence_id uuid NOT NULL REFERENCES evidence.reference,
  component_code text NOT NULL CHECK (component_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  points numeric(6,2) NOT NULL CHECK (points >= 0),
  PRIMARY KEY (evidence_id, component_code)
);
CREATE TRIGGER pvp_mark_immutable BEFORE UPDATE OR DELETE ON assessment.pvp_mark
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

-- Revised marks from approved PVP corrections of a record, later versions winning.
CREATE FUNCTION assessment.revisions(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(m.component_code, m.points ORDER BY d.version_no, m.component_code),
      '{}'::jsonb)
  FROM workflow.decision d
  JOIN workflow.change_request q ON q.request_id=d.request_id
  JOIN assessment.pvp_mark m ON m.evidence_id=q.evidence_id
  WHERE d.record_id=p_record AND d.version_no IS NOT NULL
$$;

-- Registrars of the record's institution may correct its published grade.
CREATE FUNCTION assessment.pvp_record(p_actor uuid,p_record uuid)
RETURNS TABLE(publication_id uuid, enrolment_id uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM academic.role_assignment ra JOIN academic.app_user u ON u.user_id=ra.user_id
    WHERE ra.user_id=p_actor AND ra.role_code='registrar' AND u.account_state='active'
  ) THEN
    RAISE EXCEPTION 'Paper-viewing corrections require a registrar' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT pg.publication_id, g.enrolment_id
    FROM academic.grade_record g
    JOIN assessment.publication_grade pg ON pg.record_id=g.record_id
    JOIN academic.role_assignment ra ON ra.institution_id=g.institution_id AND ra.user_id=p_actor
      AND ra.role_code='registrar'
    WHERE g.record_id=p_record;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002'; END IF;
END $$;

-- What the API needs to apply a revaluation: the published inputs and earlier revisions.
CREATE FUNCTION assessment.pvp_context(p_digest text,p_record uuid)
RETURNS TABLE(offering_id uuid, student_code text, latest_version integer, policy_id text,
  policy_version integer, attendance jsonb, marks jsonb, revisions jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target record;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  SELECT * INTO target FROM assessment.pvp_record(actor,p_record);
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

-- Records the revised marks and proposes the API-computed grade through the existing workflow,
-- effective over the same period as the published version.
CREATE FUNCTION assessment.propose_pvp(p_digest text,p_record uuid,p_key uuid,p_expected integer,
  p_evidence uuid,p_marks jsonb,p_grade_points numeric,p_outcome text,p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target record; effective timestamptz; stored jsonb; supplied jsonb;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF jsonb_typeof(p_marks) IS DISTINCT FROM 'object' OR p_marks='{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid revaluation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO target FROM assessment.pvp_record(actor,p_record);
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

-- Corrections of a published pilot grade must carry PVP revised marks.
CREATE FUNCTION assessment.guard_published_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT FROM evidence.reference r JOIN assessment.publication_grade pg ON pg.record_id=r.record_id
    WHERE r.evidence_id=NEW.evidence_id
  ) AND NOT EXISTS (SELECT FROM assessment.pvp_mark m WHERE m.evidence_id=NEW.evidence_id) THEN
    RAISE EXCEPTION 'A published pilot grade changes only through paper viewing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_request_published_guard BEFORE INSERT ON workflow.change_request
FOR EACH ROW EXECUTE FUNCTION assessment.guard_published_change();

-- Results now show the current version, recomputed from the published inputs and approved
-- revaluations, alongside the published version.
CREATE OR REPLACE FUNCTION assessment.publication_view(p_digest text,p_offering uuid)
RETURNS TABLE(publication_id uuid, kind text, publisher_subject text, published_at text,
  policy_id text, policy_version integer, inputs jsonb, results jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target assessment.publication%ROWTYPE;
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
       WHERE a.publication_id=target.publication_id)
    FROM academic.app_user u
    JOIN assessment.offering_policy op ON op.offering_id=target.offering_id
    WHERE u.user_id=target.publisher_id;
END $$;

DROP FUNCTION assessment.my_results(text);
CREATE FUNCTION assessment.my_results(p_digest text)
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
    SELECT p.offering_id, g.record_id, c.course_code, o.section_code, t.term_code, p.kind,
      workflow.iso(p.published_at), op.policy_id, op.policy_version, pg.version_no,
      cv.version_no, cv.grade_points, cv.outcome,
      jsonb_build_object('eligible',a.eligible,'percent',a.percent),
      assessment.published_marks(p.publication_id,e.enrolment_id), assessment.revisions(g.record_id)
    FROM academic.student st
    JOIN academic.enrolment e ON e.student_id=st.student_id
    JOIN assessment.publication p ON p.offering_id=e.offering_id
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
GRANT SELECT,INSERT ON assessment.pvp_mark TO academic_assessment_owner;
GRANT SELECT ON workflow.decision TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION workflow.propose_change(text,uuid,uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)
  TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.revisions(uuid),assessment.pvp_record(uuid,uuid),
  assessment.published_marks(uuid,uuid),assessment.result_capable(uuid),
  assessment.result_scope(uuid,uuid),assessment.offering_scope(uuid) TO academic_assessment_owner;
ALTER FUNCTION assessment.pvp_context(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.propose_pvp(text,uuid,uuid,integer,uuid,jsonb,numeric,text,text)
  OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.guard_published_change() OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.publication_view(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.my_results(text) OWNER TO academic_assessment_owner;
-- The workflow owner inserts change requests, which fires the guard.
GRANT USAGE ON SCHEMA assessment TO scholarproof_workflow_owner;
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
  assessment.propose_pvp(text,uuid,uuid,integer,uuid,jsonb,numeric,text,text)
  TO scholarproof_api_access;
