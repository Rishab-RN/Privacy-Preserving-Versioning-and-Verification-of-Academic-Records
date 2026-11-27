CREATE SCHEMA pilot;

CREATE TABLE pilot.department (
  department_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution,
  department_code text NOT NULL CHECK (length(btrim(department_code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  UNIQUE (institution_id, department_code)
);

CREATE TABLE pilot.offering_department (
  offering_id uuid PRIMARY KEY REFERENCES academic.course_offering,
  department_id uuid NOT NULL REFERENCES pilot.department
);

CREATE TABLE pilot.offering_duty (
  offering_id uuid REFERENCES pilot.offering_department,
  user_id uuid REFERENCES academic.app_user,
  duty text CHECK (duty IN ('course_teacher', 'see_examiner')),
  PRIMARY KEY (offering_id, user_id, duty)
);

CREATE TABLE pilot.department_duty (
  department_id uuid REFERENCES pilot.department,
  term_id uuid REFERENCES academic.academic_term,
  user_id uuid REFERENCES academic.app_user,
  duty text CHECK (duty IN ('hod', 'hod_delegate')),
  PRIMARY KEY (department_id, term_id, user_id, duty)
);

CREATE TABLE pilot.roster_delegation (
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

ALTER TABLE academic.role_assignment DROP CONSTRAINT role_assignment_role_code_check;
ALTER TABLE academic.role_assignment ADD CONSTRAINT role_assignment_role_code_check
  CHECK (role_code IN ('registrar', 'examiner', 'student', 'auditor', 'faculty',
    'exam_staff', 'exam_approver', 'dean_academics'));

CREATE TRIGGER department_scope_immutable BEFORE UPDATE ON pilot.department
FOR EACH ROW EXECUTE FUNCTION academic.guard_stable_scope_identity('department_id');

CREATE FUNCTION pilot.check_department_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pilot,pg_temp AS $$
DECLARE institution uuid; parent_institution uuid;
BEGIN
  SELECT institution_id INTO institution FROM pilot.department WHERE department_id=NEW.department_id;
  IF TG_TABLE_NAME='offering_department' THEN
    SELECT institution_id INTO parent_institution FROM academic.course_offering_context
      WHERE offering_id=NEW.offering_id;
  ELSE
    SELECT institution_id INTO parent_institution FROM academic.academic_term WHERE term_id=NEW.term_id;
  END IF;
  IF institution IS NULL OR institution IS DISTINCT FROM parent_institution THEN
    RAISE EXCEPTION 'Pilot department and target must belong to the same institution' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER offer_department_scope BEFORE INSERT OR UPDATE ON pilot.offering_department
FOR EACH ROW EXECUTE FUNCTION pilot.check_department_tenant();
CREATE TRIGGER department_duty_scope BEFORE INSERT OR UPDATE ON pilot.department_duty
FOR EACH ROW EXECUTE FUNCTION pilot.check_department_tenant();
CREATE TRIGGER roster_delegation_scope BEFORE INSERT OR UPDATE ON pilot.roster_delegation
FOR EACH ROW EXECUTE FUNCTION pilot.check_department_tenant();

CREATE INDEX offering_duty_actor_idx ON pilot.offering_duty(user_id, offering_id);
CREATE INDEX department_duty_actor_idx ON pilot.department_duty(user_id, department_id, term_id);
CREATE INDEX roster_delegation_grantee_idx ON pilot.roster_delegation(grantee_id, department_id, term_id);

-- Null columns encode the three grant scopes internally. Every grant is tied to
-- an institution and every roster is reached through a registered pilot offering.
CREATE FUNCTION pilot.roster_scopes(p_actor uuid,p_at timestamptz)
RETURNS TABLE(institution_id uuid, offering_id uuid, department_id uuid, term_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,pilot,pg_temp AS $$
  SELECT d.institution_id,a.offering_id,NULL::uuid,NULL::uuid
    FROM pilot.offering_duty a JOIN pilot.offering_department od USING(offering_id)
    JOIN pilot.department d USING(department_id) WHERE a.user_id=p_actor
  UNION ALL
  SELECT d.institution_id,NULL,a.department_id,a.term_id
    FROM pilot.department_duty a JOIN pilot.department d USING(department_id) WHERE a.user_id=p_actor
  UNION ALL
  SELECT ra.institution_id,NULL,NULL,NULL FROM academic.role_assignment ra
    WHERE ra.user_id=p_actor AND ra.role_code='exam_approver'
  UNION ALL
  SELECT d.institution_id,NULL,a.department_id,a.term_id
    FROM pilot.roster_delegation a JOIN pilot.department d USING(department_id)
    JOIN academic.app_user u ON u.user_id=a.grantor_id AND u.account_state='active'
    JOIN academic.role_assignment ra ON ra.institution_id=d.institution_id
      AND ra.user_id=a.grantor_id AND ra.role_code='exam_approver'
    WHERE a.grantee_id=p_actor AND a.valid_during @> p_at
$$;

CREATE FUNCTION pilot.roster_offerings(p_digest text,p_offering uuid DEFAULT NULL)
RETURNS TABLE(offering_id uuid, department_code text, course_code text, section_code text, term_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pilot,pg_temp AS $$
DECLARE actor uuid; observed_at timestamptz;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  observed_at:=statement_timestamp();
  IF NOT EXISTS (SELECT FROM pilot.roster_scopes(actor,observed_at)) THEN
    RAISE EXCEPTION 'Roster access requires an active duty' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT o.offering_id,d.department_code,c.course_code,o.section_code,t.term_code
    FROM pilot.offering_department od
    JOIN pilot.department d USING(department_id)
    JOIN academic.course_offering_context o ON o.offering_id=od.offering_id AND o.institution_id=d.institution_id
    JOIN academic.course c ON c.course_id=o.course_id
    JOIN academic.academic_term t ON t.term_id=o.term_id
    WHERE (p_offering IS NULL OR o.offering_id=p_offering) AND EXISTS (
      SELECT FROM pilot.roster_scopes(actor,observed_at) g
      WHERE g.institution_id=o.institution_id
        AND (g.offering_id IS NULL OR g.offering_id=o.offering_id)
        AND (g.department_id IS NULL OR (g.department_id=od.department_id AND g.term_id=o.term_id))
    )
    ORDER BY o.offering_id LIMIT 501;
END $$;

CREATE FUNCTION pilot.read_roster(p_digest text,p_offering uuid,p_after uuid)
RETURNS TABLE(enrolment_id uuid, student_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pilot,pg_temp AS $$
BEGIN
  IF p_offering IS NULL OR NOT EXISTS (SELECT FROM pilot.roster_offerings(p_digest,p_offering)) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;
  RETURN QUERY SELECT e.enrolment_id,s.student_code
    FROM academic.enrolment e JOIN academic.student s USING(student_id)
    WHERE e.offering_id=p_offering AND (p_after IS NULL OR e.enrolment_id>p_after)
    ORDER BY e.enrolment_id LIMIT 101;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='academic_pilot_reader') THEN
    CREATE ROLE academic_pilot_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='academic_pilot_reader'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolconfig IS NOT NULL))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid,m.member)
      WHERE r.rolname='academic_pilot_reader') THEN
    RAISE EXCEPTION 'Unsafe pilot roster reader' USING ERRCODE='42501';
  END IF;
END $$;

REVOKE ALL ON SCHEMA pilot FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pilot FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pilot FROM PUBLIC;
GRANT USAGE ON SCHEMA academic,workflow,access_control,pilot TO academic_pilot_reader;
GRANT SELECT ON academic.app_user,academic.role_assignment,academic.course_offering_context,
  academic.course,academic.academic_term,academic.enrolment,academic.student,
  access_control.api_session TO academic_pilot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA pilot TO academic_pilot_reader;
GRANT EXECUTE ON FUNCTION workflow.actor_for_session(text),pilot.roster_scopes(uuid,timestamptz)
  TO academic_pilot_reader;
GRANT CREATE ON SCHEMA pilot TO academic_pilot_reader;
ALTER FUNCTION pilot.roster_offerings(text,uuid) OWNER TO academic_pilot_reader;
ALTER FUNCTION pilot.read_roster(text,uuid,uuid) OWNER TO academic_pilot_reader;
REVOKE CREATE ON SCHEMA pilot FROM academic_pilot_reader;
GRANT USAGE ON SCHEMA pilot TO scholarproof_api_access;
GRANT EXECUTE ON FUNCTION pilot.roster_offerings(text,uuid),pilot.read_roster(text,uuid,uuid)
  TO scholarproof_api_access;
