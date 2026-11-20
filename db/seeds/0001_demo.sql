-- Public synthetic fixture. Deterministic UUIDs are fixture identifiers, not privacy tokens.
-- The seed runner supplies a transaction and an immutable seed checksum marker.
INSERT INTO academic.institution(institution_id,institution_code,name)
VALUES(md5('demo:institution')::uuid,'DEMO_UNIVERSITY','Synthetic Demonstration University');

INSERT INTO academic.app_user(user_id,auth_subject)
VALUES(md5('demo:registrar')::uuid,'demo:registrar');

INSERT INTO academic.role_assignment(institution_id,user_id,role_code)
VALUES(md5('demo:institution')::uuid,md5('demo:registrar')::uuid,'registrar');

INSERT INTO academic.programme(programme_id,institution_id,programme_code,name)
VALUES(md5('demo:programme')::uuid,md5('demo:institution')::uuid,'DEMO_AIML','Synthetic AI/ML Programme');

INSERT INTO academic.academic_term(term_id,institution_id,term_code,starts_on,ends_on)
VALUES(md5('demo:term')::uuid,md5('demo:institution')::uuid,'2026-DEMO','2026-01-01','2026-12-31');

INSERT INTO academic.grading_scheme(scheme_id,institution_id,scheme_code,max_points,pass_points)
VALUES(md5('demo:scheme')::uuid,md5('demo:institution')::uuid,'DEMO_TEN_POINT',10,5);

DO $$
DECLARE
  student_number integer;
  course_number integer;
  student_uuid uuid;
  course_uuid uuid;
  offering_uuid uuid;
  enrolment_uuid uuid;
  record_uuid uuid;
  points numeric;
BEGIN
  FOR course_number IN 1..4 LOOP
    course_uuid := md5('demo:course:' || course_number)::uuid;
    offering_uuid := md5('demo:offering:' || course_number)::uuid;
    INSERT INTO academic.course(course_id,institution_id,course_code,title)
      VALUES(course_uuid,md5('demo:institution')::uuid,'DEMO_C' || course_number,
        'Synthetic Course ' || course_number);
    INSERT INTO academic.course_offering(offering_id,institution_id,course_id,term_id,scheme_id,credits)
      VALUES(offering_uuid,md5('demo:institution')::uuid,course_uuid,
        md5('demo:term')::uuid,md5('demo:scheme')::uuid,4);
  END LOOP;

  FOR student_number IN 1..25 LOOP
    student_uuid := md5('demo:student:' || student_number)::uuid;
    INSERT INTO academic.student(student_id,institution_id,programme_id,student_code,admission_year)
      VALUES(student_uuid,md5('demo:institution')::uuid,md5('demo:programme')::uuid,
        'DEMO_STUDENT_' || lpad(student_number::text,3,'0'),2026);
    FOR course_number IN 1..4 LOOP
      offering_uuid := md5('demo:offering:' || course_number)::uuid;
      enrolment_uuid := md5('demo:enrolment:' || student_number || ':' || course_number)::uuid;
      record_uuid := md5('demo:record:' || student_number || ':' || course_number)::uuid;
      INSERT INTO academic.enrolment(enrolment_id,institution_id,student_id,offering_id)
        VALUES(enrolment_uuid,md5('demo:institution')::uuid,student_uuid,offering_uuid);
      INSERT INTO academic.grade_record(record_id,institution_id,enrolment_id)
        VALUES(record_uuid,md5('demo:institution')::uuid,enrolment_uuid);
      points := CASE WHEN student_number=1 AND course_number=1 THEN 4
        ELSE 5 + mod(student_number + course_number,6) END;
      PERFORM academic.append_grade_version(record_uuid,0,points,
        CASE WHEN points < 5 THEN 'failed' ELSE 'passed' END,
        '2026-01-01T00:00:00Z',NULL,md5('demo:registrar')::uuid,'Synthetic initial result');
    END LOOP;
  END LOOP;
END;
$$;

-- Full retroactive correction: previous knowledge remains queryable.
SELECT academic.append_grade_version(md5('demo:record:1:1')::uuid,1,8,'passed',
  '2026-01-01T00:00:00Z',NULL,md5('demo:registrar')::uuid,'Synthetic approved revaluation');

-- A partial valid-time correction: the original grade remains effective outside this range.
SELECT academic.append_grade_version(md5('demo:record:2:2')::uuid,1,9,'passed',
  '2026-04-01T00:00:00Z','2026-07-01T00:00:00Z',md5('demo:registrar')::uuid,'Synthetic limited validity correction');
