-- $1: student UUID; $2: known-at time; $3: effective-at time.
-- Direct query form permits inspection of the actual join/index plan.
SELECT gr.record_id, gv.version_no, c.course_code, co.credits,
  gv.grade_points, gv.outcome, gv.recorded_at, seg.valid_during
FROM academic.enrolment e
JOIN academic.grade_record gr ON gr.enrolment_id = e.enrolment_id
JOIN academic.grade_temporal_segment seg ON seg.record_id = gr.record_id
JOIN academic.grade_version gv ON gv.record_id = seg.record_id AND gv.version_no = seg.version_no
JOIN academic.course_offering co ON co.offering_id = e.offering_id
JOIN academic.course c ON c.course_id = co.course_id
WHERE e.student_id = $1::uuid
  AND seg.system_during @> $2::timestamptz
  AND seg.valid_during @> $3::timestamptz
ORDER BY c.course_code, gr.record_id;
