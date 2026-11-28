-- T4 department review and exam-section validation of submitted marks batches.
-- HoDs and delegates approve or return CIE batches of their department and term. Exam-section
-- staff validate submitted batches under a time-bound delegation from an exam approver.
-- Entry, validation and review are held by different people.

CREATE TABLE assessment.validation_delegation (
  delegation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES pilot.department,
  term_id uuid NOT NULL REFERENCES academic.academic_term,
  grantor_id uuid NOT NULL REFERENCES academic.app_user,
  grantee_id uuid NOT NULL REFERENCES academic.app_user,
  valid_during tstzrange NOT NULL,
  CHECK (grantor_id <> grantee_id),
  CHECK (NOT isempty(valid_during) AND lower_inc(valid_during) AND NOT upper_inc(valid_during)
    AND lower(valid_during) IS NOT NULL AND upper(valid_during) IS NOT NULL
    AND isfinite(lower(valid_during)) AND isfinite(upper(valid_during)))
);

-- The delegation determines the validator, so the validator is not stored again.
CREATE TABLE assessment.validation_report (
  batch_id uuid PRIMARY KEY REFERENCES assessment.batch,
  delegation_id uuid NOT NULL REFERENCES assessment.validation_delegation,
  missing_rows integer NOT NULL CHECK (missing_rows >= 0),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(checked_at))
);

CREATE TABLE assessment.batch_review (
  batch_id uuid PRIMARY KEY REFERENCES assessment.batch,
  reviewer_id uuid NOT NULL REFERENCES academic.app_user,
  verdict text NOT NULL CHECK (verdict IN ('approved', 'returned')),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(reviewed_at)),
  CHECK (verdict = 'approved' OR reason IS NOT NULL)
);

CREATE INDEX validation_delegation_grantee_idx ON assessment.validation_delegation(grantee_id);

CREATE TRIGGER validation_delegation_immutable BEFORE UPDATE OR DELETE ON assessment.validation_delegation
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER validation_report_immutable BEFORE UPDATE OR DELETE ON assessment.validation_report
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER batch_review_immutable BEFORE UPDATE OR DELETE ON assessment.batch_review
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

CREATE FUNCTION assessment.guard_delegation_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pilot.department d JOIN academic.academic_term t ON t.institution_id=d.institution_id
    WHERE d.department_id=NEW.department_id AND t.term_id=NEW.term_id
  ) THEN
    RAISE EXCEPTION 'Delegation department and term belong to different institutions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validation_delegation_tenant BEFORE INSERT ON assessment.validation_delegation
FOR EACH ROW EXECUTE FUNCTION assessment.guard_delegation_tenant();

-- Active validation delegations: inside their window, with a grantor who is still an active exam
-- approver in the department's institution.
CREATE FUNCTION assessment.active_delegations(p_actor uuid,p_at timestamptz)
RETURNS TABLE(delegation_id uuid, department_id uuid, term_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT v.delegation_id, v.department_id, v.term_id
  FROM assessment.validation_delegation v
  JOIN pilot.department d ON d.department_id=v.department_id
  JOIN academic.app_user g ON g.user_id=v.grantor_id AND g.account_state='active'
  JOIN academic.role_assignment ra ON ra.user_id=v.grantor_id AND ra.institution_id=d.institution_id
    AND ra.role_code='exam_approver'
  WHERE v.grantee_id=p_actor AND v.valid_during @> p_at
$$;

-- The reviewing department and term of an offering.
CREATE FUNCTION assessment.offering_scope(p_offering uuid)
RETURNS TABLE(department_id uuid, term_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT od.department_id, o.term_id FROM pilot.offering_department od
  JOIN academic.course_offering_context o ON o.offering_id=od.offering_id
  WHERE od.offering_id=p_offering
$$;

CREATE FUNCTION assessment.validate_batch(p_digest text,p_batch uuid,p_note text)
RETURNS TABLE(checked_at text, missing_rows integer, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target assessment.batch%ROWTYPE; grant_id uuid; latest integer;
  prior assessment.validation_report%ROWTYPE; prior_grantee uuid; missing integer; stamp timestamptz;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT EXISTS (SELECT FROM assessment.active_delegations(actor,statement_timestamp())) THEN
    RAISE EXCEPTION 'Validation requires an active delegation' USING ERRCODE='42501';
  END IF;
  SELECT * INTO target FROM assessment.batch b WHERE b.batch_id=p_batch;
  IF FOUND THEN
    SELECT a.delegation_id INTO grant_id
    FROM assessment.active_delegations(actor,statement_timestamp()) a
    JOIN assessment.offering_scope(target.offering_id) s
      ON s.department_id=a.department_id AND s.term_id=a.term_id
    ORDER BY a.delegation_id LIMIT 1;
  END IF;
  IF grant_id IS NULL THEN RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002'; END IF;
  IF target.author_id=actor OR EXISTS (
    SELECT FROM assessment.batch_review r WHERE r.batch_id=p_batch AND r.reviewer_id=actor
  ) THEN
    RAISE EXCEPTION 'The validator took part in this batch' USING ERRCODE='AB004';
  END IF;
  SELECT * INTO prior FROM assessment.validation_report r WHERE r.batch_id=p_batch;
  IF FOUND THEN
    SELECT v.grantee_id INTO prior_grantee FROM assessment.validation_delegation v
      WHERE v.delegation_id=prior.delegation_id;
    IF prior_grantee=actor THEN
      RETURN QUERY SELECT workflow.iso(prior.checked_at), prior.missing_rows, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'The batch was already validated' USING ERRCODE='AB005';
  END IF;
  IF NOT EXISTS (SELECT FROM assessment.batch_submission s WHERE s.batch_id=p_batch) THEN
    RAISE EXCEPTION 'Only submitted batches can be validated' USING ERRCODE='AB001';
  END IF;
  SELECT max(b.revision_no) INTO latest FROM assessment.batch b
    WHERE b.offering_id=target.offering_id AND b.stage=target.stage;
  IF latest <> target.revision_no THEN
    RAISE EXCEPTION 'A newer revision exists' USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO missing FROM academic.enrolment e
    WHERE e.offering_id=target.offering_id
      AND NOT EXISTS (SELECT FROM assessment.mark m WHERE m.batch_id=p_batch AND m.enrolment_id=e.enrolment_id);
  INSERT INTO assessment.validation_report(batch_id,delegation_id,missing_rows,note)
    VALUES(p_batch,grant_id,missing,nullif(btrim(p_note),''))
    RETURNING validation_report.checked_at INTO stamp;
  RETURN QUERY SELECT workflow.iso(stamp), missing, true;
END $$;

CREATE FUNCTION assessment.review_batch(p_digest text,p_batch uuid,p_verdict text,p_reason text)
RETURNS TABLE(reviewed_at text, verdict text, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target assessment.batch%ROWTYPE; latest integer;
  prior assessment.batch_review%ROWTYPE; clean_reason text:=nullif(btrim(p_reason),''); stamp timestamptz;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF p_verdict IS NULL OR p_verdict NOT IN ('approved','returned')
    OR (p_verdict='returned' AND clean_reason IS NULL) THEN
    RAISE EXCEPTION 'A return needs a reason' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT FROM pilot.department_duty d WHERE d.user_id=actor) THEN
    RAISE EXCEPTION 'Review requires a department duty' USING ERRCODE='42501';
  END IF;
  SELECT * INTO target FROM assessment.batch b WHERE b.batch_id=p_batch;
  IF NOT FOUND OR target.stage<>'cie' OR NOT EXISTS (
    SELECT FROM pilot.department_duty d JOIN assessment.offering_scope(target.offering_id) s
      ON s.department_id=d.department_id AND s.term_id=d.term_id
    WHERE d.user_id=actor
  ) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  IF target.author_id=actor THEN
    RAISE EXCEPTION 'Authors cannot review their own batch' USING ERRCODE='AB003';
  END IF;
  IF EXISTS (
    SELECT FROM assessment.validation_report r
    JOIN assessment.validation_delegation v ON v.delegation_id=r.delegation_id
    WHERE r.batch_id=p_batch AND v.grantee_id=actor
  ) THEN
    RAISE EXCEPTION 'The validator cannot review the same batch' USING ERRCODE='AB004';
  END IF;
  SELECT * INTO prior FROM assessment.batch_review r WHERE r.batch_id=p_batch;
  IF FOUND THEN
    IF prior.reviewer_id=actor AND prior.verdict=p_verdict
      AND prior.reason IS NOT DISTINCT FROM clean_reason THEN
      RETURN QUERY SELECT workflow.iso(prior.reviewed_at), prior.verdict, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'The batch already has a review' USING ERRCODE='AB002';
  END IF;
  IF NOT EXISTS (SELECT FROM assessment.batch_submission s WHERE s.batch_id=p_batch) THEN
    RAISE EXCEPTION 'Only submitted batches can be reviewed' USING ERRCODE='AB001';
  END IF;
  SELECT max(b.revision_no) INTO latest FROM assessment.batch b
    WHERE b.offering_id=target.offering_id AND b.stage=target.stage;
  IF latest <> target.revision_no THEN
    RAISE EXCEPTION 'A newer revision exists' USING ERRCODE='40001';
  END IF;
  INSERT INTO assessment.batch_review(batch_id,reviewer_id,verdict,reason)
    VALUES(p_batch,actor,p_verdict,clean_reason) RETURNING batch_review.reviewed_at INTO stamp;
  RETURN QUERY SELECT workflow.iso(stamp), p_verdict, true;
END $$;

-- A returned head reopens entry; an approved head is locked for publication.
CREATE OR REPLACE FUNCTION assessment.create_revision(p_digest text,p_offering uuid,p_stage text,
  p_expected integer,p_key uuid,p_marks jsonb)
RETURNS TABLE(batch_id uuid, revision_no integer, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; prior assessment.batch%ROWTYPE; latest integer; head uuid; created_id uuid;
  head_verdict text;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF p_stage IS NULL OR p_stage NOT IN ('cie','see') OR p_expected IS NULL OR p_expected < 0
    OR p_key IS NULL OR jsonb_typeof(p_marks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_marks)=0 THEN
    RAISE EXCEPTION 'Invalid marks batch' USING ERRCODE='22023';
  END IF;
  PERFORM assessment.authorize_entry(actor,p_offering,p_stage);
  SELECT * INTO prior FROM assessment.batch b WHERE b.author_id=actor AND b.idempotency_key=p_key;
  IF FOUND THEN
    IF prior.offering_id=p_offering AND prior.stage=p_stage AND prior.revision_no=p_expected+1
      AND assessment.stored_rows(prior.batch_id)=assessment.input_rows(p_marks) THEN
      RETURN QUERY SELECT prior.batch_id, prior.revision_no, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'The idempotency key was used for a different batch' USING ERRCODE='23505';
  END IF;
  IF NOT EXISTS (SELECT FROM assessment.offering_policy WHERE offering_id=p_offering) THEN
    RAISE EXCEPTION 'No assessment policy is assigned to this offering' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('assessment:' || p_offering::text || ':' || p_stage, 0));
  SELECT b.batch_id, b.revision_no INTO head, latest FROM assessment.batch b
    WHERE b.offering_id=p_offering AND b.stage=p_stage ORDER BY b.revision_no DESC LIMIT 1;
  latest:=coalesce(latest,0);
  IF latest <> p_expected THEN
    RAISE EXCEPTION 'A newer revision exists' USING ERRCODE='40001';
  END IF;
  IF head IS NOT NULL AND EXISTS (SELECT FROM assessment.batch_submission s WHERE s.batch_id=head) THEN
    SELECT r.verdict INTO head_verdict FROM assessment.batch_review r WHERE r.batch_id=head;
    IF head_verdict='approved' THEN
      RAISE EXCEPTION 'The approved revision is locked for publication' USING ERRCODE='AB006';
    ELSIF head_verdict IS NULL THEN
      RAISE EXCEPTION 'The latest revision is submitted and awaits review' USING ERRCODE='55000';
    END IF;
  END IF;
  INSERT INTO assessment.batch(offering_id,stage,revision_no,author_id,idempotency_key)
    VALUES(p_offering,p_stage,latest+1,actor,p_key) RETURNING batch.batch_id INTO created_id;
  INSERT INTO assessment.mark(batch_id,enrolment_id,component_code,points)
    SELECT created_id,(e->>'enrolmentId')::uuid,e->>'component',(e->>'points')::numeric(6,2)
    FROM jsonb_array_elements(p_marks) e;
  RETURN QUERY SELECT created_id, latest+1, true;
END $$;

-- Listing and reading now include the review and validation facts.
DROP FUNCTION assessment.list_batches(text,uuid);
DROP FUNCTION assessment.read_batch(text,uuid);

CREATE FUNCTION assessment.list_batches(p_digest text,p_offering uuid)
RETURNS TABLE(batch_id uuid, stage text, revision_no integer, author_subject text,
  created_at text, submitted_at text, review jsonb, validation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT assessment.read_capable(actor) THEN
    RAISE EXCEPTION 'Reading marks requires an assessment duty' USING ERRCODE='42501';
  END IF;
  IF NOT (assessment.can_read(actor,p_offering,'cie') OR assessment.can_read(actor,p_offering,'see')) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  RETURN QUERY
    SELECT b.batch_id, b.stage, b.revision_no, u.auth_subject, workflow.iso(b.created_at),
      workflow.iso(s.submitted_at), assessment.review_json(b.batch_id),
      assessment.validation_json(b.batch_id)
    FROM assessment.batch b JOIN academic.app_user u ON u.user_id=b.author_id
    LEFT JOIN assessment.batch_submission s ON s.batch_id=b.batch_id
    WHERE b.offering_id=p_offering AND assessment.can_read(actor,p_offering,b.stage)
    ORDER BY b.stage, b.revision_no;
END $$;

CREATE FUNCTION assessment.read_batch(p_digest text,p_batch uuid)
RETURNS TABLE(offering_id uuid, stage text, revision_no integer, author_subject text,
  created_at text, submitted_at text, policy_id text, policy_version integer, marks jsonb,
  review jsonb, validation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target assessment.batch%ROWTYPE;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT assessment.read_capable(actor) THEN
    RAISE EXCEPTION 'Reading marks requires an assessment duty' USING ERRCODE='42501';
  END IF;
  SELECT * INTO target FROM assessment.batch b WHERE b.batch_id=p_batch;
  IF NOT FOUND OR NOT assessment.can_read(actor,target.offering_id,target.stage) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  RETURN QUERY
    SELECT target.offering_id, target.stage, target.revision_no, u.auth_subject,
      workflow.iso(target.created_at), workflow.iso(s.submitted_at), p.policy_id, p.policy_version,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('enrolmentId',m.enrolment_id,
          'studentCode',st.student_code,'component',m.component_code,'points',m.points)
        ORDER BY st.student_code, m.component_code), '[]'::jsonb)
       FROM assessment.mark m JOIN academic.enrolment e ON e.enrolment_id=m.enrolment_id
       JOIN academic.student st ON st.student_id=e.student_id WHERE m.batch_id=target.batch_id),
      assessment.review_json(target.batch_id), assessment.validation_json(target.batch_id)
    FROM academic.app_user u
    JOIN assessment.offering_policy p ON p.offering_id=target.offering_id
    LEFT JOIN assessment.batch_submission s ON s.batch_id=target.batch_id
    WHERE u.user_id=target.author_id;
END $$;

CREATE FUNCTION assessment.review_json(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT jsonb_build_object('verdict',r.verdict,'reviewerSubject',u.auth_subject,
    'reviewedAt',workflow.iso(r.reviewed_at),'reason',r.reason)
  FROM assessment.batch_review r JOIN academic.app_user u ON u.user_id=r.reviewer_id
  WHERE r.batch_id=p_batch
$$;

CREATE FUNCTION assessment.validation_json(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT jsonb_build_object('validatorSubject',u.auth_subject,'checkedAt',workflow.iso(r.checked_at),
    'missingRows',r.missing_rows,'note',r.note)
  FROM assessment.validation_report r
  JOIN assessment.validation_delegation v ON v.delegation_id=r.delegation_id
  JOIN academic.app_user u ON u.user_id=v.grantee_id
  WHERE r.batch_id=p_batch
$$;

-- Submitted CIE heads awaiting the caller's department review.
CREATE FUNCTION assessment.review_queue(p_digest text)
RETURNS TABLE(batch_id uuid, offering_id uuid, revision_no integer, author_subject text,
  submitted_at text, validation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT EXISTS (SELECT FROM pilot.department_duty d WHERE d.user_id=actor) THEN
    RAISE EXCEPTION 'Review requires a department duty' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT b.batch_id, b.offering_id, b.revision_no, u.auth_subject, workflow.iso(s.submitted_at),
      assessment.validation_json(b.batch_id)
    FROM assessment.batch b
    JOIN assessment.batch_submission s ON s.batch_id=b.batch_id
    JOIN academic.app_user u ON u.user_id=b.author_id
    JOIN pilot.offering_department od ON od.offering_id=b.offering_id
    JOIN academic.course_offering_context o ON o.offering_id=b.offering_id
    JOIN pilot.department_duty d ON d.department_id=od.department_id AND d.term_id=o.term_id
      AND d.user_id=actor
    WHERE b.stage='cie' AND b.author_id<>actor
      AND NOT EXISTS (SELECT FROM assessment.batch_review r WHERE r.batch_id=b.batch_id)
      AND b.revision_no=(SELECT max(x.revision_no) FROM assessment.batch x
        WHERE x.offering_id=b.offering_id AND x.stage=b.stage)
    ORDER BY s.submitted_at, b.batch_id;
END $$;

-- Submitted heads awaiting validation in the caller's actively delegated departments.
CREATE FUNCTION assessment.validation_queue(p_digest text)
RETURNS TABLE(batch_id uuid, offering_id uuid, stage text, revision_no integer, submitted_at text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT EXISTS (SELECT FROM assessment.active_delegations(actor,statement_timestamp())) THEN
    RAISE EXCEPTION 'Validation requires an active delegation' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT DISTINCT b.batch_id, b.offering_id, b.stage, b.revision_no, workflow.iso(s.submitted_at)
    FROM assessment.batch b
    JOIN assessment.batch_submission s ON s.batch_id=b.batch_id
    JOIN assessment.offering_scope(b.offering_id) sc ON true
    JOIN assessment.active_delegations(actor,statement_timestamp()) a
      ON a.department_id=sc.department_id AND a.term_id=sc.term_id
    WHERE b.author_id<>actor
      AND NOT EXISTS (SELECT FROM assessment.validation_report r WHERE r.batch_id=b.batch_id)
      AND b.revision_no=(SELECT max(x.revision_no) FROM assessment.batch x
        WHERE x.offering_id=b.offering_id AND x.stage=b.stage)
    ORDER BY 5, 1;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA assessment FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA assessment FROM PUBLIC;
GRANT SELECT,INSERT ON assessment.validation_report,assessment.batch_review TO academic_assessment_owner;
GRANT SELECT ON assessment.validation_delegation,academic.academic_term TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.active_delegations(uuid,timestamptz),
  assessment.offering_scope(uuid),assessment.review_json(uuid),assessment.validation_json(uuid),
  assessment.stage_duty(text),assessment.authorize_entry(uuid,uuid,text),
  assessment.can_read(uuid,uuid,text),assessment.read_capable(uuid),assessment.input_rows(jsonb),
  assessment.stored_rows(uuid) TO academic_assessment_owner;
ALTER FUNCTION assessment.create_revision(text,uuid,text,integer,uuid,jsonb) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.validate_batch(text,uuid,text) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.review_batch(text,uuid,text,text) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.list_batches(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.read_batch(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.review_queue(text) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.validation_queue(text) OWNER TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.entry_context(text,uuid,text),
  assessment.create_revision(text,uuid,text,integer,uuid,jsonb),assessment.submit_batch(text,uuid),
  assessment.list_batches(text,uuid),assessment.read_batch(text,uuid),
  assessment.validate_batch(text,uuid,text),assessment.review_batch(text,uuid,text,text),
  assessment.review_queue(text),assessment.validation_queue(text) TO scholarproof_api_access;
