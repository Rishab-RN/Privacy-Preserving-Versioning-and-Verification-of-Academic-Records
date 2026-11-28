-- Pilot desk: what the caller may do on each pilot offering, so the web screens show only the
-- desks a person holds. Each flag repeats the authority check of the function it leads to; the
-- functions themselves still decide every request.
CREATE FUNCTION assessment.my_desk(p_digest text)
RETURNS TABLE(offering_id uuid, course_code text, section_code text, term_code text,
  department_code text, entry_stages text[], reviews boolean, validates boolean,
  publishes boolean, reads_results boolean, corrects boolean, published boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,assessment,pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor:=workflow.actor_for_session(p_digest);
  RETURN QUERY
    SELECT x.offering_id, x.course_code, x.section_code, x.term_code, x.department_code,
      x.entry_stages, x.reviews, x.validates, x.publishes, x.reads_results, x.corrects, x.published
    FROM (
      SELECT o.offering_id, c.course_code, o.section_code, t.term_code, d.department_code,
        coalesce((
          SELECT array_agg(CASE dt.duty WHEN 'course_teacher' THEN 'cie' ELSE 'see' END
            ORDER BY dt.duty)
          FROM pilot.offering_duty dt WHERE dt.offering_id=o.offering_id AND dt.user_id=actor
        ), '{}'::text[]) AS entry_stages,
        EXISTS (
          SELECT FROM pilot.department_duty dd
          WHERE dd.user_id=actor AND dd.department_id=od.department_id AND dd.term_id=o.term_id
        ) AS reviews,
        EXISTS (
          SELECT FROM assessment.active_delegations(actor,statement_timestamp()) a
          WHERE a.department_id=od.department_id AND a.term_id=o.term_id
        ) AS validates,
        (assessment.publisher_scope(actor,o.offering_id)
          AND NOT assessment.offering_participant(actor,o.offering_id)) AS publishes,
        assessment.result_scope(actor,o.offering_id) AS reads_results,
        EXISTS (
          SELECT FROM academic.role_assignment ra JOIN academic.app_user u ON u.user_id=ra.user_id
          WHERE ra.user_id=actor AND ra.institution_id=o.institution_id AND ra.role_code='registrar'
            AND u.account_state='active'
        ) AS corrects,
        EXISTS (SELECT FROM assessment.publication p WHERE p.offering_id=o.offering_id) AS published
      FROM pilot.offering_department od
      JOIN academic.course_offering_context o ON o.offering_id=od.offering_id
      JOIN academic.course c ON c.course_id=o.course_id
      JOIN academic.academic_term t ON t.term_id=o.term_id
      JOIN pilot.department d ON d.department_id=od.department_id
    ) x
    WHERE cardinality(x.entry_stages)>0 OR x.reviews OR x.validates OR x.publishes
      OR x.reads_results OR x.corrects
    ORDER BY x.term_code, x.course_code, x.department_code, x.section_code;
END $$;

REVOKE ALL ON FUNCTION assessment.my_desk(text) FROM PUBLIC;
ALTER FUNCTION assessment.my_desk(text) OWNER TO academic_assessment_owner;
GRANT EXECUTE ON FUNCTION assessment.my_desk(text) TO scholarproof_api_access;
