-- T3 marks batches: immutable CIE/SEE mark revisions for pilot offerings.
-- Course teachers enter CIE and SEE examiners enter SEE for their assigned offering.
-- Every revision is append-only; submission is a separate immutable fact.

CREATE SCHEMA assessment;

-- The versioned assessment policy (packages/assessment) applied to an offering.
CREATE TABLE assessment.offering_policy (
  offering_id uuid PRIMARY KEY REFERENCES pilot.offering_department,
  policy_id text NOT NULL CHECK (policy_id ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  policy_version integer NOT NULL CHECK (policy_version > 0)
);

CREATE TABLE assessment.batch (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES assessment.offering_policy,
  stage text NOT NULL CHECK (stage IN ('cie', 'see')),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  author_id uuid NOT NULL REFERENCES academic.app_user,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  UNIQUE (offering_id, stage, revision_no),
  UNIQUE (author_id, idempotency_key)
);

-- A NULL value records an absence (AB); the policy decides where absence is allowed.
CREATE TABLE assessment.mark (
  batch_id uuid REFERENCES assessment.batch,
  enrolment_id uuid REFERENCES academic.enrolment,
  component_code text CHECK (component_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  points numeric(6,2) CHECK (points IS NULL OR points >= 0),
  PRIMARY KEY (batch_id, enrolment_id, component_code)
);

CREATE TABLE assessment.batch_submission (
  batch_id uuid PRIMARY KEY REFERENCES assessment.batch,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(submitted_at))
);

CREATE INDEX batch_offering_stage_idx ON assessment.batch(offering_id, stage, revision_no DESC);
CREATE INDEX mark_enrolment_idx ON assessment.mark(enrolment_id);

CREATE TRIGGER batch_immutable BEFORE UPDATE OR DELETE ON assessment.batch
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER mark_immutable BEFORE UPDATE OR DELETE ON assessment.mark
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();
CREATE TRIGGER batch_submission_immutable BEFORE UPDATE OR DELETE ON assessment.batch_submission
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

CREATE FUNCTION assessment.guard_offering_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT FROM assessment.batch WHERE offering_id=OLD.offering_id) THEN
    RAISE EXCEPTION 'The assessment policy is frozen once marks exist' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER offering_policy_frozen BEFORE UPDATE OR DELETE ON assessment.offering_policy
FOR EACH ROW EXECUTE FUNCTION assessment.guard_offering_policy();

CREATE FUNCTION assessment.guard_mark_enrolment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM assessment.batch b JOIN academic.enrolment e ON e.offering_id=b.offering_id
    WHERE b.batch_id=NEW.batch_id AND e.enrolment_id=NEW.enrolment_id
  ) THEN
    RAISE EXCEPTION 'Marks must belong to an enrolment in the batch offering' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mark_enrolment_scope BEFORE INSERT ON assessment.mark
FOR EACH ROW EXECUTE FUNCTION assessment.guard_mark_enrolment();

-- Course teachers enter CIE; SEE examiners enter SEE.
CREATE FUNCTION assessment.stage_duty(p_stage text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE p_stage WHEN 'cie' THEN 'course_teacher' WHEN 'see' THEN 'see_examiner' END
$$;

-- 403 for a caller with no marks-entry duty anywhere; 404 when no duty covers this offering and stage.
CREATE FUNCTION assessment.authorize_entry(p_actor uuid,p_offering uuid,p_stage text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM pilot.offering_duty WHERE user_id=p_actor) THEN
    RAISE EXCEPTION 'Marks entry requires an offering duty' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pilot.offering_duty
    WHERE user_id=p_actor AND offering_id=p_offering AND duty=assessment.stage_duty(p_stage)
  ) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
END $$;

-- Read access: assigned entry duty for the stage, HoD or delegate of the reviewing department and
-- term, or an exam approver in the offering's institution.
CREATE FUNCTION assessment.can_read(p_actor uuid,p_offering uuid,p_stage text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (
      SELECT FROM pilot.offering_duty
      WHERE user_id=p_actor AND offering_id=p_offering AND duty=assessment.stage_duty(p_stage))
    OR EXISTS (
      SELECT FROM pilot.offering_department od
      JOIN academic.course_offering_context o ON o.offering_id=od.offering_id
      JOIN pilot.department_duty d ON d.department_id=od.department_id AND d.term_id=o.term_id
      WHERE od.offering_id=p_offering AND d.user_id=p_actor)
    OR EXISTS (
      SELECT FROM pilot.offering_department od
      JOIN pilot.department dep USING(department_id)
      JOIN academic.role_assignment ra ON ra.institution_id=dep.institution_id
      WHERE od.offering_id=p_offering AND ra.user_id=p_actor AND ra.role_code='exam_approver')
$$;

CREATE FUNCTION assessment.read_capable(p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT EXISTS (SELECT FROM pilot.offering_duty WHERE user_id=p_actor)
    OR EXISTS (SELECT FROM pilot.department_duty WHERE user_id=p_actor)
    OR EXISTS (SELECT FROM academic.role_assignment WHERE user_id=p_actor AND role_code='exam_approver')
$$;

CREATE FUNCTION assessment.input_rows(p_marks jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_array(
      (e->>'enrolmentId')::uuid, e->>'component', (e->>'points')::numeric(6,2))
    ORDER BY (e->>'enrolmentId')::uuid, e->>'component'), '[]'::jsonb)
  FROM jsonb_array_elements(p_marks) e
$$;

CREATE FUNCTION assessment.stored_rows(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,assessment,pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_array(enrolment_id, component_code, points)
    ORDER BY enrolment_id, component_code), '[]'::jsonb)
  FROM assessment.mark WHERE batch_id=p_batch
$$;

-- Policy and head revision for an author before the API validates a batch.
CREATE FUNCTION assessment.entry_context(p_digest text,p_offering uuid,p_stage text)
RETURNS TABLE(policy_id text, policy_version integer, latest_revision integer, latest_submitted boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF p_stage IS NULL OR p_stage NOT IN ('cie','see') THEN
    RAISE EXCEPTION 'Unknown assessment stage' USING ERRCODE='22023';
  END IF;
  PERFORM assessment.authorize_entry(actor,p_offering,p_stage);
  RETURN QUERY
    SELECT p.policy_id, p.policy_version, coalesce(h.revision_no,0),
      coalesce(EXISTS (SELECT FROM assessment.batch_submission s WHERE s.batch_id=h.batch_id), false)
    FROM assessment.offering_policy p
    LEFT JOIN LATERAL (
      SELECT b.batch_id, b.revision_no FROM assessment.batch b
      WHERE b.offering_id=p.offering_id AND b.stage=p_stage ORDER BY b.revision_no DESC LIMIT 1
    ) h ON true
    WHERE p.offering_id=p_offering;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No assessment policy is assigned to this offering' USING ERRCODE='22023';
  END IF;
END $$;

CREATE FUNCTION assessment.create_revision(p_digest text,p_offering uuid,p_stage text,
  p_expected integer,p_key uuid,p_marks jsonb)
RETURNS TABLE(batch_id uuid, revision_no integer, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; prior assessment.batch%ROWTYPE; latest integer; created_id uuid;
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
  SELECT coalesce(max(b.revision_no),0) INTO latest
    FROM assessment.batch b WHERE b.offering_id=p_offering AND b.stage=p_stage;
  IF latest <> p_expected THEN
    RAISE EXCEPTION 'A newer revision exists' USING ERRCODE='40001';
  END IF;
  IF EXISTS (
    SELECT FROM assessment.batch b JOIN assessment.batch_submission s ON s.batch_id=b.batch_id
    WHERE b.offering_id=p_offering AND b.stage=p_stage AND b.revision_no=latest
  ) THEN
    RAISE EXCEPTION 'The latest revision is submitted and awaits review' USING ERRCODE='55000';
  END IF;
  INSERT INTO assessment.batch(offering_id,stage,revision_no,author_id,idempotency_key)
    VALUES(p_offering,p_stage,latest+1,actor,p_key) RETURNING batch.batch_id INTO created_id;
  INSERT INTO assessment.mark(batch_id,enrolment_id,component_code,points)
    SELECT created_id,(e->>'enrolmentId')::uuid,e->>'component',(e->>'points')::numeric(6,2)
    FROM jsonb_array_elements(p_marks) e;
  RETURN QUERY SELECT created_id, latest+1, true;
END $$;

-- Only the author may submit, and only the latest revision. A repeated submission is a no-op.
CREATE FUNCTION assessment.submit_batch(p_digest text,p_batch uuid)
RETURNS TABLE(submitted_at text, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid; target assessment.batch%ROWTYPE; latest integer; stamp timestamptz;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  IF NOT EXISTS (SELECT FROM pilot.offering_duty WHERE user_id=actor) THEN
    RAISE EXCEPTION 'Submitting marks requires an offering duty' USING ERRCODE='42501';
  END IF;
  SELECT * INTO target FROM assessment.batch WHERE batch_id=p_batch;
  IF NOT FOUND OR target.author_id<>actor OR NOT EXISTS (
    SELECT FROM pilot.offering_duty
    WHERE user_id=actor AND offering_id=target.offering_id AND duty=assessment.stage_duty(target.stage)
  ) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  SELECT s.submitted_at INTO stamp FROM assessment.batch_submission s WHERE s.batch_id=p_batch;
  IF FOUND THEN
    RETURN QUERY SELECT workflow.iso(stamp), false;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('assessment:' || target.offering_id::text || ':' || target.stage, 0));
  SELECT max(b.revision_no) INTO latest
    FROM assessment.batch b WHERE b.offering_id=target.offering_id AND b.stage=target.stage;
  IF latest <> target.revision_no THEN
    RAISE EXCEPTION 'A newer revision exists' USING ERRCODE='40001';
  END IF;
  INSERT INTO assessment.batch_submission(batch_id) VALUES(p_batch) RETURNING batch_submission.submitted_at INTO stamp;
  RETURN QUERY SELECT workflow.iso(stamp), true;
END $$;

CREATE FUNCTION assessment.list_batches(p_digest text,p_offering uuid)
RETURNS TABLE(batch_id uuid, stage text, revision_no integer, author_subject text,
  created_at text, submitted_at text)
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
      workflow.iso(s.submitted_at)
    FROM assessment.batch b JOIN academic.app_user u ON u.user_id=b.author_id
    LEFT JOIN assessment.batch_submission s ON s.batch_id=b.batch_id
    WHERE b.offering_id=p_offering AND assessment.can_read(actor,p_offering,b.stage)
    ORDER BY b.stage, b.revision_no;
END $$;

CREATE FUNCTION assessment.read_batch(p_digest text,p_batch uuid)
RETURNS TABLE(offering_id uuid, stage text, revision_no integer, author_subject text,
  created_at text, submitted_at text, policy_id text, policy_version integer, marks jsonb)
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
       JOIN academic.student st ON st.student_id=e.student_id WHERE m.batch_id=target.batch_id)
    FROM academic.app_user u
    JOIN assessment.offering_policy p ON p.offering_id=target.offering_id
    LEFT JOIN assessment.batch_submission s ON s.batch_id=target.batch_id
    WHERE u.user_id=target.author_id;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='academic_assessment_owner') THEN
    CREATE ROLE academic_assessment_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='academic_assessment_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolconfig IS NOT NULL))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid,m.member)
      WHERE r.rolname='academic_assessment_owner') THEN
    RAISE EXCEPTION 'Unsafe assessment owner' USING ERRCODE='42501';
  END IF;
END $$;

REVOKE ALL ON SCHEMA assessment FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA assessment FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA assessment FROM PUBLIC;
GRANT USAGE ON SCHEMA assessment,academic,workflow,access_control,pilot TO academic_assessment_owner;
GRANT SELECT,INSERT ON assessment.batch,assessment.mark,assessment.batch_submission TO academic_assessment_owner;
GRANT SELECT ON assessment.offering_policy TO academic_assessment_owner;
GRANT SELECT ON academic.app_user,academic.role_assignment,academic.course_offering_context,
  academic.enrolment,academic.student,access_control.api_session TO academic_assessment_owner;
GRANT SELECT ON pilot.offering_duty,pilot.department_duty,pilot.offering_department,pilot.department
  TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION workflow.actor_for_session(text),workflow.iso(timestamptz)
  TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.stage_duty(text),assessment.authorize_entry(uuid,uuid,text),
  assessment.can_read(uuid,uuid,text),assessment.read_capable(uuid),assessment.input_rows(jsonb),
  assessment.stored_rows(uuid) TO academic_assessment_owner;
ALTER FUNCTION assessment.entry_context(text,uuid,text) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.create_revision(text,uuid,text,integer,uuid,jsonb) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.submit_batch(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.list_batches(text,uuid) OWNER TO academic_assessment_owner;
ALTER FUNCTION assessment.read_batch(text,uuid) OWNER TO academic_assessment_owner;
GRANT USAGE ON SCHEMA assessment TO scholarproof_api_access;
GRANT EXECUTE ON FUNCTION assessment.entry_context(text,uuid,text),
  assessment.create_revision(text,uuid,text,integer,uuid,jsonb),assessment.submit_batch(text,uuid),
  assessment.list_batches(text,uuid),assessment.read_batch(text,uuid) TO scholarproof_api_access;
