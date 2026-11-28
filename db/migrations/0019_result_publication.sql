-- T5 authorized provisional publication of pilot results.
-- An exam approver who took no part in an offering's marks publishes its approved CIE head and
-- submitted SEE head. One transaction records the publication, its inputs and the imported
-- attendance, and appends version 1 of every enrolment's grade to the temporal grade store.
-- The offering determines the frozen policy, so the policy is not stored again.

CREATE TABLE assessment.publication (
  publication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES assessment.offering_policy,
  kind text NOT NULL CHECK (kind IN ('provisional', 'final')),
  publisher_id uuid NOT NULL REFERENCES academic.app_user,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(published_at)),
  UNIQUE (offering_id, kind)
);

CREATE TABLE assessment.publication_input (
  publication_id uuid NOT NULL REFERENCES assessment.publication,
  batch_id uuid NOT NULL REFERENCES assessment.batch,
  PRIMARY KEY (publication_id, batch_id)
);

CREATE TABLE assessment.publication_attendance (
  publication_id uuid NOT NULL REFERENCES assessment.publication,
  enrolment_id uuid NOT NULL REFERENCES academic.enrolment,
  eligible boolean NOT NULL,
  percent numeric(5,2) CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  PRIMARY KEY (publication_id, enrolment_id)
);

CREATE TABLE assessment.publication_grade (
  record_id uuid NOT NULL,
  version_no integer NOT NULL,
  publication_id uuid NOT NULL REFERENCES assessment.publication,
  PRIMARY KEY (record_id, version_no),
  UNIQUE (publication_id, record_id),
  FOREIGN KEY (record_id, version_no) REFERENCES academic.grade_version(record_id, version_no)
);

CREATE TRIGGER publication_immutable BEFORE UPDATE OR DELETE ON assessment.publication
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER publication_input_immutable BEFORE UPDATE OR DELETE ON assessment.publication_input
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER publication_attendance_immutable BEFORE UPDATE OR DELETE ON assessment.publication_attendance
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER publication_grade_immutable BEFORE UPDATE OR DELETE ON assessment.publication_grade
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

-- Inputs, attendance and grades must belong to the published offering.
CREATE FUNCTION assessment.guard_publication_member() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE target uuid; member uuid;
BEGIN
  SELECT p.offering_id INTO target FROM assessment.publication p WHERE p.publication_id=NEW.publication_id;
  IF TG_TABLE_NAME='publication_input' THEN
    SELECT b.offering_id INTO member FROM assessment.batch b WHERE b.batch_id=NEW.batch_id;
  ELSIF TG_TABLE_NAME='publication_attendance' THEN
    SELECT e.offering_id INTO member FROM academic.enrolment e WHERE e.enrolment_id=NEW.enrolment_id;
  ELSE
    SELECT e.offering_id INTO member FROM academic.grade_record g
      JOIN academic.enrolment e ON e.enrolment_id=g.enrolment_id WHERE g.record_id=NEW.record_id;
  END IF;
  IF member IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'Publication facts must belong to the published offering' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_input_member BEFORE INSERT ON assessment.publication_input
FOR EACH ROW EXECUTE FUNCTION assessment.guard_publication_member();
CREATE TRIGGER publication_attendance_member BEFORE INSERT ON assessment.publication_attendance
FOR EACH ROW EXECUTE FUNCTION assessment.guard_publication_member();
CREATE TRIGGER publication_grade_member BEFORE INSERT ON assessment.publication_grade
FOR EACH ROW EXECUTE FUNCTION assessment.guard_publication_member();

-- Exam approvers author published grade versions, alongside registrars and examiners.
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
      AND ra.role_code IN ('registrar','examiner','exam_approver')) THEN
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

-- Publishing authority: an active exam approver, anywhere and in the offering's institution.
CREATE FUNCTION assessment.publisher_capable(p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM academic.role_assignment ra JOIN academic.app_user u ON u.user_id=ra.user_id
    WHERE ra.user_id=p_actor AND ra.role_code='exam_approver' AND u.account_state='active')
$$;

CREATE FUNCTION assessment.publisher_scope(p_actor uuid,p_offering uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM academic.course_offering_context o
    JOIN academic.role_assignment ra ON ra.institution_id=o.institution_id
    JOIN academic.app_user u ON u.user_id=ra.user_id
    WHERE o.offering_id=p_offering AND ra.user_id=p_actor AND ra.role_code='exam_approver'
      AND u.account_state='active')
$$;

-- Whether the actor authored, validated or reviewed any revision of the offering.
CREATE FUNCTION assessment.offering_participant(p_actor uuid,p_offering uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM assessment.batch b WHERE b.offering_id=p_offering AND (
      b.author_id=p_actor
      OR EXISTS (SELECT FROM assessment.batch_review r WHERE r.batch_id=b.batch_id AND r.reviewer_id=p_actor)
      OR EXISTS (
        SELECT FROM assessment.validation_report v
        JOIN assessment.validation_delegation d ON d.delegation_id=v.delegation_id
        WHERE v.batch_id=b.batch_id AND d.grantee_id=p_actor)))
$$;

CREATE FUNCTION assessment.authorize_publication(p_actor uuid,p_offering uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF NOT assessment.publisher_capable(p_actor) THEN
    RAISE EXCEPTION 'Publication requires an exam approver' USING ERRCODE='42501';
  END IF;
  IF NOT assessment.publisher_scope(p_actor,p_offering) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  IF assessment.offering_participant(p_actor,p_offering) THEN
    RAISE EXCEPTION 'The publisher took part in this offering''s marks' USING ERRCODE='AB004';
  END IF;
END $$;

-- The approved CIE head and submitted SEE head. Both are locked once in that state.
CREATE FUNCTION assessment.publishable_heads(p_offering uuid, OUT cie_batch uuid, OUT see_batch uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  SELECT b.batch_id INTO cie_batch FROM assessment.batch b
    WHERE b.offering_id=p_offering AND b.stage='cie' ORDER BY b.revision_no DESC LIMIT 1;
  IF cie_batch IS NULL OR NOT EXISTS (
    SELECT FROM assessment.batch_review r WHERE r.batch_id=cie_batch AND r.verdict='approved'
  ) THEN
    RAISE EXCEPTION 'The latest CIE revision is not approved' USING ERRCODE='AB007';
  END IF;
  SELECT b.batch_id INTO see_batch FROM assessment.batch b
    WHERE b.offering_id=p_offering AND b.stage='see' ORDER BY b.revision_no DESC LIMIT 1;
  IF see_batch IS NULL OR NOT EXISTS (
    SELECT FROM assessment.batch_submission s WHERE s.batch_id=see_batch
  ) THEN
    RAISE EXCEPTION 'The latest SEE revision is not submitted' USING ERRCODE='AB008';
  END IF;
END $$;

CREATE FUNCTION assessment.input_attendance(p_attendance jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_array((e->>'enrolmentId')::uuid, (e->>'eligible')::boolean,
      (e->>'percent')::numeric(5,2)) ORDER BY (e->>'enrolmentId')::uuid), '[]'::jsonb)
  FROM jsonb_array_elements(p_attendance) e
$$;

CREATE FUNCTION assessment.stored_attendance(p_publication uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_array(a.enrolment_id, a.eligible, a.percent)
      ORDER BY a.enrolment_id), '[]'::jsonb)
  FROM assessment.publication_attendance a WHERE a.publication_id=p_publication
$$;

-- Whether a JSON array names every enrolment of the offering exactly once.
CREATE FUNCTION assessment.covers_roster(p_offering uuid,p_entries jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT coalesce((SELECT array_agg((e->>'enrolmentId')::uuid ORDER BY (e->>'enrolmentId')::uuid)
      FROM jsonb_array_elements(p_entries) e), '{}')
    = coalesce((SELECT array_agg(e.enrolment_id ORDER BY e.enrolment_id)
      FROM academic.enrolment e WHERE e.offering_id=p_offering), '{}')
$$;

-- Everything the API needs to compute results, for a publisher who may publish now.
CREATE FUNCTION assessment.publication_inputs(p_digest text,p_offering uuid)
RETURNS TABLE(cie_batch uuid, see_batch uuid, policy_id text, policy_version integer,
  roster jsonb, marks jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; heads record;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  PERFORM assessment.authorize_publication(actor,p_offering);
  SELECT * INTO heads FROM assessment.publishable_heads(p_offering);
  RETURN QUERY
    SELECT heads.cie_batch, heads.see_batch, p.policy_id, p.policy_version,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('enrolmentId',e.enrolment_id,
          'studentCode',st.student_code) ORDER BY st.student_code), '[]'::jsonb)
       FROM academic.enrolment e JOIN academic.student st ON st.student_id=e.student_id
       WHERE e.offering_id=p_offering),
      (SELECT coalesce(jsonb_agg(jsonb_build_object('enrolmentId',m.enrolment_id,
          'component',m.component_code,'points',m.points) ORDER BY m.enrolment_id, m.component_code),
          '[]'::jsonb)
       FROM assessment.mark m WHERE m.batch_id IN (heads.cie_batch, heads.see_batch))
    FROM assessment.offering_policy p WHERE p.offering_id=p_offering;
END $$;

-- Records the publication and appends version 1 of every enrolment's grade. The API computes
-- the results from the returned inputs with the frozen policy; the publication view recomputes
-- them from the stored inputs as an audit.
CREATE FUNCTION assessment.publish_results(p_digest text,p_offering uuid,p_cie uuid,p_see uuid,
  p_attendance jsonb,p_results jsonb)
RETURNS TABLE(publication_id uuid, published_at text, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; heads record; prior assessment.publication%ROWTYPE; created_id uuid;
  stamp timestamptz; tenant uuid; entry record; grade_id uuid; next_version integer;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF jsonb_typeof(p_attendance) IS DISTINCT FROM 'array' OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid publication' USING ERRCODE='22023';
  END IF;
  PERFORM assessment.authorize_publication(actor,p_offering);
  -- Serialize with new revisions of either stage and with other publications of the offering.
  PERFORM pg_advisory_xact_lock(hashtextextended('assessment:' || p_offering::text || ':cie', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('assessment:' || p_offering::text || ':see', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('publication:' || p_offering::text, 0));
  SELECT * INTO prior FROM assessment.publication p WHERE p.offering_id=p_offering AND p.kind='provisional';
  IF FOUND THEN
    IF prior.publisher_id=actor
      AND assessment.stored_attendance(prior.publication_id)=assessment.input_attendance(p_attendance) THEN
      RETURN QUERY SELECT prior.publication_id, workflow.iso(prior.published_at), false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'The offering already has provisional results' USING ERRCODE='AB009';
  END IF;
  SELECT * INTO heads FROM assessment.publishable_heads(p_offering);
  IF heads.cie_batch IS DISTINCT FROM p_cie OR heads.see_batch IS DISTINCT FROM p_see THEN
    RAISE EXCEPTION 'A newer revision exists' USING ERRCODE='40001';
  END IF;
  IF NOT assessment.covers_roster(p_offering,p_attendance)
    OR NOT assessment.covers_roster(p_offering,p_results) THEN
    RAISE EXCEPTION 'Attendance and results must cover every enrolment once' USING ERRCODE='22023';
  END IF;
  INSERT INTO assessment.publication(offering_id,kind,publisher_id)
    VALUES(p_offering,'provisional',actor)
    RETURNING publication.publication_id, publication.published_at INTO created_id, stamp;
  INSERT INTO assessment.publication_input(publication_id,batch_id)
    VALUES(created_id,p_cie),(created_id,p_see);
  INSERT INTO assessment.publication_attendance(publication_id,enrolment_id,eligible,percent)
    SELECT created_id,(e->>'enrolmentId')::uuid,(e->>'eligible')::boolean,(e->>'percent')::numeric(5,2)
    FROM jsonb_array_elements(p_attendance) e;
  SELECT o.institution_id INTO tenant FROM academic.course_offering_context o WHERE o.offering_id=p_offering;
  FOR entry IN
    SELECT (e->>'enrolmentId')::uuid AS enrolment_id, (e->>'gradePoints')::numeric(4,2) AS points,
      e->>'outcome' AS outcome
    FROM jsonb_array_elements(p_results) e ORDER BY 1
  LOOP
    SELECT g.record_id INTO grade_id FROM academic.grade_record g WHERE g.enrolment_id=entry.enrolment_id;
    IF NOT FOUND THEN
      INSERT INTO academic.grade_record(institution_id,enrolment_id) VALUES(tenant,entry.enrolment_id)
        RETURNING grade_record.record_id INTO grade_id;
    END IF;
    next_version:=academic.append_grade_version(grade_id,0,entry.points,entry.outcome,stamp,NULL,actor,
      'Provisional publication');
    INSERT INTO assessment.publication_grade(record_id,version_no,publication_id)
      VALUES(grade_id,next_version,created_id);
  END LOOP;
  RETURN QUERY SELECT created_id, workflow.iso(stamp), true;
END $$;

-- Result-reading authority: course teachers, department duties, exam approvers, registrars and
-- auditors. Students read their own results through my_results.
CREATE FUNCTION assessment.result_capable(p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (SELECT FROM pilot.offering_duty WHERE user_id=p_actor AND duty='course_teacher')
    OR EXISTS (SELECT FROM pilot.department_duty WHERE user_id=p_actor)
    OR EXISTS (SELECT FROM academic.role_assignment WHERE user_id=p_actor
      AND role_code IN ('exam_approver','registrar','auditor'))
$$;

CREATE FUNCTION assessment.result_scope(p_actor uuid,p_offering uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (
      SELECT FROM pilot.offering_duty
      WHERE user_id=p_actor AND offering_id=p_offering AND duty='course_teacher')
    OR EXISTS (
      SELECT FROM pilot.department_duty d JOIN assessment.offering_scope(p_offering) s
        ON s.department_id=d.department_id AND s.term_id=d.term_id
      WHERE d.user_id=p_actor)
    OR EXISTS (
      SELECT FROM academic.course_offering_context o
      JOIN academic.role_assignment ra ON ra.institution_id=o.institution_id
      WHERE o.offering_id=p_offering AND ra.user_id=p_actor
        AND ra.role_code IN ('exam_approver','registrar','auditor'))
$$;

-- An enrolment's stored marks in a publication's inputs, keyed by component.
CREATE FUNCTION assessment.published_marks(p_publication uuid,p_enrolment uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(m.component_code, m.points), '{}'::jsonb)
  FROM assessment.publication_input i JOIN assessment.mark m ON m.batch_id=i.batch_id
  WHERE i.publication_id=p_publication AND m.enrolment_id=p_enrolment
$$;

CREATE FUNCTION assessment.publication_view(p_digest text,p_offering uuid)
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
          'attendance',jsonb_build_object('eligible',a.eligible,'percent',a.percent),
          'marks',assessment.published_marks(target.publication_id,a.enrolment_id))
        ORDER BY st.student_code), '[]'::jsonb)
       FROM assessment.publication_attendance a
       JOIN academic.enrolment e ON e.enrolment_id=a.enrolment_id
       JOIN academic.student st ON st.student_id=e.student_id
       JOIN academic.grade_record g ON g.enrolment_id=a.enrolment_id
       JOIN assessment.publication_grade pg ON pg.publication_id=target.publication_id
         AND pg.record_id=g.record_id
       JOIN academic.grade_version v ON v.record_id=pg.record_id AND v.version_no=pg.version_no
       WHERE a.publication_id=target.publication_id)
    FROM academic.app_user u
    JOIN assessment.offering_policy op ON op.offering_id=target.offering_id
    WHERE u.user_id=target.publisher_id;
END $$;

-- A student's own published results, with the stored inputs needed to show the breakdown.
CREATE FUNCTION assessment.my_results(p_digest text)
RETURNS TABLE(offering_id uuid, course_code text, section_code text, term_code text, kind text,
  published_at text, policy_id text, policy_version integer, version_no integer,
  grade_points numeric, outcome text, attendance jsonb, marks jsonb)
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
    SELECT p.offering_id, c.course_code, o.section_code, t.term_code, p.kind,
      workflow.iso(p.published_at), op.policy_id, op.policy_version, v.version_no, v.grade_points,
      v.outcome, jsonb_build_object('eligible',a.eligible,'percent',a.percent),
      assessment.published_marks(p.publication_id,e.enrolment_id)
    FROM academic.student st
    JOIN academic.enrolment e ON e.student_id=st.student_id
    JOIN assessment.publication p ON p.offering_id=e.offering_id
    JOIN assessment.publication_attendance a ON a.publication_id=p.publication_id
      AND a.enrolment_id=e.enrolment_id
    JOIN academic.grade_record g ON g.enrolment_id=e.enrolment_id
    JOIN assessment.publication_grade pg ON pg.publication_id=p.publication_id AND pg.record_id=g.record_id
    JOIN academic.grade_version v ON v.record_id=pg.record_id AND v.version_no=pg.version_no
    JOIN academic.course_offering_context o ON o.offering_id=p.offering_id
    JOIN academic.course c ON c.course_id=o.course_id
    JOIN academic.academic_term t ON t.term_id=o.term_id
    JOIN assessment.offering_policy op ON op.offering_id=p.offering_id
    WHERE st.user_id=actor
    ORDER BY t.term_code, c.course_code, p.published_at;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA assessment FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA assessment FROM PUBLIC;
GRANT SELECT,INSERT ON assessment.publication,assessment.publication_input,
  assessment.publication_attendance,assessment.publication_grade TO academic_assessment_owner;
-- Appending grade versions runs the temporal store's invoker triggers as the owner.
GRANT SELECT ON academic.grade_record,academic.grade_version,academic.grade_temporal_segment,
  academic.course_offering,academic.course,academic.grading_scheme TO academic_assessment_owner;
GRANT INSERT ON academic.grade_record,academic.grade_version,academic.grade_temporal_segment
  TO academic_assessment_owner;
GRANT UPDATE(latest_version_no) ON academic.grade_record TO academic_assessment_owner;
GRANT UPDATE(system_during) ON academic.grade_temporal_segment TO academic_assessment_owner;
-- PostgreSQL row locking requires UPDATE on a column, even for FOR SHARE. The owner's functions
-- never update these columns, and enrolments reject every update.
GRANT UPDATE(section_code) ON academic.course_offering TO academic_assessment_owner;
GRANT UPDATE(student_id) ON academic.enrolment TO academic_assessment_owner;
-- The record-identity guard on grade records references these relations.
GRANT USAGE ON SCHEMA evidence TO academic_assessment_owner;
GRANT SELECT ON evidence.reference,workflow.change_request TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION academic.append_grade_version(uuid,integer,numeric,text,timestamptz,timestamptz,uuid,text)
  TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.active_delegations(uuid,timestamptz),
  assessment.offering_scope(uuid),assessment.review_json(uuid),assessment.validation_json(uuid),
  assessment.stage_duty(text),assessment.authorize_entry(uuid,uuid,text),
  assessment.can_read(uuid,uuid,text),assessment.read_capable(uuid),assessment.input_rows(jsonb),
  assessment.stored_rows(uuid),assessment.publisher_capable(uuid),assessment.publisher_scope(uuid,uuid),
  assessment.offering_participant(uuid,uuid),assessment.authorize_publication(uuid,uuid),
  assessment.publishable_heads(uuid),assessment.input_attendance(jsonb),
  assessment.stored_attendance(uuid),assessment.covers_roster(uuid,jsonb),
  assessment.result_capable(uuid),assessment.result_scope(uuid,uuid),
  assessment.published_marks(uuid,uuid) TO academic_assessment_owner;
ALTER FUNCTION assessment.publication_inputs(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.publish_results(text,uuid,uuid,uuid,jsonb,jsonb) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.publication_view(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.my_results(text) OWNER TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.entry_context(text,uuid,text),
  assessment.create_revision(text,uuid,text,integer,uuid,jsonb),assessment.submit_batch(text,uuid),
  assessment.list_batches(text,uuid),assessment.read_batch(text,uuid),
  assessment.validate_batch(text,uuid,text),assessment.review_batch(text,uuid,text,text),
  assessment.review_queue(text),assessment.validation_queue(text),
  assessment.publication_inputs(text,uuid),
  assessment.publish_results(text,uuid,uuid,uuid,jsonb,jsonb),
  assessment.publication_view(text,uuid),assessment.my_results(text) TO scholarproof_api_access;
