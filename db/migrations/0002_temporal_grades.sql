CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE academic.grade_version (
  record_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  institution_id uuid NOT NULL,
  previous_version_no integer,
  grade_points numeric(4,2),
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'withdrawn', 'incomplete')),
  valid_during tstzrange NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  author_id uuid NOT NULL REFERENCES academic.app_user(user_id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  PRIMARY KEY (record_id, version_no),
  UNIQUE (institution_id, record_id, version_no),
  FOREIGN KEY (institution_id, record_id)
    REFERENCES academic.grade_record(institution_id, record_id),
  FOREIGN KEY (record_id, previous_version_no)
    REFERENCES academic.grade_version(record_id, version_no),
  CHECK ((version_no = 1 AND previous_version_no IS NULL)
    OR (version_no > 1 AND previous_version_no = version_no - 1)),
  CHECK (grade_points IS NULL OR (grade_points >= 0 AND grade_points <= 10)),
  CHECK ((outcome IN ('passed', 'failed') AND grade_points IS NOT NULL)
    OR (outcome IN ('withdrawn', 'incomplete') AND grade_points IS NULL)),
  CHECK (NOT isempty(valid_during) AND NOT lower_inf(valid_during)
    AND isfinite(lower(valid_during)) AND lower_inc(valid_during)
    AND NOT upper_inc(valid_during)
    AND (upper_inf(valid_during) OR isfinite(upper(valid_during)))),
  CHECK (isfinite(recorded_at))
);

ALTER TABLE academic.grade_record
  ADD CONSTRAINT grade_record_latest_version_fk
  FOREIGN KEY (record_id, latest_version_no)
    REFERENCES academic.grade_version(record_id, version_no)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE academic.grade_temporal_segment (
  segment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  record_id uuid NOT NULL,
  version_no integer NOT NULL,
  valid_during tstzrange NOT NULL,
  system_during tstzrange NOT NULL,
  FOREIGN KEY (institution_id, record_id, version_no)
    REFERENCES academic.grade_version(institution_id, record_id, version_no),
  CHECK (NOT isempty(valid_during) AND NOT lower_inf(valid_during)
    AND isfinite(lower(valid_during)) AND lower_inc(valid_during)
    AND NOT upper_inc(valid_during)
    AND (upper_inf(valid_during) OR isfinite(upper(valid_during)))),
  CHECK (NOT isempty(system_during) AND NOT lower_inf(system_during)
    AND isfinite(lower(system_during)) AND lower_inc(system_during)
    AND NOT upper_inc(system_during)
    AND (upper_inf(system_during) OR isfinite(upper(system_during)))),
  EXCLUDE USING gist (
    institution_id WITH =,
    record_id WITH =,
    valid_during WITH &&,
    system_during WITH &&
  )
);

CREATE INDEX grade_version_history_idx ON academic.grade_version(record_id, version_no DESC);
CREATE INDEX grade_version_author_idx ON academic.grade_version(author_id);
CREATE INDEX grade_segment_current_idx ON academic.grade_temporal_segment(institution_id, record_id)
  WHERE upper_inf(system_during);

CREATE TRIGGER grade_version_immutable
BEFORE UPDATE OR DELETE ON academic.grade_version
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

-- An enrolment is an identity relationship, not an editable transcript label.
-- Reassigning it would silently move every historical grade to a different
-- student or policy. New attempts need new enrolments instead.
CREATE TRIGGER enrolment_immutable
BEFORE UPDATE ON academic.enrolment
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

CREATE FUNCTION academic.guard_grade_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, academic
AS $$
DECLARE
  record_row academic.grade_record%ROWTYPE;
  prior_time timestamptz;
  policy_max numeric;
  policy_pass numeric;
BEGIN
  SELECT * INTO record_row FROM academic.grade_record
    WHERE record_id = NEW.record_id FOR UPDATE;
  IF NOT FOUND OR record_row.institution_id IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'Grade record does not belong to the supplied institution'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.version_no IS DISTINCT FROM coalesce(record_row.latest_version_no, 0) + 1 THEN
    RAISE EXCEPTION 'Grade versions must form a contiguous revision history'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.previous_version_no IS NOT NULL
     AND NEW.previous_version_no IS DISTINCT FROM record_row.latest_version_no THEN
    RAISE EXCEPTION 'Invalid predecessor revision' USING ERRCODE = '23514';
  END IF;
  NEW.previous_version_no := record_row.latest_version_no;

  IF NOT EXISTS (
    SELECT 1 FROM academic.app_user u
    JOIN academic.role_assignment ra ON ra.user_id = u.user_id
    WHERE u.user_id = NEW.author_id AND u.account_state = 'active'
      AND ra.institution_id = record_row.institution_id
      AND ra.role_code IN ('registrar', 'examiner')
  ) THEN
    RAISE EXCEPTION 'Author is not active academic staff in this institution'
      USING ERRCODE = '42501';
  END IF;

  SELECT gs.max_points, gs.pass_points INTO policy_max, policy_pass
  FROM academic.enrolment e
  JOIN academic.course_offering co ON co.offering_id = e.offering_id
  JOIN academic.grading_scheme gs ON gs.scheme_id = co.scheme_id
  WHERE e.enrolment_id = record_row.enrolment_id
  FOR SHARE OF co;

  IF NEW.grade_points IS NOT NULL AND (NEW.grade_points < 0 OR NEW.grade_points > policy_max) THEN
    RAISE EXCEPTION 'Grade points exceed the referenced scheme' USING ERRCODE = '23514';
  END IF;
  IF (NEW.outcome = 'passed' AND (NEW.grade_points IS NULL OR NEW.grade_points < policy_pass))
     OR (NEW.outcome = 'failed' AND (NEW.grade_points IS NULL OR NEW.grade_points >= policy_pass)) THEN
    RAISE EXCEPTION 'Grade points and outcome disagree with the referenced scheme'
      USING ERRCODE = '23514';
  END IF;

  IF record_row.latest_version_no IS NOT NULL THEN
    SELECT recorded_at INTO prior_time FROM academic.grade_version
      WHERE record_id = NEW.record_id AND version_no = record_row.latest_version_no;
  END IF;
  NEW.recorded_at := greatest(clock_timestamp(), prior_time + interval '1 microsecond');
  RETURN NEW;
END;
$$;

CREATE TRIGGER grade_version_guard
BEFORE INSERT ON academic.grade_version
FOR EACH ROW EXECUTE FUNCTION academic.guard_grade_version();

CREATE FUNCTION academic.guard_record_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, academic
AS $$
DECLARE
  actual_latest integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.latest_version_no IS NOT NULL THEN
      RAISE EXCEPTION 'A new record starts without revisions' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.latest_version_no IS NOT NULL AND (
    NEW.record_id IS DISTINCT FROM OLD.record_id
    OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
    OR NEW.enrolment_id IS DISTINCT FROM OLD.enrolment_id
  ) THEN
    RAISE EXCEPTION 'A versioned grade record cannot change identity' USING ERRCODE = '55000';
  END IF;
  IF NEW.latest_version_no IS DISTINCT FROM OLD.latest_version_no THEN
    SELECT max(version_no) INTO actual_latest FROM academic.grade_version WHERE record_id = NEW.record_id;
    IF NEW.latest_version_no IS DISTINCT FROM actual_latest
       OR NEW.latest_version_no < OLD.latest_version_no THEN
      RAISE EXCEPTION 'Record head must identify the latest recorded revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER grade_record_head_guard
BEFORE INSERT OR UPDATE ON academic.grade_record
FOR EACH ROW EXECUTE FUNCTION academic.guard_record_head();

CREATE FUNCTION academic.project_grade_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, academic
AS $$
DECLARE
  previous_segment academic.grade_temporal_segment%ROWTYPE;
  remainder tstzrange;
BEGIN
  FOR previous_segment IN
    SELECT * FROM academic.grade_temporal_segment
    WHERE record_id = NEW.record_id AND upper_inf(system_during)
      AND valid_during && NEW.valid_during
    FOR UPDATE
  LOOP
    UPDATE academic.grade_temporal_segment
    SET system_during = tstzrange(lower(previous_segment.system_during), NEW.recorded_at, '[)')
    WHERE segment_id = previous_segment.segment_id;

    FOR remainder IN
      SELECT unnest(tstzmultirange(previous_segment.valid_during) - tstzmultirange(NEW.valid_during))
    LOOP
      INSERT INTO academic.grade_temporal_segment
        (institution_id, record_id, version_no, valid_during, system_during)
      VALUES
        (previous_segment.institution_id, previous_segment.record_id, previous_segment.version_no,
         remainder, tstzrange(NEW.recorded_at, NULL, '[)'));
    END LOOP;
  END LOOP;

  INSERT INTO academic.grade_temporal_segment
    (institution_id, record_id, version_no, valid_during, system_during)
  VALUES (NEW.institution_id, NEW.record_id, NEW.version_no, NEW.valid_during,
    tstzrange(NEW.recorded_at, NULL, '[)'));

  UPDATE academic.grade_record SET latest_version_no = NEW.version_no WHERE record_id = NEW.record_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER grade_version_project
AFTER INSERT ON academic.grade_version
FOR EACH ROW EXECUTE FUNCTION academic.project_grade_version();

CREATE FUNCTION academic.freeze_used_offering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, academic
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM academic.enrolment e
    JOIN academic.grade_record gr ON gr.enrolment_id = e.enrolment_id
    WHERE e.offering_id = OLD.offering_id AND gr.latest_version_no IS NOT NULL
  ) AND (
    TG_OP = 'DELETE' OR NEW.offering_id IS DISTINCT FROM OLD.offering_id
    OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
    OR NEW.course_id IS DISTINCT FROM OLD.course_id
    OR NEW.term_id IS DISTINCT FROM OLD.term_id
    OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id
    OR NEW.credits IS DISTINCT FROM OLD.credits
  ) THEN
    RAISE EXCEPTION 'A grade-used offering cannot change academic policy or identity'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER course_offering_freeze_used
BEFORE UPDATE OR DELETE ON academic.course_offering
FOR EACH ROW EXECUTE FUNCTION academic.freeze_used_offering();

CREATE FUNCTION academic.append_grade_version(
  p_record_id uuid,
  p_expected_version integer,
  p_grade_points numeric,
  p_outcome text,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_author_id uuid,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, academic
AS $$
DECLARE
  record_row academic.grade_record%ROWTYPE;
  next_version integer;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0
    OR p_valid_from IS NULL OR NOT isfinite(p_valid_from)
    OR (p_valid_until IS NOT NULL AND (NOT isfinite(p_valid_until) OR p_valid_until <= p_valid_from))
    OR (p_grade_points IS NOT NULL AND p_grade_points <> round(p_grade_points, 2)) THEN
    RAISE EXCEPTION 'Invalid expected version, validity range or grade precision'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO record_row FROM academic.grade_record WHERE record_id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grade record does not exist' USING ERRCODE = '23503';
  END IF;
  IF coalesce(record_row.latest_version_no, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'Expected version does not match latest recorded revision'
      USING ERRCODE = '40001';
  END IF;
  next_version := p_expected_version + 1;
  INSERT INTO academic.grade_version
    (record_id, version_no, institution_id, previous_version_no, grade_points, outcome,
     valid_during, author_id, reason)
  VALUES
    (p_record_id, next_version, record_row.institution_id, record_row.latest_version_no,
     p_grade_points, p_outcome, tstzrange(p_valid_from, p_valid_until, '[)'), p_author_id, p_reason);
  RETURN next_version;
END;
$$;

CREATE FUNCTION academic.transcript_as_of(
  p_student_id uuid,
  p_known_at timestamptz,
  p_effective_at timestamptz
)
RETURNS TABLE (
  record_id uuid,
  version_no integer,
  course_code text,
  credits numeric,
  grade_points numeric,
  outcome text,
  recorded_at timestamptz,
  valid_during tstzrange
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, academic
AS $$
  SELECT gr.record_id, gv.version_no, c.course_code, co.credits,
    gv.grade_points, gv.outcome, gv.recorded_at, seg.valid_during
  FROM academic.enrolment e
  JOIN academic.grade_record gr ON gr.enrolment_id = e.enrolment_id
  JOIN academic.grade_temporal_segment seg ON seg.record_id = gr.record_id
  JOIN academic.grade_version gv ON gv.record_id = seg.record_id AND gv.version_no = seg.version_no
  JOIN academic.course_offering co ON co.offering_id = e.offering_id
  JOIN academic.course c ON c.course_id = co.course_id
  WHERE e.student_id = p_student_id AND seg.system_during @> p_known_at
    AND seg.valid_during @> p_effective_at
  ORDER BY c.course_code, gr.record_id;
$$;

CREATE VIEW academic.current_transcript AS
SELECT e.institution_id, e.student_id, gr.record_id, gv.version_no,
  c.course_code, co.credits, gv.grade_points, gv.outcome, gv.recorded_at, seg.valid_during
FROM academic.enrolment e
JOIN academic.grade_record gr ON gr.enrolment_id = e.enrolment_id
JOIN academic.grade_temporal_segment seg ON seg.record_id = gr.record_id
JOIN academic.grade_version gv ON gv.record_id = seg.record_id AND gv.version_no = seg.version_no
JOIN academic.course_offering co ON co.offering_id = e.offering_id
JOIN academic.course c ON c.course_id = co.course_id
WHERE upper_inf(seg.system_during) AND seg.valid_during @> CURRENT_TIMESTAMP;

COMMENT ON TABLE academic.grade_version IS
  'Append-only academic facts. Recorded timestamps are database assertions, not external timestamps or cryptographic commitments.';
COMMENT ON TABLE academic.grade_temporal_segment IS
  'Derived bitemporal projection. Half-open valid/system ranges prohibit contradictory overlapping beliefs for one record.';
COMMENT ON COLUMN academic.grade_record.latest_version_no IS
  'Latest recorded revision, which may not be effective at the current valid time.';
