-- AF-40: persist which model, prompt, schema, and rubric version
-- produced each evidence-extraction run, for reproducibility and
-- audit. Append-only for the same reason as audit_events (0005): a
-- record of what actually produced a result must not be editable after
-- the fact, or it stops being able to answer "what produced this."
--
-- reject_append_only_mutation is a generic version of 0005's
-- reject_audit_event_mutation (which hardcodes its exception message to
-- "audit_events"). That one is left as-is rather than edited in place
-- -- rewriting a migration once anything may have run it is not safe
-- practice, even pre-merge. Future append-only tables should use this
-- generic function instead.

CREATE OR REPLACE FUNCTION reject_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS evidence_extraction_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (length(entity_type) > 0),
  entity_id text NOT NULL CHECK (length(entity_id) > 0),
  provider text NOT NULL CHECK (length(provider) > 0),
  model text NOT NULL CHECK (length(model) > 0),
  prompt_version text NOT NULL CHECK (length(prompt_version) > 0),
  extraction_schema_version text NOT NULL CHECK (length(extraction_schema_version) > 0),
  extraction_schema_name text NOT NULL CHECK (length(extraction_schema_name) > 0),
  rubric_version text NOT NULL CHECK (length(rubric_version) > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS evidence_extraction_runs_organization_id_idx
  ON evidence_extraction_runs (organization_id);
CREATE INDEX IF NOT EXISTS evidence_extraction_runs_entity_idx
  ON evidence_extraction_runs (entity_type, entity_id);

DROP TRIGGER IF EXISTS evidence_extraction_runs_append_only ON evidence_extraction_runs;
CREATE TRIGGER evidence_extraction_runs_append_only
  BEFORE UPDATE OR DELETE ON evidence_extraction_runs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS evidence_extraction_runs_reject_truncate ON evidence_extraction_runs;
CREATE TRIGGER evidence_extraction_runs_reject_truncate
  BEFORE TRUNCATE ON evidence_extraction_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
