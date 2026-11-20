-- Week 2 provisional academic model. No production grading policy is implied.
-- The migration runner supplies the transaction; do not add transaction commands.

CREATE SCHEMA academic;

CREATE TABLE academic.institution (
  institution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_code text NOT NULL UNIQUE CHECK (length(btrim(institution_code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE academic.app_user (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE CHECK (length(btrim(auth_subject)) BETWEEN 1 AND 200),
  account_state text NOT NULL DEFAULT 'active' CHECK (account_state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE academic.role_assignment (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  user_id uuid NOT NULL REFERENCES academic.app_user(user_id),
  role_code text NOT NULL CHECK (role_code IN ('registrar', 'examiner', 'student', 'auditor')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, user_id, role_code)
);

CREATE TABLE academic.programme (
  programme_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  programme_code text NOT NULL CHECK (length(btrim(programme_code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  UNIQUE (institution_id, programme_id),
  UNIQUE (institution_id, programme_code)
);

CREATE TABLE academic.student (
  student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  programme_id uuid NOT NULL,
  user_id uuid REFERENCES academic.app_user(user_id),
  student_code text NOT NULL CHECK (length(btrim(student_code)) BETWEEN 1 AND 80),
  admission_year smallint NOT NULL CHECK (admission_year BETWEEN 1900 AND 2200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, student_id),
  UNIQUE (institution_id, student_code),
  UNIQUE (institution_id, user_id),
  FOREIGN KEY (institution_id, programme_id)
    REFERENCES academic.programme(institution_id, programme_id)
);

CREATE TABLE academic.academic_term (
  term_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  term_code text NOT NULL CHECK (length(btrim(term_code)) BETWEEN 1 AND 40),
  starts_on date NOT NULL CHECK (isfinite(starts_on)),
  ends_on date NOT NULL CHECK (isfinite(ends_on)),
  CHECK (starts_on < ends_on),
  UNIQUE (institution_id, term_id),
  UNIQUE (institution_id, term_code)
);

CREATE TABLE academic.grading_scheme (
  scheme_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  scheme_code text NOT NULL CHECK (length(btrim(scheme_code)) BETWEEN 1 AND 40),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  max_points numeric(4,2) NOT NULL DEFAULT 10.00 CHECK (max_points > 0 AND max_points <= 10),
  pass_points numeric(4,2) NOT NULL DEFAULT 5.00 CHECK (pass_points >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (pass_points <= max_points),
  UNIQUE (institution_id, scheme_id),
  UNIQUE (institution_id, scheme_code, version)
);

CREATE TABLE academic.course (
  course_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  course_code text NOT NULL CHECK (length(btrim(course_code)) BETWEEN 1 AND 40),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  UNIQUE (institution_id, course_id),
  UNIQUE (institution_id, course_code)
);

CREATE TABLE academic.course_offering (
  offering_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  course_id uuid NOT NULL,
  term_id uuid NOT NULL,
  scheme_id uuid NOT NULL,
  section_code text NOT NULL DEFAULT 'A' CHECK (length(btrim(section_code)) BETWEEN 1 AND 20),
  credits numeric(4,2) NOT NULL CHECK (credits > 0 AND credits <= 30),
  UNIQUE (institution_id, offering_id),
  UNIQUE (institution_id, course_id, term_id, section_code),
  FOREIGN KEY (institution_id, course_id)
    REFERENCES academic.course(institution_id, course_id),
  FOREIGN KEY (institution_id, term_id)
    REFERENCES academic.academic_term(institution_id, term_id),
  FOREIGN KEY (institution_id, scheme_id)
    REFERENCES academic.grading_scheme(institution_id, scheme_id)
);

CREATE TABLE academic.enrolment (
  enrolment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  student_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, enrolment_id),
  UNIQUE (student_id, offering_id),
  FOREIGN KEY (institution_id, student_id)
    REFERENCES academic.student(institution_id, student_id),
  FOREIGN KEY (institution_id, offering_id)
    REFERENCES academic.course_offering(institution_id, offering_id)
);

CREATE TABLE academic.grade_record (
  record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES academic.institution(institution_id),
  enrolment_id uuid NOT NULL UNIQUE,
  latest_version_no integer CHECK (latest_version_no > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, record_id),
  FOREIGN KEY (institution_id, enrolment_id)
    REFERENCES academic.enrolment(institution_id, enrolment_id)
);

CREATE INDEX role_assignment_user_idx ON academic.role_assignment(user_id, institution_id);
CREATE INDEX student_programme_idx ON academic.student(institution_id, programme_id);
CREATE INDEX offering_term_idx ON academic.course_offering(institution_id, term_id);
CREATE INDEX offering_scheme_idx ON academic.course_offering(institution_id, scheme_id);
CREATE INDEX enrolment_student_idx ON academic.enrolment(institution_id, student_id);
CREATE INDEX enrolment_offering_idx ON academic.enrolment(institution_id, offering_id);

CREATE FUNCTION academic.reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, academic
AS $$
BEGIN
  RAISE EXCEPTION 'This row is immutable; create a new version instead'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER grading_scheme_immutable
BEFORE UPDATE OR DELETE ON academic.grading_scheme
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

COMMENT ON TABLE academic.grading_scheme IS
  'Immutable illustrative policy versions. These values are not asserted to be RVCE grading rules.';
COMMENT ON TABLE academic.student IS
  'Opaque academic identity. No real student PII or privacy/erasure guarantee is introduced by this schema.';
