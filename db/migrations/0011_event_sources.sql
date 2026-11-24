-- A shared event identity boundary, without rewriting any committed leaf.
-- Source-specific facts stay in their authoritative subtype. Additional source
-- types require a forward migration and their own exactly-one-source guard.
CREATE TABLE transparency.event_source (
  event_id uuid PRIMARY KEY
);
INSERT INTO transparency.event_source(event_id)
SELECT event_id FROM workflow.domain_event;

ALTER TABLE transparency.event_position
  DROP CONSTRAINT event_position_event_id_fkey,
  ADD CONSTRAINT event_position_event_id_fkey FOREIGN KEY(event_id)
    REFERENCES transparency.event_source(event_id);
ALTER TABLE workflow.domain_event ADD CONSTRAINT domain_event_source_fkey
  FOREIGN KEY(event_id) REFERENCES transparency.event_source(event_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE VIEW transparency.event_context WITH (security_invoker=true) AS
SELECT e.event_id,'workflow'::text AS source_kind,e.request_id,e.kind,e.occurred_at,
  g.institution_id,e.payload
FROM workflow.domain_event e JOIN workflow.change_request q USING(request_id)
JOIN evidence.reference r USING(evidence_id)
JOIN academic.grade_record g USING(record_id)
JOIN transparency.event_source s USING(event_id);

CREATE FUNCTION transparency.guard_event_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,transparency,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workflow.domain_event WHERE event_id=NEW.event_id) THEN
    RAISE EXCEPTION 'An event identity requires exactly one authoritative source'
      USING ERRCODE='23503';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER event_source_required AFTER INSERT ON transparency.event_source
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transparency.guard_event_source();
CREATE TRIGGER event_source_immutable BEFORE UPDATE OR DELETE ON transparency.event_source
FOR EACH ROW EXECUTE FUNCTION academic.reject_immutable_change();

CREATE OR REPLACE FUNCTION transparency.sequence_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,transparency,pg_temp AS $$
DECLARE tenant uuid; slot bigint;
BEGIN
  SELECT g.institution_id INTO tenant FROM workflow.change_request q
    JOIN evidence.reference e USING(evidence_id) JOIN academic.grade_record g USING(record_id)
    WHERE q.request_id=NEW.request_id;
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'A transparency event needs an authoritative institution' USING ERRCODE='23503';
  END IF;
  INSERT INTO transparency.event_source(event_id) VALUES(NEW.event_id);
  INSERT INTO transparency.log_state(institution_id) VALUES(tenant) ON CONFLICT(institution_id) DO NOTHING;
  UPDATE transparency.log_state SET tree_size=tree_size+1 WHERE institution_id=tenant RETURNING tree_size-1 INTO slot;
  INSERT INTO transparency.event_position(event_id,institution_id,leaf_index,salt)
    VALUES(NEW.event_id,tenant,slot,transparency.random_salt());
  RETURN NEW;
END;
$$;

REVOKE ALL ON transparency.event_source,transparency.event_context FROM PUBLIC;
REVOKE ALL ON FUNCTION transparency.guard_event_source() FROM PUBLIC;
GRANT SELECT,INSERT ON transparency.event_source TO academic_log_owner;
GRANT SELECT ON transparency.event_source,transparency.event_context TO academic_log_reader;
GRANT CREATE ON SCHEMA transparency TO academic_log_owner;
ALTER FUNCTION transparency.guard_event_source() OWNER TO academic_log_owner;
REVOKE CREATE ON SCHEMA transparency FROM academic_log_owner;

COMMENT ON TABLE transparency.event_source IS
  'BCNF unary key event_id. Source kind is computed from authoritative subtype membership, never stored as a constant or redundant classification.';
COMMENT ON VIEW transparency.event_context IS
  'Invoker-scoped common event interface. No new payload encoding, salts, positions, bootstrap boundary or checkpoint bytes are introduced by this view.';
