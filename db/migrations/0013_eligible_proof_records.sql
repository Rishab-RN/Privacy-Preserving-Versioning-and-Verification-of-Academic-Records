CREATE FUNCTION privacy.eligible_records(p_token text, p_student uuid)
RETURNS TABLE("recordId" uuid, "versionNo" integer, "courseCode" text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,privacy,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor := workflow.actor_for_session(p_token);
  IF NOT EXISTS (
    SELECT 1 FROM academic.student s
    JOIN academic.role_assignment a ON a.user_id=s.user_id AND a.institution_id=s.institution_id
    WHERE s.student_id=p_student AND s.user_id=actor AND a.role_code='student'
  ) THEN
    RAISE EXCEPTION 'Resource not found' USING ERRCODE='P0002';
  END IF;

  RETURN QUERY
    SELECT g.record_id, d.version_no, c.course_code
    FROM academic.enrolment e
    JOIN academic.grade_record g USING(enrolment_id)
    JOIN workflow.decision d ON d.record_id=g.record_id AND d.version_no=g.latest_version_no
    JOIN academic.grade_version v ON v.record_id=g.record_id AND v.version_no=d.version_no
    JOIN academic.course_offering o USING(offering_id)
    JOIN academic.course c USING(course_id)
    JOIN academic.student s ON s.student_id=e.student_id
    WHERE s.student_id=p_student AND s.user_id=actor
      AND EXISTS (SELECT 1 FROM academic.role_assignment a
        WHERE a.user_id=actor AND a.institution_id=s.institution_id AND a.role_code='student')
      AND v.outcome='passed' AND v.grade_points IS NOT NULL
    ORDER BY c.course_code COLLATE "C", g.record_id
    LIMIT 501;
END $$;

REVOKE ALL ON FUNCTION privacy.eligible_records(text,uuid) FROM PUBLIC;
GRANT SELECT(course_id,course_code) ON academic.course TO academic_privacy_owner;
GRANT CREATE ON SCHEMA privacy TO academic_privacy_owner;
ALTER FUNCTION privacy.eligible_records(text,uuid) OWNER TO academic_privacy_owner;
REVOKE CREATE ON SCHEMA privacy FROM academic_privacy_owner;
GRANT EXECUTE ON FUNCTION privacy.eligible_records(text,uuid) TO scholarproof_api_access;
